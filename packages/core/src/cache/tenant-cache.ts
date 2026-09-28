import { TenantNotIdentifiedError, type Tenant } from '../domain/index.js';
import type { Bootstrapper, CacheStore } from '../ports/index.js';

export function tenantCachePrefix(tenantId: string): string {
  return `tenant:${tenantId}:`;
}

export const CENTRAL_CACHE_PREFIX = 'central:';

/** Caché aislada: todas las llaves llevan el prefijo del tenant (o `central:`). */
export class TenantCache {
  constructor(
    private readonly store: CacheStore,
    readonly tenantId: string | null,
  ) {}

  get prefix(): string {
    return this.tenantId === null ? CENTRAL_CACHE_PREFIX : tenantCachePrefix(this.tenantId);
  }

  get<T = unknown>(key: string): Promise<T | undefined> {
    return this.store.get<T>(this.prefix + key);
  }

  set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    return this.store.set(this.prefix + key, value, ttlSeconds);
  }

  delete(key: string): Promise<void> {
    return this.store.delete(this.prefix + key);
  }

  /** Devuelve el valor guardado o lo calcula con `factory` y lo guarda `ttlSeconds`. */
  async remember<T>(key: string, ttlSeconds: number, factory: () => T | Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await factory();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  /** Vacía toda la caché del tenant. */
  async flush(): Promise<void> {
    if (this.tenantId === null)
      throw new TenantNotIdentifiedError('Cannot flush the cache of the central context');
    await this.store.flushTenant(this.tenantId);
  }
}

export const CACHE_RESOURCE = 'cache';

/** Entrega una `TenantCache` con el prefijo del tenant del contexto. */
export class CacheBootstrapper implements Bootstrapper<TenantCache> {
  readonly name = CACHE_RESOURCE;

  constructor(private readonly store: CacheStore) {}

  bootstrap(tenant: Tenant | null): TenantCache {
    return new TenantCache(this.store, tenant ? tenant.id.value : null);
  }
}
