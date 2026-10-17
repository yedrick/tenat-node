import type {
  PlanOverride,
  PlanSettingsRepository,
  PlatformSettings,
  PlatformSettingsRepository,
} from '@tenancy-node/core';
import { parseJson, toBool, toDate, type CentralDb } from './central-db.js';

type StoredOverride = Omit<
  PlanOverride,
  'planId' | 'archived' | 'createdAt' | 'updatedAt' | 'updatedBy'
>;

/** Cambios de planes del panel en `tenancy_plan_settings` (un JSON por plan). */
export class KyselyPlanSettingsRepository implements PlanSettingsRepository {
  constructor(private readonly central: CentralDb) {}

  async list(): Promise<PlanOverride[]> {
    const rows = await this.central.db
      .selectFrom('plan_settings')
      .selectAll()
      .orderBy('created_at')
      .orderBy('plan_id')
      .execute();
    return rows.map((r) => ({
      ...parseJson<StoredOverride>(r.settings),
      planId: r.plan_id,
      archived: toBool(r.archived),
      createdAt: toDate(r.created_at),
      updatedAt: toDate(r.updated_at),
      updatedBy: r.updated_by,
    }));
  }

  async save(o: PlanOverride): Promise<void> {
    const { planId, archived, createdAt, updatedAt, updatedBy, ...settings } = o;
    const values = {
      settings: JSON.stringify(settings),
      archived,
      updated_by: updatedBy,
      updated_at: updatedAt,
    };
    const updated = await this.central.db
      .updateTable('plan_settings')
      .set(values)
      .where('plan_id', '=', planId)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) > 0) return;
    await this.central.db
      .insertInto('plan_settings')
      .values({ plan_id: planId, ...values, created_at: createdAt })
      .execute();
  }

  async delete(planId: string): Promise<boolean> {
    const result = await this.central.db
      .deleteFrom('plan_settings')
      .where('plan_id', '=', planId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}

const KEY = 'platform';

/** Marca de la plataforma en `tenancy_platform_settings` (clave `platform` → JSON). */
export class KyselyPlatformSettingsRepository implements PlatformSettingsRepository {
  constructor(private readonly central: CentralDb) {}

  async get() {
    const row = await this.central.db
      .selectFrom('platform_settings')
      .selectAll()
      .where('key', '=', KEY)
      .executeTakeFirst();
    return row
      ? {
          settings: parseJson<PlatformSettings>(row.value),
          updatedAt: toDate(row.updated_at),
          updatedBy: row.updated_by,
        }
      : undefined;
  }

  async save(settings: PlatformSettings, meta: { updatedAt: Date; updatedBy: string | null }) {
    const values = {
      value: JSON.stringify(settings),
      updated_by: meta.updatedBy,
      updated_at: meta.updatedAt,
    };
    const updated = await this.central.db
      .updateTable('platform_settings')
      .set(values)
      .where('key', '=', KEY)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) > 0) return;
    await this.central.db
      .insertInto('platform_settings')
      .values({ key: KEY, ...values, created_at: meta.updatedAt })
      .execute();
  }
}
