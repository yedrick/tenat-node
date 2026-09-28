import {
  Tenant,
  TenantAlreadyExistsError,
  TenantId,
  Theme,
  type TenantRepository,
} from '@tenancy-node/core';
import { beforeEach, describe, expect, it } from 'vitest';

type Factory<T> = () => T | Promise<T>;

function tenant(id: string, createdAt = '2026-01-01T00:00:00.000Z', name = id): Tenant {
  return Tenant.create({
    id: TenantId.create(id),
    name,
    now: new Date(createdAt),
    data: { seats: 3 },
  });
}

/** Suite que todo `TenantRepository` debe pasar (sustitución de Liskov). */
export function tenantRepositoryContract(name: string, factory: Factory<TenantRepository>): void {
  describe(`TenantRepository contract: ${name}`, () => {
    let repo: TenantRepository;
    beforeEach(async () => {
      repo = await factory();
    });

    it('saves and finds a tenant by id', async () => {
      await repo.insert(tenant('bolivar'));
      const found = await repo.findById(TenantId.create('bolivar'));
      expect(found?.id.value).toBe('bolivar');
      expect(found?.data).toEqual({ seats: 3 });
      expect(found?.status).toBe('provisioning');
    });

    it('rejects inserting an existing id, even concurrently', async () => {
      await repo.insert(tenant('bolivar'));
      await expect(repo.insert(tenant('bolivar'))).rejects.toThrow(TenantAlreadyExistsError);
      const results = await Promise.allSettled([
        repo.insert(tenant('tigre')),
        repo.insert(tenant('tigre')),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(TenantAlreadyExistsError);
    });

    it('persists every field: theme, database, status dates and data', async () => {
      const t = Tenant.create({
        id: TenantId.create('full'),
        name: 'Full Club',
        plan: 'pro',
        now: new Date('2026-01-01T10:00:00.123Z'),
        data: { nested: { list: [1, 'two', true, null] }, emoji: 'ñ ⚽' },
        theme: Theme.create({
          primary: '#E4002B',
          secondary: '#FFD100',
          font: 'Inter',
          custom: { gap: '4px' },
        }),
      });
      await repo.insert(t);
      t.assignDatabase(
        {
          serverId: 'default',
          name: 'tenant_full',
          schema: null,
          username: 'u_full',
          passwordEncrypted: 'enc',
        },
        new Date('2026-01-01T10:00:01.000Z'),
      );
      t.markProvisioned(new Date('2026-01-01T10:00:02.000Z'));
      t.putInMaintenance('Back soon', new Date('2026-01-01T10:00:03.000Z'));
      await repo.save(t);

      const found = (await repo.findById(TenantId.create('full')))!;
      expect(found.toSnapshot()).toEqual(t.toSnapshot());
    });

    it('returns undefined for unknown ids', async () => {
      expect(await repo.findById(TenantId.create('nobody'))).toBeUndefined();
      expect(await repo.exists(TenantId.create('nobody'))).toBe(false);
    });

    it('updates an existing tenant on save', async () => {
      const t = tenant('tigre');
      await repo.insert(t);
      t.markProvisioned(new Date('2026-01-02T00:00:00.000Z'));
      t.update({ plan: 'pro' }, new Date('2026-01-02T00:00:00.000Z'));
      await repo.save(t);
      const found = await repo.findById(TenantId.create('tigre'));
      expect(found?.status).toBe('active');
      expect(found?.plan).toBe('pro');
    });

    it('returns independent instances (no shared mutable state)', async () => {
      await repo.insert(tenant('bolivar'));
      const a = await repo.findById(TenantId.create('bolivar'));
      a!.update({ name: 'Changed' }, new Date());
      const b = await repo.findById(TenantId.create('bolivar'));
      expect(b?.name).toBe('bolivar');
    });

    it('hides soft-deleted tenants but keeps the id taken', async () => {
      const t = tenant('bolivar');
      await repo.insert(t);
      t.markDeleting(new Date());
      t.markDeleted(new Date());
      await repo.save(t);
      expect(await repo.findById(TenantId.create('bolivar'))).toBeUndefined();
      expect(await repo.findById(TenantId.create('bolivar'), { withDeleted: true })).toBeDefined();
      expect(await repo.exists(TenantId.create('bolivar'))).toBe(true);
      expect((await repo.list()).total).toBe(0);
    });

    it('lists with filters, search and pagination ordered by creation', async () => {
      await repo.insert(tenant('c-third', '2026-01-03T00:00:00.000Z', 'Third'));
      await repo.insert(tenant('a-first', '2026-01-01T00:00:00.000Z', 'First Club'));
      const second = tenant('b-second', '2026-01-02T00:00:00.000Z', 'Second Club');
      second.markProvisioned(new Date());
      await repo.insert(second);

      const all = await repo.list({ perPage: 2 });
      expect(all.total).toBe(3);
      expect(all.items.map((t) => t.id.value)).toEqual(['a-first', 'b-second']);
      const page2 = await repo.list({ perPage: 2, page: 2 });
      expect(page2.items.map((t) => t.id.value)).toEqual(['c-third']);

      expect((await repo.list({ status: 'active' })).items.map((t) => t.id.value)).toEqual([
        'b-second',
      ]);
      expect((await repo.list({ search: 'club' })).total).toBe(2);
    });
  });
}
