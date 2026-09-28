import {
  Tenant,
  TenantAlreadyExistsError,
  type Page,
  type TenantId,
  type TenantListQuery,
  type TenantRepository,
  type TenantSnapshot,
  type TenantStatus,
  type ThemeProps,
} from '@tenancy-node/core';
import { sql, type Selectable } from 'kysely';
import type { TenantsTable } from '../schema/central-tables.js';
import { likeLower, paginate } from '../dialect.js';
import { likeContains, parseJson, toDate, toDateOrNull, type CentralDb } from './central-db.js';

type Row = Selectable<TenantsTable>;

/** `TenantRepository` sobre la tabla `tenancy_tenants`. */
export class KyselyTenantRepository implements TenantRepository {
  constructor(private readonly central: CentralDb) {}

  private get db() {
    return this.central.db;
  }

  async findById(
    id: TenantId,
    options: { withDeleted?: boolean } = {},
  ): Promise<Tenant | undefined> {
    let query = this.db.selectFrom('tenants').selectAll().where('id', '=', id.value);
    if (!options.withDeleted) query = query.where('deleted_at', 'is', null);
    const row = await query.executeTakeFirst();
    return row ? Tenant.restore(fromRow(row)) : undefined;
  }

  async exists(id: TenantId): Promise<boolean> {
    const row = await this.db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', id.value)
      .executeTakeFirst();
    return row !== undefined;
  }

  async list(query: TenantListQuery = {}): Promise<Page<Tenant>> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const perPage = Math.min(1000, Math.max(1, Math.floor(query.perPage ?? 20)));
    const statuses =
      query.status === undefined ? undefined : ([] as TenantStatus[]).concat(query.status);

    let base = this.db.selectFrom('tenants');
    if (!query.withDeleted) base = base.where('deleted_at', 'is', null);
    if (statuses)
      base =
        statuses.length === 0
          ? base.where(sql<boolean>`1 = 0`)
          : base.where('status', 'in', statuses);
    if (query.search) {
            const pattern = likeContains(query.search);
      const kind = this.central.kind;
      base = base.where((eb) => eb.or([likeLower(kind, 'id', pattern), likeLower(kind, 'name', pattern)]));
    }

    const [count, rows] = await Promise.all([
      base.select((eb) => eb.fn.countAll<number | string>().as('total')).executeTakeFirstOrThrow(),
      base
        .selectAll()
        .orderBy('created_at')
        .orderBy('id')
        .$call((q) => paginate(this.central.kind, q, perPage, (page - 1) * perPage))
        .execute(),
    ]);
    return {
      items: rows.map((row) => Tenant.restore(fromRow(row))),
      total: Number(count.total),
      page,
      perPage,
    };
  }

  async insert(tenant: Tenant): Promise<void> {
    try {
      await this.db.insertInto('tenants').values(toRow(tenant.toSnapshot())).execute();
    } catch (error) {
      if (this.central.driver.isUniqueViolation(error))
        throw new TenantAlreadyExistsError(tenant.id.value);
      throw error;
    }
  }

  async save(tenant: Tenant): Promise<void> {
    const { id, created_at: _created, ...changes } = toRow(tenant.toSnapshot());
    await this.db.updateTable('tenants').set(changes).where('id', '=', id).execute();
  }
}

function toRow(s: TenantSnapshot) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    plan: s.plan,
    data: JSON.stringify(s.data),
    theme: s.theme ? JSON.stringify(s.theme) : null,
    database_server_id: s.database?.serverId ?? null,
    database_name: s.database?.name ?? null,
    schema_name: s.database?.schema ?? null,
    database_username: s.database?.username ?? null,
    database_password_encrypted: s.database?.passwordEncrypted ?? null,
    maintenance_message: s.maintenanceMessage,
    provisioned_at: s.provisionedAt,
    suspended_at: s.suspendedAt,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    deleted_at: s.deletedAt,
  };
}

function fromRow(row: Row): TenantSnapshot {
  return {
    id: row.id,
    name: row.name,
    status: row.status as TenantStatus,
    plan: row.plan,
    data: parseJson<Record<string, unknown>>(row.data) ?? {},
    theme: row.theme === null ? null : parseJson<ThemeProps>(row.theme),
    database:
      row.database_server_id && row.database_name
        ? {
            serverId: row.database_server_id,
            name: row.database_name,
            schema: row.schema_name,
            username: row.database_username,
            passwordEncrypted: row.database_password_encrypted,
          }
        : null,
    maintenanceMessage: row.maintenance_message,
    provisionedAt: toDateOrNull(row.provisioned_at),
    suspendedAt: toDateOrNull(row.suspended_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    deletedAt: toDateOrNull(row.deleted_at),
  };
}
