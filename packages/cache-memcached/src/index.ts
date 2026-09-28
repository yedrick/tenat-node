import { createHash } from 'node:crypto';
import type { CacheStore } from '@tenancy-node/core';
import memjs from 'memjs';

export interface MemcachedOptions {
  /** `host:port` separados por coma. Por defecto `127.0.0.1:11211`. */
  servers?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  /** Prefijo global de las llaves. Por defecto `tenancy:`. */
  keyPrefix?: string | undefined;
  /**
   * Cuánto se recuerda en el proceso la versión de un tenant. Tras `flushTenant` en otra instancia,
   * esta la ve como mucho después de este tiempo. Por defecto 1000 ms.
   */
  versionCacheMs?: number;
}

/** Memcached no admite espacios ni caracteres de control en las llaves. */
function hasUnsafeChars(key: string): boolean {
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

const TENANT_KEY = /^tenant:([a-z0-9_-]+):(.*)$/s;

/**
 * Caché en Memcached. Memcached no permite borrar por prefijo, así que cada tenant tiene un
 * número de versión dentro de sus llaves: `flushTenant` la incrementa y lo anterior queda
 * inalcanzable (y vence solo).
 */
export class MemcachedCacheStore implements CacheStore {
  readonly client: memjs.Client;
  private readonly prefix: string;
  private readonly versionTtl: number;
  private readonly versions = new Map<string, { version: string; until: number }>();

  constructor(options: MemcachedOptions = {}) {
    this.client = memjs.Client.create(options.servers ?? '127.0.0.1:11211', {
      ...(options.username ? { username: options.username } : {}),
      ...(options.password ? { password: options.password } : {}),
      retries: 1,
      timeout: 2,
    });
    this.prefix = options.keyPrefix ?? 'tenancy:';
    this.versionTtl = options.versionCacheMs ?? 1000;
  }

  private versionKey(tenantId: string): string {
    return `${this.prefix}ver:${tenantId}`;
  }

  private async version(tenantId: string): Promise<string> {
    const cached = this.versions.get(tenantId);
    if (cached && cached.until > Date.now()) return cached.version;
    const { value } = await this.client.get(this.versionKey(tenantId));
    let version = value?.toString();
    if (!version) {
      // `add` no pisa una versión creada en paralelo por otra instancia.
      await this.client.add(this.versionKey(tenantId), '1', { expires: 0 }).catch(() => false);
      version = (await this.client.get(this.versionKey(tenantId))).value?.toString() ?? '1';
    }
    this.versions.set(tenantId, { version, until: Date.now() + this.versionTtl });
    return version;
  }

  /** Llave real: con la versión del tenant; con hash si no cabe en los 250 bytes de Memcached. */
  private async key(key: string): Promise<string> {
    const match = TENANT_KEY.exec(key);
    const raw = match ? `${this.prefix}${match[1]}:v${await this.version(match[1]!)}:${match[2]}` : `${this.prefix}${key}`;
    return raw.length > 200 || hasUnsafeChars(raw) ? `${this.prefix}h:${createHash('sha1').update(raw).digest('hex')}` : raw;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const { value } = await this.client.get(await this.key(key));
    return value ? (JSON.parse(value.toString('utf8')) as T) : undefined;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (value === undefined) return this.delete(key);
    await this.client.set(await this.key(key), JSON.stringify(value), { expires: ttlSeconds && ttlSeconds > 0 ? Math.ceil(ttlSeconds) : 0 });
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(await this.key(key));
  }

  async flushTenant(tenantId: string): Promise<void> {
    const { value } = await this.client.increment(this.versionKey(tenantId), 1, { initial: 2, expires: 0 });
    this.versions.set(tenantId, { version: String(value ?? 2), until: Date.now() + this.versionTtl });
  }

  async ping(): Promise<void> {
    // Un `get` cualquiera: falla si el servidor no responde.
    await this.client.get(`${this.prefix}ping`);
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

/** `cache: memcached({ servers: process.env.MEMCACHED_SERVERS })` */
export function memcached(options: MemcachedOptions = {}): MemcachedCacheStore {
  return new MemcachedCacheStore(options);
}
