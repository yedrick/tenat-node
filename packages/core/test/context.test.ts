import { createTestTenancy } from '@tenancy-node/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  TenantNotFoundError,
  TenantNotIdentifiedError,
  type Bootstrapper,
  type Tenant,
} from '../src/index.js';

describe('context', () => {
  it('knows the current tenant inside run() and nothing outside', async () => {
    const { tenancy, seed } = createTestTenancy();
    await seed(['bolivar', 'tigre']);

    expect(tenancy.current()).toBeUndefined();
    expect(tenancy.isCentral()).toBe(true);
    expect(() => tenancy.currentOrFail()).toThrow(TenantNotIdentifiedError);

    await tenancy.run('bolivar', async () => {
      expect(tenancy.currentId()).toBe('bolivar');
      expect(tenancy.isCentral()).toBe(false);
      await tenancy.run('tigre', async () => {
        await Promise.resolve();
        expect(tenancy.currentOrFail().id.value).toBe('tigre');
      });
      expect(tenancy.currentId()).toBe('bolivar');
      await tenancy.central(() => expect(tenancy.isCentral()).toBe(true));
      expect(tenancy.currentId()).toBe('bolivar');
    });
    expect(tenancy.currentId()).toBeUndefined();
  });

  it('accepts tenants and ids coming from another copy of the package', async () => {
    const { tenancy, seed } = createTestTenancy();
    const [bolivar] = await seed(['bolivar']);
    // Simula un Tenant y un TenantId creados por otra copia del módulo (instanceof da falso)
    const foreignTenant = Object.assign(Object.create(null), {
      id: { value: 'bolivar' },
      toSnapshot: () => bolivar!.toSnapshot(),
      database: null,
      theme: null,
      updatedAt: bolivar!.updatedAt,
    });
    expect(await tenancy.run(foreignTenant, () => tenancy.currentId())).toBe('bolivar');
    expect((await tenancy.tenants.findOrFail({ value: 'bolivar' } as never)).id.value).toBe(
      'bolivar',
    );
    await expect(tenancy.tenants.findOrFail({ value: 42 } as never)).rejects.toThrow(
      'Tenant "42" not found',
    );
  });

  it('accepts a Tenant instance and fails on unknown ids', async () => {
    const { tenancy, seed } = createTestTenancy();
    const [bolivar] = await seed(['bolivar']);
    expect(await tenancy.run(bolivar!, () => tenancy.currentId())).toBe('bolivar');
    await expect(tenancy.run('ghost', () => 1)).rejects.toThrow(TenantNotFoundError);
  });

  it('runForEach walks every active tenant with limited concurrency', async () => {
    const { tenancy, seed } = createTestTenancy();
    const ids = Array.from({ length: 230 }, (_, i) => `t${String(i).padStart(3, '0')}`);
    await seed(ids);
    await tenancy.tenants.suspend('t000');

    let running = 0;
    let peak = 0;
    const seen: string[] = [];
    const result = await tenancy.runForEach(
      async (tenant) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 1));
        expect(tenancy.currentId()).toBe(tenant.id.value);
        seen.push(tenant.id.value);
        running--;
        if (tenant.id.value === 't007') throw new Error('boom');
      },
      { concurrency: 7 },
    );
    expect(peak).toBeLessThanOrEqual(7);
    expect(peak).toBeGreaterThan(1);
    expect(seen).toHaveLength(229);
    expect(result.succeeded).toHaveLength(228);
    expect(result.failed.map((f) => f.tenantId)).toEqual(['t007']);

    const all = await tenancy.runForEach(() => undefined, { status: ['active', 'suspended'] });
    expect(all.succeeded).toHaveLength(230);
    await expect(
      tenancy.runForEach(
        () => {
          throw new Error('stop');
        },
        { stopOnError: true, concurrency: 1 },
      ),
    ).rejects.toThrow('stop');
  });

  it('creates bootstrapper resources lazily per context and reverts them', async () => {
    const revert = vi.fn();
    const created: (string | null)[] = [];
    const db: Bootstrapper<{ tenant: string | null }> = {
      name: 'db',
      bootstrap(tenant: Tenant | null) {
        created.push(tenant?.id.value ?? null);
        return { tenant: tenant?.id.value ?? null };
      },
      revert,
    };
    const failing: Bootstrapper = {
      name: 'failing',
      bootstrap: () => ({}),
      revert: () => {
        throw new Error('revert failed');
      },
    };
    const { tenancy, seed, logger } = createTestTenancy({ bootstrappers: [db, failing] });
    await seed(['bolivar']);

    await tenancy.run('bolivar', () => {
      expect(tenancy.resource<{ tenant: string }>('db').tenant).toBe('bolivar');
      expect(tenancy.resource('db')).toBe(tenancy.resource('db'));
      tenancy.resource('failing');
    });
    await tenancy.run('bolivar', () => undefined);
    expect(created).toEqual(['bolivar']);
    expect(revert).toHaveBeenCalledOnce();
    expect(logger.find((e) => e.message === 'Bootstrapper revert failed')).toHaveLength(1);

    expect(tenancy.resource<{ tenant: null }>('db').tenant).toBeNull();
    await tenancy.close();
    expect(revert).toHaveBeenCalledTimes(2);
    expect(() => tenancy.resource('nope')).toThrow(/No bootstrapper/);
    expect(() => createTestTenancy({ bootstrappers: [db, db] })).toThrow(/Duplicate bootstrapper/);
  });

  it('isolates the cache per tenant', async () => {
    const { tenancy, seed } = createTestTenancy();
    await seed(['bolivar', 'tigre']);
    await tenancy.run('bolivar', () => tenancy.cache().set('productos', ['a']));
    await tenancy.run('tigre', () => tenancy.cache().set('productos', ['b']));
    await tenancy.cache().set('productos', ['central']);

    expect(await tenancy.run('bolivar', () => tenancy.cache().get('productos'))).toEqual(['a']);
    expect(await tenancy.cache().get('productos')).toEqual(['central']);

    const factory = vi.fn(() => 42);
    await tenancy.run('tigre', async () => {
      expect(await tenancy.cache().remember('n', 60, factory)).toBe(42);
      expect(await tenancy.cache().remember('n', 60, factory)).toBe(42);
      await tenancy.cache().flush();
      expect(await tenancy.cache().get('productos')).toBeUndefined();
      await tenancy.cache().delete('n');
    });
    expect(factory).toHaveBeenCalledOnce();
    expect(await tenancy.run('bolivar', () => tenancy.cache().get('productos'))).toEqual(['a']);
    await expect(tenancy.cache().flush()).rejects.toThrow(TenantNotIdentifiedError);
  });

  it('scopes can be entered many times and closed once', async () => {
    const { tenancy, seed } = createTestTenancy();
    const [bolivar] = await seed(['bolivar']);
    const scope = await tenancy.openScope(bolivar!);
    expect(scope.run(() => tenancy.currentId())).toBe('bolivar');
    const resource = scope.bind();
    expect(resource.runInAsyncScope(() => tenancy.currentId())).toBe('bolivar');
    expect(scope.closed).toBe(false);
    await Promise.all([scope.close(), scope.close()]);
    expect(scope.closed).toBe(true);
  });
});
