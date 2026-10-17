import { createTestTenancy } from '@tenancy-node/testing';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { requireFeature, tenancyPlugin } from '@tenancy-node/adapter-fastify';

describe('fastify: requireFeature', () => {
  it('protects routes and groups by plan module', async () => {
    const { tenancy } = createTestTenancy({
      centralDomains: ['tuapp.com'],
      plans: {
        basico: { label: 'Básico', features: ['agenda'] },
        pro: { label: 'Pro', features: ['agenda', 'reportes'] },
      },
      http: { plans: true },
    });
    await tenancy.tenants.create({ id: 'basica', plan: 'basico', domain: 'basica.tuapp.com' });
    await tenancy.tenants.create({ id: 'pro', plan: 'pro', domain: 'pro.tuapp.com' });
    const app = Fastify();
    await app.register(tenancyPlugin, { tenancy });
    app.get('/api/agenda', { preHandler: requireFeature(tenancy, 'agenda') }, async () => 'ok');
    await app.register(async (instance) => {
      instance.addHook('preHandler', requireFeature(tenancy, 'reportes'));
      instance.get('/api/reportes', async () => 'reportes');
    });
    await app.ready();

    const inject = (url: string, host: string) => app.inject({ url, headers: { host } });
    expect((await inject('/api/agenda', 'basica.tuapp.com')).body).toBe('ok');
    expect((await inject('/api/reportes', 'pro.tuapp.com')).body).toBe('reportes');
    const denied = await inject('/api/reportes', 'basica.tuapp.com');
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatchObject({
      code: 'TENANCY_FEATURE_NOT_IN_PLAN',
      details: { feature: 'reportes' },
    });
    const plans = await inject('/tenancy/plans', '10.0.0.1');
    expect(plans.statusCode).toBe(200);
    expect(plans.json().plans).toHaveLength(2);
  });

  it('rethrows non-tenancy errors', async () => {
    const broken = {
      features: {
        require: () => {
          throw new Error('boom');
        },
      },
    };
    await expect(requireFeature(broken as never, 'x')({} as never, {} as never)).rejects.toThrow(
      'boom',
    );
  });
});
