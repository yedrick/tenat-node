import { tenantCachePrefix, type CacheStore } from '@tenancy-node/core';
import { beforeEach, describe, expect, it } from 'vitest';

type Factory<T> = () => T | Promise<T>;

/** Suite que todo `CacheStore` debe pasar. */
export function cacheStoreContract(name: string, factory: Factory<CacheStore>): void {
  describe(`CacheStore contract: ${name}`, () => {
    let store: CacheStore;
    beforeEach(async () => {
      store = await factory();
    });

    it('stores, reads and deletes values', async () => {
      await store.set('k', { a: 1 });
      expect(await store.get('k')).toEqual({ a: 1 });
      await store.delete('k');
      expect(await store.get('k')).toBeUndefined();
    });

    it('returns undefined for missing keys', async () => {
      expect(await store.get('missing')).toBeUndefined();
    });

    it('flushes only the keys of one tenant', async () => {
      await store.set(`${tenantCachePrefix('bolivar')}a`, 1);
      await store.set(`${tenantCachePrefix('bolivar')}b`, 2);
      await store.set(`${tenantCachePrefix('tigre')}a`, 3);
      await store.set('central:a', 4);
      await store.flushTenant('bolivar');
      expect(await store.get(`${tenantCachePrefix('bolivar')}a`)).toBeUndefined();
      expect(await store.get(`${tenantCachePrefix('bolivar')}b`)).toBeUndefined();
      expect(await store.get(`${tenantCachePrefix('tigre')}a`)).toBe(3);
      expect(await store.get('central:a')).toBe(4);
    });
  });
}
