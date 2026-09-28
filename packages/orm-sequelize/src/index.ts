import type { Tenancy, TenancyPlugin } from '@tenancy-node/core';
import {
  TenantInstances,
  type DatabaseExtension,
  type MigrationContext,
  type MigrationRun,
  type MigrationStatus,
  type TenancyMigrator,
} from '@tenancy-node/db';
import { Sequelize, type Dialect, type Options, type QueryInterface } from 'sequelize';
import { SequelizeStorage, Umzug, type InputMigrations } from 'umzug';

export interface SequelizeIntegrationOptions {
  /** Define los modelos en cada instancia nueva: `(s) => { Cliente.init(attrs, { sequelize: s }) }`. */
  models: (sequelize: Sequelize) => void;
  /** Instancias vivas como máximo. Por defecto 50. */
  maxInstances?: number;
  /** Pool de cada instancia. Por defecto `{ min: 0, max: 5 }`. */
  pool?: Options['pool'];
  /** Opciones extra de Sequelize (sin conexión). Por defecto `logging: false`. */
  options?: Omit<Options, 'dialect' | 'host' | 'port' | 'username' | 'password' | 'database'>;
}

export interface SequelizeExtension {
  /** Instancia de Sequelize de la base del tenant actual, con sus modelos definidos. */
  sequelize(): Sequelize;
}

const DIALECT: Record<string, Dialect> = { mysql: 'mysql', postgres: 'postgres', mssql: 'mssql' };

function sequelizeOptions(
  context: { kind: string; options: MigrationContext['connection']; schema?: string | null | undefined },
  extra: Options,
): Options {
  const dialect = DIALECT[context.kind];
  if (!dialect) throw new Error(`The Sequelize integration does not support the ${context.kind} driver yet`);
  const { host, port, user, password, database } = context.options;
  return {
    logging: false,
    ...extra,
    dialect,
    host,
    port,
    username: user,
    ...(password !== undefined ? { password } : {}),
    ...(database ? { database } : {}),
    // queryInterface califica las tablas con este schema (por defecto sería `public`).
    ...(context.schema ? { schema: context.schema } : {}),
    dialectOptions: {
      ...(extra.dialectOptions as object | undefined),
      // Modo schema (PostgreSQL): cada conexión nace con el search_path del tenant.
      ...(context.schema ? { options: `-c search_path="${context.schema}"` } : {}),
    },
  };
}

/**
 * `tenancy.sequelize()`: una instancia de Sequelize por tenant (con sus modelos), creada con la
 * primera consulta y guardada en un LRU. Requiere `@tenancy-node/db`.
 *
 * Los modelos quedan atados a su instancia: úsalos con `tenancy.sequelize().models.Cliente`,
 * nunca importando la clase de otro tenant.
 */
export function sequelizeIntegration(
  options: SequelizeIntegrationOptions,
): TenancyPlugin<SequelizeExtension> {
  let instances: TenantInstances<Sequelize> | undefined;
  return {
    name: 'sequelize',
    setup(context) {
      instances = new TenantInstances<Sequelize>({
        name: 'sequelize',
        max: options.maxInstances ?? 50,
        logger: context.logger,
        destroy: (s) => s.close(),
      });
      // Al borrar un tenant sus instancias se cierran; al moverlo, tras el tiempo de gracia.
      for (const type of ['tenant.deleted', 'database.moved'] as const) {
        context.events.on(
          type,
          async (event) =>
            instances?.evictWhere((key) => key.endsWith(`#${event.tenantId}`), {
              graceful: type === 'database.moved',
            }),
          { mode: 'sync' },
        );
      }
      return { close: async () => instances?.closeAll() };
    },
    extend(tenancy: Tenancy) {
      const db = tenancy as Tenancy & Partial<DatabaseExtension>;
      return {
        sequelize: () => {
          if (!db.database) throw new Error('tenancy.sequelize() needs the database plugin (@tenancy-node/db)');
          const info = db.database.connection();
          return instances!.get(`${info.key}#${info.tenant.id.value}`, () => {
            const sequelize = new Sequelize(
              sequelizeOptions(info, { ...options.options, pool: options.pool ?? { min: 0, max: 5 } }),
            );
            options.models(sequelize);
            return sequelize;
          });
        },
      };
    },
  };
}

export interface SequelizeMigrationContext {
  queryInterface: QueryInterface;
  sequelize: Sequelize;
}

export interface SequelizeMigratorOptions {
  /** Migraciones de Umzug: `{ glob: 'migrations/*.js' }` o una lista `{ name, up, down }`. */
  migrations: InputMigrations<SequelizeMigrationContext>;
  /** Tabla de control. Por defecto `SequelizeMeta` (la misma de sequelize-cli). */
  tableName?: string;
}

/**
 * Migrador con Umzug para las bases de los tenants (`migrations: { tenant: sequelizeMigrator({...}) }`).
 * Cada migración recibe `{ context: { queryInterface, sequelize } }`.
 */
export function sequelizeMigrator(options: SequelizeMigratorOptions): TenancyMigrator {
  const withUmzug = async <T>(
    context: MigrationContext | undefined,
    fn: (umzug: Umzug<SequelizeMigrationContext>, storage: SequelizeStorage) => Promise<T>,
  ): Promise<T> => {
    if (!context) throw new Error('sequelizeMigrator needs the migration context (use it through @tenancy-node/db)');
    const sequelize = new Sequelize(
      sequelizeOptions({ kind: context.kind, options: context.connection, schema: context.schema }, { pool: { min: 0, max: 1 } }),
    );
    const storage = new SequelizeStorage({
      sequelize,
      tableName: options.tableName ?? 'SequelizeMeta',
      // Guarda cuándo corrió cada migración (para `migrate:status`).
      timestamps: true,
    });
    const umzug = new Umzug<SequelizeMigrationContext>({
      migrations: options.migrations,
      context: { queryInterface: sequelize.getQueryInterface(), sequelize },
      storage,
      logger: undefined,
    });
    try {
      return await fn(umzug, storage);
    } finally {
      await sequelize.close();
    }
  };
  return {
    latest: (_db, context) =>
      withUmzug(context, async (umzug): Promise<MigrationRun> => ({
        executed: (await umzug.up()).map((m) => m.name),
      })),
    rollback: (_db, rollback, context) =>
      withUmzug(context, async (umzug): Promise<MigrationRun> => ({
        executed: (await umzug.down(rollback?.all ? { to: 0 } : { step: rollback?.steps ?? 1 })).map((m) => m.name),
      })),
    status: (_db, context) =>
      withUmzug(context, async (umzug, storage): Promise<MigrationStatus[]> => {
        await umzug.executed(); // crea la tabla de control si falta
        const rows = (await storage.getModel().findAll({ raw: true })) as unknown as {
          name: string;
          createdAt?: Date | string;
        }[];
        const when = new Map(rows.map((r) => [r.name, r.createdAt ? new Date(r.createdAt) : null]));
        const pending = await umzug.pending();
        return [
          ...[...when.keys()].sort().map((name) => ({ name, executedAt: when.get(name) ?? new Date(0) })),
          ...pending.map((m) => ({ name: m.name, executedAt: null })),
        ];
      }),
  };
}
