import { createServer, type IncomingMessage, type Server } from 'node:http';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTenancy, parseCloudEvent } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { outbox } from '@tenancy-node/outbox';
import { MemoryLogger } from '@tenancy-node/testing';
import {
  SIGNATURE_HEADER,
  UnsafeWebhookUrlError,
  verifyWebhook,
  webhooks,
  type WebhooksOptions,
} from '@tenancy-node/transport-webhook';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

interface Received {
  path: string;
  body: string;
  headers: IncomingMessage['headers'];
}

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('webhooks (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let url = '';
  let server: Server;
  let base = '';
  let received: Received[] = [];
  /** Respuesta por ruta: número de estado o función. */
  let respond: Record<string, number> = {};
  let n = 0;
  const open: { close(): Promise<void> }[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withUsername('admin')
      .withPassword('secret')
      .withDatabase('app')
      .start();
    url = `postgres://admin:secret@${container.getHost()}:${container.getPort()}/app`;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ path: req.url!, body, headers: req.headers });
        res
          .writeHead(respond[req.url!] ?? 200)
          .end(respond[req.url!] ? 'error del receptor' : 'ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 300_000);
  afterEach(async () => {
    received = [];
    respond = {};
    for (const t of open.splice(0)) await t.close();
  });
  afterAll(async () => {
    server?.close();
    await container?.stop();
  });

  /** `shared`: prefijo de otra instancia, para simular varios procesos sobre las mismas tablas. */
  const make = async (options: WebhooksOptions = {}, shared?: string) => {
    const p = shared ?? `w${++n}_`;
    const tenancy = createTenancy({
      logger: new MemoryLogger(),
      centralDomains: ['tuapp.com'],
      plugins: [
        database({
          driver: postgres(),
          central: { url },
          tablePrefix: p,
          prefix: `${p}t_`,
          encryptionKey: 'base64:' + Buffer.alloc(32, 3).toString('base64'),
        }),
        outbox({ baseDelayMs: 1 }),
        webhooks({
          allowPrivateNetworks: true,
          retrySchedule: [10, 10],
          circuitThreshold: 3,
          circuitCooldownMs: 60_000,
          ...options,
        }),
      ],
    });
    open.push(tenancy);
    if (!shared) await tenancy.database.install();
    return Object.assign(tenancy, { prefix: p });
  };

  /** outbox → transporte webhooks → entregas → envío HTTP */
  const pump = async (tenancy: Awaited<ReturnType<typeof make>>) => {
    await tenancy.outbox.relayOnce();
    return tenancy.webhooks.dispatchOnce();
  };

  it('delivers signed CloudEvents to global and per-tenant endpoints', async () => {
    const tenancy = await make();
    await tenancy.tenants.create({ id: 'bolivar' });
    await tenancy.tenants.create({ id: 'tigre' });
    // Los eventos anteriores salen antes de registrar los endpoints (la coincidencia se decide al entregar)
    await pump(tenancy);
    const global = await tenancy.webhooks.register({
      name: 'CRM',
      url: `${base}/global`,
      events: ['tenant.created', 'pedido.*'],
    });
    const bolivar = await tenancy.webhooks.register({
      tenant: 'bolivar',
      name: 'ERP Bolívar',
      url: `${base}/bolivar`,
      events: ['pedido.*'],
    });
    expect(global.secret).toMatch(/^whsec_/);

    await tenancy.tenants.create({ id: 'wilster' });
    await tenancy.run('bolivar', () => tenancy.events.publish('pedido.creado', { total: 450 }));
    await tenancy.run('tigre', () => tenancy.events.publish('pedido.creado', { total: 99 }));
    expect(await pump(tenancy)).toEqual({ sent: 4, failed: 0, dead: 0 });

    const byPath = (p: string) =>
      received.filter((r) => r.path === p).map((r) => parseCloudEvent<{ total?: number }>(r.body));
    expect(
      byPath('/global')
        .map((e) => `${e.type}:${e.tenantid}`)
        .sort(),
    ).toEqual(['pedido.creado:bolivar', 'pedido.creado:tigre', 'tenant.created:wilster']);
    expect(byPath('/bolivar').map((e) => `${e.type}:${e.tenantid}`)).toEqual([
      'pedido.creado:bolivar',
    ]);

    // El receptor verifica la firma con el secreto que recibió al registrar el endpoint
    for (const r of received) {
      const secret = r.path === '/global' ? global.secret : bolivar.secret;
      expect(
        verifyWebhook({ secret, body: r.body, header: r.headers[SIGNATURE_HEADER] as string }),
      ).toBe(true);
      expect(r.headers['content-type']).toBe('application/cloudevents+json');
      expect(r.headers['x-tenancy-event']).toMatch(/\./);
    }
    const history = await tenancy.webhooks.deliveries(global.endpoint.id);
    expect(history.map((d) => [d.status, d.httpStatus, d.attempt])).toEqual([
      ['success', 200, 1],
      ['success', 200, 1],
      ['success', 200, 1],
    ]);
    // Reenviar el mismo evento (at-least-once) no crea una entrega nueva
    await tenancy.outbox.retry('all');
    expect(await pump(tenancy)).toEqual({ sent: 0, failed: 0, dead: 0 });
  });

  it('retries, opens the circuit after repeated failures, dead-letters and redelivers', async () => {
    const tenancy = await make({
      retrySchedule: [10, 10],
      circuitThreshold: 2,
      // Con margen: bajo cobertura (más lento) una pausa corta vencería antes de comprobarla.
      circuitCooldownMs: 800,
    });
    const { endpoint } = await tenancy.webhooks.register({
      name: 'Caído',
      url: `${base}/down`,
      events: ['*'],
    });
    respond['/down'] = 500;
    await tenancy.events.publish('pedido.creado', {});
    await tenancy.outbox.relayOnce();

    expect((await tenancy.webhooks.dispatchOnce()).failed).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect((await tenancy.webhooks.dispatchOnce()).failed).toBe(1);
    // Dos fallos seguidos: circuito abierto y endpoint en pausa
    expect(await tenancy.webhooks.get(endpoint.id)).toMatchObject({
      circuitState: 'open',
      consecutiveFailures: 2,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(await tenancy.webhooks.dispatchOnce()).toEqual({ sent: 0, failed: 0, dead: 0 });

    await new Promise((r) => setTimeout(r, 850));
    await tenancy.webhooks.dispatchOnce(); // pausa vencida → half_open → último intento falla → dead
    const [delivery] = await tenancy.webhooks.deliveries(endpoint.id);
    expect(delivery).toMatchObject({
      status: 'dead',
      attempt: 3,
      httpStatus: 500,
      responseBody: 'error del receptor',
      lastError: 'HTTP 500',
    });
    const operations = tenancy.observability.errors().map((e) => e.operation);
    expect(operations).toEqual(
      expect.arrayContaining(['webhook.deliver', 'webhook.circuit_open', 'webhook.dead']),
    );

    // Se arregla el receptor: reactivar (cierra el circuito) y reenviar desde dead-letter
    respond = {};
    await tenancy.webhooks.update(endpoint.id, { active: true });
    await tenancy.webhooks.redeliver(delivery!.id);
    expect((await tenancy.webhooks.dispatchOnce()).sent).toBe(1);
    expect(await tenancy.webhooks.get(endpoint.id)).toMatchObject({
      circuitState: 'closed',
      consecutiveFailures: 0,
    });
  });

  it('manages endpoints: test, update, rotate secret and remove', async () => {
    const tenancy = await make();
    const { endpoint } = await tenancy.webhooks.register({
      name: 'Prueba',
      url: `${base}/test`,
      events: ['tenant.*'],
    });
    const result = await tenancy.webhooks.test(endpoint.id);
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(parseCloudEvent(received[0]!.body).type).toBe('webhook.test');

    const updated = await tenancy.webhooks.update(endpoint.id, {
      name: 'Renombrado',
      events: ['pedido.*'],
    });
    expect(updated).toMatchObject({ name: 'Renombrado', events: ['pedido.*'] });
    const secret = await tenancy.webhooks.rotateSecret(endpoint.id);
    await tenancy.webhooks.test(endpoint.id);
    expect(
      verifyWebhook({
        secret,
        body: received[1]!.body,
        header: received[1]!.headers[SIGNATURE_HEADER] as string,
      }),
    ).toBe(true);
    expect(await tenancy.webhooks.list({ tenant: null })).toHaveLength(1);
    await tenancy.webhooks.remove(endpoint.id);
    expect(await tenancy.webhooks.list()).toEqual([]);
    await expect(tenancy.webhooks.remove(endpoint.id)).rejects.toThrow(/not found/);
    await expect(
      tenancy.webhooks.register({ name: 'x', url: `${base}/x`, events: [] }),
    ).rejects.toThrow(/events/);
    await expect(
      tenancy.webhooks.register({ tenant: 'nadie', name: 'x', url: `${base}/x`, events: ['*'] }),
    ).rejects.toThrow(/not found/);
  });

  it('blocks internal destinations unless explicitly allowed', async () => {
    const tenancy = await make({ allowPrivateNetworks: false });
    await expect(
      tenancy.webhooks.register({
        name: 'SSRF',
        url: 'http://169.254.169.254/latest/meta-data',
        events: ['*'],
      }),
    ).rejects.toThrow(UnsafeWebhookUrlError);
    await expect(
      tenancy.webhooks.register({ name: 'Local', url: `${base}/x`, events: ['*'] }),
    ).rejects.toThrow(UnsafeWebhookUrlError);
  });

  it('times out slow receivers and runs the dispatcher in the background', async () => {
    const slow = createServer((_req, res) => setTimeout(() => res.end('tarde'), 500));
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const tenancy = await make({ timeoutMs: 100, pollIntervalMs: 20 });
    const { endpoint } = await tenancy.webhooks.register({
      name: 'Lento',
      url: `http://127.0.0.1:${(slow.address() as { port: number }).port}/`,
      events: ['*'],
    });
    await tenancy.events.publish('pedido.creado', {});
    await tenancy.outbox.relayOnce();
    const dispatcher = tenancy.webhooks.startDispatcher();
    const deadline = Date.now() + 5000;
    let deliveries = await tenancy.webhooks.deliveries(endpoint.id);
    while (deliveries[0]?.attempt !== 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
      deliveries = await tenancy.webhooks.deliveries(endpoint.id);
    }
    await dispatcher.stop();
    slow.close();
    expect(deliveries[0]).toMatchObject({
      status: 'failed',
      lastError: 'timeout after 100 ms',
      httpStatus: null,
    });
  });

  it('never sends a delivery twice with several dispatchers running in parallel', async () => {
    const total = 120;
    const first = await make({ batchSize: 2 });
    // Varias instancias (cada una con su pool) sobre las mismas tablas, como varios procesos.
    const instances = [first];
    for (let i = 0; i < 5; i++) instances.push(await make({ batchSize: 2 }, first.prefix));
    await first.webhooks.register({ name: 'Paralelo', url: `${base}/parallel`, events: ['pedido.*'] });
    for (let i = 0; i < total; i++) await first.events.publish('pedido.creado', { i });
    while ((await first.outbox.relayOnce()).claimed > 0);

    // Cada instancia despacha en bucle hasta que no quedan entregas vencidas.
    const drain = async (tenancy: typeof first) => {
      let sent = 0;
      for (;;) {
        const run = await tenancy.webhooks.dispatchOnce();
        sent += run.sent + run.failed;
        if (run.sent + run.failed === 0) return sent;
      }
    };
    const counts = await Promise.all(instances.map(drain));
    expect(counts.reduce((sum, c) => sum + c, 0)).toBe(total);

    const ids = received
      .filter((r) => r.path === '/parallel')
      .map((r) => parseCloudEvent(r.body).id);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
  });
});
