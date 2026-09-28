import {
  Tenant,
  type Domain,
  type DomainName,
  type TenantId,
  type TenantSnapshot,
} from '../domain/index.js';
import type {
  DomainRepository,
  Invalidation,
  NewDomain,
  Page,
  TenantListQuery,
  TenantRepository,
} from '../ports/index.js';
import { LruCache } from '../support/lru-cache.js';

export interface LookupCacheOptions {
  /** Entradas máximas. Por defecto 10 000. */
  max?: number;
  /** Vida de cada entrada en ms. Por defecto 60 000. */
  ttlMs?: number;
  now?: () => number;
}

/** Recibe cada invalidación local, para reenviarla a las demás instancias. */
export type InvalidationListener = (item: Invalidation) => void;

function lru<V>(options: LookupCacheOptions): LruCache<string, V> {
  return new LruCache<string, V>({
    max: options.max ?? 10_000,
    ttlMs: options.ttlMs ?? 60_000,
    ...(options.now ? { now: options.now } : {}),
  });
}

/**
 * Decorator: agrega caché LRU + TTL a `findById` sin tocar el repositorio real.
 * Guarda snapshots, así cada lectura devuelve una instancia nueva que se puede modificar.
 * Las ausencias también se cachean para no consultar la base con ids inexistentes.
 */
export class CachedTenantRepository implements TenantRepository {
  private readonly cache: LruCache<string, TenantSnapshot | null>;

  constructor(
    private readonly inner: TenantRepository,
    options: LookupCacheOptions = {},
    private readonly onInvalidate?: InvalidationListener,
  ) {
    this.cache = lru(options);
  }

  private changed(id: string): void {
    this.cache.delete(id);
    this.onInvalidate?.({ kind: 'tenant', tenantId: id });
  }

  async findById(
    id: TenantId,
    options: { withDeleted?: boolean } = {},
  ): Promise<Tenant | undefined> {
    if (options.withDeleted) return this.inner.findById(id, options);
    const cached = this.cache.get(id.value);
    if (cached !== undefined) return cached === null ? undefined : Tenant.restore(cached);
    const tenant = await this.inner.findById(id);
    this.cache.set(id.value, tenant ? tenant.toSnapshot() : null);
    return tenant;
  }

  exists(id: TenantId): Promise<boolean> {
    return this.inner.exists(id);
  }

  list(query?: TenantListQuery): Promise<Page<Tenant>> {
    return this.inner.list(query);
  }

  async insert(tenant: Tenant): Promise<void> {
    await this.inner.insert(tenant);
    // Otras instancias pueden haber cacheado la ausencia de este id.
    this.changed(tenant.id.value);
  }

  async save(tenant: Tenant): Promise<void> {
    this.cache.delete(tenant.id.value);
    await this.inner.save(tenant);
    this.changed(tenant.id.value);
  }

  invalidate(id: string): void {
    this.cache.delete(id);
  }

  /** Como `invalidate`, pero también avisa a las demás instancias. */
  evict(id: string): void {
    this.changed(id);
  }

  clear(): void {
    this.cache.clear();
  }
}

/** Decorator con caché para la resolución dominio → tenant (camino crítico de cada petición). */
export class CachedDomainRepository implements DomainRepository {
  private readonly cache: LruCache<string, Domain | null>;

  constructor(
    private readonly inner: DomainRepository,
    options: LookupCacheOptions = {},
    private readonly onInvalidate?: InvalidationListener,
  ) {
    this.cache = lru(options);
  }

  private changedDomain(domain: string): void {
    this.cache.delete(domain);
    this.onInvalidate?.({ kind: 'domain', domain });
  }

  private changedTenant(tenantId: string): void {
    this.invalidateTenant(tenantId);
    this.onInvalidate?.({ kind: 'domains-of', tenantId });
  }

  async findByName(domain: DomainName): Promise<Domain | undefined> {
    const cached = this.cache.get(domain.value);
    if (cached !== undefined) return cached ?? undefined;
    const found = await this.inner.findByName(domain);
    this.cache.set(domain.value, found ?? null);
    return found;
  }

  listByTenant(tenantId: TenantId): Promise<Domain[]> {
    return this.inner.listByTenant(tenantId);
  }

  async create(input: NewDomain): Promise<Domain> {
    const created = await this.inner.create(input);
    this.changedDomain(input.domain.value);
    if (input.isPrimary) this.changedTenant(input.tenantId.value);
    return created;
  }

  async setPrimary(tenantId: TenantId, domain: DomainName, now: Date): Promise<void> {
    await this.inner.setPrimary(tenantId, domain, now);
    this.changedTenant(tenantId.value);
    this.changedDomain(domain.value);
  }

  async delete(domain: DomainName): Promise<void> {
    await this.inner.delete(domain);
    this.changedDomain(domain.value);
  }

  async deleteByTenant(tenantId: TenantId): Promise<void> {
    await this.inner.deleteByTenant(tenantId);
    this.changedTenant(tenantId.value);
  }

  invalidate(domain: string): void {
    this.cache.delete(domain);
  }

  invalidateTenant(tenantId: string): void {
    this.cache.deleteWhere((value) => value !== null && value.tenantId.value === tenantId);
  }

  clear(): void {
    this.cache.clear();
  }
}
