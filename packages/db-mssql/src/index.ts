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
import { Kysely, MssqlDialect, sql } from 'kysely';
import * as tarn from 'tarn';
import * as tedious from 'tedious';

export interface MssqlDriverOptions {
  /** Cifrar la conexión (TLS). Por defecto `true`. */
  encrypt?: boolean;
  /** Aceptar certificados autofirmados (desarrollo y Docker). Por defecto `false`. */
  trustServerCertificate?: boolean;
}

const ident = (name: string) => `[${assertSafeIdentifier(name)}]`;

/**
 * Driver SQL Server 2019+: una base por tenant, credenciales compartidas o por tenant
 * (login + usuario dueño de la base), candados con `sp_getapplock`.
 */
export function mssql(options: MssqlDriverOptions = {}): DatabaseDriver {
  return {
    name: 'mssql',
    kind: 'mssql',
    defaultPort: 1433,
    maxIdentifierLength: 128,
    maxUserLength: 128,
    adminDatabase: 'master',
    supportsSchemas: false,

    connect(connection: ConnectionOptions, pool: PoolOptions): OpenedConnection {
      const dialect = new MssqlDialect({
        tarn: { ...tarn, options: { min: 0, max: pool.max } },
        tedious: {
          ...tedious,
          connectionFactory: () => {
            const c = new tedious.Connection({
              server: connection.host,
              authentication: { type: 'default', options: { userName: connection.user, password: connection.password ?? '' } },
              options: {
                port: connection.port,
                ...(connection.database ? { database: connection.database } : {}),
                encrypt: options.encrypt ?? true,
                trustServerCertificate: options.trustServerCertificate ?? false,
                useUTC: true,
              },
            });
            c.on('error', (error: Error) => pool.onError?.(error));
            return c;
          },
        },
      });
      const db = new Kysely<AnyDB>({ dialect });
      return { db, native: dialect, destroy: () => db.destroy() };
    },

    async databaseExists(admin, name) {
      const result = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM sys.databases WHERE name = ${name}`.execute(admin);
      return Number(result.rows[0]?.n ?? 0) > 0;
    },

    async createDatabase(admin, name) {
      await sql.raw(`IF DB_ID(N'${assertSafeIdentifier(name)}') IS NULL CREATE DATABASE ${ident(name)}`).execute(admin);
    },

    async dropDatabase(admin, name) {
      // Se cierran las sesiones abiertas antes de borrar.
      await sql
        .raw(
          `IF DB_ID(N'${assertSafeIdentifier(name)}') IS NOT NULL BEGIN ALTER DATABASE ${ident(name)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${ident(name)}; END`,
        )
        .execute(admin);
    },

    async createUser(admin, username, password, database) {
      const user = assertSafeIdentifier(username);
      const secret = assertSafePassword(password);
      await sql
        .raw(
          `IF SUSER_ID(N'${user}') IS NULL CREATE LOGIN ${ident(user)} WITH PASSWORD = N'${secret}', CHECK_POLICY = ON; ELSE ALTER LOGIN ${ident(user)} WITH PASSWORD = N'${secret}';`,
        )
        .execute(admin);
      // El usuario vive dentro de la base del tenant y es dueño solo de ella.
      await sql
        .raw(
          `EXEC(N'USE ${ident(database)}; IF USER_ID(N''${user}'') IS NULL CREATE USER ${ident(user)} FOR LOGIN ${ident(user)}; ALTER ROLE db_owner ADD MEMBER ${ident(user)};')`,
        )
        .execute(admin);
    },

    async dropUser(admin, username) {
      const user = assertSafeIdentifier(username);
      await sql.raw(`IF SUSER_ID(N'${user}') IS NOT NULL DROP LOGIN ${ident(user)}`).execute(admin);
    },

    async withLock(db, key, timeoutMs, fn) {
      return db.connection().execute(async (conn) => {
        const result = await sql<{ r: number }>`DECLARE @r int; EXEC @r = sp_getapplock @Resource = ${key}, @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = ${timeoutMs}; SELECT @r AS r`.execute(conn);
        if (Number(result.rows[0]?.r ?? -1) < 0) throw new LockTimeoutError(key);
        try {
          return await fn();
        } finally {
          await sql`EXEC sp_releaseapplock @Resource = ${key}, @LockOwner = 'Session'`.execute(conn);
        }
      });
    },

    isUniqueViolation(error) {
      const n = (error as { number?: number })?.number;
      return n === 2627 || n === 2601;
    },

    isTransientError(error) {
      const n = (error as { number?: number })?.number;
      // 1205 = víctima de deadlock, 1222 = tiempo de espera de lock.
      // 3903 = ROLLBACK sin transacción: SQL Server ya revirtió a la víctima de un deadlock y el
      // ROLLBACK de Kysely falla con este error, que tapa al 1205 original.
      return n === 1205 || n === 1222 || n === 3903;
    },
  };
}
