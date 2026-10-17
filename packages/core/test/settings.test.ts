import { createTestTenancy, settingsRepositoryContract } from '@tenancy-node/testing';
import { describe, expect, it } from 'vitest';
import {
  InMemoryPlanSettingsRepository,
  InMemoryPlatformSettingsRepository,
  InMemoryTenantRepository,
  InvalidPlanError,
  InvalidPlatformError,
  MemoryInvalidationBus,
  MemoryStorage,
  PlanConflictError,
  PlanNotFoundError,
  UlidGenerator,
  mergePlatform,
  EMPTY_PLATFORM,
  type EventEnvelope,
  type TenancyConfig,
} from '../src/index.js';

const PLANS: TenancyConfig = {
  features: { agenda: 'Agenda', caja: 'Caja', reportes: 'Reportes' },
  plans: {
    basico: {
      label: 'Básico',
      price: { currency: 'BOB', monthly: 150 },
      features: ['agenda'],
      limits: { usuarios: 3 },
    },
    pro: { label: 'Pro', features: '*' },
  },
  defaultPlan: 'basico',
  http: { plans: true, platform: true, me: true },
  publicFields: ['plan', 'features', 'limits'],
};
const get = (path: string, headers: Record<string, string> = {}) => ({
  method: 'GET',
  path,
  headers,
});

describe('editable plans', () => {
  it('overrides config plans, creates and archives panel plans, and resets', async () => {
    const { tenancy } = createTestTenancy(PLANS);
    const events: EventEnvelope[] = [];
    tenancy.events.on('plan.updated', (e) => void events.push(e), { mode: 'sync' });
    await tenancy.tenants.create({ id: 'aa' });

    const edited = await tenancy.plans.update(
      'basico',
      {
        label: 'Básico+',
        price: { currency: 'BOB', monthly: 199, yearly: 1990 },
        features: ['agenda', 'caja'],
        limits: { usuarios: 5 },
        highlight: true,
      },
      { by: 'ana@tuapp.com' },
    );
    expect(edited).toMatchObject({
      id: 'basico',
      label: 'Básico+',
      price: { monthly: 199, yearly: 1990 },
      features: ['agenda', 'caja'],
      limits: { usuarios: 5 },
      highlight: true,
      source: 'config',
      customized: true,
      updatedBy: 'ana@tuapp.com',
    });
    // Los permisos y límites cambian al instante (síncronos).
    await tenancy.run('aa', () => {
      expect(tenancy.features.has('caja')).toBe(true);
      expect(tenancy.features.limit('usuarios')).toBe(5);
    });
    // La web comercial ve los precios nuevos.
    const plans = JSON.parse((await tenancy.http.handle(get('/tenancy/plans')))!.body as string);
    expect(plans.plans[0]).toMatchObject({ label: 'Básico+', price: { monthly: 199 } });
    expect(plans.plans[0].source).toBeUndefined();

    const created = await tenancy.plans.create('clinica', {
      label: 'Clínica',
      features: '*',
      price: { currency: 'BOB', monthly: 400 },
    });
    expect(created).toMatchObject({ source: 'panel', features: ['agenda', 'caja', 'reportes'] });
    expect(tenancy.plans.list().map((p) => p.id)).toEqual(['basico', 'pro', 'clinica']);
    await tenancy.plans.assign('aa', 'clinica');
    await expect(tenancy.plans.remove('clinica')).rejects.toThrow(PlanConflictError);
    await tenancy.plans.assign('aa', 'pro');
    expect(await tenancy.plans.remove('clinica')).toBe('archived');
    expect(tenancy.plans.get('clinica')).toBeUndefined();
    await expect(tenancy.plans.assign('aa', 'clinica')).rejects.toThrow(/not a configured plan/);
    const described = await tenancy.plans.describe();
    expect(described.find((p) => p.id === 'clinica')).toMatchObject({ archived: true });
    await expect(tenancy.plans.create('clinica', { label: 'x', features: [] })).rejects.toThrow(
      /archived/,
    );
    await expect(tenancy.plans.update('clinica', { label: 'x' })).rejects.toThrow(
      PlanNotFoundError,
    );
    await expect(tenancy.plans.remove('clinica')).rejects.toThrow(PlanNotFoundError);

    expect(await tenancy.plans.remove('basico')).toBe('reset');
    expect(tenancy.plans.get('basico')).toMatchObject({ label: 'Básico', price: { monthly: 150 } });
    expect(events.map((e) => (e.data as { action: string }).action)).toEqual([
      'updated',
      'created',
      'archived',
      'reset',
    ]);
  });

  it('validates panel changes against the code catalog', async () => {
    const { tenancy } = createTestTenancy(PLANS);
    await expect(tenancy.plans.update('basico', { features: ['inventado'] })).rejects.toThrow(
      InvalidPlanError,
    );
    await expect(
      tenancy.plans.update('basico', { price: { currency: 'BOB', monthly: -1 } }),
    ).rejects.toThrow(/monthly/);
    await expect(tenancy.plans.update('basico', { label: '' })).rejects.toThrow(/label/);
    await expect(tenancy.plans.update('basico', { description: 'x'.repeat(501) })).rejects.toThrow(
      /description/,
    );
    await expect(tenancy.plans.update('nope', { label: 'x' })).rejects.toThrow(PlanNotFoundError);
    await expect(tenancy.plans.create('pro', { label: 'x', features: [] })).rejects.toThrow(
      PlanConflictError,
    );
    await expect(tenancy.plans.create('1malo', { label: 'x', features: [] })).rejects.toThrow(
      InvalidPlanError,
    );
    await expect(tenancy.plans.create('nuevo', { label: '', features: [] })).rejects.toThrow(
      InvalidPlanError,
    );
    await expect(tenancy.plans.create('nuevo', { label: 'x', features: ['nope'] })).rejects.toThrow(
      InvalidPlanError,
    );
    // Un plan de código con descripción y precio que se quitan.
    const cleared = await tenancy.plans.update('basico', {
      description: 'Para empezar',
      price: null,
      public: false,
    });
    expect(cleared).toMatchObject({ description: 'Para empezar', price: null, public: false });
    expect(tenancy.plans.list({ publicOnly: true }).map((p) => p.id)).toEqual(['pro']);
  });

  it('loads changes saved by another instance and reloads on invalidation', async () => {
    const plans = new InMemoryPlanSettingsRepository();
    const platform = new InMemoryPlatformSettingsRepository();
    const tenants = new InMemoryTenantRepository();
    const bus = new MemoryInvalidationBus();
    const config = {
      ...PLANS,
      tenants,
      planSettings: { repository: plans },
      platform: { repository: platform },
      invalidation: bus,
      lookupCache: false as const,
    };
    // Ids reales: con el generador secuencial de prueba las dos instancias tendrían el mismo origen.
    const ids = () => ({ idGenerator: new UlidGenerator() });
    const a = createTestTenancy({ ...config, ...ids() }).tenancy;
    const b = createTestTenancy({ ...config, ...ids() }).tenancy;
    await a.tenants.create({ id: 'aa' });
    // La primera petición de b espera la carga inicial.
    await a.plans.update('basico', { features: ['agenda', 'reportes'] });
    const scope = await b.openRequestScope(
      { host: 'aa.app.test', path: '/', headers: {} },
      { onUnidentified: 'central' },
    );
    await scope.close();
    expect(b.features.of(await b.tenants.findOrFail('aa')).features).toEqual([
      'agenda',
      'reportes',
    ]);
    // Después, un cambio en a llega a b por el bus.
    await a.plans.update('basico', { features: ['caja'] });
    await expect
      .poll(async () => b.features.of(await b.tenants.findOrFail('aa')).features)
      .toEqual(['caja']);
    await a.platform.update({ name: 'IONIX' });
    await expect.poll(async () => (await b.platform.get()).name).toBe('IONIX');
    await b.plans.reload();
    await a.close();
    await b.close();
  });

  it('keeps the code configuration when the settings cannot be loaded', async () => {
    const broken = {
      list: async () => {
        throw new Error('Table tenancy_plan_settings does not exist');
      },
      save: async () => undefined,
      delete: async () => false,
    };
    const { tenancy, logger } = createTestTenancy({
      ...PLANS,
      planSettings: { repository: broken, refreshMs: 0 },
    });
    await tenancy.plans.reload();
    await tenancy.plans.reload();
    expect(tenancy.plans.get('basico')?.label).toBe('Básico');
    expect(logger.entries.filter((e) => e.fields.operation === 'settings.load')).toHaveLength(1);
  });

  it('enables plan control when the first plan is created from the panel', async () => {
    const { tenancy } = createTestTenancy({ features: { agenda: 'Agenda', caja: 'Caja' } });
    expect(tenancy.features.enabled).toBe(false);
    await tenancy.plans.create('unico', { label: 'Único', features: ['agenda'] });
    expect(tenancy.features.enabled).toBe(true);
  });
});

describe('platform settings', () => {
  it('validates and merges', () => {
    const merged = mergePlatform(EMPTY_PLATFORM, {
      name: '  IONIX ',
      primary: '#0f766e',
      contact: { whatsapp: '+591 700-00000', email: 'ventas@ionix.bo' },
      salesNotifyTo: ['a@ionix.bo', 'a@ionix.bo', 'b@ionix.bo'],
    });
    expect(merged).toEqual({
      name: 'IONIX',
      logo: null,
      favicon: null,
      primary: '#0F766E',
      contact: { whatsapp: '59170000000', email: 'ventas@ionix.bo' },
      salesNotifyTo: ['a@ionix.bo', 'b@ionix.bo'],
    });
    expect(mergePlatform(merged, { name: null, contact: { email: null } })).toMatchObject({
      name: null,
      contact: { whatsapp: '59170000000', email: null },
    });
    for (const patch of [
      { name: '' },
      { primary: 'rojo' },
      { contact: { whatsapp: '123' } },
      { contact: { email: 'no-es-email' } },
      { salesNotifyTo: ['x'] },
      { salesNotifyTo: 'a@b.co' as never },
      { logo: 'con espacio.png' },
    ])
      expect(() => mergePlatform(merged, patch)).toThrow(InvalidPlatformError);
  });

  it('serves the public brand and its logo on any host, without private emails', async () => {
    const storage = new MemoryStorage();
    const { tenancy } = createTestTenancy({
      ...PLANS,
      storage,
      platform: {
        defaults: { name: 'IONIX', primary: '#0F766E', contact: { whatsapp: '59170000000' } },
      },
    });
    expect(await tenancy.platform.public()).toEqual({
      name: 'IONIX',
      logoUrl: null,
      faviconUrl: null,
      primary: '#0F766E',
      contact: { whatsapp: '59170000000', email: null },
    });
    const events: EventEnvelope[] = [];
    tenancy.events.on('platform.updated', (e) => void events.push(e), { mode: 'sync' });
    await tenancy.platform.update(
      { contact: { email: 'ventas@ionix.bo' }, salesNotifyTo: ['jefe@ionix.bo'] },
      { by: 'ana' },
    );
    const withLogo = await tenancy.platform.upload('logo', Buffer.from('PNG'), 'png', {
      contentType: 'image/png',
      by: 'ana',
    });
    expect(withLogo.logo).toMatch(/^platform\/logo-[0-9a-f]{16}\.png$/);
    expect(withLogo.logoUrl).toBe(
      `/tenancy/platform/assets/${withLogo.logo!.slice('platform/'.length)}`,
    );
    expect(withLogo).toMatchObject({ salesNotifyTo: ['jefe@ionix.bo'], updatedBy: 'ana' });
    expect(events.map((e) => e.data)).toEqual([
      { fields: ['contact', 'salesNotifyTo'], by: 'ana' },
      { fields: ['logo'], by: 'ana' },
    ]);
    await expect(tenancy.platform.upload('favicon', Buffer.from('x'), 'p n g')).rejects.toThrow();

    expect(tenancy.http.isPublic('GET', '/tenancy/platform')).toBe(true);
    const res = (await tenancy.http.handle(get('/tenancy/platform')))!;
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const body = JSON.parse(res.body as string);
    expect(body).toEqual({
      name: 'IONIX',
      logoUrl: withLogo.logoUrl,
      faviconUrl: null,
      primary: '#0F766E',
      contact: { whatsapp: '59170000000', email: 'ventas@ionix.bo' },
    });
    expect(res.body).not.toContain('jefe@');
    expect(
      (await tenancy.http.handle(get('/tenancy/platform', { 'if-none-match': res.headers.etag! })))!
        .status,
    ).toBe(304);
    const logo = (await tenancy.http.handle(get(withLogo.logoUrl!)))!;
    expect(logo.status).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(Buffer.from(logo.body as Uint8Array).toString()).toBe('PNG');
    expect(
      (await tenancy.http.handle(get(withLogo.logoUrl!, { 'if-none-match': logo.headers.etag! })))!
        .status,
    ).toBe(304);
    expect((await tenancy.http.handle(get('/tenancy/platform/assets/..%2Fx')))!.status).toBe(404);
    expect((await tenancy.http.handle(get('/tenancy/platform/assets/nada.png')))!.status).toBe(404);
    expect(
      (await tenancy.http.handle({ method: 'HEAD', path: '/tenancy/platform', headers: {} }))!.body,
    ).toBe('');
    // Una URL absoluta se respeta tal cual.
    await tenancy.platform.update({ favicon: 'https://cdn.ionix.bo/favicon.ico' });
    expect((await tenancy.platform.public()).faviconUrl).toBe('https://cdn.ionix.bo/favicon.ico');
    await tenancy.platform.reload();
  });
});

settingsRepositoryContract('in-memory settings repositories', () => ({
  plans: new InMemoryPlanSettingsRepository(),
  platform: new InMemoryPlatformSettingsRepository(),
}));
