import type { Tenancy, TenancyPlugin } from '@tenancy-node/core';
import {
  TenantInstances,
  type DatabaseExtension,
  type MigrationContext,
  type MigrationRun,
  type MigrationStatus,
  type TenancyMigrator,
} from '@tenancy-node/db';
import { DataSource, MigrationExecutor, type DataSourceOptions } from 'typeorm';

type Extra = Omit<DataSourceOptions, 'type' | 'host' | 'port' | 'username' | 'password' | 'database' | 'schema'>;

export interface TypeormIntegrationOptions {
  /** Entidades (clases o `EntitySchema`) de las bases de los tenants. */
  entities: NonNullable<DataSourceOptions['entities']>;
  /** DataSources vivos como máximo. Por defecto 50. */
  maxInstances?: number;
  /** Conexiones por DataSource. Por defecto 5. */
  poolSize?: number;
  /** Opciones extra de TypeORM (logging, naming strategy...). Nunca `synchronize` en producción. */
  options?: Partial<Extra>;
}

export interface TypeormExtension {
  /** DataSource inicializado de la base del tenant actual. */
  typeorm(): Promise<DataSource>;
}

const TYPE = { mysql: 'mysql', postgres: 'postgres', mssql: 'mssql' } as const;

function dataSourceOptions(
  context: { kind: string; options: MigrationContext['connection']; schema?: string | null | undefined },
  extra: object,
): DataSourceOptions {
  const type = TYPE[context.kind as keyof typeof TYPE];
  if (!type) throw new Error(`The TypeORM integration does not support the ${context.kind} driver yet`);
  const { host, port, user, password, database } = context.options;
  return {
    ...extra,
    type,
    host,
    port,
    username: user,
    ...(password !== undefined ? { password } : {}),
    ...(database ? { database } : {}),
    // Modo schema (PostgreSQL): tablas y tabla de migraciones en el schema del tenant.
    ...(context.schema
      ? {
          schema: context.schema,
          // Y el search_path, para que el SQL crudo (migraciones, `query()`) caiga en el mismo schema.
          extra: { ...(extra as { extra?: object }).extra, options: `-c search_path="${context.schema}"` },
        }
      : {}),
  } as DataSourceOptions;
}

/**
 * `await tenancy.typeorm()`: un DataSource por tenant, inicializado con la primera consulta y
 * guardado en un LRU. Requiere `@tenancy-node/db`.
 */
export function typeormIntegration(options: TypeormIntegrationOptions): TenancyPlugin<TypeormExtension> {
  let instances: TenantInstances<Promise<DataSource>> | undefined;
  return {
    name: 'typeorm',
    setup(context) {
      instances = new TenantInstances<Promise<DataSource>>({
        name: 'typeorm',
        max: options.maxInstances ?? 50,
        logger: context.logger,
        destroy: async (pending) => {
          const ds = await pending.catch(() => undefined);
          if (ds?.isInitialized) await ds.destroy();
        },
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
        typeorm: async () => {
          if (!db.database) throw new Error('tenancy.typeorm() needs the database plugin (@tenancy-node/db)');
          const info = db.database.connection();
          const key = `${info.key}#${info.tenant.id.value}`;
          return instances!.get(key, () => {
            const pending = new DataSource(
              dataSourceOptions(info, {
                ...options.options,
                entities: options.entities,
                poolSize: options.poolSize ?? 5,
              }),
            ).initialize();
            // Si no conecta, no queda cacheado: el próximo intento vuelve a probar.
            pending.catch(() => instances?.evictWhere((k) => k === key));
            return pending;
          });
        },
      };
    },
  };
}

export interface TypeormMigratorOptions {
  /** Clases de migración (o globs) de TypeORM. */
  migrations: NonNullable<DataSourceOptions['migrations']>;
  /** Necesarias si las migraciones usan repositorios. */
  entities?: DataSourceOptions['entities'];
  /** Tabla de control. Por defecto `migrations`. */
  tableName?: string;
  /** `each` (por defecto): una transacción por migración. */
  transaction?: 'all' | 'none' | 'each';
}

/**
 * Migrador de TypeORM para las bases de los tenants (`migrations: { tenant: typeormMigrator({...}) }`).
 * Abre un DataSource temporal con las credenciales del tenant y lo cierra al terminar.
 */
export function typeormMigrator(options: TypeormMigratorOptions): TenancyMigrator {
  const withDataSource = async <T>(context: MigrationContext | undefined, fn: (ds: DataSource) => Promise<T>) => {
    if (!context) throw new Error('typeormMigrator needs the migration context (use it through @tenancy-node/db)');
    const ds = await new DataSource(
      dataSourceOptions({ kind: context.kind, options: context.connection, schema: context.schema }, {
        migrations: options.migrations,
        entities: options.entities ?? [],
        migrationsTableName: options.tableName ?? 'migrations',
        migrationsTransactionMode: options.transaction ?? 'each',
        poolSize: 1,
        logging: false,
      }),
    ).initialize();
    try {
      return await fn(ds);
    } finally {
      await ds.destroy();
    }
  };
  return {
    latest: (_db, context) =>
      withDataSource(context, async (ds): Promise<MigrationRun> => {
        const done = await ds.runMigrations({ transaction: options.transaction ?? 'each' });
        return { executed: done.map((m) => m.name) };
      }),
    rollback: (_db, rollback, context) =>
      withDataSource(context, async (ds): Promise<MigrationRun> => {
        const executed: string[] = [];
        const steps = rollback?.all ? Number.POSITIVE_INFINITY : (rollback?.steps ?? 1);
        const executor = new MigrationExecutor(ds);
        for (let i = 0; i < steps; i++) {
          const last = (await executor.getExecutedMigrations())[0];
          if (!last) break;
          await ds.undoLastMigration({ transaction: options.transaction ?? 'each' });
          executed.push(last.name);
        }
        return { executed };
      }),
    status: (_db, context) =>
      withDataSource(context, async (ds): Promise<MigrationStatus[]> => {
        const executor = new MigrationExecutor(ds);
        const done = await executor.getExecutedMigrations();
        const pending = await executor.getPendingMigrations();
        return [
          // TypeORM no guarda cuándo corrió cada una: se usa su timestamp.
          ...done
            .sort((a, b) => a.timestamp - b.timestamp)
            .map((m) => ({ name: m.name, executedAt: new Date(m.timestamp) })),
          ...pending.map((m) => ({ name: m.name, executedAt: null })),
        ];
      }),
  };
}
