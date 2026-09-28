import {
  parseCloudEvent,
  toCloudEvent,
  type CloudEvent,
  type EventTransport,
} from '@tenancy-node/core';
import { Redis, type RedisOptions } from 'ioredis';

export interface RedisStreamsOptions {
  /** Por defecto `redis://127.0.0.1:6379`. Acepta `process.env.REDIS_URL` aunque no esté definida. */
  url?: string | undefined;
  client?: Redis;
  redisOptions?: RedisOptions;
  /** Stream de destino. Por defecto `tenancy:events` (o `routingKey` de `forward`). */
  stream?: string | undefined;
  /** Largo aproximado máximo del stream (`MAXLEN ~`). Por defecto 100 000. */
  maxLen?: number;
  name?: string;
}

/** Transporte a Redis Streams: `XADD <stream> MAXLEN ~ n * event <CloudEvent JSON>`. */
export function redisStreams(
  options: RedisStreamsOptions = {},
): EventTransport & { client: Redis } {
  const owned = !options.client;
  const client =
    options.client ??
    new Redis(options.url ?? 'redis://127.0.0.1:6379', options.redisOptions ?? {});
  return {
    name: options.name ?? 'redis-streams',
    client,
    async send(event, { source, routingKey }) {
      const cloud = toCloudEvent(event, source);
      await client.xadd(
        routingKey ?? options.stream ?? 'tenancy:events',
        'MAXLEN',
        '~',
        String(options.maxLen ?? 100_000),
        '*',
        'id',
        cloud.id,
        'type',
        cloud.type,
        'tenantid',
        cloud.tenantid ?? '',
        'event',
        JSON.stringify(cloud),
      );
    },
    async ping() {
      await client.ping();
    },
    async close() {
      if (owned) await client.quit().catch(() => client.disconnect());
    },
  };
}

export interface RedisStreamConsumerOptions {
  url?: string | undefined;
  redisOptions?: RedisOptions;
  stream?: string | undefined;
  /** Grupo de consumidores (cada microservicio usa el suyo). */
  group: string;
  /** Nombre de esta instancia dentro del grupo. */
  consumer: string;
  /** Si lanza, el mensaje no se confirma y se reintenta (lo retoma `XAUTOCLAIM`) hasta `maxAttempts`. */
  handler: (event: CloudEvent) => Promise<void>;
  /** Mensajes pendientes con más de este tiempo se retoman de consumidores caídos. Por defecto 30 s. */
  claimIdleMs?: number;
  batch?: number;
  blockMs?: number;
  /** Entregas antes de descartar un mensaje que siempre falla (se confirma). Por defecto 5. */
  maxAttempts?: number;
  /**
   * Stream donde se copian los mensajes descartados (agotaron `maxAttempts` o no traen un
   * CloudEvent válido), con el campo `error`. Por defecto no se copian.
   */
  deadLetterStream?: string;
  /** Recibe cada fallo del handler, los mensajes descartados y los errores de conexión del bucle. */
  onError?: (error: unknown, event: CloudEvent | undefined) => void;
}

/**
 * Consume eventos de un stream con un grupo: confirma (`XACK`) solo después de procesar.
 * Un mensaje que falla `maxAttempts` veces, o que no trae un campo `event` válido, se confirma
 * (y se copia a `deadLetterStream` si se indicó) para que no se reintente para siempre.
 */
export function consumeRedisStream(options: RedisStreamConsumerOptions): { stop(): Promise<void> } {
  const client = new Redis(options.url ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
    ...options.redisOptions,
  });
  const stream = options.stream ?? 'tenancy:events';
  const maxAttempts = options.maxAttempts ?? 5;
  let stopped = false;

  // Un `onError` que lanza no debe detener el consumidor.
  const report = (error: unknown, event: CloudEvent | undefined) => {
    try {
      options.onError?.(error, event);
    } catch {
      // ignorado
    }
  };

  /** Confirma un mensaje que no se volverá a procesar y lo copia a la dead-letter si hay. */
  const discard = async (id: string, fields: string[], error: unknown) => {
    if (options.deadLetterStream) {
      const message = error instanceof Error ? error.message : String(error);
      await client.xadd(options.deadLetterStream, '*', ...fields, 'error', message, 'sourceid', id);
    }
    await client.xack(stream, options.group, id);
  };

  /** Veces que se entregó el mensaje (según la lista de pendientes del grupo). */
  const deliveries = async (id: string) => {
    const pending = (await client.xpending(stream, options.group, id, id, 1)) as [
      string,
      string,
      number,
      number,
    ][];
    return Number(pending[0]?.[3] ?? 1);
  };

  const handle = async (entries: [string, string[] | null][]) => {
    for (const [id, fields] of entries) {
      // XAUTOCLAIM devuelve `null` para entradas borradas del stream (p. ej. por MAXLEN).
      if (!fields) {
        await client.xack(stream, options.group, id);
        continue;
      }
      let event: CloudEvent | undefined;
      try {
        const index = fields.findIndex((field, i) => i % 2 === 0 && field === 'event');
        if (index === -1) throw new Error(`Stream entry ${id} has no "event" field`);
        event = parseCloudEvent(fields[index + 1]);
      } catch (error) {
        // Mensaje inválido: reintentarlo no sirve de nada.
        report(error, undefined);
        await discard(id, fields, error);
        continue;
      }
      try {
        await options.handler(event);
        await client.xack(stream, options.group, id);
      } catch (error) {
        report(error, event);
        const count = await deliveries(id);
        if (count >= maxAttempts) {
          report(
            new Error(`Event ${event.id} discarded after ${count} failed deliveries`),
            event,
          );
          await discard(id, fields, error);
        }
      }
    }
  };

  const ensureGroup = () =>
    client.xgroup('CREATE', stream, options.group, '0', 'MKSTREAM').catch((e: Error) => {
      if (!e.message.includes('BUSYGROUP')) throw e;
    });

  const loop = (async () => {
    let ready = false;
    while (!stopped) {
      try {
        if (!ready) {
          await ensureGroup();
          ready = true;
        }
        // Primero, lo que otros consumidores (o este) dejaron sin confirmar.
        const claimed = (await client.xautoclaim(
          stream,
          options.group,
          options.consumer,
          options.claimIdleMs ?? 30_000,
          '0-0',
          'COUNT',
          options.batch ?? 50,
        )) as [string, [string, string[] | null][]];
        if (claimed[1].length > 0) await handle(claimed[1]);
        const result = (await client.xreadgroup(
          'GROUP',
          options.group,
          options.consumer,
          'COUNT',
          options.batch ?? 50,
          'BLOCK',
          options.blockMs ?? 1000,
          'STREAMS',
          stream,
          '>',
        )) as [string, [string, string[]][]][] | null;
        if (result) for (const [, entries] of result) await handle(entries);
      } catch (error) {
        if (stopped) break;
        // Error de Redis (conexión, stream o grupo borrados): avisar, esperar y volver a empezar.
        report(error, undefined);
        ready = false;
        await new Promise((r) => setTimeout(r, options.blockMs ?? 1000));
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      await loop;
      client.disconnect();
    },
  };
}
