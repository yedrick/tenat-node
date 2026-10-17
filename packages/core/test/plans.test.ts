import { createTestTenancy } from '@tenancy-node/testing';
import { describe, expect, it } from 'vitest';
import {
  InMemoryTenantRepository,
  Theme,
  FeatureNotInPlanError,
  FontCatalog,
  InvalidConfigError,
  InvalidThemeError,
  InvalidTenantDataError,
  PlanCatalog,
  PlanLimitReachedError,
  Tenant,
  TenantId,
  TenantNotIdentifiedError,
  errorResponseBody,
  httpStatusFor,
  normalizeFeatureOverrides,
  type EventEnvelope,
  type TenancyConfig,
} from '../src/index.js';

const PLANS: TenancyConfig = {
  features: {
    agenda: 'Agenda de citas',
    caja: 'Caja chica',
    reportes: { label: 'Reportes', description: 'Reportes y PDF' },
    finanzas: 'Finanzas',
  },
  plans: {
    basico: {
      label: 'Básico',
      price: { currency: 'BOB', monthly: 150 },
      features: ['agenda', 'caja'],
      limits: { usuarios: 3 },
    },
    profesional: {
      label: 'Profesional',
      price: { currency: 'BOB', monthly: 300, yearly: 3000 },
      features: ['agenda', 'caja', 'reportes'],
      limits: { usuarios: 10 },
      highlight: true,
    },
    clinica: { label: 'Clínica', features: '*', limits: { usuarios: null } },
    interno: { label: 'Interno', features: '*', public: false },
  },
  defaultPlan: 'basico',
};

const get = (path: string, headers: Record<string, string> = {}) => ({
  method: 'GET',
  path,
  headers,
});

describe('PlanCatalog', () => {
  const catalog = new PlanCatalog(PLANS);

  it('resolves plan features in catalog order, with add/remove and own limits', () => {
    expect(catalog.resolve('basico', null)).toEqual({
      plan: 'basico',
      planLabel: 'Básico',
      knownPlan: true,
      unknownPlan: null,
      features: ['agenda', 'caja'],
      limits: { usuarios: 3 },
    });
    expect(
      catalog.resolve('basico', { add: ['reportes'], remove: ['caja'], limits: { usuarios: 5 } }),
    ).toMatchObject({ features: ['agenda', 'reportes'], limits: { usuarios: 5 } });
    expect(catalog.resolve('clinica', null).features).toEqual([
      'agenda',
      'caja',
      'reportes',
      'finanzas',
    ]);
  });

  it('uses defaultPlan for tenants without plan and for unknown plans', () => {
    expect(catalog.resolve(null, null).plan).toBe('basico');
    // Un plan que ya no existe cae al plan por defecto (no queda sin módulos ni sin límites).
    expect(catalog.resolve('viejo', { add: ['reportes'] })).toEqual({
      plan: 'basico',
      planLabel: 'Básico',
      knownPlan: false,
      unknownPlan: 'viejo',
      features: ['agenda', 'caja', 'reportes'],
      limits: { usuarios: 3 },
    });
    // Sin defaultPlan: solo sus módulos sueltos.
    const strict = new PlanCatalog({ plans: { p: { label: 'P', features: ['x', 'y'] } } });
    expect(strict.resolve('viejo', { add: ['x'] })).toMatchObject({
      plan: null,
      unknownPlan: 'viejo',
      features: ['x'],
      limits: {},
    });
  });

  it('is disabled without plans: every feature, no limits', () => {
    const off = new PlanCatalog({ features: { a: 'A', b: 'B' } });
    expect(off.enabled).toBe(false);
    expect(off.resolve(null, null).features).toEqual(['a', 'b']);
  });

  it('derives the catalog from the plans when features are not declared', () => {
    const derived = new PlanCatalog({ plans: { p: { label: 'P', features: ['x', 'y'] } } });
    expect(derived.features().map((f) => f.id)).toEqual(['x', 'y']);
  });

  it('lists public plans with prices', () => {
    expect(catalog.plans({ publicOnly: true }).map((p) => p.id)).toEqual([
      'basico',
      'profesional',
      'clinica',
    ]);
    expect(catalog.plan('profesional')).toMatchObject({
      price: { currency: 'BOB', monthly: 300, yearly: 3000 },
      highlight: true,
      features: ['agenda', 'caja', 'reportes'],
    });
    expect(catalog.plan('nope')).toBeUndefined();
  });

  it.each([
    [{ features: { 'bad name': 'x' } }, /invalid name/],
    [{ features: { a: { label: '' } } }, /label is required/],
    [
      { plans: { p: { label: 'P', features: ['x'] } }, features: { a: 'A' } },
      /not in the features/,
    ],
    [{ plans: { p: { label: 'P', features: [], limits: { u: -1 } } } }, /integer >= 0/],
    [{ plans: { p: { label: 'P', features: [], price: { currency: '' } } } }, /currency/],
    [
      { plans: { p: { label: 'P', features: [], price: { currency: 'BOB', monthly: -5 } } } },
      /monthly/,
    ],
    [{ plans: { p: { label: 'P', features: [] } }, defaultPlan: 'q' }, /defaultPlan/],
    [{ plans: { p: { label: '', features: [] } } }, /label is required/],
    [{ plans: { p: { label: 'P', features: 'all' } } }, /array or/],
  ])('rejects invalid config %#', (config, message) => {
    expect(() => new PlanCatalog(config as never)).toThrow(message);
    expect(() => new PlanCatalog(config as never)).toThrow(InvalidConfigError);
  });

  it('validates plans and overrides', () => {
    expect(() => catalog.validatePlan('gold')).toThrow(InvalidTenantDataError);
    expect(() => catalog.validatePlan(null)).not.toThrow();
    expect(() => catalog.normalizeOverrides({ add: ['nope'] })).toThrow(/not in the features/);
    expect(catalog.normalizeOverrides({ add: [], remove: [] })).toBeNull();
  });

  it('normalizes overrides: unique, sorted, add wins over remove', () => {
    expect(
      normalizeFeatureOverrides({
        add: ['b', 'a', 'b'],
        remove: ['a', 'c'],
        limits: { z: 1, a: null },
      }),
    ).toEqual({ add: ['a', 'b'], remove: ['c'], limits: { a: null, z: 1 } });
    expect(() => normalizeFeatureOverrides([] as never)).toThrow(InvalidTenantDataError);
    expect(() => normalizeFeatureOverrides({ add: 'x' as never })).toThrow(/array/);
    expect(() => normalizeFeatureOverrides({ add: ['1x'] })).toThrow(/invalid feature/);
    expect(() => normalizeFeatureOverrides({ limits: { u: 1.5 } })).toThrow(/integer/);
    expect(() =>
      normalizeFeatureOverrides({ add: Array.from({ length: 201 }, (_, i) => `f${i}`) }),
    ).toThrow(/at most/);
  });
});

describe('Tenant feature overrides', () => {
  it('keeps overrides in the snapshot and reports changes', () => {
    const now = new Date('2026-10-01');
    const tenant = Tenant.create({
      id: TenantId.create('t1'),
      name: 'T',
      now,
      features: { add: ['x'] },
    });
    expect(tenant.toSnapshot().features).toEqual({ add: ['x'] });
    expect(tenant.update({ features: { add: ['x'] } }, now)).toEqual([]);
    expect(tenant.update({ features: null }, now)).toEqual(['features']);
    // Snapshots de repositorios anteriores a 0.11 no tienen `features`.
    const { features: _, ...old } = tenant.toSnapshot();
    expect(Tenant.restore(old).features).toBeNull();
  });
});

describe('tenancy.features / tenancy.plans', () => {
  it('answers has, list, limit, remaining and assertLimit for the current tenant', async () => {
    const { tenancy } = createTestTenancy(PLANS);
    await tenancy.tenants.create({ id: 'clinica-a', plan: 'basico' });
    await tenancy.run('clinica-a', () => {
      expect(tenancy.features.enabled).toBe(true);
      expect(tenancy.features.has('agenda')).toBe(true);
      expect(tenancy.features.has('reportes')).toBe(false);
      expect(tenancy.features.list()).toEqual(['agenda', 'caja']);
      expect(tenancy.features.limit('usuarios')).toBe(3);
      expect(tenancy.features.limit('sucursales')).toBeNull();
      expect(tenancy.features.remaining('usuarios', 1)).toBe(2);
      expect(tenancy.features.remaining('sucursales', 1)).toBeNull();
      expect(() => tenancy.features.assertLimit('usuarios', 2)).not.toThrow();
      expect(() => tenancy.features.assertLimit('sucursales', 99)).not.toThrow();
      expect(() => tenancy.features.require(['agenda', 'caja'])).not.toThrow();

      const limit = (() => {
        try {
          tenancy.features.assertLimit('usuarios', 3);
        } catch (error) {
          return error;
        }
      })();
      expect(limit).toBeInstanceOf(PlanLimitReachedError);
      expect(httpStatusFor(limit)).toBe(403);
      expect(errorResponseBody(limit)).toEqual({
        error: {
          code: 'TENANCY_PLAN_LIMIT_REACHED',
          message: 'The plan of tenant "clinica-a" allows 3 usuarios',
          details: { tenantId: 'clinica-a', limit: 'usuarios', max: 3, plan: 'basico' },
        },
      });

      const missing = (() => {
        try {
          tenancy.features.require('reportes');
        } catch (error) {
          return error;
        }
      })();
      expect(missing).toBeInstanceOf(FeatureNotInPlanError);
      expect(httpStatusFor(missing)).toBe(403);
      expect(errorResponseBody(missing).error.details).toEqual({
        tenantId: 'clinica-a',
        feature: 'reportes',
        plan: 'basico',
      });
    });
    expect(() => tenancy.features.has('agenda')).toThrow(TenantNotIdentifiedError);
    const tenant = await tenancy.tenants.findOrFail('clinica-a');
    expect(tenancy.features.of(tenant)).toMatchObject({ plan: 'basico', planLabel: 'Básico' });
    expect(tenancy.features.catalog()).toHaveLength(4);
  });

  it('assigns plans with overrides and publishes tenant.plan_changed', async () => {
    const { tenancy } = createTestTenancy(PLANS);
    const events: EventEnvelope[] = [];
    tenancy.events.on('tenant.plan_changed', (e) => void events.push(e), { mode: 'sync' });
    await tenancy.tenants.create({ id: 'clinica-b' });

    const tenant = await tenancy.plans.assign('clinica-b', 'basico', { add: ['reportes'] });
    expect(tenancy.features.list(tenant)).toEqual(['agenda', 'caja', 'reportes']);
    expect(events[0]!.data).toMatchObject({
      previousPlan: null,
      plan: 'basico',
      overrides: { add: ['reportes'] },
      features: ['agenda', 'caja', 'reportes'],
      limits: { usuarios: 3 },
    });

    // Sin overrides se conservan los que tenía.
    const upgraded = await tenancy.plans.assign('clinica-b', 'profesional');
    expect(upgraded.features).toEqual({ add: ['reportes'] });
    expect(events).toHaveLength(2);

    // Sin cambios no hay evento.
    await tenancy.plans.assign('clinica-b', 'profesional');
    expect(events).toHaveLength(2);

    await expect(tenancy.plans.assign('clinica-b', 'gold')).rejects.toThrow(InvalidTenantDataError);
    await expect(
      tenancy.tenants.update('clinica-b', { features: { add: ['nope'] } }),
    ).rejects.toThrow(/not in the features/);
    await expect(tenancy.tenants.create({ id: 'clinica-c', plan: 'gold' })).rejects.toThrow(
      InvalidTenantDataError,
    );
    expect(tenancy.plans.list({ publicOnly: true })).toHaveLength(3);
    expect(tenancy.plans.get('interno')?.public).toBe(false);
    expect(tenancy.plans.defaultPlan).toBe('basico');
  });

  it('warns once for a plan that is no longer configured', async () => {
    const { tenancy, logger } = createTestTenancy(PLANS);
    // Creado con otra configuración (plan "viejo"), leído con la actual.
    const old = Tenant.create({
      id: TenantId.create('vieja'),
      name: 'Vieja',
      plan: 'viejo',
      now: new Date(),
    });
    expect(tenancy.features.list(old)).toEqual(['agenda', 'caja']);
    expect(tenancy.features.list(old)).toEqual(['agenda', 'caja']);
    expect(logger.entries.filter((e) => e.fields.operation === 'features.resolve')).toHaveLength(1);
  });

  it('allows everything when no plans are configured', async () => {
    const { tenancy } = createTestTenancy();
    await tenancy.tenants.create({ id: 'libre', plan: 'cualquiera' });
    await tenancy.run('libre', () => {
      expect(tenancy.features.enabled).toBe(false);
      expect(tenancy.features.has('lo-que-sea')).toBe(true);
      expect(() => tenancy.features.require('lo-que-sea')).not.toThrow();
      expect(tenancy.features.limit('usuarios')).toBeNull();
    });
  });

  it('serves /tenancy/plans on any host and features in /tenancy/me', async () => {
    const { tenancy } = createTestTenancy({
      ...PLANS,
      http: { me: true, plans: true },
      publicFields: ['name', 'plan', 'planLabel', 'features', 'limits'],
    });
    await tenancy.tenants.create({
      id: 'clinica-d',
      plan: 'profesional',
      features: { remove: ['caja'] },
    });
    await tenancy.tenants.create({ id: 'sin-plan' });

    // Contexto central: la web comercial.
    expect(tenancy.http.isPublic('GET', '/tenancy/plans')).toBe(true);
    const plans = (await tenancy.http.handle(get('/tenancy/plans')))!;
    expect(plans.status).toBe(200);
    expect(plans.headers['access-control-allow-origin']).toBe('*');
    const body = JSON.parse(plans.body as string);
    expect(body.defaultPlan).toBe('basico');
    expect(body.plans.map((p: { id: string }) => p.id)).toEqual([
      'basico',
      'profesional',
      'clinica',
    ]);
    expect(body.features[2]).toEqual({
      id: 'reportes',
      label: 'Reportes',
      description: 'Reportes y PDF',
    });
    const cached = await tenancy.http.handle(
      get('/tenancy/plans', { 'if-none-match': plans.headers.etag! }),
    );
    expect(cached?.status).toBe(304);
    const head = await tenancy.http.handle({ method: 'HEAD', path: '/tenancy/plans', headers: {} });
    expect(head?.body).toBe('');

    await tenancy.run('clinica-d', async () => {
      const me = JSON.parse((await tenancy.http.handle(get('/tenancy/me')))!.body as string);
      expect(me).toMatchObject({
        plan: 'profesional',
        planLabel: 'Profesional',
        features: ['agenda', 'reportes'],
        limits: { usuarios: 10 },
      });
    });
    // Sin plan guardado: /me dice el plan efectivo (defaultPlan), no null.
    await tenancy.run('sin-plan', async () => {
      const me = JSON.parse((await tenancy.http.handle(get('/tenancy/me')))!.body as string);
      expect(me).toMatchObject({
        plan: 'basico',
        planLabel: 'Básico',
        features: ['agenda', 'caja'],
      });
    });
  });
});

describe('fonts', () => {
  const fonts = [
    { family: 'Inter', weights: [700, 400] },
    { family: 'Georgia', source: 'system' as const, fallback: 'serif' },
    { family: 'Marca', source: 'url' as const, url: '/fonts/marca.css', label: 'Fuente de marca' },
  ];

  it('builds the Google URL and the font stack', () => {
    const catalog = new FontCatalog(fonts);
    expect(catalog.get('Inter')).toMatchObject({
      cssUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap',
      stack: "'Inter', system-ui, sans-serif",
    });
    expect(catalog.get('Georgia')).toMatchObject({ cssUrl: null, stack: "'Georgia', serif" });
    expect(catalog.get('Marca')?.label).toBe('Fuente de marca');
    expect(() => catalog.validate('Comic Sans')).toThrow(InvalidThemeError);
    expect(() => new FontCatalog().validate('Lo que sea')).not.toThrow();
  });

  it.each([
    [[{ family: "x'; }" }], /invalid family/],
    [[{ family: 'A' }, { family: 'A' }], /duplicated/],
    [[{ family: 'A', source: 'cdn' }], /invalid source/],
    [[{ family: 'A', weights: [50] }], /invalid weight/],
    [[{ family: 'A', fallback: 'x;}' }], /invalid fallback/],
    [[{ family: 'A', source: 'url', url: 'http://x' }], /url must be/],
  ])('rejects invalid fonts %#', (defs, message) => {
    expect(() => new FontCatalog(defs as never)).toThrow(message);
  });

  it('validates the theme font and loads it from theme.css', async () => {
    const { tenancy } = createTestTenancy({ theme: { fonts }, http: { theme: true } });
    expect(tenancy.theme.fonts().map((f) => f.family)).toEqual(['Inter', 'Georgia', 'Marca']);
    await tenancy.tenants.create({ id: 'fuentes', theme: { font: 'Inter' } });
    await expect(tenancy.theme.update('fuentes', { font: 'Comic Sans' })).rejects.toThrow(
      InvalidThemeError,
    );
    await expect(
      tenancy.tenants.create({ id: 'otra', theme: { font: 'Comic Sans' } }),
    ).rejects.toThrow(InvalidThemeError);
    await tenancy.run('fuentes', async () => {
      const css = (await tenancy.http.handle(get('/tenancy/theme.css')))!.body as string;
      expect(
        css.startsWith(
          "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');\n:root {",
        ),
      ).toBe(true);
      expect(css).toContain("--font-main: 'Inter', system-ui, sans-serif;");
    });
    expect(() => createTestTenancy({ theme: { fonts, defaults: { font: 'Comic Sans' } } })).toThrow(
      /not in theme.fonts/,
    );
  });

  it('matches fonts without case, saves the catalog name and only validates a changed font', async () => {
    const { tenancy } = createTestTenancy({ theme: { fonts } });
    expect(
      (await tenancy.tenants.create({ id: 'mayus', theme: { font: 'inter' } })).theme?.font,
    ).toBe('Inter');
    expect((await tenancy.theme.update('mayus', { font: 'GEORGIA' })).font).toBe('Georgia');
    expect(new FontCatalog(fonts).canonical('marca')).toBe('Marca');
    expect(new FontCatalog().canonical('lo que sea')).toBe('lo que sea');

    // Tema guardado antes de la lista ('arial' en minúsculas): se puede seguir editando.
    const repo = new InMemoryTenantRepository();
    await repo.insert(
      Tenant.create({
        id: TenantId.create('vieja'),
        name: 'Vieja',
        theme: Theme.create({ primary: '#000000', secondary: '#64748B', font: 'arial' }),
        now: new Date(),
      }),
    );
    const { tenancy: after } = createTestTenancy({
      theme: {
        fonts: [...fonts, { family: 'Arial', source: 'system', fallback: 'Helvetica, sans-serif' }],
      },
      tenants: repo,
      http: { theme: true },
    });
    // Misma fuente con otras mayúsculas: pasa a la de la lista.
    expect((await after.theme.update('vieja', { font: 'ARIAL', primary: '#111111' })).font).toBe(
      'Arial',
    );
    await expect(after.theme.update('vieja', { font: 'Comic Sans' })).rejects.toThrow(
      InvalidThemeError,
    );

    // Una fuente que no está en la lista se conserva si no cambia.
    await repo.insert(
      Tenant.create({
        id: TenantId.create('rara'),
        name: 'Rara',
        theme: Theme.create({ primary: '#000000', secondary: '#64748B', font: 'Fuente Rara' }),
        now: new Date(),
      }),
    );
    expect((await after.theme.update('rara', { font: 'fuente rara', radius: 'lg' })).font).toBe(
      'Fuente Rara',
    );
    const css = await after.run(
      'vieja',
      async () => (await after.http.handle(get('/tenancy/theme.css')))!.body,
    );
    expect(css).toContain("--font-main: 'Arial', Helvetica, sans-serif;");
  });
});
