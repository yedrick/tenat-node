import {
  DomainAlreadyTakenError,
  DomainName,
  TenantId,
  type Domain,
  type DomainRepository,
  type NewDomain,
} from '@tenancy-node/core';
import type { Selectable } from 'kysely';
import { insertReturningId } from '../dialect.js';
import type { DomainsTable } from '../schema/central-tables.js';
import { toBool, toDate, toDateOrNull, type CentralDb } from './central-db.js';

/** `DomainRepository` sobre la tabla `tenancy_domains`. */
export class KyselyDomainRepository implements DomainRepository {
  constructor(private readonly central: CentralDb) {}

  private get db() {
    return this.central.db;
  }

  async findByName(domain: DomainName): Promise<Domain | undefined> {
    const row = await this.db
      .selectFrom('domains')
      .selectAll()
      .where('domain', '=', domain.value)
      .executeTakeFirst();
    return row ? fromRow(row) : undefined;
  }

  async listByTenant(tenantId: TenantId): Promise<Domain[]> {
    const rows = await this.db
      .selectFrom('domains')
      .selectAll()
      .where('tenant_id', '=', tenantId.value)
      .orderBy('is_primary', 'desc')
      .orderBy('id')
      .execute();
    return rows.map(fromRow);
  }

  async create(input: NewDomain): Promise<Domain> {
    const values = {
      tenant_id: input.tenantId.value,
      domain: input.domain.value,
      is_primary: false,
      created_at: input.now,
      updated_at: input.now,
    };
    try {
      await insertReturningId(this.central.kind, this.db.insertInto('domains').values(values));
    } catch (error) {
      if (this.central.driver.isUniqueViolation(error))
        throw new DomainAlreadyTakenError(input.domain.value);
      throw error;
    }
    if (input.isPrimary) await this.setPrimary(input.tenantId, input.domain, input.now);
    return (await this.findByName(input.domain))!;
  }

  async setPrimary(tenantId: TenantId, domain: DomainName, now: Date): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const target = await trx
        .selectFrom('domains')
        .select('id')
        .where('tenant_id', '=', tenantId.value)
        .where('domain', '=', domain.value)
        .executeTakeFirst();
      if (!target) return;
      await trx
        .updateTable('domains')
        .set({ is_primary: false, updated_at: now })
        .where('tenant_id', '=', tenantId.value)
        .where('is_primary', '=', true)
        .execute();
      await trx
        .updateTable('domains')
        .set({ is_primary: true, updated_at: now })
        .where('id', '=', target.id)
        .execute();
    });
  }

  async delete(domain: DomainName): Promise<void> {
    await this.db.deleteFrom('domains').where('domain', '=', domain.value).execute();
  }

  async deleteByTenant(tenantId: TenantId): Promise<void> {
    await this.db.deleteFrom('domains').where('tenant_id', '=', tenantId.value).execute();
  }
}

function fromRow(row: Selectable<DomainsTable>): Domain {
  return {
    id: Number(row.id),
    domain: DomainName.create(row.domain),
    tenantId: TenantId.create(row.tenant_id),
    isPrimary: toBool(row.is_primary),
    verifiedAt: toDateOrNull(row.verified_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}
