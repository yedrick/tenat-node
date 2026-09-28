import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { createServer } from 'node:net';
import { createTestTenancy } from '@tenancy-node/testing';
import type { CloudEvent } from '@tenancy-node/core';
import { consumeKafka, kafka } from '@tenancy-node/transport-kafka';
import { Kafka, logLevel } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const waitFor = async (check: () => boolean, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};

// Kafka anuncia su dirección a los clientes: el puerto del host tiene que ser fijo y conocido.
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('Kafka transport', () => {
  let container: StartedTestContainer;
  let brokers: string[] = [];
  beforeAll(async () => {
    const port = await freePort();
    container = await new GenericContainer('apache/kafka:3.9.0')
      .withExposedPorts({ container: 9092, host: port })
      .withEnvironment({
        KAFKA_NODE_ID: '1',
        KAFKA_PROCESS_ROLES: 'broker,controller',
        KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
        KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:${port}`,
        KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
        KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
        KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
        KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
        KAFKA_NUM_PARTITIONS: '3',
      })
      .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
      .start();
    brokers = [`127.0.0.1:${port}`];
    const admin = new Kafka({ brokers, logLevel: logLevel.NOTHING }).admin();
    await admin.connect();
    await admin.createTopics({ waitForLeaders: true, topics: [{ topic: 'tenancy.events', numPartitions: 3 }, { topic: 'otros' }] });
    await admin.disconnect();
  }, 240_000);
  afterAll(async () => void (await container?.stop()));

  it('publishes CloudEvents keyed by tenant and a consumer group receives them in order', async () => {
    const received: CloudEvent[] = [];
    const transport = kafka({ brokers, kafka: { logLevel: logLevel.NOTHING } });
    const { tenancy, seed } = createTestTenancy({ events: { transports: [transport] } });
    tenancy.events.forward('pedido.*', { transport: 'kafka' });
    await seed(['bolivar', 'tigre']);
    await tenancy.run('bolivar', () => tenancy.events.publish('pedido.creado', { n: -1 }));
    await tenancy.events.flush();
    expect((await tenancy.health()).checks['transport:kafka']?.ok).toBe(true);
    // Envíos en secuencia (como la outbox): la clave es el tenant y cada tenant conserva su orden.
    for (let i = 0; i < 5; i++) {
      for (const tenantId of ['bolivar', 'tigre']) {
        await transport.send({ id: `${tenantId}-${i}`, type: 'pedido.creado', tenantId, data: { n: i }, time: new Date() } as never, { source: 'test' });
      }
    }

    const consumer = await consumeKafka({ brokers, groupId: 'emails', kafka: { logLevel: logLevel.NOTHING }, handler: async (e) => void received.push(e) });
    await waitFor(() => received.length === 11);
    expect(received.filter((e) => e.tenantid === 'bolivar').map((e) => (e.data as { n: number }).n)).toEqual([-1, 0, 1, 2, 3, 4]);
    expect(received.filter((e) => e.tenantid === 'tigre').map((e) => (e.data as { n: number }).n)).toEqual([0, 1, 2, 3, 4]);
    expect(received[0]).toMatchObject({ specversion: '1.0', type: 'pedido.creado' });
    await consumer.stop();
    await tenancy.close();
  }, 120_000);

  it('retries a message whose handler fails and routes to a custom topic', async () => {
    const transport = kafka({ brokers, topic: 'otros', kafka: { logLevel: logLevel.NOTHING } });
    let attempts = 0;
    const errors: unknown[] = [];
    const consumer = await consumeKafka({
      brokers,
      groupId: 'reintentos',
      kafka: { logLevel: logLevel.NOTHING },
      topics: ['otros'],
      onError: (e) => errors.push(e),
      handler: async () => {
        if (++attempts < 3) throw new Error('falla temporal');
      },
    });
    const { tenancy, seed } = createTestTenancy({ events: { transports: [transport] } });
    tenancy.events.forward('aviso', { transport: 'kafka' });
    await seed(['bolivar']);
    await tenancy.run('bolivar', () => tenancy.events.publish('aviso', {}));
    await tenancy.events.flush();
    await waitFor(() => attempts >= 3, 60_000);
    expect(errors).toHaveLength(2);
    await consumer.stop();
    await tenancy.close();
  }, 120_000);

  it('fails health when the broker is unreachable', async () => {
    const transport = kafka({ brokers: ['127.0.0.1:1'], kafka: { retry: { retries: 0 }, connectionTimeout: 300, logLevel: logLevel.NOTHING } });
    await expect(transport.ping!()).rejects.toThrow();
    await transport.close!();
  });
});
