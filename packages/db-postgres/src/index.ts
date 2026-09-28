import {
  LockTimeoutError,
  assertSafeIdentifier,
  assertSafePassword,
  type AnyDB,
  type ConnectionOptions,
  type DatabaseDriver,
  type OpenedConnection,
  type PoolOptions,
} from '@tenancy-node/db';
import { CompiledQuery, Kysely, PostgresDialect, sql, type DatabaseConnection } from 'kysely';
import pg from 'pg';

export interface PostgresDriverOptions {
  /** Base a la que se conecta el administrador para crear bases. Por defecto `postgres`. */
  adminDatabase?: string;
}

const ident = (name: string) => `"${assertSafeIdentifier(name)}"`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `SET search_path` solo al schema del tenant (sin `public`: las tablas centrales no quedan a la vista). */
const searchPath = (schema: string) => async (connection: DatabaseConnection) => {
  await connection.executeQuery(CompiledQuery.raw(`SET search_path TO ${ident(schema)}`));
};

/**
 * Driver PostgreSQL 13+: una base por tenant, credenciales compartidas o por tenant,
 * candados con `pg_advisory_lock`.
 */
export function postgres(options: PostgresDriverOptions = {}): DatabaseDriver {
  return {
    name: 'postgres',
    kind: 'postgres',
    defaultPort: 5432,
    maxIdentifierLength: 63,
    maxUserLength: 63,
    adminDatabase: options.adminDatabase ?? 'postgres',

        supportsSchemas: true,

    connect(connection: ConnectionOptions, pool: PoolOptions): OpenedConnection {const native = new pg.Pool({
        host: connection.host,
        port: connection.port,
        user: connection.user,
        ...(connection.password !== undefined ? { password: connection.password } : {}),
        ...(connection.database ? { database: connection.database } : {}),
        ...(connection.ssl ? { ssl: connection.ssl as never } : {}),
        max: pool.max,
      });
      native.on('error', (error) => pool.onError?.(error));
      const db = new Kysely<AnyDB>({
        dialect: new PostgresDialect({ pool: native, ...(pool.schema ? { onReserveConnection: searchPath(pool.schema) } : {}) }),
      });
      return { db, native, destroy: () => db.destroy() };
    },

    scope(base, schema) {
      // Mismo pool nativo; cada conexión que se toma queda apuntando al schema del tenant.
      const db = new Kysely<AnyDB>({
        dialect: new PostgresDialect({ pool: base.native as pg.Pool, onReserveConnection: searchPath(schema) }),
      });
      return { db, native: base.native, destroy: async () => {} };
    },

    async schemaExists(admin, schema) {
      const result = await sql<{ n: string }>`SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ${schema}`.execute(admin);
      return Number(result.rows[0]?.n ?? 0) > 0;
    },

    async createSchema(admin, schema) {
      await sql.raw(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`).execute(admin);
    },

    async dropSchema(admin, schema) {
      await sql.raw(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`).execute(admin);
    },

    async grantSchema(admin, username, schema, database) {
      const role = ident(username);
      await sql.raw(`GRANT CONNECT ON DATABASE ${ident(database)} TO ${role}`).execute(admin);
      // El usuario del tenant es dueño de su schema y de nada más.
      await sql.raw(`ALTER SCHEMA ${ident(schema)} OWNER TO ${role}`).execute(admin);
      await sql.raw(`REVOKE CREATE ON SCHEMA public FROM ${role}`).execute(admin);
    },

    async databaseExists(admin, name) {
      const result = await sql<{
        n: string;
      }>`SELECT COUNT(*) AS n FROM pg_database WHERE datname = ${name}`.execute(admin);
      return Number(result.rows[0]?.n ?? 0) > 0;
    },

    async createDatabase(admin, name) {
      if (await this.databaseExists(admin, name)) return;
      // CREATE DATABASE no puede ir en una transacción: se ejecuta suelto.
      await sql
        .raw(`CREATE DATABASE ${ident(name)} WITH ENCODING 'UTF8' TEMPLATE template0`)
        .execute(admin);
    },

    async dropDatabase(admin, name) {
      await sql.raw(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`).execute(admin);
    },

    async createRole(admin, username, password) {
      const role = ident(username);
      const secret = `'${assertSafePassword(password)}'`;
      const exists = await sql<{ n: string }>`SELECT COUNT(*) AS n FROM pg_roles WHERE rolname = ${username}`.execute(admin);
      if (Number(exists.rows[0]?.n ?? 0) === 0) await sql.raw(`CREATE ROLE ${role} LOGIN PASSWORD ${secret}`).execute(admin);
      else await sql.raw(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${secret}`).execute(admin);
    },

    async createUser(admin, username, password, database) {
      const role = ident(username);
      const secret = `'${assertSafePassword(password)}'`;
      const exists = await sql<{
        n: string;
      }>`SELECT COUNT(*) AS n FROM pg_roles WHERE rolname = ${username}`.execute(admin);
      if (Number(exists.rows[0]?.n ?? 0) === 0) {
        await sql.raw(`CREATE ROLE ${role} LOGIN PASSWORD ${secret}`).execute(admin);
      } else {
        await sql.raw(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${secret}`).execute(admin);
      }
      await sql.raw(`ALTER DATABASE ${ident(database)} OWNER TO ${role}`).execute(admin);
      await sql.raw(`REVOKE CONNECT ON DATABASE ${ident(database)} FROM PUBLIC`).execute(admin);
      await sql.raw(`GRANT CONNECT ON DATABASE ${ident(database)} TO ${role}`).execute(admin);
    },

    async dropUser(admin, username) {
      await sql.raw(`DROP ROLE IF EXISTS ${ident(username)}`).execute(admin);
    },

    async withLock(db, key, timeoutMs, fn) {
      return db.connection().execute(async (conn) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const result = await sql<{
            acquired: boolean;
          }>`SELECT pg_try_advisory_lock(hashtext(${key})) AS acquired`.execute(conn);
          if (result.rows[0]?.acquired) break;
          if (Date.now() >= deadline) throw new LockTimeoutError(key);
          await sleep(100);
        }
        try {
          return await fn();
        } finally {
          await sql`SELECT pg_advisory_unlock(hashtext(${key}))`.execute(conn);
        }
      });
    },

    isTransientError(error) {
      const code = (error as { code?: string })?.code;
      // 40P01 = deadlock, 40001 = serialization failure, 55P03 = lock not available
      return code === '40P01' || code === '40001' || code === '55P03';
    },

    isUniqueViolation(error) {
      return (error as { code?: string })?.code === '23505';
    },
  };
}
