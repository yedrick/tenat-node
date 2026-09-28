import { createTestTenancy, MemoryTransport } from '@tenancy-node/testing';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  InvalidCloudEventError,
  InvalidConfigError,
  InvalidEventDataError,
  fromCloudEvent,
  parseCloudEvent,
  toCloudEvent,
  type EventEnvelope,
  type EventSink,
} from '../src/index.js';

describe('CloudEvents', () => {
  it('converts envelopes to CloudEvents 1.0 and back, validating the input', () => {
    const envelope: EventEnvelope = {
      id: '01J9Z3',
      type: 'tenant.created',
      tenantId: 'bolivar',
      time: new Date('2026-09-24T15:30:00.000Z'),
      data: { id: 'bolivar' },
    };
    const event = toCloudEvent(envelope, 'tenancy-node://tuapp.com');
    expect(event).toEqual({
      specversion: '1.0',
      id: '01J9Z3',
      type: 'tenant.created',
      source: 'tenancy-node://tuapp.com',
      time: '2026-09-24T15:30:00.000Z',
      tenantid: 'bolivar',
      datacontenttype: 'application/json',
      data: { id: 'bolivar' },
    });
    expect(fromCloudEvent(parseCloudEvent(JSON.stringify(event)))).toEqual(envelope);
    expect(
      parseCloudEvent({
        specversion: '1.0',
        id: 'x',
        type: 't',
        source: 's',
        time: '2026-01-01T00:00:00Z',
      }).tenantid,
    ).toBeNull();
    expect(() => parseCloudEvent('{nope')).toThrow(InvalidCloudEventError);
    expect(() =>
      parseCloudEvent({ specversion: '0.3', id: 'x', type: 't', source: 's', time: 'x' }),
    ).toThrow(/specversion/);
  });
});

describe('events.forward without outbox', () => {
  it('sends matching events to transports outside the request path', async () => {
    const hooks = new MemoryTransport('hooks');
    const bus = new MemoryTransport('bus');
    const { tenancy } = createTestTenancy({
      centralDomains: ['tuapp.com'],
      events: { transports: [hooks, bus] },
    });
    tenancy.events.forward('tenant.*', { transport: 'hooks' });
    tenancy.events.forward('pedido.creado', { transport: ['bus'], routingKey: 'pedidos' });
    tenancy.events.forward('*', { transport: 'bus' });

    await tenancy.tenants.create({ id: 'bolivar' });
    await tenancy.run('bolivar', () => tenancy.events.publish('pedido.creado', { pedidoId: 1 }));
    await tenancy.events.flush();

    expect(hooks.received.map((e) => e.type)).toEqual([
      'tenant.creating',
      'tenant.created',
      'tenant.provisioned',
    ]);
    expect(hooks.received[0]).toMatchObject({
      specversion: '1.0',
      source: 'tenancy-node://tuapp.com',
      tenantid: 'bolivar',
    });
    const pedido = bus.received.filter((e) => e.type === 'pedido.creado');
    expect(pedido.map((e) => e.routingKey)).toEqual(['pedidos', undefined]);
    // '*' no reenvía los eventos de ciclo de vida (uno por petición)
    expect(bus.received.some((e) => e.type.startsWith('tenancy.'))).toBe(false);
    expect(tenancy.events.transport('hooks')).toBe(hooks);
    expect(tenancy.events.source).toBe('tenancy-node://tuapp.com');
    expect(() => tenancy.events.forward('x', { transport: 'nope' })).toThrow(InvalidConfigError);
    await tenancy.close();
    expect(hooks.closed).toBe(true);
  });

  it('retries a failing transport and records the final failure for the tenant', async () => {
    const flaky = new MemoryTransport('flaky');
    flaky.failTimes = 1;
    const dead = new MemoryTransport('dead');
    dead.down = true;
    const { tenancy, seed, logger } = createTestTenancy({ events: { transports: [flaky, dead] } });
    await seed(['bolivar']);
    tenancy.events.forward('pedido.*', { transport: ['flaky', 'dead'] });
    await tenancy.run('bolivar', () => tenancy.events.publish('pedido.creado', { n: 1 }));
    await tenancy.events.flush();
    expect(flaky.received).toHaveLength(1);
    expect(flaky.attempts).toBe(2);
    expect(dead.attempts).toBe(3);
    const errors = tenancy.observability
      .errors({ tenantId: 'bolivar' })
      .filter((e) => e.operation === 'events.transport');
    expect(errors.map((e) => e.context.transport)).toEqual(
      expect.arrayContaining(['flaky', 'dead']),
    );
    const levels = logger
      .find((e) => e.fields.operation === 'events.transport' && e.fields.transport === 'dead')
      .map((e) => e.level);
    expect(levels).toEqual(['warn', 'warn', 'error']);
  });
});

describe('events.forward with an event sink (outbox)', () => {
  it('stores events in the sink synchronously instead of sending them', async () => {
    const accepted: { type: string; destinations: unknown }[] = [];
    const sink: EventSink = {
      accept: async (event, destinations) => void accepted.push({ type: event.type, destinations }),
    };
    const transport = new MemoryTransport('rabbit');
    const { tenancy } = createTestTenancy({
      plugins: [
        { name: 'fake-outbox', setup: () => ({ eventSink: sink, transports: [transport] }) },
      ],
    });
    tenancy.events.forward('pedido.*', { transport: 'rabbit', routingKey: 'pedidos' });
    await tenancy.events.publish('pedido.creado', {});
    // Sin flush: la publicación esperó a que el evento quedara guardado
    expect(accepted).toEqual([
      { type: 'pedido.creado', destinations: [{ transport: 'rabbit', routingKey: 'pedidos' }] },
    ]);
    expect(transport.received).toEqual([]);
  });

  it('fails the publication when the sink is down (the event must not be lost silently)', async () => {
    const sink: EventSink = { accept: async () => Promise.reject(new Error('outbox unavailable')) };
    const { tenancy } = createTestTenancy({
      plugins: [
        {
          name: 'fake-outbox',
          setup: () => ({ eventSink: sink, transports: [new MemoryTransport('x')] }),
        },
      ],
    });
    tenancy.events.forward('*', { transport: 'x' });
    await expect(tenancy.events.publish('pedido.creado', {})).rejects.toThrow('outbox unavailable');
    expect(() =>
      createTestTenancy({
        plugins: [
          { name: 'a', setup: () => ({ eventSink: sink }) },
          { name: 'b', setup: () => ({ eventSink: sink }) },
        ],
      }),
    ).toThrow(/second event sink/);
    expect(() =>
      createTestTenancy({
        events: { transports: [new MemoryTransport('x'), new MemoryTransport('x')] },
      }),
    ).toThrow(/Duplicate event transport/);
  });
});

describe('typed custom events', () => {
  it('validates event data with a Valibot schema', async () => {
    const { tenancy } = createTestTenancy();
    tenancy.events.define(
      'pedido.creado',
      v.object({ pedidoId: v.number(), total: v.pipe(v.number(), v.minValue(0)) }),
    );
    await expect(
      tenancy.events.publish('pedido.creado', { pedidoId: 1, total: 450 }),
    ).resolves.toMatchObject({ type: 'pedido.creado' });
    const error = await tenancy.events
      .publish('pedido.creado', { pedidoId: 'x', total: -1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidEventDataError);
    expect((error as Error).message).toContain('pedidoId');
    expect((error as Error).message).toContain('total');
  });

  it('checks transport health', async () => {
    const t = new MemoryTransport('pinged');
    Object.assign(t, { ping: async () => Promise.reject(new Error('broker down')) });
    const { tenancy } = createTestTenancy({ events: { transports: [t] } });
    expect((await tenancy.health()).checks['transport:pinged']).toMatchObject({
      ok: false,
      error: 'broker down',
    });
  });
});
