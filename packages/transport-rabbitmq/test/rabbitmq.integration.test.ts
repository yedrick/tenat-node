import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { createTestTenancy } from '@tenancy-node/testing';
import type { CloudEvent } from '@tenancy-node/core';
import { consumeRabbitmq, rabbitmq } from '@tenancy-node/transport-rabbitmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const waitFor = async (check: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('RabbitMQ transport', () => {
  let container: StartedTestContainer;
  let url = '';
  beforeAll(async () => {
    container = await new GenericContainer('rabbitmq:4-alpine')
      .withExposedPorts(5672)
      .withWaitStrategy(Wait.forLogMessage(/Server startup complete/))
      .start();
    url = `amqp://guest:guest@${container.getHost()}:${container.getMappedPort(5672)}`;
  }, 240_000);
  afterAll(async () => void (await container?.stop()));

  it('routes events by type with topic bindings, confirmed by the broker', async () => {
    const received: Record<string, CloudEvent[]> = { emails: [], pedidos: [] };
    const emails = await consumeRabbitmq({
      url,
      queue: 'emails',
      bindings: ['tenant.created'],
      handler: async (e) => void received.emails!.push(e),
    });
    const pedidos = await consumeRabbitmq({
      url,
      queue: 'pedidos',
      bindings: ['pedido.*'],
      handler: async (e) => void received.pedidos!.push(e),
    });

    const { tenancy, seed } = createTestTenancy({ events: { transports: [rabbitmq({ url })] } });
    tenancy.events.forward('tenant.created', { transport: 'rabbitmq' });
    tenancy.events.forward('pedido.*', { transport: 'rabbitmq' });
    await seed(['bolivar']);
    await tenancy.run('bolivar', () => tenancy.events.publish('pedido.creado', { total: 450 }));
    await tenancy.events.flush();

    await waitFor(() => received.emails!.length === 1 && received.pedidos!.length === 1);
    expect(received.emails![0]).toMatchObject({
      type: 'tenant.created',
      tenantid: 'bolivar',
      data: { id: 'bolivar' },
    });
    expect(received.pedidos![0]).toMatchObject({ type: 'pedido.creado', data: { total: 450 } });
    expect((await tenancy.health()).checks['transport:rabbitmq']?.ok).toBe(true);
    await emails.stop();
    await pedidos.stop();
    await tenancy.close();
  });

  it('redelivers a message whose handler failed, and gives up after maxAttempts', async () => {
    let flakyCalls = 0;
    let poisonCalls = 0;
    const errors: unknown[] = [];
    const consumer = await consumeRabbitmq({
      url,
      queue: 'reintentos',
      bindings: ['flaky.*', 'poison.*'],
      maxAttempts: 3,
      onError: (e) => void errors.push(e),
      handler: async (e) => {
        if (e.type === 'flaky.event' && ++flakyCalls < 2) throw new Error('temporal');
        if (e.type === 'poison.event') {
          poisonCalls++;
          throw new Error('siempre falla');
        }
      },
    });
    const { tenancy } = createTestTenancy({ events: { transports: [rabbitmq({ url })] } });
    tenancy.events.forward('*', { transport: 'rabbitmq' });
    await tenancy.events.publish('flaky.event', {});
    await tenancy.events.publish('poison.event', {});
    await tenancy.events.flush();
    await waitFor(() => flakyCalls === 2 && poisonCalls === 3);
    await new Promise((r) => setTimeout(r, 300));
    expect(poisonCalls).toBe(3);
    expect(errors).toHaveLength(4);
    await consumer.stop();
    await tenancy.close();
  });

  it('fails the send (so the outbox retries) when the broker is unreachable', async () => {
    const transport = rabbitmq({ url: 'amqp://guest:guest@127.0.0.1:1' });
    await expect(
      transport.send(
        { id: '1', type: 'x', tenantId: null, time: new Date(), data: {} },
        { source: 's' },
      ),
    ).rejects.toThrow();
    await transport.close();
  });
});
