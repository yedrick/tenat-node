import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { createTestTenancy, cacheStoreContract } from '@tenancy-node/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RedisCacheStore } from '@tenancy-node/cache-redis';
import { redis, redisInvalidation } from '@tenancy-node/cache-redis';
import {
  createTenancy,
  InMemoryDomainRepository,
  InMemoryTenantRepository,
  NoopLogger,
} from '@tenancy-node/core';

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('Redis/Valkey cache', () => {
  let container: StartedTestContainer;
  let url = '';
  let db = 0;
  const stores: RedisCacheStore[] = [];
  // Cada test usa una base lógica distinta de Valkey para no mezclarse.
  const make = () => {
    const store = redis({ url: `${url}/${db++ % 16}` });
    stores.push(store);
    return store;
  };

  beforeAll(async () => {
    container = await new GenericContainer('valkey/valkey:8-alpine').withExposedPorts(6379).start();
    url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  }, 180_000);
  afterAll(async () => {
    for (const s of stores) await s.close();
    await container?.stop();
  });

  cacheStoreContract('RedisCacheStore (Valkey 8)', async () => {
    const store = make();
    await store.client.flushdb();
    return store;
  });

  it('expires keys, flushes thousands of tenant keys with SCAN and pings', async () => {
    const store = make();
    await store.client.flushdb();
    await store.set('tenant:bolivar:tmp', 1, 1);
    expect(await store.client.ttl('tenancy:tenant:bolivar:tmp')).toBeGreaterThan(0);
    const pipeline = store.client.pipeline();
    for (let i = 0; i < 3000; i++) pipeline.set(`tenancy:tenant:bolivar:k${i}`, '1');
    pipeline.set('tenancy:tenant:bolivar2:k', '1');
    await pipeline.exec();
    await store.flushTenant('bolivar');
    expect(await store.client.keys('tenancy:tenant:bolivar:*')).toEqual([]);
    expect(await store.get('tenant:bolivar2:k')).toBe(1);
    await store.set('x', undefined);
    await store.ping();
  });

  it('isolates tenants through tenancy.cache()', async () => {
    const store = make();
    const { tenancy, seed } = createTestTenancy({ cache: store });
    await seed(['bolivar', 'tigre']);
    await tenancy.run('bolivar', () => tenancy.cache().set('carrito', { items: 2 }));
    expect(await tenancy.run('tigre', () => tenancy.cache().get('carrito'))).toBeUndefined();
    expect(await tenancy.run('bolivar', () => tenancy.cache().get('carrito'))).toEqual({
      items: 2,
    });
    expect((await tenancy.health()).checks.cache?.ok).toBe(true);
  });

  it('invalidates the lookup cache of other instances through pub/sub', async () => {
    // Dos réplicas con repositorios compartidos, cada una con su propia conexión a Redis.
    const tenants = new InMemoryTenantRepository();
    const domains = new InMemoryDomainRepository();
    const errors: unknown[] = [];
    const make = () =>
      createTenancy({
        tenants,
        domains,
        logger: new NoopLogger(),
        invalidation: redisInvalidation({ url, channel: 'app1:invalidation', onError: (e) => errors.push(e) }),
      });
    const a = make();
    const b = make();
    await new Promise((r) => setTimeout(r, 200)); // las suscripciones se confirman
    expect(await b.tenants.find('bolivar')).toBeUndefined();
    await a.tenants.create({ id: 'bolivar', domain: 'bolivar.com' });
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 5000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await until(async () => (await b.tenants.find('bolivar')) !== undefined);
    await a.tenants.suspend('bolivar');
    await until(async () => (await b.tenants.find('bolivar'))?.status === 'suspended');

    // Un mensaje ajeno en el canal no rompe nada: se reporta.
    const raw = redis({ url });
    stores.push(raw);
    await raw.client.publish('app1:invalidation', 'no es json');
    await until(async () => errors.length > 0);
    expect((await a.health()).checks['invalidation']?.ok).toBe(true);
    await a.close();
    await b.close();
  });
});

