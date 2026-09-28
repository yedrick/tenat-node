import type { Tenancy, TenancyPlugin } from '@tenancy-node/core';
import {
  TenantInstances,
  type DatabaseExtension,
  type MigrationContext,
  type MigrationRun,
  type MigrationStatus,
  type TenancyMigrator,
} from '@tenancy-node/db';
import { MikroORM, type EntityManager, type Options } from '@mikro-orm/core';

type Driver = NonNullable<Options['driver']>;

export interface MikroOrmIntegrationOptions {
  /** Driver de MikroORM: `PostgreSqlDriver` de `@mikro-orm/postgresql`, `MySqlDriver`... */
  driver: Driver;
  /** Entidades (clases o `EntitySchema`). */
  entities: NonNullable<Options['entities']>;
  /** Instancias vivas como máximo. Por defecto 50. */
  maxInstances?: number;
  /** Conexiones por instancia. Por defecto `{ min: 0, max: 5 }`. */
  pool?: Options['pool'];
  /** Opciones extra de MikroORM (sin conexión). */
  options?: Omit<Options, 'driver' | 'entities' | 'host' | 'port' | 'user' | 'password' | 'dbName' | 'clientUrl'>;
}

export interface MikroOrmExtension {
  /** MikroORM inicializado de la base del tenant actual. */
  mikroOrm(): Promise<MikroORM>;
  /** EntityManager nuevo (`fork()`) del tenant actual: uno por petición o unidad de trabajo. */
  em(): Promise<EntityManager>;
}

const SUPPORTED = new Set(['mysql', 'postgres', 'mssql']);

function ormOptions(
  context: { kind: string; options: MigrationContext['connection']; schema?: string | null | undefined },
  extra: Options,
): Options {
  if (!SUPPORTED.has(context.kind))
    throw new Error(`The MikroORM integration does not support the ${context.kind} driver yet`);
  const { host, port, user, password, database } = context.options;
  return {
    allowGlobalContext: false,
    debug: false,
    ...extra,
    host,
    port,
    user,
    ...(password !== undefined ? { password } : {}),
    ...(database ? { dbName: database } : {}),
    ...(context.schema
      ? {
          // Modo schema (PostgreSQL): entidades, tabla de migraciones y SQL crudo en el schema del tenant.
          schema: context.schema,
          driverOptions: {
            ...(extra.driverOptions as object | undefined),
            connection: { options: `-c search_path="${context.schema}"` },
          },
        }
      : {}),
  } as Options;
}

/**
 * `await tenancy.em()`: un MikroORM por tenant (con su propio identity map por `fork()`),
 * creado con la primera consulta y guardado en un LRU. Requiere `@tenancy-node/db`.
 */
export function mikroOrmIntegration(options: MikroOrmIntegrationOptions): TenancyPlugin<MikroOrmExtension> {
  let instances: TenantInstances<Promise<MikroORM>> | undefined;
  return {
    name: 'mikro-orm',
    setup(context) {
      instances = new TenantInstances<Promise<MikroORM>>({
        name: 'mikro-orm',
        max: options.maxInstances ?? 50,
        logger: context.logger,
        destroy: async (pending) => {
          const orm = await pending.catch(() => undefined);
          await orm?.close();
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
      const mikroOrm = async (): Promise<MikroORM> => {
        if (!db.database) throw new Error('tenancy.mikroOrm() needs the database plugin (@tenancy-node/db)');
        const info = db.database.connection();
        const key = `${info.key}#${info.tenant.id.value}`;
        return instances!.get(key, () => {
          const pending = MikroORM.init(
            ormOptions(info, {
              ...options.options,
              driver: options.driver,
              entities: options.entities,
              pool: options.pool ?? { min: 0, max: 5 },
            } as Options),
          );
          pending.catch(() => instances?.evictWhere((k) => k === key));
          return pending;
        });
      };
      return { mikroOrm, em: async () => (await mikroOrm()).em.fork() };
    },
  };
}

export interface MikroOrmMigratorOptions {
  driver: Driver;
  /** La extensión `Migrator` de `@mikro-orm/migrations`. */
  migrator: NonNullable<Options['extensions']>[number];
  /** Clases de migración (`class Migration20260101 extends Migration`). */
  migrations: NonNullable<NonNullable<Options['migrations']>['migrationsList']>;
  entities?: Options['entities'];
  /** Tabla de control. Por defecto `mikro_orm_migrations`. */
  tableName?: string;
}

interface MikroMigrator {
  up(): Promise<{ name: string }[]>;
  down(options?: { step?: number; to?: string | number }): Promise<{ name: string }[]>;
  getExecutedMigrations(): Promise<{ name: string; executed_at: Date }[]>;
  getPendingMigrations(): Promise<{ name: string }[]>;
}

/**
 * Migrador de MikroORM para las bases de los tenants (`migrations: { tenant: mikroOrmMigrator({...}) }`).
 * Abre un MikroORM temporal con las credenciales del tenant y lo cierra al terminar.
 */
export function mikroOrmMigrator(options: MikroOrmMigratorOptions): TenancyMigrator {
  const withMigrator = async <T>(context: MigrationContext | undefined, fn: (m: MikroMigrator) => Promise<T>) => {
    if (!context) throw new Error('mikroOrmMigrator needs the migration context (use it through @tenancy-node/db)');
    const orm = await MikroORM.init(
      ormOptions({ kind: context.kind, options: context.connection, schema: context.schema }, {
        driver: options.driver,
        entities: options.entities ?? [],
        discovery: { warnWhenNoEntities: false },
        extensions: [options.migrator],
        pool: { min: 0, max: 1 },
        migrations: {
          migrationsList: options.migrations,
          tableName: options.tableName ?? 'mikro_orm_migrations',
          transactional: true,
          silent: true,
        },
      } as Options),
    );
    try {
      return await fn(orm.getMigrator() as unknown as MikroMigrator);
    } finally {
      await orm.close();
    }
  };
  return {
    latest: (_db, context) =>
      withMigrator(context, async (m): Promise<MigrationRun> => ({ executed: (await m.up()).map((x) => x.name) })),
    rollback: (_db, rollback, context) =>
      withMigrator(context, async (m): Promise<MigrationRun> => ({
        executed: (await m.down(rollback?.all ? { to: 0 } : { step: rollback?.steps ?? 1 })).map((x) => x.name),
      })),
    status: (_db, context) =>
      withMigrator(context, async (m): Promise<MigrationStatus[]> => [
        ...(await m.getExecutedMigrations()).map((x) => ({ name: x.name, executedAt: new Date(x.executed_at) })),
        ...(await m.getPendingMigrations()).map((x) => ({ name: x.name, executedAt: null })),
      ]),
  };
}
