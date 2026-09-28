import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { cacheStoreContract, createTestTenancy } from '@tenancy-node/testing';
import { memcached, type MemcachedCacheStore } from '@tenancy-node/cache-memcached';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('Memcached cache', () => {
  let container: StartedTestContainer;
  let servers = '';
  let n = 0;
  const stores: MemcachedCacheStore[] = [];
  // Cada test con su propio prefijo: Memcached no tiene bases lógicas.
  const make = (options: { versionCacheMs?: number; keyPrefix?: string } = {}) => {
    const store = memcached({ servers, keyPrefix: `t${n++}:`, ...options });
    stores.push(store);
    return store;
  };

  beforeAll(async () => {
    container = await new GenericContainer('memcached:1.6-alpine').withExposedPorts(11211).start();
    servers = `${container.getHost()}:${container.getMappedPort(11211)}`;
  }, 180_000);
  afterAll(async () => {
    for (const s of stores) await s.close();
    await container?.stop();
  });

  cacheStoreContract('MemcachedCacheStore (1.6)', async () => make());

  it('expires keys, hashes long or unsafe keys and pings', async () => {
    const store = make();
    await store.set('tenant:bolivar:tmp', 1, 1);
    expect(await store.get('tenant:bolivar:tmp')).toBe(1);
    const long = `tenant:bolivar:${'x'.repeat(400)}`;
    await store.set(long, { big: true });
    await store.set('tenant:bolivar:con espacios\n', 'ok');
    expect(await store.get(long)).toEqual({ big: true });
    expect(await store.get('tenant:bolivar:con espacios\n')).toBe('ok');
    await store.flushTenant('bolivar');
    expect(await store.get(long)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 2100));
    await store.ping();
  });

  it('a flush in one instance is seen by another after the version cache', async () => {
    const a = make({ versionCacheMs: 200 });
    const b = make({ versionCacheMs: 200, keyPrefix: (a as unknown as { prefix: string }).prefix });
    await a.set('tenant:tigre:x', 'v1');
    expect(await b.get('tenant:tigre:x')).toBe('v1');
    await a.flushTenant('tigre');
    expect(await a.get('tenant:tigre:x')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 250));
    expect(await b.get('tenant:tigre:x')).toBeUndefined();
  });

  it('works as the cache of a tenancy with health', async () => {
    const { tenancy, seed } = createTestTenancy({ cache: make() });
    await seed(['bolivar', 'tigre']);
    await tenancy.run('bolivar', () => tenancy.cache().set('color', 'rojo'));
    await tenancy.run('tigre', () => tenancy.cache().set('color', 'azul'));
    expect(await tenancy.run('bolivar', () => tenancy.cache().get('color'))).toBe('rojo');
    await tenancy.run('bolivar', () => tenancy.cache().flush());
    expect(await tenancy.run('bolivar', () => tenancy.cache().get('color'))).toBeUndefined();
    expect(await tenancy.run('tigre', () => tenancy.cache().get('color'))).toBe('azul');
    expect((await tenancy.health()).checks['cache']?.ok).toBe(true);
    await tenancy.close();
  });

  it('reports a clear error when the server is down', async () => {
    const store = memcached({ servers: '127.0.0.1:1' });
    await expect(store.ping()).rejects.toThrow();
    await store.close();
  });
});
