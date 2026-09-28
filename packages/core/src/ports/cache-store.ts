/**
 * Almacén de caché crudo (Redis, Memcached, memoria...). No conoce tenants:
 * el aislamiento lo hace el `CacheBootstrapper` con el prefijo `tenant:{id}:`.
 */
export interface CacheStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Borra todas las llaves del tenant (las que empiezan con `tenant:{id}:`). */
  flushTenant(tenantId: string): Promise<void>;
  ping?(): Promise<void>;
  close?(): Promise<void>;
}
