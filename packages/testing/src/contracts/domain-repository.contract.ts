import {
  DomainAlreadyTakenError,
  DomainName,
  TenantId,
  type DomainRepository,
} from '@tenancy-node/core';
import { beforeEach, describe, expect, it } from 'vitest';

type Factory<T> = () => T | Promise<T>;

/** Suite que todo `DomainRepository` debe pasar. */
export function domainRepositoryContract(name: string, factory: Factory<DomainRepository>): void {
  describe(`DomainRepository contract: ${name}`, () => {
    let repo: DomainRepository;
    const bolivar = TenantId.create('bolivar');
    const tigre = TenantId.create('tigre');
    const now = new Date('2026-01-01T00:00:00.000Z');
    const d = (value: string) => DomainName.create(value);

    beforeEach(async () => {
      repo = await factory();
    });

    it('creates and finds a domain by name', async () => {
      const created = await repo.create({
        domain: d('bolivar.app.com'),
        tenantId: bolivar,
        isPrimary: true,
        now,
      });
      expect(created.id).toBeTypeOf('number');
      const found = await repo.findByName(d('BOLIVAR.app.com'));
      expect(found?.tenantId.value).toBe('bolivar');
      expect(found?.isPrimary).toBe(true);
    });

    it('rejects a domain that already exists', async () => {
      await repo.create({ domain: d('a.com'), tenantId: bolivar, isPrimary: true, now });
      await expect(
        repo.create({ domain: d('A.com'), tenantId: tigre, isPrimary: false, now }),
      ).rejects.toThrow(DomainAlreadyTakenError);
    });

    it('keeps a single primary domain per tenant', async () => {
      await repo.create({ domain: d('a.com'), tenantId: bolivar, isPrimary: true, now });
      await repo.create({ domain: d('b.com'), tenantId: bolivar, isPrimary: false, now });
      await repo.create({ domain: d('c.com'), tenantId: tigre, isPrimary: true, now });
      await repo.setPrimary(bolivar, d('b.com'), now);

      const list = await repo.listByTenant(bolivar);
      expect(list.map((x) => [x.domain.value, x.isPrimary])).toEqual([
        ['b.com', true],
        ['a.com', false],
      ]);
      expect((await repo.findByName(d('c.com')))?.isPrimary).toBe(true);
    });

    it('deletes one domain or all of a tenant', async () => {
      await repo.create({ domain: d('a.com'), tenantId: bolivar, isPrimary: true, now });
      await repo.create({ domain: d('b.com'), tenantId: bolivar, isPrimary: false, now });
      await repo.create({ domain: d('c.com'), tenantId: tigre, isPrimary: true, now });

      await repo.delete(d('a.com'));
      expect(await repo.findByName(d('a.com'))).toBeUndefined();
      await repo.deleteByTenant(bolivar);
      expect(await repo.listByTenant(bolivar)).toEqual([]);
      expect(await repo.findByName(d('c.com'))).toBeDefined();
    });
  });
}
