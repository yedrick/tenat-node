import { createTestTenancy } from '@tenancy-node/testing';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { tenancyErrorHandler, tenancyMiddleware } from '@tenancy-node/adapter-express';

async function setup() {
  const t = createTestTenancy({ centralDomains: ['tuapp.com'] });
  await t.seed(['bolivar', 'tigre']);
  const app = express();
  app.use(express.json());
  app.use(tenancyMiddleware(t.tenancy, { skip: (req) => req.path === '/health' }));
  app.get('/whoami', (req, res) => {
    res.json({ current: t.tenancy.currentId() ?? null, req: req.tenant?.id.value ?? null });
  });
  app.post('/echo', async (req, res) => {
    await new Promise((r) => setTimeout(r, Math.random() * 3));
    res.json({ current: t.tenancy.currentId(), body: req.body });
  });
  app.get('/health', (_req, res) => void res.json({ ok: true }));
  app.get('/tenant-error', async () => {
    await t.tenancy.tenants.findOrFail('ghost');
  });
  app.get('/crash', () => {
    throw new Error('crash');
  });
  app.use(tenancyErrorHandler(t.tenancy));
  app.use(
    ((_err, _req, res, _next) =>
      void res.status(500).json({ custom: true })) as express.ErrorRequestHandler,
  );
  return { ...t, app };
}

describe('express adapter', () => {
  it('resolves the tenant and runs routes in its context', async () => {
    const { app } = await setup();
    const res = await request(app).get('/whoami').set('Host', 'bolivar.tuapp.com');
    expect(res.body).toEqual({ current: 'bolivar', req: 'bolivar' });
    expect((await request(app).get('/whoami').set('Host', 'tuapp.com')).body).toEqual({
      current: null,
      req: null,
    });
    expect((await request(app).get('/health').set('Host', 'nobody.com')).body).toEqual({
      ok: true,
    });
  });

  it('answers tenancy errors with their status and logs every request', async () => {
    const { app, tenancy, logger } = await setup();
    const res = await request(app).get('/whoami').set('Host', 'nobody.com');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TENANCY_TENANT_NOT_IDENTIFIED');

    const tenantError = await request(app).get('/tenant-error').set('Host', 'bolivar.tuapp.com');
    expect(tenantError.status).toBe(404);
    const crash = await request(app)
      .get('/crash')
      .set('Host', 'tigre.tuapp.com')
      .set('X-Request-Id', 'abc');
    expect(crash.body).toEqual({ custom: true });

    expect(tenancy.observability.errors({ tenantId: 'tigre' })[0]).toMatchObject({
      operation: 'http.request',
      message: 'crash',
      context: { requestId: 'abc', path: '/crash', method: 'GET' },
    });
    await new Promise((r) => setTimeout(r, 10));
    const lines = logger.find(
      (e) =>
        e.fields.operation === 'http.request' &&
        'statusCode' in e.fields &&
        'durationMs' in e.fields,
    );
    expect(lines.map((l) => [l.fields.tenantId, l.fields.statusCode])).toEqual([
      [null, 404],
      ['bolivar', 404],
      ['tigre', 500],
    ]);
  });

  it('keeps concurrent requests with bodies isolated', async () => {
    const { app } = await setup();
    const server = app.listen(0);
    try {
      const ids = ['bolivar', 'tigre'];
      const results = await Promise.all(
        Array.from({ length: 200 }, async (_, i) => {
          const id = ids[i % 2]!;
          const res = await request(server)
            .post('/echo')
            .set('Host', `${id}.tuapp.com`)
            .send({ i });
          return { id, i, body: res.body };
        }),
      );
      for (const r of results) expect(r.body).toEqual({ current: r.id, body: { i: r.i } });
    } finally {
      server.close();
    }
  });
});
