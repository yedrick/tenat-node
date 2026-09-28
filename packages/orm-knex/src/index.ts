import type { Tenancy, TenancyPlugin } from '@tenancy-node/core';
import {
  TenantInstances,
  type DatabaseExtension,
  type MigrationContext,
  type MigrationRun,
  type MigrationStatus,
  type TenancyMigrator,
} from '@tenancy-node/db';
import knexFactory, { type Knex } from 'knex';

export interface KnexIntegrationOptions {
  /** Instancias (pools) de Knex vivas como máximo. Por defecto 50. */
  maxInstances?: number;
  /** Pool de cada instancia. Por defecto `{ min: 0, max: 5 }`. */
  pool?: Knex.PoolConfig;
  /** Opciones extra para `knex()` (sin `client` ni `connection`). */
  config?: Omit<Knex.Config, 'client' | 'connection'>;
}

export interface KnexExtension {
  /** Instancia de Knex conectada a la base del tenant actual. */
  knex(): Knex;
}

const CLIENT = { mysql: 'mysql2', postgres: 'pg' } as const;

function clientOf(kind: string): (typeof CLIENT)[keyof typeof CLIENT] {
  if (kind !== 'mysql' && kind !== 'postgres') throw new Error(`The Knex integration does not support the ${kind} driver yet`);
  return CLIENT[kind];
}

function connectionOf(context: { kind: string; options: MigrationContext['connection'] }): Knex.StaticConnectionConfig {
  const { host, port, user, password, database } = context.options;
  return {
    host,
    port,
    user,
    ...(password !== undefined ? { password } : {}),
    ...(database ? { database } : {}),
  } as Knex.StaticConnectionConfig;
}

/**
 * `tenancy.knex()`: una instancia de Knex por tenant, creada con la primera consulta
 * y guardada en un LRU. Requiere `@tenancy-node/db`.
 */
export function knexIntegration(
  options: KnexIntegrationOptions = {},
): TenancyPlugin<KnexExtension> {
  let instances: TenantInstances<Knex> | undefined;
  return {
    name: 'knex',
    setup(context) {
      instances = new TenantInstances<Knex>({
        name: 'knex',
        max: options.maxInstances ?? 50,
        logger: context.logger,
        destroy: (k) => k.destroy(),
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
        knex: () => {
          if (!db.database)
            throw new Error('tenancy.knex() needs the database plugin (@tenancy-node/db)');
          const info = db.database.connection();
          return instances!.get(`${info.key}#${info.tenant.id.value}`, () =>
            knexFactory({
              ...options.config,
              client: clientOf(info.kind),
              connection: connectionOf(info),
              pool: options.pool ?? { min: 0, max: 5 },
              // Modo schema (PostgreSQL): Knex fija el search_path del tenant.
              ...(info.schema ? { searchPath: [info.schema] } : {}),
            }),
          );
        },
      };
    },
  };
}

export interface KnexMigratorOptions {
  /** Carpeta de migraciones de Knex. */
  directory: string | string[];
  /** Tabla de control. Por defecto `knex_migrations`. */
  tableName?: string;
  loadExtensions?: string[];
}

/**
 * Migrador de Knex para las bases de los tenants (`migrations: { tenant: knexMigrator({...}) }`).
 * Abre una conexión temporal con las credenciales del tenant y la cierra al terminar.
 */
export function knexMigrator(options: KnexMigratorOptions): TenancyMigrator {
  const withKnex = async <T>(
    context: MigrationContext | undefined,
    fn: (k: Knex) => Promise<T>,
  ): Promise<T> => {
    if (!context)
      throw new Error('knexMigrator needs the migration context (use it through @tenancy-node/db)');
        const k = knexFactory({
      client: clientOf(context.kind),
      connection: connectionOf({ kind: context.kind, options: context.connection }),
      pool: { min: 0, max: 1 },
      ...(context.schema ? { searchPath: [context.schema] } : {}),
    });
    try {
      return await fn(k);
    } finally {
      await k.destroy();
    }
  };
  const config = {
    directory: options.directory,
    tableName: options.tableName ?? 'knex_migrations',
    ...(options.loadExtensions ? { loadExtensions: options.loadExtensions } : {}),
  };
  return {
    latest: (_db, context) =>
      withKnex(context, async (k): Promise<MigrationRun> => {
        const [, executed] = (await k.migrate.latest(config)) as [number, string[]];
        return { executed };
      }),
    rollback: (_db, rollback, context) =>
      withKnex(context, async (k): Promise<MigrationRun> => {
        const executed: string[] = [];
        for (let i = 0; i < (rollback?.all ? 1 : (rollback?.steps ?? 1)); i++) {
          const [, reverted] = (await k.migrate.rollback(config, rollback?.all ?? false)) as [
            number,
            string[],
          ];
          if (reverted.length === 0) break;
          executed.push(...reverted);
        }
        return { executed };
      }),
    status: (_db, context) =>
      withKnex(context, async (k): Promise<MigrationStatus[]> => {
        const [, pending] = (await k.migrate.list(config)) as [unknown[], { file: string }[]];
        const done = (await k(config.tableName).select('name', 'migration_time').orderBy('id')) as {
          name: string;
          migration_time: Date | string;
        }[];
        return [
          ...done.map((m) => ({ name: m.name, executedAt: new Date(m.migration_time) })),
          ...pending.map((m) => ({ name: m.file, executedAt: null })),
        ];
      }),
  };
}
