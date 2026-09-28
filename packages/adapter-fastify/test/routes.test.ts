import { createTestTenancy } from '@tenancy-node/testing';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { tenancyPlugin } from '@tenancy-node/adapter-fastify';

describe('fastify: optional tenancy routes', () => {
  it('serves health on any host, tenant routes only for tenants, and leaves app routes alone', async () => {
    const { tenancy, seed } = createTestTenancy({
      centralDomains: ['tuapp.com'],
      http: { me: true, theme: true, assets: true, health: true },
    });
    await seed(['bolivar']);
    await tenancy.theme.update('bolivar', { primary: '#E4002B' });
    await tenancy.run('bolivar', () => tenancy.storage().put('logo.svg', '<svg/>'));
    const app = Fastify();
    await app.register(tenancyPlugin, { tenancy });
    app.get('/tenancy/otra', async () => ({ app: true }));
    await app.ready();

    const health = await app.inject({ url: '/tenancy/health', headers: { host: '10.0.0.1' } });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', checks: {} });
    const head = await app.inject({
      method: 'HEAD',
      url: '/tenancy/health',
      headers: { host: '10.0.0.1' },
    });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');

    const css = await app.inject({
      url: '/tenancy/theme.css',
      headers: { host: 'bolivar.tuapp.com' },
    });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.body).toContain('#E4002B');
    const cached = await app.inject({
      url: '/tenancy/theme.css',
      headers: { host: 'bolivar.tuapp.com', 'if-none-match': css.headers.etag as string },
    });
    expect(cached.statusCode).toBe(304);

    const me = await app.inject({ url: '/tenancy/me', headers: { host: 'bolivar.tuapp.com' } });
    expect(me.json()).toMatchObject({ id: 'bolivar', name: 'bolivar' });
    const asset = await app.inject({
      url: '/tenancy/assets/logo.svg',
      headers: { host: 'bolivar.tuapp.com' },
    });
    expect(asset.headers['content-type']).toBe('image/svg+xml');
    expect(asset.body).toBe('<svg/>');
    const malformed = await app.inject({
      url: '/tenancy/assets/%E0%A4%A',
      headers: { host: 'bolivar.tuapp.com' },
    });
    // find-my-way rechaza el escape mal formado antes de los hooks: 400 igual, nunca 500.
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe('FST_ERR_BAD_URL');
    // Las rutas en sí (lo que usan Express y node:http) responden 400 con cuerpo de tenancy.
    const direct = await tenancy.run('bolivar', () =>
      tenancy.http.handle({ method: 'GET', path: '/tenancy/assets/%E0%A4%A', headers: {} }),
    );
    expect(direct?.status).toBe(400);
    expect(JSON.parse(String(direct?.body)).error.code).toBe('TENANCY_INVALID_STORAGE_PATH');

    expect(
      (await app.inject({ url: '/tenancy/me', headers: { host: 'tuapp.com' } })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: '/tenancy/otra', headers: { host: 'bolivar.tuapp.com' } })).json(),
    ).toEqual({ app: true });
  });
});
