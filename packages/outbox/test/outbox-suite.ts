import { createTenancy, type OperationSample, type Telemetry } from '@tenancy-node/core';
import { database, type DatabaseDriver } from '@tenancy-node/db';
import { outbox, type OutboxOptions } from '@tenancy-node/outbox';
import { MemoryLogger, MemoryTransport } from '@tenancy-node/testing';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

export interface OutboxTarget {
  name: string;
  driver: () => DatabaseDriver;
  start(): Promise<{ url: string; stop(): Promise<void> }>;
}

export function outboxSuite(target: OutboxTarget): void {
  describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')(`outbox: ${target.name}`, () => {
    let url = '';
    let stop: (() => Promise<void>) | undefined;
    let n = 0;
    const open: { close(): Promise<void> }[] = [];
    beforeAll(async () => ({ url, stop } = await target.start()), 300_000);
    afterEach(async () => {
      for (const t of open.splice(0)) await t.close();
    });
    afterAll(async () => void (await stop?.()));

    const make = async (
      options: OutboxOptions = {},
      prefix = `o${++n}_`,
      transports = [new MemoryTransport('bus')],
      telemetry: Telemetry[] = [],
    ) => {
      const logger = new MemoryLogger();
      const tenancy = createTenancy({
        logger,
        telemetry,
        events: { transports },
        plugins: [
          database({
            driver: target.driver(),
            central: { url },
            tablePrefix: prefix,
            prefix: `${prefix}t_`,
          }),
          outbox({ baseDelayMs: 1, ...options }),
        ],
      });
      open.push(tenancy);
      await tenancy.database.install();
      return { tenancy, transport: transports[0]!, prefix, logger };
    };

    it('stores one row per destination and the relay delivers them as CloudEvents', async () => {
      const bus = new MemoryTransport('bus');
      const hooks = new MemoryTransport('hooks');
      const { tenancy } = await make({}, undefined, [bus, hooks]);
      tenancy.events.forward('tenant.created', { transport: ['bus', 'hooks'] });
      tenancy.events.forward('pedido.*', { transport: 'bus', routingKey: 'pedidos' });
      await tenancy.tenants.create({ id: 'bolivar' });
      await tenancy.run('bolivar', () => tenancy.events.publish('pedido.creado', { total: 450 }));

      // Nada se envió todavía: está guardado en la outbox
      expect(bus.received).toEqual([]);
      expect(await tenancy.outbox.stats()).toMatchObject({ pending: 3, published: 0 });

      expect(await tenancy.outbox.relayOnce()).toEqual({
        claimed: 3,
        published: 3,
        retried: 0,
        dead: 0,
      });
      expect(bus.received.map((e) => [e.type, e.tenantid, e.routingKey])).toEqual(
        expect.arrayContaining([
          ['tenant.created', 'bolivar', undefined],
          ['pedido.creado', 'bolivar', 'pedidos'],
        ]),
      );
      expect(hooks.received.map((e) => e.type)).toEqual(['tenant.created']);
      // El mismo id de evento en cada destino (los consumidores deduplican por id)
      expect(hooks.received[0]!.id).toBe(bus.received.find((e) => e.type === 'tenant.created')!.id);
      expect(await tenancy.outbox.stats()).toMatchObject({ pending: 0, published: 3 });
      expect(await tenancy.outbox.relayOnce()).toMatchObject({ claimed: 0 });
    });

    it('retries with backoff, moves exhausted events to dead-letter and retries them on demand', async () => {
      const { tenancy, transport } = await make({ maxAttempts: 3 });
      tenancy.events.forward('pedido.*', { transport: 'bus' });
      transport.down = true;
      await tenancy.events.publish('pedido.creado', { n: 1 });
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 20));
        await tenancy.outbox.relayOnce();
      }
      expect(await tenancy.outbox.stats()).toMatchObject({ failed: 1, pending: 0 });
      const [dead] = await tenancy.outbox.failed();
      expect(dead).toMatchObject({
        type: 'pedido.creado',
        destination: 'bus',
        attempts: 3,
        lastError: 'bus unavailable',
      });
      expect(tenancy.observability.errors().map((e) => e.operation)).toEqual(
        expect.arrayContaining(['outbox.deliver', 'outbox.dead_letter']),
      );

      transport.down = false;
      expect(await tenancy.outbox.retry({ id: dead!.id })).toBe(1);
      expect((await tenancy.outbox.relayOnce()).published).toBe(1);
      expect(transport.received).toHaveLength(1);
      expect(await tenancy.outbox.retry('all')).toBe(0);
    });

    it('lets several relays work in parallel without delivering an event twice', async () => {
      const prefix = `o${++n}_`;
      const shared = new MemoryTransport('bus');
      const relays = await Promise.all(
        [0, 1, 2].map(() => make({ batchSize: 10 }, prefix, [shared])),
      );
      const [first] = relays;
      first!.tenancy.events.forward('pedido.*', { transport: 'bus' });
      for (let i = 0; i < 150; i++) await first!.tenancy.events.publish('pedido.creado', { i });

      let rounds = 0;
      while ((await first!.tenancy.outbox.stats()).published < 150 && rounds++ < 50) {
        await Promise.all(relays.map((r) => r.tenancy.outbox.relayOnce()));
      }
      const ids = shared.received.map((e) => e.id);
      expect(ids).toHaveLength(150);
      expect(new Set(ids).size).toBe(150);
    });

    it('traces each relay batch with events as outbox.relay (span and metric, no info log)', async () => {
      const spans: string[] = [];
      const samples: OperationSample[] = [];
      const telemetry: Telemetry = {
        name: 'memoria',
        span: (operation, _attributes, fn) => (spans.push(operation), fn()),
        recordOperation: (sample) => void samples.push(sample),
      };
      const { tenancy, logger } = await make({}, undefined, undefined, [telemetry]);
      tenancy.events.forward('pedido.*', { transport: 'bus' });
      // Sondeo sin eventos: ni span ni métrica
      await tenancy.outbox.relayOnce();
      expect(spans.filter((o) => o === 'outbox.relay')).toEqual([]);

      await tenancy.events.publish('pedido.creado', {});
      await tenancy.events.publish('pedido.pagado', {});
      await tenancy.outbox.relayOnce();
      await tenancy.outbox.relayOnce();
      expect(spans.filter((o) => o === 'outbox.relay')).toEqual(['outbox.relay']);
      expect(samples.filter((s) => s.operation === 'outbox.relay')).toEqual([
        expect.objectContaining({ tenantId: null, outcome: 'success' }),
      ]);
      const relayLogs = logger.find((e) => e.fields.operation === 'outbox.relay');
      expect(relayLogs.map((e) => e.level)).toEqual(['debug']);
    });

    it('takes over a batch left behind by a relay that died', async () => {
      const { tenancy, transport, prefix } = await make({ lockMs: 60_000 });
      tenancy.events.forward('pedido.*', { transport: 'bus' });
      await tenancy.events.publish('pedido.creado', {});
      // Simula un relay que reservó la fila y murió: 'processing' con el lease vencido
      await sql`UPDATE ${sql.table(`${prefix}event_outbox`)} SET status = 'processing', locked_until = ${new Date(Date.now() - 1000)}`.execute(
        tenancy.centralDb(),
      );
      expect((await tenancy.outbox.relayOnce()).published).toBe(1);
      expect(transport.received).toHaveLength(1);
    });

    it('runs in the background until stopped and prunes old published events', async () => {
      const { tenancy, transport, prefix } = await make({ pollIntervalMs: 20, retentionDays: 1 });
      tenancy.events.forward('pedido.*', { transport: 'bus' });
      const relay = tenancy.outbox.startRelay();
      await tenancy.events.publish('pedido.creado', {});
      const deadline = Date.now() + 5000;
      while (transport.received.length === 0 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      await relay.stop();
      expect(transport.received).toHaveLength(1);
      await sql`UPDATE ${sql.table(`${prefix}event_outbox`)} SET published_at = ${new Date(Date.now() - 3 * 86_400_000)}`.execute(
        tenancy.centralDb(),
      );
      expect(await tenancy.outbox.prune()).toBe(1);
    });
  });
}
