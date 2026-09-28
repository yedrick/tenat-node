import { describe, expect, it } from 'vitest';
import {
  UnsafeWebhookUrlError,
  assertPublicUrl,
  generateWebhookSecret,
  isPrivateAddress,
  matchesEvent,
  signWebhook,
  verifyWebhook,
} from '@tenancy-node/transport-webhook';

describe('webhook signatures', () => {
  it('signs and verifies, rejecting tampering, wrong secrets and old timestamps', () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const body = '{"type":"tenant.created"}';
    const now = 1_790_000_000_000;
    const header = signWebhook(secret, body, Math.floor(now / 1000));
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyWebhook({ secret, body, header, now })).toBe(true);
    expect(verifyWebhook({ secret, body: body + ' ', header, now })).toBe(false);
    expect(verifyWebhook({ secret: generateWebhookSecret(), body, header, now })).toBe(false);
    expect(verifyWebhook({ secret, body, header, now: now + 301_000 })).toBe(false);
    expect(verifyWebhook({ secret, body, header: undefined, now })).toBe(false);
    expect(verifyWebhook({ secret, body, header: 't=abc,v1=00', now })).toBe(false);
    expect(verifyWebhook({ secret, body, header: header.replace(/v1=../, 'v1=zz'), now })).toBe(
      false,
    );
  });

  it('matches event patterns', () => {
    expect(matchesEvent(['*'], 'x.y')).toBe(true);
    expect(matchesEvent(['tenant.*'], 'tenant.created')).toBe(true);
    expect(matchesEvent(['tenant.*'], 'domain.created')).toBe(false);
    expect(matchesEvent(['pedido.creado'], 'pedido.creado')).toBe(true);
  });
});

describe('SSRF protection', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    'not-an-ip',
  ])('%s is private', (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('%s is public', (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );

  it('rejects internal destinations, odd schemes and credentials in URLs', async () => {
    for (const url of [
      'http://127.0.0.1:3000/hook',
      'http://169.254.169.254/latest/meta-data',
      'http://localhost/x',
      'http://[::1]/x',
      'ftp://example.com',
      'https://user:pw@example.com',
      'nope',
    ]) {
      await expect(assertPublicUrl(url)).rejects.toThrow(UnsafeWebhookUrlError);
    }
    await expect(assertPublicUrl('https://93.184.215.14/hook')).resolves.toBeInstanceOf(URL);
    await expect(
      assertPublicUrl('http://127.0.0.1/x', { allowPrivateNetworks: true }),
    ).resolves.toBeInstanceOf(URL);
  });
});
