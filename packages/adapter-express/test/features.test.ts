import { createTestTenancy } from '@tenancy-node/testing';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { requireFeature, tenancyMiddleware } from '@tenancy-node/adapter-express';

const config = {
  centralDomains: ['tuapp.com'],
  plans: {
    basico: { label: 'Básico', features: ['agenda'], limits: { usuarios: 1 } },
    pro: { label: 'Pro', features: ['agenda', 'reportes'] },
  },
  http: { plans: true },
};

describe('express: requireFeature', () => {
  it('lets the plan in, answers 403 with details otherwise, and serves /tenancy/plans on any host', async () => {
    const { tenancy } = createTestTenancy(config);
    await tenancy.tenants.create({ id: 'basica', plan: 'basico', domain: 'basica.tuapp.com' });
    await tenancy.tenants.create({ id: 'pro', plan: 'pro', domain: 'pro.tuapp.com' });
    const app = express();
    app.use(tenancyMiddleware(tenancy, { onUnidentified: 'central' }));
    app.get('/api/agenda', requireFeature(tenancy, 'agenda'), (_req, res) => void res.send('ok'));
    app.use('/api/reportes', requireFeature(tenancy, 'reportes', 'agenda'));
    app.get('/api/reportes', (_req, res) => void res.send('reportes'));

    expect((await request(app).get('/api/agenda').set('Host', 'basica.tuapp.com')).text).toBe('ok');
    expect((await request(app).get('/api/reportes').set('Host', 'pro.tuapp.com')).text).toBe(
      'reportes',
    );
    const denied = await request(app).get('/api/reportes').set('Host', 'basica.tuapp.com');
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({
      code: 'TENANCY_FEATURE_NOT_IN_PLAN',
      details: { feature: 'reportes', plan: 'basico' },
    });
    // Contexto central: no hay tenant.
    expect((await request(app).get('/api/agenda').set('Host', 'tuapp.com')).status).toBe(404);

    const plans = await request(app).get('/tenancy/plans').set('Host', 'otro.com');
    expect(plans.status).toBe(200);
    expect(plans.body.plans.map((p: { id: string }) => p.id)).toEqual(['basico', 'pro']);
  });

  it('passes non-tenancy errors to next()', async () => {
    const { tenancy } = createTestTenancy(config);
    const broken = {
      ...tenancy,
      features: {
        require: () => {
          throw new Error('boom');
        },
      },
    };
    const app = express();
    app.get('/x', requireFeature(broken as never, 'agenda'), (_req, res) => void res.send('no'));
    app.use(
      (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
        void res.status(500).send(error.message),
    );
    expect((await request(app).get('/x')).text).toBe('boom');
  });
});
