import { createTestTenancy } from '@tenancy-node/testing';
import { describe, expect, it } from 'vitest';

const TENANTS = 50;
const REQUESTS = 5_000;

const randomDelay = () =>
  new Promise<void>((resolve) => {
    const r = Math.random();
    if (r < 0.33) setTimeout(resolve, Math.floor(Math.random() * 3));
    else if (r < 0.66) setImmediate(resolve);
    else queueMicrotask(resolve);
  });

/**
 * Test crítico: miles de "peticiones" concurrentes mezcladas entre tenants.
 * En ningún punto un tenant puede ver el contexto, la caché o los eventos de otro.
 */
describe('concurrent isolation', () => {
  it(`keeps ${REQUESTS} interleaved requests across ${TENANTS} tenants isolated`, async () => {
    const { tenancy, seed } = createTestTenancy();
    const ids = Array.from({ length: TENANTS }, (_, i) => `tenant-${i}`);
    await seed(ids);

    const leaks: string[] = [];
    const eventTenants = new Map<string, string | null>();
    tenancy.events.on('check.*', (e) => {
      eventTenants.set((e.data as { request: string }).request, e.tenantId);
    });

    const requests = Array.from({ length: REQUESTS }, async (_, n) => {
      const id = ids[Math.floor(Math.random() * TENANTS)]!;
      const request = `req-${n}`;
      await tenancy.run(id, async () => {
        for (let step = 0; step < 4; step++) {
          await randomDelay();
          if (tenancy.currentId() !== id)
            leaks.push(`${request}: step ${step} saw ${tenancy.currentId()}`);
        }
        await tenancy.cache().set('owner', id);
        await randomDelay();
        const owner = await tenancy.cache().get('owner');
        if (owner !== id) leaks.push(`${request}: cache returned ${String(owner)}`);
        await tenancy.events.publish('check.request', { request, expected: id });
        await randomDelay();
        if (tenancy.currentId() !== id)
          leaks.push(`${request}: after publish saw ${tenancy.currentId()}`);
      });
      if (tenancy.currentId() !== undefined) leaks.push(`${request}: context survived run()`);
      return { request, id };
    });

    const results = await Promise.all(requests);
    await tenancy.events.flush();

    expect(leaks).toEqual([]);
    for (const { request, id } of results) expect(eventTenants.get(request)).toBe(id);
    expect(tenancy.currentId()).toBeUndefined();
  });

  it('keeps nested and parallel run() calls isolated', async () => {
    const { tenancy, seed } = createTestTenancy();
    await seed(['aa', 'bb', 'cc']);
    const observed = await tenancy.run('aa', async () => {
      const inner = await Promise.all([
        tenancy.run('bb', async () => {
          await randomDelay();
          return tenancy.currentId();
        }),
        tenancy.run('cc', async () => {
          await randomDelay();
          return tenancy.currentId();
        }),
        tenancy.central(async () => {
          await randomDelay();
          return tenancy.currentId() ?? 'central';
        }),
      ]);
      await randomDelay();
      return [...inner, tenancy.currentId()];
    });
    expect(observed).toEqual(['bb', 'cc', 'central', 'aa']);
  });
});
