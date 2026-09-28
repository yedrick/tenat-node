import { createTestTenancy } from '@tenancy-node/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  DomainAlreadyTakenError,
  DomainNotFoundError,
  InvalidConfigError,
  InvalidTenantIdError,
  TenantAlreadyExistsError,
  TenantNotFoundError,
  TenantProvisioningError,
  createTenancy,
  defineConfig,
  type EventEnvelope,
  type ProvisioningPipeline,
} from '../src/index.js';

describe('tenants', () => {
  it('creates an active tenant with its primary domain and events', async () => {
    const { tenancy } = createTestTenancy();
    const events: string[] = [];
    tenancy.events.on('*', (e) => void events.push(e.type), { mode: 'sync' });

    const tenant = await tenancy.tenants.create({
      id: 'bolivar',
      name: 'Club Bolívar',
      plan: 'pro',
      domain: ['bolivar.tuapp.com', 'clubbolivar.com', 'BOLIVAR.tuapp.com'],
      theme: { primary: '#E4002B' },
    });

    expect(tenant.status).toBe('active');
    expect(tenant.provisionedAt).not.toBeNull();
    expect(tenant.theme?.primary.value).toBe('#E4002B');
    expect(tenant.theme?.secondary.value).toBe('#64748B');
    const domains = await tenancy.domains.list('bolivar');
    expect(domains.map((d) => [d.domain.value, d.isPrimary])).toEqual([
      ['bolivar.tuapp.com', true],
      ['clubbolivar.com', false],
    ]);
    expect(events).toEqual([
      'tenant.creating',
      'domain.created',
      'domain.created',
      'tenant.created',
      'tenant.provisioned',
    ]);
  });

  it('rejects duplicates, invalid ids and taken domains', async () => {
    const { tenancy, seed } = createTestTenancy();
    await seed(['bolivar']);
    await expect(tenancy.tenants.create({ id: 'bolivar' })).rejects.toThrow(
      TenantAlreadyExistsError,
    );
    await expect(tenancy.tenants.create({ id: 'Bad Id' })).rejects.toThrow(InvalidTenantIdError);
    await expect(tenancy.tenants.create({ id: 'tigre', domain: 'bolivar.test' })).rejects.toThrow(
      DomainAlreadyTakenError,
    );
    expect(await tenancy.tenants.find('tigre')).toBeUndefined();
  });

  it('lets sync tenant.creating listeners veto a creation', async () => {
    const { tenancy } = createTestTenancy();
    tenancy.events.on(
      'tenant.creating',
      (e) => {
        if (e.data.id === 'admin') throw new Error('reserved');
      },
      { mode: 'sync' },
    );
    await expect(tenancy.tenants.create({ id: 'admin' })).rejects.toThrow('reserved');
    expect(await tenancy.tenants.find('admin')).toBeUndefined();
  });

  it('marks the tenant failed when provisioning fails, and retries', async () => {
    let fail = true;
    const provisioning: ProvisioningPipeline = {
      provision: vi.fn(async () => {
        if (fail) throw new Error('db down');
      }),
      deprovision: vi.fn(async () => {}),
    };
    const { tenancy } = createTestTenancy({ provisioning });
    const failures: EventEnvelope[] = [];
    tenancy.events.on('tenant.provisioning_failed', (e) => void failures.push(e), { mode: 'sync' });

    const error = await tenancy.tenants.create({ id: 'bolivar' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantProvisioningError);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect((await tenancy.tenants.find('bolivar'))?.status).toBe('failed');
    expect(failures[0]?.data).toMatchObject({ id: 'bolivar', error: 'db down' });

    fail = false;
    const retried = await tenancy.tenants.retryProvisioning('bolivar');
    expect(retried.status).toBe('active');
    expect(provisioning.provision).toHaveBeenCalledTimes(2);
  });

  it('finds, lists, updates and changes status', async () => {
    const { tenancy, seed, clock } = createTestTenancy();
    await seed(['alpha', 'beta', 'gamma']);
    clock.advance(1000);

    expect((await tenancy.tenants.findOrFail('alpha')).id.value).toBe('alpha');
    await expect(tenancy.tenants.findOrFail('nope')).rejects.toThrow(TenantNotFoundError);
    await expect(tenancy.tenants.findOrFail('Invalid!')).rejects.toThrow(TenantNotFoundError);
    expect(await tenancy.tenants.find('Invalid!')).toBeUndefined();

    const updated = await tenancy.tenants.update('alpha', {
      plan: 'enterprise',
      data: { seats: 10 },
    });
    expect(updated.plan).toBe('enterprise');
    expect((await tenancy.tenants.find('alpha'))?.data).toEqual({ seats: 10 });
    const unchanged = await tenancy.tenants.update('alpha', { plan: 'enterprise' });
    expect(unchanged.updatedAt).toEqual(updated.updatedAt);

    await tenancy.tenants.suspend('beta');
    await tenancy.tenants.maintenance('gamma', 'Upgrading');
    expect((await tenancy.tenants.list({ status: 'active' })).items.map((t) => t.id.value)).toEqual(
      ['alpha'],
    );
    expect((await tenancy.tenants.find('gamma'))?.maintenanceMessage).toBe('Upgrading');
    await tenancy.tenants.activate('beta');
    await tenancy.tenants.maintenance('alpha');
    expect((await tenancy.tenants.find('beta'))?.status).toBe('active');
    expect((await tenancy.tenants.list()).total).toBe(3);
  });

  it('soft-deletes a tenant and frees its domains', async () => {
    const provisioning = { provision: vi.fn(async () => {}), deprovision: vi.fn(async () => {}) };
    const { tenancy, seed } = createTestTenancy({ provisioning });
    await seed(['bolivar']);
    const deleted: string[] = [];
    tenancy.events.on('tenant.deleted', (e) => void deleted.push(e.data.id), { mode: 'sync' });

    await tenancy.tenants.delete('bolivar');
    expect(provisioning.deprovision).toHaveBeenCalledOnce();
    expect(await tenancy.tenants.find('bolivar')).toBeUndefined();
    expect(deleted).toEqual(['bolivar']);
    await expect(tenancy.tenants.create({ id: 'bolivar' })).rejects.toThrow(
      TenantAlreadyExistsError,
    );
    // el dominio quedó libre
    await tenancy.tenants.create({ id: 'tigre', domain: 'bolivar.test' });
  });
});

describe('domains', () => {
  it('adds, promotes and removes domains', async () => {
    const { tenancy } = createTestTenancy();
    await tenancy.tenants.create({ id: 'bolivar' });
    const events: string[] = [];
    tenancy.events.on(
      'domain.*',
      (e) => void events.push(`${e.type}:${(e.data as { domain: string }).domain}`),
      {
        mode: 'sync',
      },
    );

    const first = await tenancy.domains.add('bolivar', 'a.com');
    expect(first.isPrimary).toBe(true);
    const second = await tenancy.domains.add('bolivar', 'b.com');
    expect(second.isPrimary).toBe(false);
    await tenancy.domains.add('bolivar', 'c.com', { primary: true });
    expect((await tenancy.domains.list('bolivar'))[0]?.domain.value).toBe('c.com');

    expect((await tenancy.domains.setPrimary('b.com')).isPrimary).toBe(true);
    expect((await tenancy.domains.setPrimary('b.com')).isPrimary).toBe(true);
    await tenancy.domains.remove('b.com');
    const remaining = await tenancy.domains.list('bolivar');
    expect(remaining.map((d) => [d.domain.value, d.isPrimary])).toEqual([
      ['a.com', true],
      ['c.com', false],
    ]);
    await tenancy.domains.remove('c.com');

    await expect(tenancy.domains.add('bolivar', 'a.com')).rejects.toThrow(DomainAlreadyTakenError);
    await expect(tenancy.domains.add('nobody', 'x.com')).rejects.toThrow(TenantNotFoundError);
    await expect(tenancy.domains.remove('zzz.com')).rejects.toThrow(DomainNotFoundError);
    await expect(tenancy.domains.setPrimary('zzz.com')).rejects.toThrow(DomainNotFoundError);
    expect(events).toContain('domain.primary_changed:a.com');
    expect(events).toContain('domain.deleted:b.com');
  });
});

describe('theme', () => {
  it('updates, renders and resets the tenant theme', async () => {
    const { tenancy, seed } = createTestTenancy({ theme: { defaults: { primary: '#111111' } } });
    await seed(['bolivar']);
    const updates: unknown[] = [];
    tenancy.events.on('theme.updated', (e) => void updates.push(e.data.theme), { mode: 'sync' });

    expect(tenancy.theme.defaults.primary.value).toBe('#111111');
    const theme = await tenancy.theme.update('bolivar', {
      primary: '#E4002B',
      font: 'Inter',
      radius: 'md',
    });
    expect(theme.toJSON()).toMatchObject({ primary: '#E4002B', secondary: '#64748B' });
    await tenancy.theme.update('bolivar', { primary: '#E4002B' });
    expect(updates).toHaveLength(1);

    const css = await tenancy.run('bolivar', () => tenancy.theme().toCss());
    expect(css).toContain('--color-primary: #E4002B;');
    expect(css).toContain("--font-main: 'Inter', system-ui, sans-serif;");
    expect(tenancy.theme().toCss()).toContain('--color-primary: #111111;');
    expect(await tenancy.theme().logoUrl()).toBeUndefined();

    await tenancy.theme.reset('bolivar');
    await tenancy.theme.reset('bolivar');
    expect((await tenancy.tenants.find('bolivar'))?.theme).toBeNull();
    expect(updates).toHaveLength(2);
  });
});

describe('events api', () => {
  it('publishes custom events with the tenant from the context', async () => {
    const { tenancy, seed } = createTestTenancy();
    await seed(['bolivar']);
    const seen: EventEnvelope[] = [];
    tenancy.events.on('pedido.*', (e) => void seen.push(e));
    await tenancy.run('bolivar', () => tenancy.events.publish('pedido.creado', { pedidoId: 1 }));
    await tenancy.events.publish('pedido.central', {});
    await tenancy.events.flush();
    expect(seen.map((e) => [e.type, e.tenantId])).toEqual([
      ['pedido.creado', 'bolivar'],
      ['pedido.central', null],
    ]);
  });

  it('emits tenancy.initialized and tenancy.ended only when listened', async () => {
    const { tenancy, seed } = createTestTenancy();
    await seed(['bolivar']);
    await tenancy.run('bolivar', () => undefined);
    const seen: string[] = [];
    tenancy.events.on('tenancy.*', (e) => void seen.push(`${e.type}:${e.tenantId}`), {
      mode: 'sync',
    });
    await tenancy.run('bolivar', () => undefined);
    await tenancy.central(() => undefined);
    expect(seen).toEqual(['tenancy.initialized:bolivar', 'tenancy.ended:bolivar']);
  });
});

describe('config', () => {
  it('validates the configuration', () => {
    expect(() => createTenancy({ centralDomains: ['bad domain'] })).toThrow(InvalidConfigError);
    expect(() => createTenancy({ resolver: 'magic' as 'domain' })).toThrow(/resolver/);
    expect(() => createTenancy({ tenants: {} as never })).toThrow(/tenants: must implement/);
    expect(() => createTenancy({ lookupCache: { max: 0 } })).toThrow(InvalidConfigError);
    expect(defineConfig({ centralDomains: ['a.com'] })).toEqual({ centralDomains: ['a.com'] });
    const tenancy = createTenancy({
      centralDomains: ['TuApp.com'],
      lookupCache: false,
      resolver: 'header',
    });
    expect(tenancy.centralDomains).toEqual(['tuapp.com']);
  });
});
