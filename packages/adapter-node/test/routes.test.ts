import { createServer } from 'node:http';
import { createTestTenancy } from '@tenancy-node/testing';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { withTenancy } from '@tenancy-node/adapter-node';

describe('node:http: optional tenancy routes', () => {
  it('serves health and /me before the handler', async () => {
    const { tenancy, seed } = createTestTenancy({
      centralDomains: ['tuapp.com'],
      http: { me: true, health: true },
      publicFields: ['name', 'pais'],
    });
    await seed(['bolivar']);
    await tenancy.tenants.update('bolivar', { data: { pais: 'BO' } });
    const server = createServer(withTenancy(tenancy, (_req, res) => void res.end('handler')));
    expect((await request(server).get('/tenancy/health').set('Host', '127.0.0.1')).status).toBe(
      200,
    );
    const head = await request(server).head('/tenancy/health').set('Host', '127.0.0.1');
    expect(head.status).toBe(200);
    expect(
      (await request(server).get('/tenancy/me').set('Host', 'bolivar.tuapp.com')).body,
    ).toMatchObject({ id: 'bolivar', pais: 'BO' });
    expect(
      (await request(server).get('/tenancy/theme.css').set('Host', 'bolivar.tuapp.com')).text,
    ).toBe('handler');
  });
});
