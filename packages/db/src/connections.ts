import { LruCache, type Tenant } from '@tenancy-node/core';
import type { ConnectionOptions, Credentials } from './connection.js';
import type { Encrypter } from './crypto/encrypter.js';
import type { DatabaseDriver, OpenedConnection } from './drivers/driver.js';
import { DatabaseNotAssignedError } from './errors.js';
import type { ConnectionPoolRegistry, PoolLease } from './pool/connection-pool-registry.js';
import type { ServerRegistry } from './servers/server-registry.js';

export type CredentialsMode = 'shared' | 'per-tenant';
/** `database`: una base por tenant. `schema`: un schema por tenant dentro de una base compartida (PostgreSQL). */
export type IsolationMode = 'database' | 'schema';

export interface ConnectionManagerOptions {
  driver: DatabaseDriver;
  pools: ConnectionPoolRegistry;
  servers: ServerRegistry;
  encrypter: Encrypter;
  /** Usuario compartido de los tenants (modo `shared`). Por defecto, el administrador del servidor. */
  tenantCredentials?: Credentials | undefined;
  poolMax: number;
  ssl?: unknown;
  /** Errores de conexiones inactivas de los pools. */
  onPoolError?: (error: Error, pool: string) => void;
  isolation?: IsolationMode;
  /** Modo schema: base física donde viven los schemas de los tenants. */
  schemaDatabase?: string | undefined;
}

/** Arma las conexiones de cada tenant y de administración a partir del servidor asignado. */
export class ConnectionManager {
  /** Modo schema con credenciales compartidas: instancias livianas sobre el pool base de cada servidor. */
  private readonly scoped = new LruCache<string, OpenedConnection>({ max: 10_000 });

  constructor(private readonly options: ConnectionManagerOptions) {}

  /** Conexión del tenant (sus credenciales o las compartidas). El servidor debe estar cargado. */
  acquireTenant(tenant: Tenant): PoolLease {
    const database = tenant.database;
    if (!database) throw new DatabaseNotAssignedError(tenant.id.value);
    const connection = this.tenantConnection(tenant);

    if (database.schema && !database.username) {
      // Un solo pool por servidor; cada tenant recibe una instancia que fija su search_path.
      const baseKey = `${database.serverId}/${connection.database}/~shared/~base`;
      const base = this.options.pools.acquire(database.serverId, baseKey, () =>
        this.options.driver.connect({ ...connection, schema: undefined }, this.poolOptions(baseKey)),
      );
      const scopeKey = `${database.serverId}/${database.schema}`;
      let scoped = this.scoped.get(scopeKey);
      if (!scoped || scoped.native !== base.native) {
        scoped = this.options.driver.scope!({ db: base.db, native: base.native, destroy: async () => {} }, database.schema);
        this.scoped.set(scopeKey, scoped);
      }
      return { db: scoped.db, native: base.native, release: base.release };
    }

    const key = ConnectionManager.tenantKey(tenant);
    return this.options.pools.acquire(database.serverId, key, () =>
      this.options.driver.connect(connection, {
        ...this.poolOptions(key),
        ...(database.schema ? { schema: database.schema } : {}),
      }),
    );
  }

  /** Conexión de administración (crear y borrar bases, schemas y usuarios). */
  acquireAdmin(serverId: string, database = this.options.driver.adminDatabase): PoolLease {
    const server = this.options.servers.get(serverId);
    const credentials = this.options.servers.adminCredentials(server);
    const key = `${serverId}/~admin/${database ?? ''}`;
    return this.options.pools.acquire(serverId, key, () =>
      this.options.driver.connect(
        { host: server.host, port: server.port, user: credentials.user, password: credentials.password, database, ssl: this.options.ssl },
        { max: 2, onError: (error) => this.options.onPoolError?.(error, key) },
      ),
    );
  }

  /** Datos de conexión del tenant. En modo schema, `database` es la base compartida y `schema` el del tenant. */
  tenantConnection(tenant: Tenant): ConnectionOptions {
    const database = tenant.database;
    if (!database) throw new DatabaseNotAssignedError(tenant.id.value);
    const server = this.options.servers.get(database.serverId);
    const credentials: Credentials = database.username
      ? {
          user: database.username,
          password: database.passwordEncrypted ? this.options.encrypter.decrypt(database.passwordEncrypted) : undefined,
        }
      : (this.options.tenantCredentials ?? this.options.servers.adminCredentials(server));
    return {
      host: server.host,
      port: server.port,
      user: credentials.user,
      password: credentials.password,
      database: database.schema ? this.options.schemaDatabase : database.name,
      ...(database.schema ? { schema: database.schema } : {}),
      ssl: this.options.ssl,
    };
  }

  /** Cierra los pools del tenant (antes de borrar su base o cambiar sus credenciales). */
  closeTenant(tenant: Tenant): Promise<void> {
    const d = tenant.database;
    if (!d) return Promise.resolve();
    if (d.schema) this.scoped.delete(`${d.serverId}/${d.schema}`);
    // Mismo formato que tenantKey (el pool base compartido nunca se cierra aquí).
    const prefix = d.schema ? `${d.serverId}/~schema/${d.schema}/` : `${d.serverId}/${d.name}/`;
    return this.options.pools.closeWhere((key) => key.startsWith(prefix));
  }

  private poolOptions(key: string) {
    return { max: this.options.poolMax, onError: (error: Error) => this.options.onPoolError?.(error, key) };
  }

  /** URL con credenciales para una conexión (herramientas externas: Prisma, psql, scripts). */
  static toUrl(kind: 'mysql' | 'postgres' | 'sqlite' | 'mssql', c: ConnectionOptions): string {
    const auth = `${encodeURIComponent(c.user)}${c.password ? `:${encodeURIComponent(c.password)}` : ''}`;
    // Modo schema: libpq y node-postgres entienden `options=-c search_path=<schema>`.
    const query = c.schema ? `?options=${encodeURIComponent(`-c search_path=${c.schema}`)}` : '';
    return `${kind}://${auth}@${c.host}:${c.port}/${encodeURIComponent(c.database ?? '')}${query}`;
  }

  static tenantKey(tenant: Tenant): string {
    const d = tenant.database!;
    return d.schema ? `${d.serverId}/~schema/${d.schema}/${d.username ?? '~shared'}` : `${d.serverId}/${d.name}/${d.username ?? '~shared'}`;
  }
}
