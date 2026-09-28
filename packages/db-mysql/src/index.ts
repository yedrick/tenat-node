import {
  LockTimeoutError,
  assertSafeIdentifier,
  assertSafePassword,
  type AnyDB,
  type ConnectionOptions,
  type DatabaseDriver,
  type OpenedConnection,
} from '@tenancy-node/db';
import { Kysely, MysqlDialect, sql } from 'kysely';
import { createPool } from 'mysql2';

export interface MysqlDriverOptions {
  /** `mariadb` para MariaDB 10.6+. Por defecto `mysql` (MySQL 8+). */
  variant?: 'mysql' | 'mariadb';
  charset?: string;
  collation?: string;
}

const ident = (name: string) => `\`${assertSafeIdentifier(name)}\``;

/**
 * Driver MySQL / MariaDB: una base por tenant, credenciales compartidas o por tenant,
 * candados con `GET_LOCK`.
 */
export function mysql(options: MysqlDriverOptions = {}): DatabaseDriver {
  const charset = options.charset ?? 'utf8mb4';
  const collation = options.collation ?? 'utf8mb4_unicode_ci';

  return {
    name: options.variant ?? 'mysql',
    kind: 'mysql',
    defaultPort: 3306,
    maxIdentifierLength: 64,
    maxUserLength: 32,
    adminDatabase: undefined,

    // MySQL no tiene schemas dentro de una base (schema = base): solo modo base por tenant.

    supportsSchemas: false,


    connect(
      connection: ConnectionOptions,
      pool: { max: number; onError?: (error: Error) => void },
    ): OpenedConnection {
      const native = createPool({
        host: connection.host,
        port: connection.port,
        user: connection.user,
        ...(connection.password !== undefined ? { password: connection.password } : {}),
        ...(connection.database ? { database: connection.database } : {}),
        ...(connection.ssl ? { ssl: connection.ssl as never } : {}),
        connectionLimit: pool.max,
        timezone: 'Z',
        charset: collation.toUpperCase(),
        supportBigNumbers: true,
        decimalNumbers: true,
      });
      native.on('error' as never, (error: Error) => pool.onError?.(error));
      const db = new Kysely<AnyDB>({ dialect: new MysqlDialect({ pool: native }) });
      return { db, native, destroy: () => db.destroy() };
    },

    async databaseExists(admin, name) {
      const result = await sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${name}`.execute(
        admin,
      );
      return Number(result.rows[0]?.n ?? 0) > 0;
    },

    async createDatabase(admin, name) {
      await sql
        .raw(
          `CREATE DATABASE IF NOT EXISTS ${ident(name)} CHARACTER SET ${assertSafeIdentifier(charset)} COLLATE ${assertSafeIdentifier(collation)}`,
        )
        .execute(admin);
    },

    async dropDatabase(admin, name) {
      await sql.raw(`DROP DATABASE IF EXISTS ${ident(name)}`).execute(admin);
    },

    async createUser(admin, username, password, database) {
      const user = `'${assertSafeIdentifier(username)}'@'%'`;
      const secret = `'${assertSafePassword(password)}'`;
      await sql.raw(`CREATE USER IF NOT EXISTS ${user} IDENTIFIED BY ${secret}`).execute(admin);
      await sql.raw(`ALTER USER ${user} IDENTIFIED BY ${secret}`).execute(admin);
      await sql.raw(`GRANT ALL PRIVILEGES ON ${ident(database)}.* TO ${user}`).execute(admin);
    },

    async dropUser(admin, username) {
      await sql.raw(`DROP USER IF EXISTS '${assertSafeIdentifier(username)}'@'%'`).execute(admin);
    },

    async withLock(db, key, timeoutMs, fn) {
      return db.connection().execute(async (conn) => {
        const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
        const result = await sql<{
          acquired: number | null;
        }>`SELECT GET_LOCK(${key}, ${seconds}) AS acquired`.execute(conn);
        if (Number(result.rows[0]?.acquired) !== 1) throw new LockTimeoutError(key);
        try {
          return await fn();
        } finally {
          await sql`SELECT RELEASE_LOCK(${key})`.execute(conn);
        }
      });
    },

    isTransientError(error) {
      const e = error as { code?: string; errno?: number };
      // 1213 = deadlock, 1205 = lock wait timeout
      return (
        e?.errno === 1213 ||
        e?.errno === 1205 ||
        e?.code === 'ER_LOCK_DEADLOCK' ||
        e?.code === 'ER_LOCK_WAIT_TIMEOUT'
      );
    },

    isUniqueViolation(error) {
      const e = error as { code?: string; errno?: number };
      return e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062;
    },
  };
}
