import {
  tenantCachePrefix,
  type CacheStore,
  type InvalidationBus,
  type InvalidationMessage,
} from '@tenancy-node/core';
import { Redis, type RedisOptions } from 'ioredis';

export interface RedisCacheOptions {
  /** `redis://localhost:6379`. Se ignora si se pasa `client`. */
  url?: string | undefined;
  /** Cliente ioredis propio (no se cierra al terminar). */
  client?: Redis;
  redisOptions?: RedisOptions;
  /** Prefijo global de las llaves. Por defecto `tenancy:`. */
  keyPrefix?: string | undefined;
  /** Llaves por iteración de SCAN al vaciar un tenant. Por defecto 500. */
  scanCount?: number;
}

/**
 * Caché en Redis o Valkey. Los valores se guardan como JSON (las fechas vuelven como texto).
 * `flushTenant` usa `SCAN` + `UNLINK`: no bloquea el servidor aunque haya millones de llaves.
 */
export class RedisCacheStore implements CacheStore {
  readonly client: Redis;
  private readonly prefix: string;
  private readonly scanCount: number;
  private readonly owned: boolean;

  constructor(options: RedisCacheOptions = {}) {
    this.owned = !options.client;
    this.client =
      options.client ??
      new Redis(options.url ?? 'redis://127.0.0.1:6379', {
        lazyConnect: false,
        ...options.redisOptions,
      });
    this.prefix = options.keyPrefix ?? 'tenancy:';
    this.scanCount = options.scanCount ?? 500;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(this.prefix + key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (value === undefined) {
      await this.delete(key);
      return;
    }
    const raw = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0)
      await this.client.set(this.prefix + key, raw, 'EX', Math.ceil(ttlSeconds));
    else await this.client.set(this.prefix + key, raw);
  }

  async delete(key: string): Promise<void> {
    await this.client.unlink(this.prefix + key);
  }

  async flushTenant(tenantId: string): Promise<void> {
    const pattern = `${escapeGlob(this.prefix + tenantCachePrefix(tenantId))}*`;
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        this.scanCount,
      );
      cursor = next;
      if (keys.length > 0) await this.client.unlink(...keys);
    } while (cursor !== '0');
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async close(): Promise<void> {
    if (this.owned) await this.client.quit().catch(() => this.client.disconnect());
  }
}

function escapeGlob(value: string): string {
  return value.replace(/[*?[\]\\]/g, (c) => `\\${c}`);
}

/** `cache: redis({ url: process.env.REDIS_URL })` */
export function redis(options: RedisCacheOptions = {}): RedisCacheStore {
  return new RedisCacheStore(options);
}

export interface RedisInvalidationOptions {
  /** `redis://localhost:6379`. Se ignora si se pasa `client`. */
  url?: string | undefined;
  /** Cliente para publicar (no se cierra al terminar). La suscripción usa una copia (`duplicate()`). */
  client?: Redis;
  redisOptions?: RedisOptions;
  /** Canal de pub/sub. Por defecto `tenancy:invalidation`. Usa uno por app si comparten Redis. */
  channel?: string | undefined;
  /** Mensajes que no se pudieron leer (de otra versión o ajenos al canal). */
  onError?: (error: unknown) => void;
}

const KINDS = new Set(['tenant', 'domain', 'domains-of', 'all']);

function parseMessage(raw: string): InvalidationMessage {
  const message = JSON.parse(raw) as InvalidationMessage;
  if (
    typeof message?.origin !== 'string' ||
    !Array.isArray(message.items) ||
    !message.items.every((i) => i && KINDS.has(i.kind))
  )
    throw new Error('Invalid invalidation message');
  return message;
}

/**
 * Invalidación entre instancias con Redis pub/sub: cuando una réplica cambia un tenant o un
 * dominio, las demás borran su caché de búsqueda en el acto.
 *
 * `invalidation: redisInvalidation({ url: process.env.REDIS_URL })`
 */
export function redisInvalidation(options: RedisInvalidationOptions = {}): InvalidationBus {
  const channel = options.channel ?? 'tenancy:invalidation';
  const owned = !options.client;
  const publisher =
    options.client ?? new Redis(options.url ?? 'redis://127.0.0.1:6379', { ...options.redisOptions });
  let subscriber: Redis | undefined;
  return {
    async publish(message) {
      await publisher.publish(channel, JSON.stringify(message));
    },
    async subscribe(handler) {
      // Una conexión en modo suscripción no puede publicar: va aparte.
      subscriber ??= publisher.duplicate();
      subscriber.on('message', (from: string, raw: string) => {
        if (from !== channel) return;
        let message: InvalidationMessage;
        try {
          message = parseMessage(raw);
        } catch (error) {
          options.onError?.(error);
          return;
        }
        handler(message);
      });
      // ioredis vuelve a suscribirse solo tras una reconexión.
      await subscriber.subscribe(channel);
    },
    async ping() {
      await publisher.ping();
    },
    async close() {
      if (subscriber) await subscriber.quit().catch(() => subscriber?.disconnect());
      if (owned) await publisher.quit().catch(() => publisher.disconnect());
    },
  };
}
