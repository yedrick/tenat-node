import type {
  DevicePlatform,
  Notification,
  NotificationAudience,
  NotificationDevice,
  NotificationLevel,
  NotificationRepository,
  Page,
} from '@tenancy-node/core';
import type { Selectable } from 'kysely';
import { paginate } from '../dialect.js';
import type { NotificationsTable } from '../schema/central-tables.js';
import { parseJson, toDate, toDateOrNull, type CentralDb } from './central-db.js';

type Row = Selectable<NotificationsTable>;

/** `NotificationRepository` sobre `tenancy_notifications`, `_reads` y `_devices`. */
export class KyselyNotificationRepository implements NotificationRepository {
  constructor(private readonly central: CentralDb) {}

  private get db() {
    return this.central.db;
  }

  async insert(n: Notification): Promise<void> {
    await this.db
      .insertInto('notifications')
      .values({
        id: n.id,
        title: n.title,
        body: n.body,
        level: n.level,
        audience_type: n.audience.type,
        audience_values:
          n.audience.type === 'all'
            ? null
            : JSON.stringify(n.audience.type === 'tenants' ? n.audience.tenants : n.audience.plans),
        roles: n.roles ? JSON.stringify(n.roles) : null,
        link_url: n.link?.url ?? null,
        link_label: n.link?.label ?? null,
        starts_at: n.startsAt,
        expires_at: n.expiresAt,
        created_by: n.createdBy,
        created_at: n.createdAt,
      })
      .execute();
  }

  async findById(id: string): Promise<Notification | undefined> {
    const row = await this.db
      .selectFrom('notifications')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? fromRow(row) : undefined;
  }

  async list(query: { page?: number; perPage?: number } = {}): Promise<Page<Notification>> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const perPage = Math.min(100, Math.max(1, Math.floor(query.perPage ?? 20)));
    const base = this.db.selectFrom('notifications');
    const [count, rows] = await Promise.all([
      base.select((eb) => eb.fn.countAll<number | string>().as('total')).executeTakeFirstOrThrow(),
      base
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .$call((q) => paginate(this.central.kind, q, perPage, (page - 1) * perPage))
        .execute(),
    ]);
    return { items: rows.map(fromRow), total: Number(count.total), page, perPage };
  }

  async active(now: Date): Promise<Notification[]> {
    const rows = await this.db
      .selectFrom('notifications')
      .selectAll()
      .where((eb) => eb.or([eb('starts_at', 'is', null), eb('starts_at', '<=', now)]))
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(fromRow);
  }

  async delete(id: string): Promise<boolean> {
    // Las lecturas se borran primero: SQLite no aplica la FK en cascada sin `PRAGMA foreign_keys`.
    await this.db.deleteFrom('notification_reads').where('notification_id', '=', id).execute();
    const result = await this.db
      .deleteFrom('notifications')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async markRead(
    entries: readonly { notificationId: string; tenantId: string; userId: string }[],
    now: Date,
  ): Promise<void> {
    const unique = new Map(
      entries.map((e) => [`${e.notificationId}\0${e.tenantId}\0${e.userId}`, e]),
    );
    for (const e of unique.values()) {
      try {
        await this.db
          .insertInto('notification_reads')
          .values({
            notification_id: e.notificationId,
            tenant_id: e.tenantId,
            user_id: e.userId,
            read_at: now,
          })
          .execute();
      } catch (error) {
        // Ya estaba leído (o el aviso se borró en el medio): idempotente.
        if (
          !this.central.driver.isUniqueViolation(error) &&
          !(await this.missing(e.notificationId))
        )
          throw error;
      }
    }
  }

  private async missing(id: string): Promise<boolean> {
    return (await this.findById(id)) === undefined;
  }

  async readIds(tenantId: string, userId: string, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db
      .selectFrom('notification_reads')
      .select('notification_id')
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .where('notification_id', 'in', [...ids])
      .execute();
    return new Set(rows.map((r) => r.notification_id));
  }

  async readStats(ids: readonly string[]) {
    const stats = new Map<string, { tenants: number; users: number }>();
    for (const id of ids) stats.set(id, { tenants: 0, users: 0 });
    if (ids.length === 0) return stats;
    const rows = await this.db
      .selectFrom('notification_reads')
      .select((eb) => [
        'notification_id',
        eb.fn.count<number | string>('tenant_id').distinct().as('tenants'),
        eb.fn.countAll<number | string>().as('users'),
      ])
      .where('notification_id', 'in', [...ids])
      .groupBy('notification_id')
      .execute();
    for (const r of rows)
      stats.set(r.notification_id, { tenants: Number(r.tenants), users: Number(r.users) });
    return stats;
  }

  async saveDevice(device: NotificationDevice): Promise<void> {
    const values = {
      tenant_id: device.tenantId,
      user_id: device.userId,
      platform: device.platform,
      roles: device.roles ? JSON.stringify(device.roles) : null,
      last_seen_at: device.lastSeenAt,
    };
    // Un token se mueve de usuario o de tenant (cerró sesión y entró otro): se actualiza.
    const updated = await this.db
      .updateTable('notification_devices')
      .set(values)
      .where('token', '=', device.token)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) > 0) return;
    try {
      await this.db
        .insertInto('notification_devices')
        .values({ token: device.token, ...values, created_at: device.lastSeenAt })
        .execute();
    } catch (error) {
      if (!this.central.driver.isUniqueViolation(error)) throw error;
      await this.db
        .updateTable('notification_devices')
        .set(values)
        .where('token', '=', device.token)
        .execute();
    }
  }

  async deleteDevices(tokens: readonly string[]): Promise<number> {
    if (tokens.length === 0) return 0;
    const result = await this.db
      .deleteFrom('notification_devices')
      .where('token', 'in', [...tokens])
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async devices(tenantIds: readonly string[], userId?: string): Promise<NotificationDevice[]> {
    if (tenantIds.length === 0) return [];
    let query = this.db
      .selectFrom('notification_devices')
      .selectAll()
      .where('tenant_id', 'in', [...tenantIds]);
    if (userId !== undefined) query = query.where('user_id', '=', userId);
    const rows = await query.orderBy('token').execute();
    return rows.map((r) => ({
      token: r.token,
      tenantId: r.tenant_id,
      userId: r.user_id,
      platform: r.platform as DevicePlatform,
      roles: r.roles === null ? null : parseJson<string[]>(r.roles),
      lastSeenAt: toDate(r.last_seen_at),
    }));
  }
}

function fromRow(r: Row): Notification {
  const values = r.audience_values === null ? [] : parseJson<string[]>(r.audience_values);
  const audience: NotificationAudience =
    r.audience_type === 'tenants'
      ? { type: 'tenants', tenants: values }
      : r.audience_type === 'plans'
        ? { type: 'plans', plans: values }
        : { type: 'all' };
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    level: r.level as NotificationLevel,
    audience,
    roles: r.roles === null ? null : parseJson<string[]>(r.roles),
    link: r.link_url ? { url: r.link_url, label: r.link_label ?? 'Ver más' } : null,
    startsAt: toDateOrNull(r.starts_at),
    expiresAt: toDateOrNull(r.expires_at),
    createdBy: r.created_by,
    createdAt: toDate(r.created_at),
  };
}
