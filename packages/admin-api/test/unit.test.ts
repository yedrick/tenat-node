import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { clientIpOf, readJson, readRaw } from '../src/http.js';
import {
  base32Decode,
  base32Encode,
  can,
  generateTotpSecret,
  permissionsOf,
  totp,
  verifyTotp,
} from '@tenancy-node/admin-api';
import { RateLimiter } from '../src/auth/rate-limit.js';

describe('TOTP (RFC 6238)', () => {
  // Vectores oficiales del RFC 6238 (SHA-1, secreto "12345678901234567890"), últimos 6 dígitos.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('at %i seconds is %s', (seconds, code) => {
    expect(totp(secret, seconds * 1000)).toBe(code);
  });

  it('accepts one step of clock drift and rejects the rest', () => {
    const s = generateTotpSecret();
    const now = 1_790_000_000_000;
    expect(verifyTotp(s, totp(s, now), now)).toBe(true);
    expect(verifyTotp(s, totp(s, now - 30_000), now)).toBe(true);
    expect(verifyTotp(s, totp(s, now - 90_000), now)).toBe(false);
    expect(verifyTotp(s, '12345', now)).toBe(false);
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(base32Encode(Buffer.from('hola')))).toEqual(Buffer.from('hola'));
  });
});

describe('roles', () => {
  it('grants each role only what it needs', () => {
    expect(can('support', 'tenants:read')).toBe(true);
    expect(can('support', 'impersonate')).toBe(true);
    expect(can('support', 'tenants:write')).toBe(false);
    expect(can('admin', 'tenants:write')).toBe(true);
    expect(can('admin', 'tenants:delete')).toBe(false);
    expect(can('admin', 'users:manage')).toBe(false);
    expect(can('owner', 'users:manage')).toBe(true);
    expect(permissionsOf('owner').length).toBeGreaterThan(permissionsOf('admin').length);
  });
});

describe('RateLimiter', () => {
  it('blocks after max failures in the window and resets', () => {
    const limiter = new RateLimiter(2, 1000);
    limiter.fail('k', 0);
    expect(limiter.allowed('k', 10)).toBe(true);
    limiter.fail('k', 10);
    expect(limiter.allowed('k', 20)).toBe(false);
    expect(limiter.retryAfterSeconds('k', 20)).toBe(1);
    expect(limiter.allowed('k', 1001)).toBe(true);
    limiter.fail('j', 0);
    limiter.reset('j');
    expect(limiter.allowed('j', 1)).toBe(true);
  });
});

describe('readJson', () => {
  /** Petición cuyo stream ya consumió otro body parser (como `express.json()`). */
  async function consumed(body: unknown): Promise<IncomingMessage> {
    const req = Readable.from([Buffer.from('{"a":1}')]) as unknown as IncomingMessage;
    req.headers = { 'content-type': 'application/json' };
    for await (const _chunk of req) void _chunk;
    Object.assign(req, { body });
    return req;
  }

  it('uses req.body when a previous parser already read the stream', async () => {
    await expect(readJson(await consumed({ email: 'a@b.c' }), 1024)).resolves.toEqual({
      email: 'a@b.c',
    });
    await expect(readJson(await consumed('{"x":2}'), 1024)).resolves.toEqual({ x: 2 });
    await expect(readJson(await consumed(Buffer.from('')), 1024)).resolves.toBeUndefined();
    await expect(readJson(await consumed('nope'), 1024)).rejects.toMatchObject({
      code: 'ADMIN_INVALID_JSON',
    });
  });
});

describe('clientIpOf', () => {
  const req = (forwarded?: string, socket = '127.0.0.1') =>
    ({
      socket: { remoteAddress: socket },
      headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    }) as unknown as IncomingMessage;

  it('uses the socket address unless the proxy is trusted', () => {
    expect(clientIpOf(req('203.0.113.1'))).toBe('127.0.0.1');
    expect(clientIpOf(req('203.0.113.1'), 0)).toBe('127.0.0.1');
    expect(clientIpOf(req(undefined), 1)).toBe('127.0.0.1');
  });

  it('skips the trusted proxies counting from the socket', () => {
    expect(clientIpOf(req('203.0.113.1'), 1)).toBe('203.0.113.1');
    // El cliente agregó una IP falsa: el proxy de confianza escribió la real al final.
    expect(clientIpOf(req('1.2.3.4, 203.0.113.1'), 1)).toBe('203.0.113.1');
    expect(clientIpOf(req('203.0.113.1, 10.0.0.2'), 2)).toBe('203.0.113.1');
    expect(clientIpOf(req('203.0.113.1'), 5)).toBe('203.0.113.1');
    expect(clientIpOf(req('1.2.3.4, 203.0.113.1'), true)).toBe('1.2.3.4');
  });
});

describe('readRaw', () => {
  it('reads binary bodies with a size limit', async () => {
    const make = (chunks: Buffer[]) => Readable.from(chunks) as unknown as IncomingMessage;
    const bytes = Buffer.from([0x89, 0x50, 0x00, 0xff]);
    await expect(readRaw(make([bytes]), 10)).resolves.toEqual(bytes);
    await expect(readRaw(make([]), 10)).resolves.toBeUndefined();
    await expect(readRaw(make([Buffer.alloc(11)]), 10)).rejects.toMatchObject({
      code: 'ADMIN_PAYLOAD_TOO_LARGE',
    });
  });

  it('uses the Buffer left by express.raw() and refuses other parsers', async () => {
    const consumed = async (body: unknown) => {
      const req = Readable.from([Buffer.from('x')]) as unknown as IncomingMessage;
      for await (const _chunk of req) void _chunk;
      return Object.assign(req, { body });
    };
    await expect(readRaw(await consumed(Buffer.from('png')), 10)).resolves.toEqual(
      Buffer.from('png'),
    );
    await expect(readRaw(await consumed({}), 10)).rejects.toMatchObject({
      code: 'ADMIN_BODY_ALREADY_PARSED',
    });
  });
});
