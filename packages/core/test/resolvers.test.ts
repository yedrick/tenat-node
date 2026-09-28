import { createTestTenancy } from '@tenancy-node/testing';
import { describe, expect, it } from 'vitest';
import {
  InMemoryDomainRepository,
  TenantInMaintenanceError,
  TenantNotFoundError,
  TenantNotReadyError,
  TenantSuspendedError,
  byDomain,
  byHeader,
  byPath,
  bySubdomain,
  chain,
  hostnameOf,
  resolverFromName,
  type RequestLike,
  type ResolveContext,
} from '../src/index.js';

const ctx = (domains = new InMemoryDomainRepository()): ResolveContext => ({
  domains,
  centralDomains: ['tuapp.com', 'localhost'],
});
const req = (host?: string, path = '/', headers: RequestLike['headers'] = {}): RequestLike => ({
  host,
  path,
  headers,
});

describe('hostnameOf', () => {
  it.each([
    ['Bolivar.TuApp.com:3000', 'bolivar.tuapp.com'],
    ['bolivar.tuapp.com.', 'bolivar.tuapp.com'],
    ['[::1]:3000', '::1'],
    ['[::1', undefined],
    ['', undefined],
    [undefined, undefined],
    [':80', undefined],
  ])('%j → %j', (input, expected) => {
    expect(hostnameOf(input)).toBe(expected);
  });
});

describe('resolvers', () => {
  it('bySubdomain takes one label under a base domain', async () => {
    const r = bySubdomain();
    expect((await r.resolve(req('bolivar.tuapp.com:3000'), ctx()))?.value).toBe('bolivar');
    expect((await r.resolve(req('tigre.localhost'), ctx()))?.value).toBe('tigre');
    expect(await r.resolve(req('a.b.tuapp.com'), ctx())).toBeUndefined();
    expect(await r.resolve(req('tuapp.com'), ctx())).toBeUndefined();
    expect(await r.resolve(req('bolivar.other.com'), ctx())).toBeUndefined();
    expect(await r.resolve(req('BAD_.tuapp.com'), ctx())).toBeUndefined();
    expect(await r.resolve(req(undefined), ctx())).toBeUndefined();
    const custom = bySubdomain({ baseDomains: ['saas.io'] });
    expect((await custom.resolve(req('x1.saas.io'), ctx()))?.value).toBe('x1');
  });

  it('byPath reads a path segment', async () => {
    expect((await byPath().resolve(req('x', '/bolivar/productos?x=1'), ctx()))?.value).toBe(
      'bolivar',
    );
    expect((await byPath({ segment: 1 }).resolve(req('x', '/t/tigre'), ctx()))?.value).toBe(
      'tigre',
    );
    expect(await byPath().resolve(req('x', '/'), ctx())).toBeUndefined();
    expect(await byPath().resolve({ headers: {} }, ctx())).toBeUndefined();
  });

  it('byHeader reads a header', async () => {
    expect((await byHeader().resolve(req('x', '/', { 'x-tenant': 'bolivar' }), ctx()))?.value).toBe(
      'bolivar',
    );
    expect(
      (await byHeader('X-Org').resolve(req('x', '/', { 'x-org': ['tigre', 'x'] }), ctx()))?.value,
    ).toBe('tigre');
    expect(
      await byHeader().resolve(req('x', '/', { 'x-tenant': 'DROP TABLE' }), ctx()),
    ).toBeUndefined();
  });

  it('byDomain and chain', async () => {
    const { tenancy, seed } = createTestTenancy();
    await seed(['bolivar']);
    await tenancy.domains.add('bolivar', 'clubbolivar.com');
    const r = chain([byDomain(), byHeader()]);
    expect(r.name).toBe('chain(domain,header)');
    const resolution = await tenancy.resolve(req('clubbolivar.com'));
    expect(resolution.kind === 'tenant' && resolution.tenant.id.value).toBe('bolivar');
    const domains = new InMemoryDomainRepository();
    expect(await r.resolve(req('clubbolivar.com'), ctx(domains))).toBeUndefined();
    expect(await byDomain().resolve(req('bad host!'), ctx(domains))).toBeUndefined();
  });

  it('resolverFromName', () => {
    expect(
      ['domain', 'subdomain', 'path', 'header'].map((n) => resolverFromName(n as 'path').name),
    ).toEqual(['domain', 'subdomain', 'path', 'header']);
  });
});

describe('tenancy.resolve', () => {
  it('distinguishes central, tenant and unidentified requests', async () => {
    const { tenancy, seed } = createTestTenancy({ centralDomains: ['tuapp.com'] });
    await seed(['bolivar']);
    expect(await tenancy.resolve(req('tuapp.com'))).toEqual({ kind: 'central' });
    expect(await tenancy.resolve(req('other.com'))).toEqual({ kind: 'unidentified' });
    const r = await tenancy.resolve(req('bolivar.tuapp.com'));
    expect(r.kind === 'tenant' && r.tenant.id.value).toBe('bolivar');
    expect((await tenancy.resolve(req('bolivar.test'))).kind).toBe('tenant');
    await expect(tenancy.resolve(req('ghost.tuapp.com'))).rejects.toThrow(TenantNotFoundError);
  });

  it('refuses tenants that cannot serve requests', async () => {
    const { tenancy, seed } = createTestTenancy({ centralDomains: ['tuapp.com'] });
    await seed(['s1', 'm1']);
    await tenancy.tenants.suspend('s1');
    await tenancy.tenants.maintenance('m1', 'soon');
    await expect(tenancy.resolve(req('s1.tuapp.com'))).rejects.toThrow(TenantSuspendedError);
    await expect(tenancy.resolve(req('m1.tuapp.com'))).rejects.toThrow(TenantInMaintenanceError);

    const failing = createTestTenancy({
      centralDomains: ['tuapp.com'],
      provisioning: {
        provision: async () => Promise.reject(new Error('x')),
        deprovision: async () => {},
      },
    });
    await failing.tenancy.tenants.create({ id: 'f1' }).catch(() => {});
    await expect(failing.tenancy.resolve(req('f1.tuapp.com'))).rejects.toThrow(TenantNotReadyError);
  });
});
