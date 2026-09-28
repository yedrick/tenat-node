import {
  CLOUDEVENTS_CONTENT_TYPE,
  TenancyError,
  TenantId,
  UlidGenerator,
  toCloudEvent,
  type Clock,
  type EventTransport,
  type Observer,
  type Tenancy,
  type TenancyPlugin,
} from '@tenancy-node/core';
import { insertReturningId, paginate, withTransientRetry, type CentralAccess, type DatabaseExtension } from '@tenancy-node/db';
import { sql } from 'kysely';
import { SIGNATURE_HEADER, generateWebhookSecret, signWebhook } from './signature.js';
import { assertPublicUrl } from './ssrf.js';

export interface WebhooksOptions {
  /** Esperas entre reintentos. Por defecto 1 min, 5 min, 30 min, 2 h, 12 h (6 intentos en total). */
  retrySchedule?: readonly number[];
  /** Fallos seguidos que abren el circuito de un endpoint. Por defecto 5. */
  circuitThreshold?: number;
  /** Pausa del endpoint con el circuito abierto. Por defecto 10 min. */
  circuitCooldownMs?: number;
  /** Tiempo máximo de cada petición. Por defecto 10 s. */
  timeoutMs?: number;
  /** Solo para desarrollo y tests: permitir destinos en redes internas. Por defecto `false` (protección SSRF). */
  allowPrivateNetworks?: boolean;
  /** Entregas por lote. Por defecto 50. */
  batchSize?: number;
  pollIntervalMs?: number;
  /** Eventos que se reenvían a los webhooks. Por defecto todos (`*`). */
  forward?: string;
}

export interface WebhookEndpoint {
  id: number;
  tenantId: string | null;
  name: string;
  url: string;
  events: string[];
  isActive: boolean;
  circuitState: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  pausedUntil: Date | null;
  createdAt: Date;
}

export interface WebhookDelivery {
  id: number;
  endpointId: number;
  eventId: string;
  eventType: string | null;
  status: 'pending' | 'success' | 'failed' | 'dead';
  attempt: number;
  httpStatus: number | null;
  responseMs: number | null;
  responseBody: string | null;
  lastError: string | null;
  nextRetryAt: Date | null;
  createdAt: Date;
}

export interface RegisterWebhookInput {
  /** `null` o ausente = webhook global (todos los tenants). */
  tenant?: string | null;
  name: string;
  url: string;
  /** Tipos o patrones: `tenant.created`, `pedido.*`, `*`. */
  events: readonly string[];
  /** Por defecto se genera uno. */
  secret?: string;
}

export interface WebhooksApi {
  /** Registra un endpoint. El secreto solo se devuelve aquí: guárdalo para verificar las firmas. */
  register(input: RegisterWebhookInput): Promise<{ endpoint: WebhookEndpoint; secret: string }>;
  list(options?: { tenant?: string | null }): Promise<WebhookEndpoint[]>;
  get(id: number): Promise<WebhookEndpoint | undefined>;
  update(
    id: number,
    changes: { name?: string; url?: string; events?: readonly string[]; active?: boolean },
  ): Promise<WebhookEndpoint>;
  remove(id: number): Promise<void>;
  rotateSecret(id: number): Promise<string>;
  deliveries(
    endpointId: number,
    options?: { limit?: number; status?: WebhookDelivery['status'] },
  ): Promise<WebhookDelivery[]>;
  /** Vuelve a enviar una entrega (por ejemplo, desde dead-letter). */
  redeliver(deliveryId: number): Promise<void>;
  /** Envía un evento `webhook.test` al endpoint y devuelve el resultado (no se reintenta). */
  test(id: number): Promise<{ ok: boolean; status: number | null; ms: number; error?: string }>;
  dispatchOnce(): Promise<{ sent: number; failed: number; dead: number }>;
  startDispatcher(): { stop(): Promise<void> };
}

export interface WebhooksExtension {
  webhooks: WebhooksApi;
}

export class WebhookNotFoundError extends TenancyError {
  constructor(id: number) {
    super('TENANCY_WEBHOOK_NOT_FOUND', `Webhook endpoint ${id} not found`, { id });
  }
}

export class InvalidWebhookError extends TenancyError {
  constructor(reason: string) {
    super('TENANCY_INVALID_WEBHOOK', `Invalid webhook: ${reason}`);
  }
}

const DEFAULT_SCHEDULE = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];

export function matchesEvent(patterns: readonly string[], type: string): boolean {
  return patterns.some(
    (p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))),
  );
}

const parseJson = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const bool = (v: unknown) => v === true || v === 1 || v === '1';

/**
 * Webhooks firmados con HMAC-SHA256: endpoints globales o por tenant, reintentos con espera,
 * circuit breaker, dead-letter, historial de entregas y protección contra SSRF.
 */
export function webhooks(options: WebhooksOptions = {}): TenancyPlugin<WebhooksExtension> {
  const schedule = options.retrySchedule ?? DEFAULT_SCHEDULE;
  const threshold = options.circuitThreshold ?? 5;
  const cooldown = options.circuitCooldownMs ?? 600_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const batchSize = options.batchSize ?? 50;
  const pollMs = options.pollIntervalMs ?? 1000;
  const lease = Math.max(timeoutMs * 3, 30_000);
  const ids = new UlidGenerator();
  let central: CentralAccess | undefined;
  let tenancyRef: (Tenancy & DatabaseExtension) | undefined;
  let observer: Observer;
  let clock: Clock;
  let nudge: (() => void) | undefined;

  const db = () => {
    if (!central)
      throw new Error('The webhooks plugin needs the database plugin (@tenancy-node/db)');
    return central;
  };

  const toEndpoint = (r: Record<string, unknown>): WebhookEndpoint => ({
    id: Number(r.id),
    tenantId: (r.tenant_id as string | null) ?? null,
    name: r.name as string,
    url: r.url as string,
    events: parseJson<string[]>(r.events),
    isActive: bool(r.is_active),
    circuitState: r.circuit_state as WebhookEndpoint['circuitState'],
    consecutiveFailures: Number(r.consecutive_failures),
    pausedUntil: r.paused_until ? new Date(r.paused_until as string) : null,
    createdAt: new Date(r.created_at as string),
  });

  const toDelivery = (r: Record<string, unknown>): WebhookDelivery => ({
    id: Number(r.id),
    endpointId: Number(r.endpoint_id),
    eventId: r.event_id as string,
    eventType: r.payload ? parseJson<{ type: string }>(r.payload).type : null,
    status: r.status as WebhookDelivery['status'],
    attempt: Number(r.attempt),
    httpStatus: r.http_status === null ? null : Number(r.http_status),
    responseMs: r.response_ms === null ? null : Number(r.response_ms),
    responseBody: (r.response_body as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    nextRetryAt: r.next_retry_at ? new Date(r.next_retry_at as string) : null,
    createdAt: new Date(r.created_at as string),
  });

  const validate = async (input: { url?: string; events?: readonly string[]; name?: string }) => {
    if (input.name !== undefined && (input.name.trim().length === 0 || input.name.length > 100)) {
      throw new InvalidWebhookError('name must have 1-100 characters');
    }
    if (
      input.events !== undefined &&
      (input.events.length === 0 ||
        input.events.some((e) => !/^(\*|[a-z0-9_.-]+(\.\*)?)$/i.test(e)))
    ) {
      throw new InvalidWebhookError('events must be event types or patterns like "tenant.*"');
    }
    if (input.url !== undefined) {
      if (input.url.length > 2048) throw new InvalidWebhookError('url is too long');
      await assertPublicUrl(input.url, {
        allowPrivateNetworks: options.allowPrivateNetworks ?? false,
      });
    }
  };

  /** Transporte `webhooks`: crea una entrega por endpoint que coincide (sin duplicados). */
  const transport: EventTransport = {
    name: 'webhooks',
    async send(event, sendOptions) {
      const { db: cdb, kind } = db();
      const endpoints = await cdb
        .selectFrom('webhook_endpoints')
        .selectAll()
        .where('is_active', '=', true)
        .where((eb) =>
          event.tenantId
            ? eb.or([eb('tenant_id', 'is', null), eb('tenant_id', '=', event.tenantId)])
            : eb('tenant_id', 'is', null),
        )
        .execute();
      const targets = endpoints.filter((e) =>
        matchesEvent(parseJson<string[]>(e.events), event.type),
      );
      if (targets.length === 0) return;
      const now = clock.now();
      const payload = JSON.stringify(toCloudEvent(event, sendOptions.source));
      const values = targets.map((e) => ({
        endpoint_id: e.id as number,
        event_id: event.id,
        status: 'pending',
        attempt: 0,
        next_retry_at: now,
        payload,
        created_at: now,
        updated_at: now,
      }));
      // El mismo evento reenviado dos veces (at-least-once) no crea una entrega duplicada.
      if (kind === 'mssql') {
        for (const value of values) {
          await cdb.insertInto('webhook_deliveries').values(value).execute().catch((error: unknown) => {
            if (!db().driver.isUniqueViolation(error)) throw error;
          });
        }
      } else {
        const insert = cdb.insertInto('webhook_deliveries').values(values);
        await (kind === 'mysql' ? insert.ignore() : insert.onConflict((oc) => oc.columns(['endpoint_id', 'event_id']).doNothing())).execute();
      }
      nudge?.();
    },
    async close() {},
  };

  const deliver = async (
    endpoint: Record<string, unknown>,
    body: string,
    headers: Record<string, string>,
  ): Promise<{
    ok: boolean;
    status: number | null;
    ms: number;
    responseBody: string | null;
    error?: string;
  }> => {
    const started = performance.now();
    try {
      await assertPublicUrl(endpoint.url as string, {
        allowPrivateNetworks: options.allowPrivateNetworks ?? false,
      });
      const secret = db().encrypter.decrypt(endpoint.secret_encrypted as string);
      const response = await fetch(endpoint.url as string, {
        method: 'POST',
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'content-type': CLOUDEVENTS_CONTENT_TYPE,
          'user-agent': 'tenancy-node-webhooks/1',
          [SIGNATURE_HEADER]: signWebhook(secret, body),
          ...headers,
        },
      });
      const text = (await response.text().catch(() => '')).slice(0, 2000);
      const ms = Math.round(performance.now() - started);
      const ok = response.status >= 200 && response.status < 300;
      return {
        ok,
        status: response.status,
        ms,
        responseBody: text || null,
        ...(ok ? {} : { error: `HTTP ${response.status}` }),
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        ms: Math.round(performance.now() - started),
        responseBody: null,
        error:
          error instanceof Error
            ? error.name === 'TimeoutError'
              ? `timeout after ${timeoutMs} ms`
              : error.message
            : String(error),
      };
    }
  };

  const dispatchOnce: WebhooksApi['dispatchOnce'] = async () => {
    const { db: cdb } = db();
    const now = clock.now();
    // Reservar entregas vencidas de endpoints activos cuyo circuito no esté en pausa.
    const claimed = await withTransientRetry(db().driver, () =>
      cdb.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom('webhook_deliveries')
          .innerJoin('webhook_endpoints', 'webhook_endpoints.id', 'webhook_deliveries.endpoint_id')
          .select(['webhook_deliveries.id as id'])
          .where('webhook_deliveries.status', 'in', ['pending', 'failed'])
          .where('webhook_deliveries.next_retry_at', '<=', now)
          .where('webhook_endpoints.is_active', '=', true)
          .where((eb) =>
            eb.or([
              eb('webhook_endpoints.paused_until', 'is', null),
              eb('webhook_endpoints.paused_until', '<=', now),
            ]),
          )
          .orderBy('webhook_deliveries.next_retry_at')
          .$call((q) => paginate(db().kind, q, batchSize))
          .execute();
        if (rows.length === 0) return [];
        // Bloquear volviendo a comprobar que siguen vencidas: otro dispatcher pudo reservarlas
        // (lease) o terminarlas entre el SELECT anterior y este bloqueo.
        const locked =
          db().kind === 'mssql'
            ? // SQL Server: hints de tabla en lugar de FOR UPDATE SKIP LOCKED.
              ((
                await sql<Record<string, unknown>>`SELECT * FROM ${sql.raw(`${db().tablePrefix}webhook_deliveries`)} WITH (UPDLOCK, READPAST, ROWLOCK) WHERE id IN (${sql.join(rows.map((r) => r.id))}) AND status IN ('pending', 'failed') AND next_retry_at <= ${now}`.execute(trx)
              ).rows as never[])
            : await trx
                .selectFrom('webhook_deliveries')
                .selectAll()
                .where('id', 'in', rows.map((r) => r.id))
                .where('status', 'in', ['pending', 'failed'])
                .where('next_retry_at', '<=', now)
                .$if(db().kind !== 'sqlite', (q) => q.forUpdate().skipLocked())
                .execute();
        if (locked.length > 0) {
          // La reserva es un "lease": si el proceso muere, la entrega vuelve a estar lista después.
          await trx
            .updateTable('webhook_deliveries')
            .set({ next_retry_at: new Date(now.getTime() + lease), updated_at: now })
            .where(
              'id',
              'in',
              locked.map((r) => r.id),
            )
            .execute();
        }
        return locked;
      }),
    );

    const result = { sent: 0, failed: 0, dead: 0 };
    for (const delivery of claimed) {
      const endpoint = await cdb
        .selectFrom('webhook_endpoints')
        .selectAll()
        .where('id', '=', delivery.endpoint_id)
        .executeTakeFirst();
      if (!endpoint) continue;
      const attempt = Number(delivery.attempt) + 1;
      const body =
        typeof delivery.payload === 'string' ? delivery.payload : JSON.stringify(delivery.payload);
      const eventType = parseJson<{ type: string }>(delivery.payload).type;
      const outcome = await deliver(endpoint as Record<string, unknown>, body, {
        'x-tenancy-event': eventType,
        'x-tenancy-delivery': String(delivery.id),
        'x-tenancy-attempt': String(attempt),
      });
      const finished = clock.now();
      const context = {
        tenantId:
          (endpoint.tenant_id as string | null) ??
          parseJson<{ tenantid: string | null }>(delivery.payload).tenantid,
        endpointId: Number(endpoint.id),
        deliveryId: Number(delivery.id),
        eventId: delivery.event_id,
        eventType,
        attempt,
        httpStatus: outcome.status,
        durationMs: outcome.ms,
      };
      const dead = !outcome.ok && attempt > schedule.length;
      await cdb
        .updateTable('webhook_deliveries')
        .set({
          status: outcome.ok ? 'success' : dead ? 'dead' : 'failed',
          attempt,
          http_status: outcome.status,
          response_ms: outcome.ms,
          response_body: outcome.responseBody,
          last_error: outcome.error ?? null,
          next_retry_at:
            outcome.ok || dead ? null : new Date(finished.getTime() + schedule[attempt - 1]!),
          updated_at: finished,
        })
        .where('id', '=', delivery.id)
        .execute();

      if (outcome.ok) {
        result.sent++;
        await cdb
          .updateTable('webhook_endpoints')
          .set({
            consecutive_failures: 0,
            circuit_state: 'closed',
            paused_until: null,
            updated_at: finished,
          })
          .where('id', '=', endpoint.id)
          .execute();
        observer.logger.info(
          { ...context, operation: 'webhook.deliver', outcome: 'success' },
          `Webhook delivered to endpoint ${endpoint.id}`,
        );
        continue;
      }
      result.failed++;
      if (dead) result.dead++;
      const failures = Number(endpoint.consecutive_failures) + 1;
      // Circuito: tras N fallos seguidos (o si falla la prueba en half_open) el endpoint se pausa.
      const open = failures >= threshold || endpoint.circuit_state !== 'closed';
      await cdb
        .updateTable('webhook_endpoints')
        .set({
          consecutive_failures: failures,
          circuit_state: open ? 'open' : 'closed',
          paused_until: open ? new Date(finished.getTime() + cooldown) : null,
          updated_at: finished,
        })
        .where('id', '=', endpoint.id)
        .execute();
      const error = new Error(`Webhook delivery failed: ${outcome.error}`);
      observer.reportError(dead ? 'webhook.dead' : 'webhook.deliver', error, context, !dead);
      if (open && endpoint.circuit_state === 'closed') {
        observer.reportError(
          'webhook.circuit_open',
          new Error(`Endpoint ${endpoint.id} paused after ${failures} consecutive failures`),
          context,
        );
      }
    }
    // Endpoints con la pausa vencida pasan a half_open: la próxima entrega es la prueba.
    await cdb
      .updateTable('webhook_endpoints')
      .set({ circuit_state: 'half_open' })
      .where('circuit_state', '=', 'open')
      .where('paused_until', '<=', clock.now())
      .execute();
    return result;
  };

  const find = async (id: number) => {
    const row = await db()
      .db.selectFrom('webhook_endpoints')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new WebhookNotFoundError(id);
    return row;
  };

  const api: WebhooksApi = {
    async register(input) {
      await validate(input);
      const tenantId = input.tenant
        ? (await tenancyRef!.tenants.findOrFail(input.tenant)).id.value
        : null;
      const secret = input.secret ?? generateWebhookSecret();
      const now = clock.now();
      const { db: cdb, kind, encrypter } = db();
      const values = {
        tenant_id: tenantId,
        name: input.name.trim(),
        url: input.url,
        events: JSON.stringify(input.events),
        secret_encrypted: encrypter.encrypt(secret),
        circuit_state: 'closed',
        consecutive_failures: 0,
        created_at: now,
        updated_at: now,
      };
      const id = await insertReturningId(kind, cdb.insertInto('webhook_endpoints').values(values));
      observer.logger.info(
        { tenantId, operation: 'webhook.register', endpointId: id },
        `Webhook ${id} registered`,
      );
      return { endpoint: toEndpoint((await find(id)) as Record<string, unknown>), secret };
    },
    async list(opts = {}) {
      let query = db().db.selectFrom('webhook_endpoints').selectAll();
      if (opts.tenant !== undefined)
        query =
          opts.tenant === null
            ? query.where('tenant_id', 'is', null)
            : query.where('tenant_id', '=', TenantId.create(opts.tenant).value);
      return (await query.orderBy('id').execute()).map((r) =>
        toEndpoint(r as Record<string, unknown>),
      );
    },
    async get(id) {
      const row = await db()
        .db.selectFrom('webhook_endpoints')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? toEndpoint(row as Record<string, unknown>) : undefined;
    },
    async update(id, changes) {
      await find(id);
      await validate(changes);
      await db()
        .db.updateTable('webhook_endpoints')
        .set({
          ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
          ...(changes.url !== undefined ? { url: changes.url } : {}),
          ...(changes.events !== undefined ? { events: JSON.stringify(changes.events) } : {}),
          ...(changes.active !== undefined ? { is_active: changes.active } : {}),
          // Reactivar o cambiar la URL cierra el circuito.
          ...(changes.active === true || changes.url !== undefined
            ? { circuit_state: 'closed', consecutive_failures: 0, paused_until: null }
            : {}),
          updated_at: clock.now(),
        })
        .where('id', '=', id)
        .execute();
      return toEndpoint((await find(id)) as Record<string, unknown>);
    },
    async remove(id) {
      await find(id);
      await db().db.deleteFrom('webhook_endpoints').where('id', '=', id).execute();
    },
    async rotateSecret(id) {
      await find(id);
      const secret = generateWebhookSecret();
      await db()
        .db.updateTable('webhook_endpoints')
        .set({ secret_encrypted: db().encrypter.encrypt(secret), updated_at: clock.now() })
        .where('id', '=', id)
        .execute();
      return secret;
    },
    async deliveries(endpointId, opts = {}) {
      let query = db()
        .db.selectFrom('webhook_deliveries')
        .selectAll()
        .where('endpoint_id', '=', endpointId);
      if (opts.status) query = query.where('status', '=', opts.status);
      const rows = await query
        .orderBy('id', 'desc')
        .$call((q) => paginate(db().kind, q, opts.limit ?? 50))
        .execute();
      return rows.map((r) => toDelivery(r as Record<string, unknown>));
    },
    async redeliver(deliveryId) {
      const result = await db()
        .db.updateTable('webhook_deliveries')
        .set({
          status: 'pending',
          attempt: 0,
          next_retry_at: clock.now(),
          last_error: null,
          updated_at: clock.now(),
        })
        .where('id', '=', deliveryId)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0)
        throw new TenancyError(
          'TENANCY_WEBHOOK_DELIVERY_NOT_FOUND',
          `Delivery ${deliveryId} not found`,
        );
      nudge?.();
    },
    async test(id) {
      const endpoint = await find(id);
      const event = {
        id: ids.generate(),
        type: 'webhook.test',
        tenantId: (endpoint.tenant_id as string | null) ?? null,
        time: clock.now(),
        data: { endpointId: id },
      };
      const body = JSON.stringify(toCloudEvent(event, tenancyRef!.events.source));
      const outcome = await deliver(endpoint as Record<string, unknown>, body, {
        'x-tenancy-event': 'webhook.test',
      });
      return {
        ok: outcome.ok,
        status: outcome.status,
        ms: outcome.ms,
        ...(outcome.error ? { error: outcome.error } : {}),
      };
    },
    dispatchOnce,
    startDispatcher() {
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      let current: Promise<unknown> = Promise.resolve();
      const loop = async () => {
        if (stopped) return;
        let busy = false;
        try {
          const run = await dispatchOnce();
          busy = run.sent + run.failed >= batchSize;
        } catch (error) {
          observer.reportError('webhook.dispatcher', error, { tenantId: null });
        }
        if (!stopped) timer = setTimeout(() => void (current = loop()), busy ? 0 : pollMs);
      };
      nudge = () => {
        if (stopped || !timer) return;
        clearTimeout(timer);
        timer = setTimeout(() => void (current = loop()), 0);
      };
      current = loop();
      observer.logger.info(
        { tenantId: null, operation: 'webhook.dispatcher', batchSize },
        'Webhook dispatcher started',
      );
      return {
        stop: async () => {
          stopped = true;
          nudge = undefined;
          if (timer) clearTimeout(timer);
          await current;
        },
      };
    },
  };

  return {
    name: 'webhooks',
    setup(context) {
      observer = context.observer;
      clock = context.clock;
      return { transports: [transport] };
    },
    extend(tenancy: Tenancy) {
      const t = tenancy as Tenancy & Partial<DatabaseExtension>;
      if (!t.database)
        throw new Error('The webhooks plugin needs the database plugin (@tenancy-node/db)');
      tenancyRef = t as Tenancy & DatabaseExtension;
      central = t.database.central();
      tenancy.events.forward(options.forward ?? '*', { transport: 'webhooks' });
      return { webhooks: api };
    },
  };
}
