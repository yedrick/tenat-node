import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import type { DatabaseServersTable } from '../schema/central-tables.js';
import { toBool, type CentralDb } from './central-db.js';

export interface DatabaseServer {
  id: string;
  driver: string;
  host: string;
  port: number;
  /** `null` = usar el usuario administrador de la configuración. */
  adminUsername: string | null;
  adminPasswordEncrypted: string | null;
  /** `null` = sin límite. */
  maxTenants: number | null;
  tenantCount: number;
  weight: number;
  isActive: boolean;
}

/** Tabla `tenancy_database_servers`. */
export class DatabaseServerRepository {
  constructor(private readonly central: CentralDb) {}

  private get db() {
    return this.central.db;
  }

  async list(): Promise<DatabaseServer[]> {
    const rows = await this.db.selectFrom('database_servers').selectAll().orderBy('id').execute();
    return rows.map(fromRow);
  }

  async find(id: string): Promise<DatabaseServer | undefined> {
    const row = await this.db
      .selectFrom('database_servers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? fromRow(row) : undefined;
  }

  /** Inserta o actualiza los datos de conexión (no toca `tenant_count`). */
  async upsert(server: Omit<DatabaseServer, 'tenantCount'>, now: Date): Promise<void> {
    const values = {
      driver: server.driver,
      host: server.host,
      port: server.port,
      admin_username: server.adminUsername,
      admin_password_encrypted: server.adminPasswordEncrypted,
      max_tenants: server.maxTenants,
      weight: server.weight,
      is_active: server.isActive,
      updated_at: now,
    };
    // Insertar y, si ya existe, actualizar: atómico aunque varias instancias corran install() a la vez.
    try {
      await this.db
        .insertInto('database_servers')
        .values({ id: server.id, ...values, created_at: now })
        .execute();
    } catch (error) {
      if (!this.central.driver.isUniqueViolation(error)) throw error;
      await this.db
        .updateTable('database_servers')
        .set(values)
        .where('id', '=', server.id)
        .execute();
    }
  }

  /** Reserva un lugar para un tenant nuevo respetando `max_tenants` (atómico). */
  async reserveSlot(id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('database_servers')
      .set({ tenant_count: sql`tenant_count + 1` })
      .where('id', '=', id)
      .where('is_active', '=', true)
      .where((eb) =>
        eb.or([eb('max_tenants', 'is', null), eb('tenant_count', '<', eb.ref('max_tenants'))]),
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async releaseSlot(id: string): Promise<void> {
    await this.db
      .updateTable('database_servers')
      .set({ tenant_count: sql`tenant_count - 1` })
      .where('id', '=', id)
      .where('tenant_count', '>', 0)
      .execute();
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('database_servers').where('id', '=', id).execute();
  }
}

function fromRow(row: Selectable<DatabaseServersTable>): DatabaseServer {
  return {
    id: row.id,
    driver: row.driver,
    host: row.host,
    port: Number(row.port),
    adminUsername: row.admin_username,
    adminPasswordEncrypted: row.admin_password_encrypted,
    maxTenants: row.max_tenants === null ? null : Number(row.max_tenants),
    tenantCount: Number(row.tenant_count),
    weight: Number(row.weight),
    isActive: toBool(row.is_active),
  };
}
