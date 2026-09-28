import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { createTestTenancy } from '@tenancy-node/testing';
import type { CloudEvent } from '@tenancy-node/core';
import { consumeNats, nats } from '@tenancy-node/transport-nats';
import { connect } from 'nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const waitFor = async (check: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('NATS JetStream transport', () => {
  let container: StartedTestContainer;
  let servers = '';
  beforeAll(async () => {
    container = await new GenericContainer('nats:2-alpine')
      .withCommand(['-js'])
      .withExposedPorts(4222)
      .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
      .start();
    servers = `${container.getHost()}:${container.getMappedPort(4222)}`;
  }, 180_000);
  afterAll(async () => void (await container?.stop()));

  it('persists events in the stream, deduplicates by id and delivers to durable consumers', async () => {
    const transport = nats({ servers });
    const { tenancy, seed } = createTestTenancy({ events: { transports: [transport] } });
    tenancy.events.forward('tenant.created', { transport: 'nats' });
    tenancy.events.forward('pedido.*', { transport: 'nats' });
    await seed(['bolivar']);
    await tenancy.run('bolivar', () => tenancy.events.publish('pedido.creado', { total: 450 }));
    await tenancy.events.flush();
    expect((await tenancy.health()).checks['transport:nats']?.ok).toBe(true);

    // Reenvío del mismo evento (como haría la outbox tras un fallo): el stream lo descarta.
    const event = { id: '01DUPLICADO', type: 'pedido.creado', tenantId: 'bolivar', data: { total: 1 }, time: new Date() };
    await transport.send(event as never, { source: 'test' });
    await transport.send(event as never, { source: 'test' });

    const pedidos: CloudEvent[] = [];
    const todos: CloudEvent[] = [];
    const a = await consumeNats({ servers, durable: 'pedidos', filterSubject: 'tenancy.pedido.>', handler: async (e) => void pedidos.push(e) });
    const b = await consumeNats({ servers, durable: 'todos', handler: async (e) => void todos.push(e) });
    await waitFor(() => pedidos.length === 2 && todos.length === 3);
    expect(pedidos[0]).toMatchObject({ type: 'pedido.creado', tenantid: 'bolivar', data: { total: 450 } });
    expect(todos.map((e) => e.type)).toContain('tenant.created');
    await a.stop();

    // Un consumidor durable retoma donde quedó.
    await tenancy.run('bolivar', () => tenancy.events.publish('pedido.pagado', {}));
    await tenancy.events.flush();
    const again: CloudEvent[] = [];
    const a2 = await consumeNats({ servers, durable: 'pedidos', handler: async (e) => void again.push(e) });
    await waitFor(() => again.length === 1);
    expect(again[0]?.type).toBe('pedido.pagado');
    await a2.stop();
    await b.stop();
    await tenancy.close();
  });

  it('redelivers when the handler fails and gives up after maxDeliver', async () => {
    const transport = nats({ servers, stream: 'FALLAS', subjectPrefix: 'fallas' });
    const { tenancy, seed } = createTestTenancy({ events: { transports: [transport] } });
    tenancy.events.forward('aviso', { transport: 'nats' });
    await seed(['bolivar']);
    await tenancy.run('bolivar', () => tenancy.events.publish('aviso', {}));
    await tenancy.events.flush();
    let attempts = 0;
    const errors: unknown[] = [];
    const c = await consumeNats({
      servers,
      stream: 'FALLAS',
      durable: 'siempre-falla',
      maxDeliver: 3,
      onError: (e) => errors.push(e),
      handler: async () => {
        attempts++;
        throw new Error('no');
      },
    });
    await waitFor(() => attempts === 3);
    await new Promise((r) => setTimeout(r, 800));
    expect(attempts).toBe(3);
    expect(errors).toHaveLength(3);
    await c.stop();
    await tenancy.close();
  });

  it('fails health when the server is unreachable', async () => {
    const transport = nats({ servers: '127.0.0.1:1', connection: { reconnect: false, timeout: 500 } });
    await expect(transport.ping!()).rejects.toThrow();
    await transport.close!();
    const nc = await connect({ servers });
    await nc.close();
  });

  it('passes connection options (auth) to the consumer', async () => {
    const secured = await new GenericContainer('nats:2-alpine')
      .withCommand(['-js', '--auth', 's3cret'])
      .withExposedPorts(4222)
      .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
      .start();
    try {
      const target = `${secured.getHost()}:${secured.getMappedPort(4222)}`;
      const transport = nats({ servers: target, connection: { token: 's3cret' } });
      const { tenancy, seed } = createTestTenancy({ events: { transports: [transport] } });
      tenancy.events.forward('tenant.created', { transport: 'nats' });
      await seed(['bolivar']);
      await tenancy.events.flush();

      // Sin credenciales el servidor rechaza la conexión.
      await expect(
        consumeNats({ servers: target, durable: 'sin-token', handler: async () => undefined, connection: { reconnect: false } }),
      ).rejects.toThrow(/authorization/i);
      const seen: CloudEvent[] = [];
      const c = await consumeNats({
        servers: target,
        durable: 'con-token',
        connection: { token: 's3cret' },
        handler: async (e) => void seen.push(e),
      });
      await waitFor(() => seen.length === 1);
      expect(seen[0]).toMatchObject({ type: 'tenant.created', tenantid: 'bolivar' });
      await c.stop();
      await tenancy.close();
    } finally {
      await secured.stop();
    }
  }, 180_000);
});
