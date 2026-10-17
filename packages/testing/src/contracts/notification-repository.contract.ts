import {
  createNotification,
  type NewNotification,
  type NotificationRepository,
} from '@tenancy-node/core';
import { beforeEach, describe, expect, it } from 'vitest';

type Factory<T> = () => T | Promise<T>;

/**
 * Suite que todo `NotificationRepository` debe pasar. Los tenants `bolivar` y `tigre` deben
 * existir si la implementación lo exige (la de la base central no tiene FK: no hace falta).
 */
export function notificationRepositoryContract(
  name: string,
  factory: Factory<NotificationRepository>,
): void {
  describe(`NotificationRepository contract: ${name}`, () => {
    let repo: NotificationRepository;
    const t0 = new Date('2026-10-01T00:00:00.000Z');
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    let seq = 0;
    const make = (input: Partial<NewNotification> = {}, createdAt = at(seq)) =>
      createNotification(
        { title: `Aviso ${seq}`, ...input },
        `01JNOTIF${String(++seq).padStart(18, '0')}`,
        createdAt,
      );

    beforeEach(async () => {
      repo = await factory();
    });

    it('stores every field and lists newest first', async () => {
      const full = make(
        {
          title: 'Mantenimiento',
          body: 'El sábado de 2 a 4 ✅',
          level: 'critical',
          audience: { type: 'plans', plans: ['basico', 'pro'] },
          roles: ['ADMIN'],
          link: { url: 'https://estado.tuapp.com', label: 'Estado' },
          startsAt: at(0),
          expiresAt: at(600),
          createdBy: 'ana@tuapp.com',
        },
        at(1),
      );
      const second = make({ audience: { type: 'tenants', tenants: ['bolivar'] } }, at(2));
      await repo.insert(full);
      await repo.insert(second);
      expect(await repo.findById(full.id)).toEqual(full);
      expect(await repo.findById('nope')).toBeUndefined();
      const page = await repo.list({ perPage: 1 });
      expect(page.total).toBe(2);
      expect(page.items.map((n) => n.id)).toEqual([second.id]);
      expect((await repo.list({ page: 2, perPage: 1 })).items.map((n) => n.id)).toEqual([full.id]);
    });

    it('returns only active notifications', async () => {
      const always = make({}, at(0));
      const later = make({ startsAt: at(60) }, at(0));
      const expired = make({ expiresAt: at(10) }, at(0));
      for (const n of [always, later, expired]) await repo.insert(n);
      expect((await repo.active(at(5))).map((n) => n.id).sort()).toEqual(
        [always.id, expired.id].sort(),
      );
      expect((await repo.active(at(61))).map((n) => n.id).sort()).toEqual(
        [always.id, later.id].sort(),
      );
    });

    it('tracks reads per tenant and user, idempotently, and deletes them with the notification', async () => {
      const a = make();
      const b = make();
      await repo.insert(a);
      await repo.insert(b);
      const entry = { notificationId: a.id, tenantId: 'bolivar', userId: 'u1' };
      await repo.markRead([entry, entry, { ...entry, userId: 'u2' }], at(1));
      await repo.markRead([entry, { ...entry, tenantId: 'tigre' }], at(2));
      expect(await repo.readIds('bolivar', 'u1', [a.id, b.id])).toEqual(new Set([a.id]));
      expect(await repo.readIds('bolivar', 'u3', [a.id, b.id])).toEqual(new Set());
      expect(await repo.readIds('bolivar', 'u1', [])).toEqual(new Set());
      const stats = await repo.readStats([a.id, b.id]);
      expect(stats.get(a.id)).toEqual({ tenants: 2, users: 3 });
      expect(stats.get(b.id)).toEqual({ tenants: 0, users: 0 });
      expect(await repo.delete(a.id)).toBe(true);
      expect(await repo.delete(a.id)).toBe(false);
      expect(await repo.readIds('bolivar', 'u1', [a.id])).toEqual(new Set());
    });

    it('saves, updates, lists and deletes devices', async () => {
      const device = {
        token: 'fcm-token-1234567890',
        tenantId: 'bolivar',
        userId: 'u1',
        platform: 'web' as const,
        roles: ['ADMIN'],
        lastSeenAt: at(0),
      };
      await repo.saveDevice(device);
      await repo.saveDevice({ ...device, userId: 'u2', roles: null, lastSeenAt: at(5) });
      await repo.saveDevice({ ...device, token: 'fcm-token-tigre-0001', tenantId: 'tigre' });
      expect(await repo.devices(['bolivar'])).toEqual([
        { ...device, userId: 'u2', roles: null, lastSeenAt: at(5) },
      ]);
      expect(await repo.devices(['bolivar', 'tigre'], 'u1')).toHaveLength(1);
      expect(await repo.devices([])).toEqual([]);
      expect(await repo.deleteDevices(['fcm-token-1234567890', 'nope'])).toBe(1);
      expect(await repo.deleteDevices([])).toBe(0);
      expect((await repo.devices(['bolivar', 'tigre'])).map((d) => d.tenantId)).toEqual(['tigre']);
    });
  });
}
