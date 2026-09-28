import {
  Tenant,
  TenantAlreadyExistsError,
  type TenantId,
  type TenantSnapshot,
} from '../../domain/index.js';
import type { Page, TenantListQuery, TenantRepository } from '../../ports/index.js';

/** Repositorio en memoria. Útil para tests, prototipos y apps sin base central. */
export class InMemoryTenantRepository implements TenantRepository {
  private readonly rows = new Map<string, TenantSnapshot>();

  async findById(
    id: TenantId,
    options: { withDeleted?: boolean } = {},
  ): Promise<Tenant | undefined> {
    const row = this.rows.get(id.value);
    if (!row || (row.deletedAt !== null && !options.withDeleted)) return undefined;
    return Tenant.restore(row);
  }

  async exists(id: TenantId): Promise<boolean> {
    return this.rows.has(id.value);
  }

  async list(query: TenantListQuery = {}): Promise<Page<Tenant>> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const perPage = Math.min(1000, Math.max(1, Math.floor(query.perPage ?? 20)));
    const statuses = query.status === undefined ? undefined : ([] as string[]).concat(query.status);
    const search = query.search?.toLowerCase();

    const filtered = [...this.rows.values()]
      .filter((row) => query.withDeleted || row.deletedAt === null)
      .filter((row) => !statuses || statuses.includes(row.status))
      .filter(
        (row) => !search || row.id.includes(search) || row.name.toLowerCase().includes(search),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

    return {
      items: filtered.slice((page - 1) * perPage, page * perPage).map((row) => Tenant.restore(row)),
      total: filtered.length,
      page,
      perPage,
    };
  }

  async insert(tenant: Tenant): Promise<void> {
    if (this.rows.has(tenant.id.value)) throw new TenantAlreadyExistsError(tenant.id.value);
    this.rows.set(tenant.id.value, tenant.toSnapshot());
  }

  async save(tenant: Tenant): Promise<void> {
    this.rows.set(tenant.id.value, tenant.toSnapshot());
  }
}
