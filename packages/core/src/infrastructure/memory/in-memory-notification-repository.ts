import type { Notification, NotificationDevice } from '../../domain/index.js';
import type { NotificationRepository, Page } from '../../ports/index.js';

/** Avisos en memoria: tests y apps sin base central (se pierden al reiniciar). */
export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly rows = new Map<string, Notification>();
  /** `notificationId → Set<tenantId\0userId>` */
  private readonly reads = new Map<string, Set<string>>();
  private readonly deviceRows = new Map<string, NotificationDevice>();

  async insert(notification: Notification): Promise<void> {
    this.rows.set(notification.id, structuredClone(notification));
  }

  async findById(id: string): Promise<Notification | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async list(query: { page?: number; perPage?: number } = {}): Promise<Page<Notification>> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const perPage = Math.min(100, Math.max(1, Math.floor(query.perPage ?? 20)));
    const all = [...this.rows.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
    );
    return {
      items: all.slice((page - 1) * perPage, page * perPage).map((n) => structuredClone(n)),
      total: all.length,
      page,
      perPage,
    };
  }

  async active(now: Date): Promise<Notification[]> {
    return [...this.rows.values()]
      .filter(
        (n) =>
          (!n.startsAt || n.startsAt.getTime() <= now.getTime()) &&
          (!n.expiresAt || n.expiresAt.getTime() > now.getTime()),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .map((n) => structuredClone(n));
  }

  async delete(id: string): Promise<boolean> {
    this.reads.delete(id);
    return this.rows.delete(id);
  }

  async markRead(
    entries: readonly { notificationId: string; tenantId: string; userId: string }[],
  ): Promise<void> {
    for (const e of entries) {
      if (!this.rows.has(e.notificationId)) continue;
      let set = this.reads.get(e.notificationId);
      if (!set) this.reads.set(e.notificationId, (set = new Set()));
      set.add(`${e.tenantId}\0${e.userId}`);
    }
  }

  async readIds(tenantId: string, userId: string, ids: readonly string[]): Promise<Set<string>> {
    return new Set(ids.filter((id) => this.reads.get(id)?.has(`${tenantId}\0${userId}`)));
  }

  async readStats(ids: readonly string[]) {
    const stats = new Map<string, { tenants: number; users: number }>();
    for (const id of ids) {
      const set = this.reads.get(id) ?? new Set<string>();
      stats.set(id, {
        tenants: new Set([...set].map((k) => k.split('\0')[0])).size,
        users: set.size,
      });
    }
    return stats;
  }

  async saveDevice(device: NotificationDevice): Promise<void> {
    this.deviceRows.set(device.token, structuredClone(device));
  }

  async deleteDevices(tokens: readonly string[]): Promise<number> {
    let n = 0;
    for (const t of tokens) if (this.deviceRows.delete(t)) n++;
    return n;
  }

  async devices(tenantIds: readonly string[], userId?: string): Promise<NotificationDevice[]> {
    const ids = new Set(tenantIds);
    return [...this.deviceRows.values()]
      .filter((d) => ids.has(d.tenantId) && (userId === undefined || d.userId === userId))
      .map((d) => structuredClone(d));
  }
}
