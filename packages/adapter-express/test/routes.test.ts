import { createTestTenancy } from '@tenancy-node/testing';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { tenancyMiddleware } from '@tenancy-node/adapter-express';

describe('express: optional tenancy routes', () => {
  it('serves health, theme.css and /me', async () => {
    const { tenancy, seed } = createTestTenancy({
      centralDomains: ['tuapp.com'],
      http: { me: true, theme: true, health: true },
    });
    await seed(['bolivar']);
    const app = express();
    app.use(tenancyMiddleware(tenancy));
    app.get('/ping', (_req, res) => void res.send('pong'));

    expect((await request(app).get('/tenancy/health').set('Host', 'unknown.com')).body).toEqual({
      status: 'ok',
      checks: {},
    });
    const css = await request(app).get('/tenancy/theme.css').set('Host', 'bolivar.tuapp.com');
    expect(css.status).toBe(200);
    expect(css.text).toContain('--color-primary');
    expect(
      (
        await request(app)
          .get('/tenancy/theme.css')
          .set('Host', 'bolivar.tuapp.com')
          .set('If-None-Match', css.headers.etag as string)
      ).status,
    ).toBe(304);
    expect(
      (await request(app).get('/tenancy/me').set('Host', 'bolivar.tuapp.com')).body,
    ).toMatchObject({ id: 'bolivar' });
    expect(
      (await request(app).get('/tenancy/assets/x.png').set('Host', 'bolivar.tuapp.com')).status,
    ).toBe(404);
    expect((await request(app).get('/ping').set('Host', 'bolivar.tuapp.com')).text).toBe('pong');
    expect((await request(app).head('/tenancy/health').set('Host', 'unknown.com')).status).toBe(
      200,
    );
  });

  it('matches the routes by full path when mounted under a sub-path, and logs health', async () => {
    const { tenancy, seed, logger } = createTestTenancy({
      centralDomains: ['tuapp.com'],
      http: { me: true, health: true, assets: true, prefix: '/api/tenancy' },
    });
    await seed(['bolivar']);
    const app = express();
    app.use('/api', tenancyMiddleware(tenancy));
    app.get('/api/ping', (_req, res) => void res.send('pong'));

    const health = await request(app).get('/api/tenancy/health?x=1').set('Host', 'unknown.com');
    expect(health.body).toEqual({ status: 'ok', checks: {} });
    const me = await request(app).get('/api/tenancy/me').set('Host', 'bolivar.tuapp.com');
    expect(me.body).toMatchObject({ id: 'bolivar' });
    const malformed = await request(app)
      .get('/api/tenancy/assets/%E0%A4%A')
      .set('Host', 'bolivar.tuapp.com');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('TENANCY_INVALID_STORAGE_PATH');
    expect((await request(app).get('/api/ping').set('Host', 'bolivar.tuapp.com')).text).toBe(
      'pong',
    );

    await new Promise((r) => setTimeout(r, 10));
    const lines = logger.find(
      (e) => e.fields.operation === 'http.request' && 'durationMs' in e.fields,
    );
    expect(lines.map((l) => [l.fields.path, l.fields.statusCode, l.fields.tenantId])).toEqual([
      ['/api/tenancy/health', 200, null],
      ['/api/tenancy/me', 200, 'bolivar'],
      ['/api/tenancy/assets/%E0%A4%A', 400, 'bolivar'],
      ['/api/ping', 200, 'bolivar'],
    ]);
  });
});
