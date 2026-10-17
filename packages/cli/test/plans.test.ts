import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '@tenancy-node/cli';
import { createTestTenancy } from '@tenancy-node/testing';
import type { TenancyConfig } from '@tenancy-node/core';
import { describe, expect, it } from 'vitest';
import type { CliTenancy } from '../src/config-loader.js';
import { memoryIO } from './helpers.js';

async function setup(config: TenancyConfig) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tenancy-cli-plans-'));
  const test = createTestTenancy({ centralDomains: ['app.test'], ...config });
  const load = async () => test.tenancy as CliTenancy;
  const run = async (argv: string[]) => {
    const io = memoryIO(dir);
    const code = await main(argv, { io, load });
    return { code, io, text: io.all() };
  };
  return { run, ...test };
}

const PLANS: TenancyConfig = {
  features: { agenda: 'Agenda', caja: 'Caja', reportes: 'Reportes' },
  plans: {
    basico: {
      label: 'Básico',
      price: { currency: 'BOB', monthly: 150, yearly: 1500 },
      features: ['agenda', 'caja'],
      limits: { usuarios: 3 },
    },
    pro: { label: 'Pro', features: '*', limits: { usuarios: null } },
    interno: { label: 'Interno', features: [], public: false },
  },
  defaultPlan: 'basico',
};

describe('cli: plans', () => {
  it('lists the plans with their tenants', async () => {
    const { run, tenancy } = await setup(PLANS);
    await tenancy.tenants.create({ id: 'aa', plan: 'pro' });
    await tenancy.tenants.create({ id: 'bb' });
    const list = await run(['plans']);
    expect(list.code).toBe(0);
    expect(list.text).toMatch(/PLAN\s+NOMBRE\s+MÓDULOS\s+LÍMITES\s+PRECIO\s+TENANTS/);
    expect(list.text).toContain('basico (por defecto)');
    expect(list.text).toContain('BOB 150/mes · 1500/año');
    expect(list.text).toContain('interno (oculto)');
    expect(list.text).toContain('usuarios: sin límite');
    await tenancy.plans.update('pro', { label: 'Pro 2026' });
    await tenancy.plans.create('extra', { label: 'Extra', features: ['agenda'] });
    const edited = await run(['plans']);
    expect(edited.text).toContain('pro (modificado)');
    expect(edited.text).toContain('extra (panel)');
    expect(edited.text).toContain('Pro 2026');
    await tenancy.plans.remove('extra');
    await tenancy.plans.remove('pro');
    const json = JSON.parse((await run(['plans', '--json'])).io.out());
    expect(json.plans.map((p: { id: string; tenants: number }) => [p.id, p.tenants])).toEqual([
      ['basico', 1],
      ['pro', 1],
      ['interno', 0],
    ]);
    const filtered = await run(['list', '--plan=pro', '--json']);
    expect(JSON.parse(filtered.io.out()).items.map((t: { id: string }) => t.id)).toEqual(['aa']);
    const none = await run(['list', '--plan=', '--json']);
    expect(JSON.parse(none.io.out()).items.map((t: { id: string }) => t.id)).toEqual(['bb']);
  });

  it('warns when there are no plans', async () => {
    const { run } = await setup({});
    const result = await run(['plans']);
    expect(result.code).toBe(0);
    expect(result.text).toContain('No hay planes');
  });

  it('shows and changes the plan, loose modules and limits of a tenant', async () => {
    const { run, tenancy } = await setup(PLANS);
    await tenancy.tenants.create({ id: 'clinica' });

    const show = await run(['tenant:plan', 'clinica']);
    expect(show.text).toContain('Plan:    basico (Básico)');
    expect(show.text).toContain('Módulos: agenda, caja');

    const changed = await run([
      'tenant:plan',
      'clinica',
      'basico',
      '--add=reportes',
      '--remove=caja',
      '--limit=usuarios=5',
      '--limit=sucursales=none',
    ]);
    expect(changed.code).toBe(0);
    expect(changed.text).toContain('plan de clinica actualizado');
    expect(changed.text).toContain('Módulos: agenda, reportes');
    expect(changed.text).toContain('usuarios: 5');
    expect((await tenancy.tenants.findOrFail('clinica')).features).toEqual({
      add: ['reportes'],
      remove: ['caja'],
      limits: { sucursales: null, usuarios: 5 },
    });

    // Volver a agregar caja la saca de "remove"; usuarios= vuelve al límite del plan.
    const json = await run(['tenant:plan', 'clinica', '--add=caja', '--limit=usuarios=', '--json']);
    expect(JSON.parse(json.io.out())).toMatchObject({
      plan: 'basico',
      features: ['agenda', 'caja', 'reportes'],
      limits: { usuarios: 3, sucursales: null },
    });

    const reset = await run(['tenant:plan', 'clinica', 'pro', '--reset']);
    expect(reset.text).toContain('Módulos: agenda, caja, reportes');
    expect((await tenancy.tenants.findOrFail('clinica')).features).toBeNull();

    expect((await run(['tenant:plan', 'clinica', '--no-plan'])).text).toContain('Plan:    basico');
    expect((await tenancy.tenants.findOrFail('clinica')).plan).toBeNull();

    const unknown = await run(['tenant:plan', 'clinica', 'gold']);
    expect(unknown.code).toBe(1);
    expect(unknown.text).toContain('TENANCY_INVALID_TENANT_DATA');
    expect((await run(['tenant:plan', 'clinica', 'pro', '--no-plan'])).code).toBe(2);
    expect((await run(['tenant:plan', 'clinica', '--limit=usuarios'])).code).toBe(2);
    expect((await run(['tenant:plan', 'clinica', '--limit=usuarios=-1'])).code).toBe(2);
    expect((await run(['tenant:plan'])).code).toBe(2);
  });

  it('warns about a plan that is not configured anymore', async () => {
    const { run, tenancy } = await setup(PLANS);
    await tenancy.tenants.create({ id: 'vieja' });
    // Plan guardado por una configuración anterior (sin pasar por la validación).
    const tenant = await tenancy.tenants.findOrFail('vieja');
    tenant.update({ plan: 'viejo' }, new Date());
    await (
      tenancy as unknown as { tenantRepo: { save(t: unknown): Promise<void> } }
    ).tenantRepo.save(tenant);
    const result = await run(['tenant:plan', 'vieja']);
    expect(result.text).toContain('no está en la configuración');
  });
});

describe('cli: notify and billing:run', () => {
  it('sends notifications to all, some tenants or plans', async () => {
    const { run, tenancy } = await setup(PLANS);
    await tenancy.tenants.create({ id: 'aa', plan: 'pro' });
    await tenancy.tenants.create({ id: 'bb' });
    const all = await run([
      'notify',
      'Mantenimiento',
      '--body=Sábado',
      '--level=warning',
      '--expires=2099-01-01',
    ]);
    expect(all.code).toBe(0);
    expect(all.text).toContain('enviado a 2 tenants');
    const some = await run(['notify', 'Hola', '--tenants=aa', '--json']);
    expect(JSON.parse(some.io.out())).toMatchObject({
      reach: 1,
      audience: { type: 'tenants', tenants: ['aa'] },
      createdBy: 'cli',
    });
    const plan = await run([
      'notify',
      'Pro',
      '--plans=pro',
      '--roles=ADMIN',
      '--link=https://x.com',
      '--link-label=Ver',
    ]);
    expect(plan.text).toContain('enviado a 1 tenant');
    expect((await tenancy.notifications.list()).total).toBe(3);
    expect((await run(['notify', 'x', '--tenants=aa', '--plans=pro'])).code).toBe(2);
    expect((await run(['notify', 'x', '--expires=mañana'])).code).toBe(2);
    expect((await run(['notify', 'x', '--level=urgente'])).text).toContain(
      'TENANCY_INVALID_NOTIFICATION',
    );
    expect((await run(['notify'])).code).toBe(2);
  });

  it('runs the billing cycle', async () => {
    const { run, tenancy, clock } = await setup({
      ...PLANS,
      billing: { suspendAfterDays: 0 },
    });
    await tenancy.tenants.create({ id: 'aa', plan: 'basico' });
    await tenancy.billing.subscribe('aa');
    clock.advance(10 * 86_400_000);
    const result = await run(['billing:run']);
    expect(result.code).toBe(0);
    expect(result.text).toContain('1 en mora · 1 suspendidos');
    expect(result.text).toContain('suspendido por falta de pago: aa');
  });
});
