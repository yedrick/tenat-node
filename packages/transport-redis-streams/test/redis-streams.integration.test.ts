import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { createTestTenancy } from '@tenancy-node/testing';
import type { CloudEvent } from '@tenancy-node/core';
import { consumeRedisStream, redisStreams } from '@tenancy-node/transport-redis-streams';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const waitFor = async (check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('Redis Streams transport', () => {
  let container: StartedTestContainer;
  let url = '';
  beforeAll(async () => {
    container = await new GenericContainer('valkey/valkey:8-alpine').withExposedPorts(6379).start();
    url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  }, 180_000);
  afterAll(async () => void (await container?.stop()));

  it('publishes CloudEvents to a stream and a consumer group processes them once', async () => {
    const transport = redisStreams({ url, stream: 'tenancy:test1' });
    const { tenancy, seed } = createTestTenancy({ events: { transports: [transport] } });
    tenancy.events.forward('tenant.created', { transport: 'redis-streams' });
    await seed(['bolivar', 'tigre']);
    await tenancy.events.flush();

    const seen: CloudEvent[] = [];
    const a = consumeRedisStream({
      url,
      stream: 'tenancy:test1',
      group: 'emails',
      consumer: 'a',
      handler: async (e) => void seen.push(e),
    });
    const b = consumeRedisStream({
      url,
      stream: 'tenancy:test1',
      group: 'emails',
      consumer: 'b',
      handler: async (e) => void seen.push(e),
    });
    await waitFor(() => seen.length === 2);
    await new Promise((r) => setTimeout(r, 300));
    await a.stop();
    await b.stop();
    // Dos consumidores del mismo grupo se reparten los mensajes: cada evento se procesa una vez
    expect(seen.map((e) => `${e.type}:${e.tenantid}`).sort()).toEqual([
      'tenant.created:bolivar',
      'tenant.created:tigre',
    ]);
    expect(seen[0]!.specversion).toBe('1.0');
    expect((await tenancy.health()).checks['transport:redis-streams']?.ok).toBe(true);
    await tenancy.close();
  });

  it('retries a message the handler failed (pending entries are reclaimed)', async () => {
    const transport = redisStreams({ url, stream: 'tenancy:test2' });
    const { tenancy } = createTestTenancy({ events: { transports: [transport] } });
    tenancy.events.forward('pedido.*', { transport: 'redis-streams' });
    await tenancy.events.publish('pedido.creado', { n: 1 });
    await tenancy.events.flush();

    let calls = 0;
    const errors: unknown[] = [];
    const consumer = consumeRedisStream({
      url,
      stream: 'tenancy:test2',
      group: 'facturas',
      consumer: 'c1',
      claimIdleMs: 50,
      blockMs: 100,
      handler: async () => {
        calls++;
        if (calls === 1) throw new Error('falla temporal');
      },
      onError: (e) => void errors.push(e),
    });
    await waitFor(() => calls === 2);
    await consumer.stop();
    expect(errors).toHaveLength(1);
    const pending = (await transport.client.xpending('tenancy:test2', 'facturas')) as [
      number,
      ...unknown[],
    ];
    expect(pending[0]).toBe(0);
    await tenancy.close();
  });

  it('discards a message that always fails after maxAttempts and copies it to the dead-letter stream', async () => {
    const transport = redisStreams({ url, stream: 'tenancy:test3' });
    const { tenancy } = createTestTenancy({ events: { transports: [transport] } });
    tenancy.events.forward('pedido.*', { transport: 'redis-streams' });
    await tenancy.events.publish('pedido.creado', { n: 1 });
    await tenancy.events.flush();

    let calls = 0;
    const errors: { error: unknown; event: CloudEvent | undefined }[] = [];
    const consumer = consumeRedisStream({
      url,
      stream: 'tenancy:test3',
      group: 'facturas',
      consumer: 'c1',
      claimIdleMs: 30,
      blockMs: 50,
      maxAttempts: 3,
      deadLetterStream: 'tenancy:test3:dead',
      handler: async () => {
        calls++;
        throw new Error('siempre falla');
      },
      onError: (error, event) => void errors.push({ error, event }),
    });
    await waitFor(() => errors.some((e) => /discarded after 3/.test(String(e.error))));
    await new Promise((r) => setTimeout(r, 300));
    await consumer.stop();
    expect(calls).toBe(3);
    expect(errors).toHaveLength(4);
    expect(errors.every((e) => e.event?.type === 'pedido.creado')).toBe(true);
    const pending = (await transport.client.xpending('tenancy:test3', 'facturas')) as [number];
    expect(pending[0]).toBe(0);
    const dead = await transport.client.xrange('tenancy:test3:dead', '-', '+');
    expect(dead).toHaveLength(1);
    expect(dead[0]![1]).toEqual(expect.arrayContaining(['type', 'pedido.creado', 'error', 'siempre falla']));
    await tenancy.close();
  });

  it('acknowledges and reports entries without a valid event instead of looping', async () => {
    const transport = redisStreams({ url, stream: 'tenancy:test4' });
    await transport.client.xadd('tenancy:test4', '*', 'otro', 'campo');
    await transport.client.xadd('tenancy:test4', '*', 'event', '{no es json');
    let calls = 0;
    const errors: { error: unknown; event: CloudEvent | undefined }[] = [];
    const consumer = consumeRedisStream({
      url,
      stream: 'tenancy:test4',
      group: 'g',
      consumer: 'c1',
      claimIdleMs: 30,
      blockMs: 50,
      handler: async () => void calls++,
      onError: (error, event) => void errors.push({ error, event }),
    });
    await waitFor(() => errors.length === 2);
    await new Promise((r) => setTimeout(r, 300));
    await consumer.stop();
    expect(calls).toBe(0);
    expect(errors).toHaveLength(2);
    expect(String(errors[0]!.error)).toMatch(/no "event" field/);
    expect(errors.every((e) => e.event === undefined)).toBe(true);
    const pending = (await transport.client.xpending('tenancy:test4', 'g')) as [number];
    expect(pending[0]).toBe(0);
    await transport.close();
  });

  it('reports Redis errors inside the loop through onError instead of an unhandled rejection', async () => {
    const transport = redisStreams({ url });
    // Una clave que no es un stream: XGROUP falla con WRONGTYPE.
    await transport.client.set('tenancy:test5', 'no es un stream');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const errors: unknown[] = [];
    const consumer = consumeRedisStream({
      url,
      stream: 'tenancy:test5',
      group: 'g',
      consumer: 'c1',
      blockMs: 50,
      handler: async () => undefined,
      onError: (error) => void errors.push(error),
    });
    await waitFor(() => errors.length >= 2);
    await consumer.stop();
    await new Promise((r) => setTimeout(r, 50));
    process.off('unhandledRejection', onUnhandled);
    expect(String(errors[0])).toMatch(/WRONGTYPE/);
    expect(unhandled).toEqual([]);
    await transport.close();
  });
});
