import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ConnectionOptions, DatabaseDriver, OpenedConnection, PoolOptions } from '@tenancy-node/db';
import { assertSafeIdentifier, type AnyDB } from '@tenancy-node/db';
import Database from 'better-sqlite3';
import type {
  CompiledQuery} from 'kysely';
import {
  Kysely,
  SqliteDialect,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';

export interface SqliteDriverOptions {
  /** Carpeta de los archivos: `<directory>/<base>.sqlite`. Por defecto `./data`. */
  directory?: string;
  /** Espera ante un archivo bloqueado por otro proceso. Por defecto 5000 ms. */
  busyTimeoutMs?: number;
}

/** Candados del proceso, compartidos por todas las instancias del driver (clave: carpeta + nombre). */
const locks = new Map<string, Promise<unknown>>();

/** better-sqlite3 no acepta fechas ni booleanos como parámetros: se convierten a ISO 8601 y 1/0. */
function convert(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

class ConvertingConnection implements DatabaseConnection {
  constructor(private readonly inner: DatabaseConnection) {}
  executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    return this.inner.executeQuery<R>({ ...query, parameters: query.parameters.map(convert) });
  }
  streamQuery<R>(query: CompiledQuery, chunkSize?: number): AsyncIterableIterator<QueryResult<R>> {
    return this.inner.streamQuery<R>({ ...query, parameters: query.parameters.map(convert) }, chunkSize);
  }
}

class ConvertingDriver implements Driver {
  private readonly wrapped = new WeakMap<DatabaseConnection, ConvertingConnection>();
  constructor(private readonly inner: Driver) {}
  init() {
    return this.inner.init();
  }
  async acquireConnection() {
    const connection = await this.inner.acquireConnection();
    let wrapped = this.wrapped.get(connection);
    if (!wrapped) this.wrapped.set(connection, (wrapped = new ConvertingConnection(connection)));
    return wrapped;
  }
  private unwrap(connection: DatabaseConnection): DatabaseConnection {
    return (connection as unknown as { inner: DatabaseConnection }).inner ?? connection;
  }
  beginTransaction(connection: DatabaseConnection, settings: TransactionSettings) {
    return this.inner.beginTransaction(this.unwrap(connection), settings);
  }
  commitTransaction(connection: DatabaseConnection) {
    return this.inner.commitTransaction(this.unwrap(connection));
  }
  rollbackTransaction(connection: DatabaseConnection) {
    return this.inner.rollbackTransaction(this.unwrap(connection));
  }
  releaseConnection(connection: DatabaseConnection) {
    return this.inner.releaseConnection(this.unwrap(connection));
  }
  destroy() {
    return this.inner.destroy();
  }
}

/**
 * Driver SQLite: un archivo por tenant. Pensado para desarrollo, tests y apps pequeñas
 * con un solo proceso de escritura. No admite usuarios por tenant ni modo schema.
 */
export function sqlite(options: SqliteDriverOptions = {}): DatabaseDriver {
  const directory = path.resolve(options.directory ?? 'data');
  const fileOf = (name: string | undefined) => (!name || name === ':memory:' ? ':memory:' : path.join(directory, `${assertSafeIdentifier(name)}.sqlite`));

  const open = (file: string) => {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    const database = new Database(file);
    database.pragma('journal_mode = WAL');
    database.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    // SQLite trae las claves foráneas apagadas.
    database.pragma('foreign_keys = ON');
    return database;
  };

  return {
    name: 'sqlite',
    kind: 'sqlite',
    defaultPort: 0,
    maxIdentifierLength: 64,
    maxUserLength: 0,
    adminDatabase: undefined,
    supportsSchemas: false,

    connect(connection: ConnectionOptions, _pool: PoolOptions): OpenedConnection {
      const native = open(fileOf(connection.database));
      const dialect = new SqliteDialect({ database: native });
      const db = new Kysely<AnyDB>({
        dialect: {
          createAdapter: () => dialect.createAdapter(),
          createDriver: () => new ConvertingDriver(dialect.createDriver()),
          createIntrospector: (k) => dialect.createIntrospector(k),
          createQueryCompiler: () => dialect.createQueryCompiler(),
        },
      });
      return { db, native, destroy: () => db.destroy() };
    },

    async databaseExists(_admin, name) {
      return existsSync(fileOf(name));
    },

    async createDatabase(_admin, name) {
      open(fileOf(name)).close();
    },

    async dropDatabase(_admin, name) {
      const file = fileOf(name);
      for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
    },

    async createUser() {
      throw new Error('SQLite has no database users: use credentials: "shared"');
    },

    async dropUser() {},

    /** Candado dentro del proceso (SQLite se usa con un solo proceso que escribe). */
    async withLock(_db, name, _timeoutMs, fn) {
      const key = `${directory}:${name}`;
      const previous = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => (release = resolve));
      const chained = previous.then(() => current);
      locks.set(key, chained);
      await previous.catch(() => undefined);
      try {
        return await fn();
      } finally {
        release();
        if (locks.get(key) === chained) locks.delete(key);
      }
    },

    isUniqueViolation(error) {
      const code = (error as { code?: string })?.code ?? '';
      return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
    },

    isTransientError(error) {
      const code = (error as { code?: string })?.code ?? '';
      return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
    },
  };
}
