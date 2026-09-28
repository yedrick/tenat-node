import { createTestTenancy } from '@tenancy-node/testing';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { tenancyPlugin } from '@tenancy-node/adapter-fastify';

async function setup(options: { onUnidentified?: 'error' | 'central' } = {}) {
  const t = createTestTenancy({ centralDomains: ['tuapp.com'] });
  await t.seed(['bolivar', 'tigre', 'closed']);
  await t.tenancy.tenants.suspend('closed');
  const app = Fastify();
  await app.register(tenancyPlugin, {
    tenancy: t.tenancy,
    skip: (r) => r.url === '/health',
    ...options,
  });
  app.get('/whoami', async (req) => ({
    current: t.tenancy.currentId() ?? null,
    req: req.tenant?.id.value ?? null,
  }));
  app.post('/echo', async (req) => {
    await new Promise((r) => setTimeout(r, Math.random() * 3));
    return { current: t.tenancy.currentId(), body: req.body };
  });
  app.get('/health', async () => ({ ok: true, central: t.tenancy.isCentral() }));
  app.get('/tenant-error', async () => {
    await t.tenancy.tenants.findOrFail('ghost');
  });
  app.get('/bad-request', async () => {
    throw Object.assign(new Error('nope'), { statusCode: 400 });
  });
  app.get('/fail', async () => {
    t.tenancy.currentOrFail();
    throw new Error('handler exploded');
  });
  await app.ready();
  return { ...t, app };
}

describe('fastify adapter', () => {
  it('resolves the tenant by subdomain and exposes req.tenant', async () => {
    const { app } = await setup();
    const res = await app.inject({ url: '/whoami', headers: { host: 'bolivar.tuapp.com' } });
    expect(res.json()).toEqual({ current: 'bolivar', req: 'bolivar' });
    const central = await app.inject({ url: '/whoami', headers: { host: 'tuapp.com' } });
    expect(central.json()).toEqual({ current: null, req: null });
  });

  it('maps tenancy errors to HTTP responses and logs them with the tenant', async () => {
    const { app, tenancy, logger } = await setup();
    const unknown = await app.inject({ url: '/whoami', headers: { host: 'nobody.com' } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('TENANCY_TENANT_NOT_IDENTIFIED');
    const missing = await app.inject({ url: '/whoami', headers: { host: 'ghost.tuapp.com' } });
    expect(missing.statusCode).toBe(404);
    const suspended = await app.inject({ url: '/whoami', headers: { host: 'closed.tuapp.com' } });
    expect(suspended.statusCode).toBe(423);

    expect(tenancy.observability.errors({ tenantId: 'closed' })[0]?.code).toBe(
      'TENANCY_TENANT_SUSPENDED',
    );
    const lines = logger.find((e) => e.fields.operation === 'http.request');
    expect(lines.map((l) => [l.fields.statusCode, l.fields.tenantId, l.level])).toEqual([
      [404, null, 'warn'],
      [404, 'ghost', 'warn'],
      [423, 'closed', 'warn'],
    ]);
  });

  it('reports handler errors with the tenant, request id and route', async () => {
    const { app, tenancy, logger } = await setup();
    const res = await app.inject({ url: '/fail?x=1', headers: { host: 'bolivar.tuapp.com' } });
    expect(res.statusCode).toBe(500);
    const [tracked] = tenancy.observability.errors({ tenantId: 'bolivar' });
    expect(tracked).toMatchObject({ operation: 'http.request', message: 'handler exploded' });
    expect(tracked?.context).toMatchObject({ method: 'GET', path: '/fail', statusCode: 500 });
    expect(tracked?.context.requestId).toBeTruthy();
    const line = logger.find(
      (e) =>
        e.fields.operation === 'http.request' &&
        e.fields.outcome === 'error' &&
        e.level === 'error',
    );
    expect(line.length).toBeGreaterThanOrEqual(1);
  });

  it('can treat unidentified hosts as central and skip routes', async () => {
    const { app } = await setup({ onUnidentified: 'central' });
    expect((await app.inject({ url: '/whoami', headers: { host: 'nobody.com' } })).json()).toEqual({
      current: null,
      req: null,
    });
    expect((await app.inject({ url: '/health', headers: { host: 'nobody.com' } })).json()).toEqual({
      ok: true,
      central: true,
    });
  });

  it('keeps concurrent requests with bodies isolated', async () => {
    const { app } = await setup();
    const ids = ['bolivar', 'tigre'];
    const results = await Promise.all(
      Array.from({ length: 400 }, async (_, i) => {
        const id = ids[i % 2]!;
        const res = await app.inject({
          method: 'POST',
          url: '/echo',
          headers: { host: `${id}.tuapp.com`, 'content-type': 'application/json' },
          payload: JSON.stringify({ i }),
        });
        return { id, i, body: res.json() };
      }),
    );
    for (const r of results) expect(r.body).toEqual({ current: r.id, body: { i: r.i } });
  });

  it('answers package errors thrown in routes with their status and body', async () => {
    const { app, tenancy, logger } = await setup();
    const res = await app.inject({ url: '/tenant-error', headers: { host: 'bolivar.tuapp.com' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'TENANCY_TENANT_NOT_FOUND', message: expect.any(String) },
    });
    const [tracked] = tenancy.observability.errors({ tenantId: 'bolivar' });
    expect(tracked).toMatchObject({ operation: 'http.request', code: 'TENANCY_TENANT_NOT_FOUND' });
    expect(tracked?.context).toMatchObject({ path: '/tenant-error', statusCode: 404 });
    const line = logger.find(
      (e) => e.fields.operation === 'http.request' && 'durationMs' in e.fields,
    );
    expect(line.map((l) => [l.fields.tenantId, l.fields.statusCode])).toEqual([['bolivar', 404]]);
  });

  it("keeps Fastify's default for other errors and logs the status actually sent", async () => {
    const { app, tenancy } = await setup();
    const bad = await app.inject({ url: '/bad-request', headers: { host: 'bolivar.tuapp.com' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ statusCode: 400, message: 'nope' });
    const crash = await app.inject({ url: '/fail', headers: { host: 'bolivar.tuapp.com' } });
    expect(crash.json()).toMatchObject({ statusCode: 500, message: 'handler exploded' });
    expect(
      tenancy.observability.errors({ tenantId: 'bolivar' }).map((e) => e.context.statusCode),
    ).toEqual(expect.arrayContaining([400, 500]));
  });

  it("lets the user's own setErrorHandler win, before or after the plugin", async () => {
    for (const order of ['after', 'before'] as const) {
      const t = createTestTenancy({ centralDomains: ['tuapp.com'] });
      await t.seed(['bolivar']);
      const app = Fastify({ allowErrorHandlerOverride: false });
      const mine = (
        error: Error,
        _req: unknown,
        reply: { code(n: number): { send(b: unknown): void } },
      ) => void reply.code(418).send({ mine: error.message });
      if (order === 'before') app.setErrorHandler(mine);
      await app.register(tenancyPlugin, { tenancy: t.tenancy });
      if (order === 'after') app.setErrorHandler(mine);
      app.get('/tenant-error', async () => {
        await t.tenancy.tenants.findOrFail('ghost');
      });
      await app.ready();
      const res = await app.inject({
        url: '/tenant-error',
        headers: { host: 'bolivar.tuapp.com' },
      });
      expect(res.statusCode).toBe(418);
      expect(res.json()).toEqual({ mine: expect.stringContaining('ghost') });
      const [tracked] = t.tenancy.observability.errors({ tenantId: 'bolivar' });
      expect(tracked?.context.statusCode).toBe(418);
      await app.close();
    }
  });
});
