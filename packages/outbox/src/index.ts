import {
  UlidGenerator,
  fromCloudEvent,
  parseCloudEvent,
  toCloudEvent,
  type Clock,
  type EventEnvelope,
  type EventSink,
  type Observer,
  type Tenancy,
  type TenancyPlugin,
} from '@tenancy-node/core';
import { paginate, withTransientRetry, type CentralAccess, type DatabaseExtension } from '@tenancy-node/db';
import { sql } from 'kysely';

export interface OutboxOptions {
  /** Intentos por evento y destino antes de pasar a dead-letter (`failed`). Por defecto 10. */
  maxAttempts?: number;
  /** Espera base entre intentos (exponencial, con tope de 1 h). Por defecto 5 s. */
  baseDelayMs?: number;
  /** Eventos por lote del relay. Por defecto 100. */
  batchSize?: number;
  /** Cada cuánto busca eventos el relay cuando no hay pendientes. Por defecto 1 s. */
  pollIntervalMs?: number;
  /** Tiempo que un relay reserva un lote; si muere, otro lo retoma después. Por defecto 60 s. */
  lockMs?: number;
  /** Días que se conservan los eventos publicados. Por defecto 7. */
  retentionDays?: number;
}

export interface RelayRun {
  claimed: number;
  published: number;
  retried: number;
  dead: number;
}

export interface OutboxEntry {
  id: string;
  eventId: string;
  type: string;
  tenantId: string | null;
  destination: string;
  status: 'pending' | 'processing' | 'published' | 'failed';
  attempts: number;
  lastError: string | null;
  availableAt: Date;
  createdAt: Date;
}

export interface OutboxApi {
  /** Procesa un lote ahora (tests, cron). */
  relayOnce(): Promise<RelayRun>;
  /** Corre el relay en segundo plano hasta `stop()`. */
  startRelay(): { stop(): Promise<void> };
  /** Cantidad de eventos por estado. */
  stats(): Promise<Record<'pending' | 'processing' | 'published' | 'failed', number>>;
  /** Dead-letter: eventos que agotaron sus intentos. */
  failed(options?: { limit?: number; tenantId?: string }): Promise<OutboxEntry[]>;
  /** Vuelve a poner en cola un evento de dead-letter (o todos los de un tenant). */
  retry(target: { id: string } | { tenantId: string } | 'all'): Promise<number>;
  /** Borra los eventos publicados más antiguos que `retentionDays`. */
  prune(): Promise<number>;
}

export interface OutboxExtension {
  outbox: OutboxApi;
}

interface ClaimedRow {
  id: string;
  type: string;
  tenant_id: string | null;
  payload: unknown;
  attempts: number;
  destination: string;
  routing_key: string | null;
}

interface State {
  tenancy: Tenancy & DatabaseExtension;
  central: CentralAccess;
}

/**
 * Outbox: cada evento reenviado (`tenancy.events.forward`) se guarda en `tenancy_event_outbox`,
 * una fila por destino, y el relay lo entrega. Entrega **al menos una vez**: los consumidores
 * deduplican con el `id` del CloudEvent.
 */
export function outbox(options: OutboxOptions = {}): TenancyPlugin<OutboxExtension> {
  const maxAttempts = options.maxAttempts ?? 10;
  const baseDelay = options.baseDelayMs ?? 5000;
  const batchSize = options.batchSize ?? 100;
  const pollMs = options.pollIntervalMs ?? 1000;
  const lockMs = options.lockMs ?? 60_000;
  const retentionDays = options.retentionDays ?? 7;
  const ids = new UlidGenerator();
  let state: State | undefined;
  let observer: Observer;
  let clock: Clock;

  const ready = (): State => {
    if (!state)
      throw new Error(
        'The outbox plugin needs the database plugin (@tenancy-node/db) registered before it',
      );
    return state;
  };

  const sink: EventSink = {
    async accept(event, destinations) {
      const { tenancy, central } = ready();
      const now = clock.now();
      const payload = JSON.stringify(toCloudEvent(event, tenancy.events.source));
      await central.db
        .insertInto('event_outbox')
        .values(
          destinations.map((d) => ({
            id: ids.generate(),
            type: event.type,
            tenant_id: event.tenantId,
            payload,
            status: 'pending',
            attempts: 0,
            available_at: now,
            destination: d.transport,
            routing_key: d.routingKey ?? null,
            created_at: now,
          })),
        )
        .execute();
    },
  };

  /** Errores que `trace('outbox.relay')` ya registró. */
  const reported = new WeakSet<object>();

  const delayFor = (attempt: number) => Math.min(3_600_000, baseDelay * 2 ** (attempt - 1));

  const relayOnce = async (): Promise<RelayRun> => {
    const { central } = ready();
    const now = clock.now();
    const lockedUntil = new Date(now.getTime() + lockMs);

    // 1. Reservar un lote: varias instancias pueden correr a la vez sin tomar las mismas filas.
    const rows = await withTransientRetry(central.driver, () =>
      central.db.transaction().execute(async (trx) => {
        const claimed =
          central.kind === 'mssql'
            ? // SQL Server: hints de tabla en lugar de FOR UPDATE SKIP LOCKED.
              (
                await sql<ClaimedRow>`SELECT TOP (${batchSize}) id, type, tenant_id, payload, attempts, destination, routing_key FROM ${sql.raw(`${central.tablePrefix}event_outbox`)} WITH (UPDLOCK, READPAST, ROWLOCK) WHERE (status = 'pending' AND available_at <= ${now}) OR (status = 'processing' AND locked_until < ${now}) ORDER BY available_at`.execute(trx)
              ).rows
            : await trx
          .selectFrom('event_outbox')
          .select(['id', 'type', 'tenant_id', 'payload', 'attempts', 'destination', 'routing_key'])
          .where((eb) =>
            eb.or([
              eb.and([eb('status', '=', 'pending'), eb('available_at', '<=', now)]),
              eb.and([eb('status', '=', 'processing'), eb('locked_until', '<', now)]),
            ]),
          )
                  .orderBy('available_at')
        .$call((q) => paginate(central.kind, q, batchSize))
        // SQLite no tiene FOR UPDATE: serializa las escrituras y la transacción ya reserva las filas.
        .$if(central.kind !== 'sqlite', (q) => q.forUpdate().skipLocked())
        .execute();
        if (claimed.length > 0) {
          await trx
            .updateTable('event_outbox')
            .set({ status: 'processing', locked_until: lockedUntil, attempts: sql`attempts + 1` })
            .where(
              'id',
              'in',
              claimed.map((r) => r.id),
            )
            .execute();
        }
        return claimed;
      }),
    );

    const run: RelayRun = { claimed: rows.length, published: 0, retried: 0, dead: 0 };
    // Sondeo sin eventos: sin span ni métrica (sería ruido en cada `pollIntervalMs`).
    if (rows.length === 0) return run;
    // 2. Entregar fuera de la transacción. Cada lote con eventos es una operación `outbox.relay`
    // (span y métrica); el log de éxito va en `debug` para no escribir una línea por lote.
    await observer
      .trace('outbox.relay', { tenantId: null, claimed: rows.length }, () => deliverAll(rows, run), {
        successLevel: 'debug',
      })
      .catch((error: unknown) => {
        // `trace` ya lo registró: el bucle de `startRelay` no debe volver a hacerlo.
        if (typeof error === 'object' && error !== null) reported.add(error);
        throw error;
      });
    return run;
  };

  const deliverAll = async (rows: readonly ClaimedRow[], run: RelayRun): Promise<void> => {
    const { tenancy, central } = ready();
    for (const row of rows) {
      const attempt = Number(row.attempts) + 1;
      const event: EventEnvelope = fromCloudEvent(
        parseCloudEvent(
          typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload),
        ),
      );
      const context = {
        tenantId: row.tenant_id,
        eventId: event.id,
        eventType: row.type,
        destination: row.destination,
        attempt,
        outboxId: row.id,
      };
      const transport = tenancy.events.transport(row.destination);
      try {
        if (!transport) throw new Error(`Unknown event transport "${row.destination}"`);
        await transport.send(event, {
          source: tenancy.events.source,
          ...(row.routing_key ? { routingKey: row.routing_key } : {}),
        });
        await central.db
          .updateTable('event_outbox')
          .set({
            status: 'published',
            published_at: clock.now(),
            locked_until: null,
            last_error: null,
          })
          .where('id', '=', row.id)
          .execute();
        run.published++;
        observer.logger.debug(
          { ...context, operation: 'outbox.deliver', outcome: 'success' },
          `Event ${row.type} delivered to ${row.destination}`,
        );
      } catch (error) {
        const dead = attempt >= maxAttempts;
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
        await central.db
          .updateTable('event_outbox')
          .set({
            status: dead ? 'failed' : 'pending',
            locked_until: null,
            last_error: message,
            available_at: new Date(clock.now().getTime() + (dead ? 0 : delayFor(attempt))),
          })
          .where('id', '=', row.id)
          .execute();
        if (dead) run.dead++;
        else run.retried++;
        // Reintento pendiente = warn; dead-letter = error.
        observer.reportError(dead ? 'outbox.dead_letter' : 'outbox.deliver', error, context, !dead);
      }
    }
  };

  const api: OutboxApi = {
    relayOnce,
    startRelay() {
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      let current: Promise<unknown> = Promise.resolve();
      let lastPrune = 0;
      const loop = async () => {
        if (stopped) return;
        let run: RelayRun = { claimed: 0, published: 0, retried: 0, dead: 0 };
        try {
          run = await relayOnce();
          if (Date.now() - lastPrune > 3_600_000) {
            lastPrune = Date.now();
            await api.prune();
          }
        } catch (error) {
          if (!(typeof error === 'object' && error !== null && reported.has(error)))
            observer.reportError('outbox.relay', error, { tenantId: null });
        }
        if (stopped) return;
        // Lote lleno: seguir enseguida. Si no, esperar.
        timer = setTimeout(() => void (current = loop()), run.claimed >= batchSize ? 0 : pollMs);
      };
      current = loop();
      observer.logger.info(
        { tenantId: null, operation: 'outbox.relay', batchSize, pollMs },
        'Outbox relay started',
      );
      return {
        stop: async () => {
          stopped = true;
          if (timer) clearTimeout(timer);
          await current;
        },
      };
    },
    async stats() {
      const rows = await ready()
        .central.db.selectFrom('event_outbox')
        .select(['status', (eb) => eb.fn.countAll<number | string>().as('n')])
        .groupBy('status')
        .execute();
      const counts = { pending: 0, processing: 0, published: 0, failed: 0 };
      for (const row of rows) counts[row.status as keyof typeof counts] = Number(row.n);
      return counts;
    },
    async failed(opts = {}) {
      let query = ready()
        .central.db.selectFrom('event_outbox')
        .selectAll()
        .where('status', '=', 'failed');
      if (opts.tenantId) query = query.where('tenant_id', '=', opts.tenantId);
      const rows = await query
        .orderBy('created_at', 'desc')
        .$call((q) => paginate(ready().central.kind, q, opts.limit ?? 50))
        .execute();
      return rows.map((r) => ({
        id: r.id,
        eventId: parseCloudEvent(
          typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload),
        ).id,
        type: r.type,
        tenantId: r.tenant_id,
        destination: r.destination,
        status: r.status as OutboxEntry['status'],
        attempts: Number(r.attempts),
        lastError: r.last_error,
        availableAt: new Date(r.available_at),
        createdAt: new Date(r.created_at),
      }));
    },
    async retry(target) {
      let query = ready()
        .central.db.updateTable('event_outbox')
        .set({ status: 'pending', attempts: 0, available_at: clock.now(), last_error: null })
        .where('status', '=', 'failed');
      if (target !== 'all')
        query =
          'id' in target
            ? query.where('id', '=', target.id)
            : query.where('tenant_id', '=', target.tenantId);
      const result = await query.executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
    async prune() {
      const limit = new Date(clock.now().getTime() - retentionDays * 86_400_000);
      const result = await ready()
        .central.db.deleteFrom('event_outbox')
        .where('status', '=', 'published')
        .where('published_at', '<', limit)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };

  return {
    name: 'outbox',
    setup(context) {
      observer = context.observer;
      clock = context.clock;
      return { eventSink: sink };
    },
    extend(tenancy: Tenancy) {
      const t = tenancy as Tenancy & Partial<DatabaseExtension>;
      if (!t.database)
        throw new Error('The outbox plugin needs the database plugin (@tenancy-node/db)');
      state = { tenancy: t as Tenancy & DatabaseExtension, central: t.database.central() };
      return { outbox: api };
    },
  };
}
