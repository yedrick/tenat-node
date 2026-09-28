import { createServer } from 'node:http';
import { createTestTenancy } from '@tenancy-node/testing';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { withTenancy } from '@tenancy-node/adapter-node';

async function setup() {
  const t = createTestTenancy({ centralDomains: ['tuapp.com'] });
  await t.seed(['bolivar', 'tigre']);
  const server = createServer(
    withTenancy(t.tenancy, async (req, res) => {
      if (req.url === '/fail') throw new Error('boom');
      if (req.url === '/late-fail') {
        res.writeHead(200);
        res.write('partial');
        throw new Error('late');
      }
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          current: t.tenancy.currentId() ?? null,
          req: req.tenant?.id.value ?? null,
        }),
      );
    }),
  );
  return { ...t, server };
}

describe('node:http adapter', () => {
  it('runs the handler in the tenant context', async () => {
    const { server } = await setup();
    expect((await request(server).get('/').set('Host', 'bolivar.tuapp.com')).body).toEqual({
      current: 'bolivar',
      req: 'bolivar',
    });
    expect((await request(server).get('/').set('Host', 'tuapp.com')).body).toEqual({
      current: null,
      req: null,
    });
  });

  it('maps errors to responses and reports them per tenant', async () => {
    const { server, tenancy, logger } = await setup();
    expect((await request(server).get('/').set('Host', 'x.com')).status).toBe(404);
    const fail = await request(server).get('/fail').set('Host', 'tigre.tuapp.com');
    expect(fail.status).toBe(500);
    expect(fail.body.error.code).toBe('TENANCY_INTERNAL_ERROR');
    await request(server)
      .get('/late-fail')
      .set('Host', 'tigre.tuapp.com')
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(tenancy.observability.errors({ tenantId: 'tigre' }).map((e) => e.message)).toEqual([
      'late',
      'boom',
    ]);
    const lines = logger.find(
      (e) => e.fields.operation === 'http.request' && 'durationMs' in e.fields,
    );
    expect(lines.map((l) => l.fields.statusCode)).toContain(500);
  });

  it('keeps concurrent requests isolated', async () => {
    const { server } = await setup();
    server.listen(0);
    try {
      const ids = ['bolivar', 'tigre'];
      const results = await Promise.all(
        Array.from({ length: 200 }, async (_, i) => {
          const id = ids[i % 2]!;
          return { id, body: (await request(server).get('/').set('Host', `${id}.tuapp.com`)).body };
        }),
      );
      for (const r of results) expect(r.body.current).toBe(r.id);
    } finally {
      server.close();
    }
  });
});
