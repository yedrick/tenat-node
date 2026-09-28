import type { CacheStore } from '../../ports/index.js';
import { LruCache } from '../../support/lru-cache.js';
import { tenantCachePrefix } from '../../cache/tenant-cache.js';

export interface MemoryCacheStoreOptions {
  /** Máximo de llaves; las menos usadas se descartan. Por defecto 10 000. */
  maxEntries?: number;
  now?: () => number;
}

/** Caché en memoria del proceso. Los valores se guardan por referencia. */
export class MemoryCacheStore implements CacheStore {
  private readonly cache: LruCache<string, unknown>;

  constructor(options: MemoryCacheStoreOptions = {}) {
    this.cache = new LruCache({
      max: options.maxEntries ?? 10_000,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.cache.get(key) as T | undefined;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (value === undefined) {
      this.cache.delete(key);
      return;
    }
    this.cache.set(key, value, ttlSeconds && ttlSeconds > 0 ? ttlSeconds * 1000 : 0);
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async flushTenant(tenantId: string): Promise<void> {
    const prefix = tenantCachePrefix(tenantId);
    this.cache.deleteWhere((_value, key) => key.startsWith(prefix));
  }
}
