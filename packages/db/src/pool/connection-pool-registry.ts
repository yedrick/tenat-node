import type { Logger } from '@tenancy-node/core';
import type { OpenedConnection } from '../drivers/driver.js';
import type { AnyKysely } from '../kysely-any.js';

export interface PoolRegistryOptions {
  /** Pools abiertos como máximo por servidor. Los menos usados y libres se cierran. Por defecto 100. */
  maxOpenPools?: number;
  /** Cierra pools sin uso después de este tiempo. `0` = nunca. Por defecto 60 000. */
  idleTimeoutMs?: number;
  logger: Logger;
  now?: () => number;
}

interface Entry {
  readonly key: string;
  readonly serverId: string;
  readonly connection: OpenedConnection;
  readonly createdAt: number;
  refs: number;
  lastUsed: number;
  /** Se pidió cerrarlo mientras estaba en uso: se cierra al liberarse. */
  draining: boolean;
}

/** Préstamo de un pool: hay que liberarlo cuando se termina de usar. */
export interface PoolLease {
  readonly db: AnyKysely;
  readonly native: unknown;
  release(): void;
}

export interface PoolStats {
  servers: Record<string, { open: number; inUse: number; maxOpenPools: number }>;
  pools: { key: string; serverId: string; refs: number; idleMs: number; ageMs: number }[];
}

/**
 * Registro de pools por tenant (Registry + LRU).
 * - Carga perezosa: el pool se crea con la primera petición.
 * - LRU por servidor: respeta el límite de conexiones de cada servidor.
 * - Conteo de referencias: nunca se cierra un pool que alguien está usando.
 */
export class ConnectionPoolRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly maxOpenPools: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly closing = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(options: PoolRegistryOptions) {
    this.maxOpenPools = options.maxOpenPools ?? 100;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    if (this.idleTimeoutMs > 0) {
      this.timer = setInterval(
        () => this.sweepIdle(),
        Math.max(1000, Math.floor(this.idleTimeoutMs / 2)),
      );
      this.timer.unref();
    }
  }

  acquire(serverId: string, key: string, open: () => OpenedConnection): PoolLease {
    let entry = this.entries.get(key);
    if (entry && entry.draining) entry = undefined;
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      entry.refs++;
      entry.lastUsed = this.now();
    } else {
      // Nace con una referencia: así la evicción nunca cierra el pool que se está pidiendo.
      entry = {
        key,
        serverId,
        connection: open(),
        createdAt: this.now(),
        refs: 1,
        lastUsed: this.now(),
        draining: false,
      };
      this.entries.set(key, entry);
      this.logger.debug({ operation: 'db.pool.open', serverId, pool: key }, 'Opened database pool');
      this.evict(serverId);
    }

    const current = entry;
    let released = false;
    return {
      db: current.connection.db,
      native: current.connection.native,
      release: () => {
        if (released) return;
        released = true;
        current.refs--;
        current.lastUsed = this.now();
        if (current.refs > 0) return;
        if (current.draining) this.destroy(current, 'drained');
        // Si se excedió el límite mientras todos estaban en uso, se vuelve a él al liberar.
        else this.evict(current.serverId, false);
      },
    };
  }

  /** Cierra los pools cuyo key cumple la condición (los que están en uso, al liberarse). */
  async closeWhere(predicate: (key: string, serverId: string) => boolean): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      if (!predicate(entry.key, entry.serverId)) continue;
      if (entry.refs > 0) entry.draining = true;
      else this.destroy(entry, 'closed');
    }
    await this.settle();
  }

  async closeAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const entry of [...this.entries.values()]) this.destroy(entry, 'shutdown');
    await this.settle();
  }

  /** Cierra los pools libres que llevan más de `idleTimeoutMs` sin uso. */
  sweepIdle(): void {
    if (this.idleTimeoutMs <= 0) return;
    const limit = this.now() - this.idleTimeoutMs;
    for (const entry of [...this.entries.values()]) {
      if (entry.refs === 0 && entry.lastUsed <= limit) this.destroy(entry, 'idle');
    }
  }

  stats(): PoolStats {
    const now = this.now();
    const servers: PoolStats['servers'] = {};
    const pools: PoolStats['pools'] = [];
    for (const entry of this.entries.values()) {
      const server = (servers[entry.serverId] ??= {
        open: 0,
        inUse: 0,
        maxOpenPools: this.maxOpenPools,
      });
      server.open++;
      if (entry.refs > 0) server.inUse++;
      pools.push({
        key: entry.key,
        serverId: entry.serverId,
        refs: entry.refs,
        idleMs: entry.refs > 0 ? 0 : now - entry.lastUsed,
        ageMs: now - entry.createdAt,
      });
    }
    return { servers, pools };
  }

  private evict(serverId: string, warn = true): void {
    const ofServer = [...this.entries.values()].filter(
      (e) => e.serverId === serverId && !e.draining,
    );
    let excess = ofServer.length - this.maxOpenPools;
    for (const entry of ofServer) {
      if (excess <= 0) return;
      if (entry.refs === 0) {
        this.destroy(entry, 'evicted');
        excess--;
      }
    }
    if (excess > 0 && warn) {
      this.logger.warn(
        {
          operation: 'db.pool.limit',
          serverId,
          open: ofServer.length,
          maxOpenPools: this.maxOpenPools,
        },
        'All database pools are in use; the pool limit was exceeded temporarily',
      );
    }
  }

  private destroy(entry: Entry, reason: string): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    const task = entry.connection
      .destroy()
      .then(() => {
        this.logger.debug(
          { operation: 'db.pool.close', serverId: entry.serverId, pool: entry.key, reason },
          'Closed database pool',
        );
      })
      .catch((error: unknown) => {
        this.logger.error(
          {
            operation: 'db.pool.close',
            outcome: 'error',
            serverId: entry.serverId,
            pool: entry.key,
            err: error,
          },
          'Failed to close database pool',
        );
      });
    this.closing.add(task);
    void task.finally(() => this.closing.delete(task));
  }

  private async settle(): Promise<void> {
    await Promise.all([...this.closing]);
  }
}
