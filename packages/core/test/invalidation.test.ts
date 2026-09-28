import { describe, expect, it } from 'vitest';
import {
  createTenancy,
  InMemoryDomainRepository,
  InMemoryTenantRepository,
  MemoryInvalidationBus,
  NoopLogger,
  type InvalidationBus,
  type InvalidationMessage,
} from '../src/index.js';
import { sleep } from './helpers.js';

// Dos "instancias" de la app sobre los mismos repositorios (como dos réplicas sobre una base).
function cluster(bus?: InvalidationBus) {
  const tenants = new InMemoryTenantRepository();
  const domains = new InMemoryDomainRepository();
  const make = () =>
    createTenancy({ tenants, domains, logger: new NoopLogger(), ...(bus ? { invalidation: bus } : {}) });
  return { a: make(), b: make() };
}

const host = (h: string) => ({ host: h, path: '/', headers: {} });

describe('cross-instance invalidation', () => {
  it('without a bus, another instance keeps its stale lookup cache until the TTL', async () => {
    const { a, b } = cluster();
    await a.tenants.create({ id: 'bolivar', name: 'Bolívar' });
    expect((await b.tenants.find('bolivar'))?.name).toBe('Bolívar');
    await a.tenants.suspend('bolivar');
    expect((await b.tenants.find('bolivar'))?.status).toBe('active');
  });

  it('tenant updates, suspensions and domain changes reach the other instance at once', async () => {
    const bus = new MemoryInvalidationBus();
    const { a, b } = cluster(bus);
    // b cachea la ausencia antes de que exista.
    expect(await b.tenants.find('bolivar')).toBeUndefined();
    await a.tenants.create({ id: 'bolivar', name: 'Bolívar', domain: 'bolivar.com' });
    await sleep(0);
    expect((await b.tenants.find('bolivar'))?.name).toBe('Bolívar');
    expect(await b.resolve(host('bolivar.com'))).toMatchObject({ kind: 'tenant' });

    await a.tenants.suspend('bolivar');
    await sleep(0);
    expect((await b.tenants.find('bolivar'))?.status).toBe('suspended');
    await a.tenants.activate('bolivar');

    // El tema: la clave del render usa updatedAt, así que basta con invalidar el tenant.
    await b.run('bolivar', () => b.theme().toCss());
    await a.theme.update('bolivar', { primary: '#ff0000' });
    await sleep(0);
    expect(await b.run('bolivar', () => b.theme().toCss())).toContain('#FF0000');

    await a.domains.add('bolivar', 'otro.com');
    expect(await b.resolve(host('otro.com'))).toMatchObject({ kind: 'tenant' });
    await a.domains.remove('otro.com');
    await sleep(0);
    expect(await b.resolve(host('otro.com'))).not.toMatchObject({ kind: 'tenant' });
    await a.close();
    await b.close();
  });

  it('batches the invalidations of one operation into a single message and ignores its own', async () => {
    const sent: InvalidationMessage[] = [];
    const inner = new MemoryInvalidationBus();
    const bus: InvalidationBus = {
      publish: async (m) => {
        sent.push(m);
        await inner.publish(m);
      },
      subscribe: (h) => inner.subscribe(h),
      close: () => inner.close(),
    };
    const { a } = cluster(bus);
    await a.tenants.create({ id: 'tigre', domain: 'tigre.com' });
    await a.close();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.flatMap((m) => m.items)).toContainEqual({ kind: 'tenant', tenantId: 'tigre' });
    expect(sent.flatMap((m) => m.items)).toContainEqual({ kind: 'domain', domain: 'tigre.com' });
    expect(new Set(sent.map((m) => m.origin)).size).toBe(1);
  });

  it('a failing bus never fails the write: the error is logged and tracked', async () => {
    let handler: ((m: InvalidationMessage) => void) | undefined;
    const bus: InvalidationBus = {
      publish: async () => {
        throw new Error('redis caído');
      },
      subscribe: async (h) => void (handler = h),
      ping: async () => {
        throw new Error('redis caído');
      },
      close: async () => undefined,
    };
    const { a } = cluster(bus);
    await a.tenants.create({ id: 'bolivar' });
    await sleep(0);
    await a.close();
    expect(a.observability.errors().map((e) => e.operation)).toContain('cache.invalidation.publish');
    expect((await a.health()).checks['invalidation']?.ok).toBe(false);

    // Un mensaje "all" de otra instancia vacía toda la caché.
    const { b } = cluster(bus);
    await b.tenants.create({ id: 'xx' });
    await b.tenants.find('xx');
    handler!({ origin: 'otra', items: [{ kind: 'all' }] });
    await b.close();
  });

  it('reports a subscription failure', async () => {
    const bus: InvalidationBus = {
      publish: async () => undefined,
      subscribe: async () => {
        throw new Error('sin permisos');
      },
      close: async () => undefined,
    };
    const { a } = cluster(bus);
    await sleep(0);
    expect(a.observability.errors()[0]).toMatchObject({ operation: 'cache.invalidation.subscribe', tenantId: null });
    await a.close();
  });
});
