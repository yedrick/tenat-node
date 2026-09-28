import type { Tenancy, TenancyPlugin } from '@tenancy-node/core';
import type {
  DatabaseExtension,
  MigrationContext,
  MigrationRun,
  MigrationStatus,
  TenancyMigrator,
} from '@tenancy-node/db';

/** `drizzle` de `drizzle-orm/node-postgres` o `drizzle-orm/mysql2`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleFactory = (...args: any[]) => unknown;
/** `migrate` de `drizzle-orm/node-postgres/migrator` o `drizzle-orm/mysql2/migrator`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleMigrate = (db: any, config: any) => Promise<void>;

export interface DrizzleIntegrationOptions {
  /** `import { drizzle } from 'drizzle-orm/node-postgres'` (o `drizzle-orm/mysql2`). */
  drizzle: DrizzleFactory;
}

export interface DrizzleExtension {
  /**
   * Drizzle sobre el pool del tenant actual: no abre conexiones nuevas, reutiliza las de `tenancy.db()`.
   * Pasa tu `schema` para tener la API relacional (`db.query.*`).
   */
  drizzle<TDb = unknown>(schema?: Record<string, unknown>): TDb;
}

/**
 * `tenancy.drizzle(schema)`. La instancia se crea una vez por pool y por schema.
 *
 * ```ts
 * import { drizzle } from 'drizzle-orm/node-postgres';
 * createTenancy({ plugins: [database({...}), drizzleIntegration({ drizzle })] });
 * const db = tenancy.drizzle<NodePgDatabase<typeof schema>>(schema);
 * ```
 */
export function drizzleIntegration(
  options: DrizzleIntegrationOptions,
): TenancyPlugin<DrizzleExtension> {
  const cache = new WeakMap<object, Map<unknown, unknown>>();
  return {
    name: 'drizzle',
    setup: () => ({}),
    extend(tenancy: Tenancy) {
      const db = tenancy as Tenancy & Partial<DatabaseExtension>;
      return {
        drizzle: <TDb>(schema?: Record<string, unknown>) => {
          if (!db.database)
            throw new Error('tenancy.drizzle() needs the database plugin (@tenancy-node/db)');
          const info = db.database.connection();
          assertEngine(info.kind);
          if (info.schema) {
            // El pool nativo compartido no tiene el search_path del tenant: consultaría el schema equivocado.
            throw new Error('tenancy.drizzle() does not support isolation: "schema" yet; use tenancy.db(), Knex or Prisma');
          }
          const pool = info.native as object;
          let bySchema = cache.get(pool);
          if (!bySchema) cache.set(pool, (bySchema = new Map()));
          let instance = bySchema.get(schema ?? null);
          if (!instance) {
            instance = options.drizzle(pool, {
              ...(schema ? { schema } : {}),
              ...(info.kind === 'mysql' && schema ? { mode: 'default' } : {}),
            });
            bySchema.set(schema ?? null, instance);
          }
          return instance as TDb;
        },
      };
    },
  };
}

/** Drizzle recibe el pool nativo (mysql2 o pg): otros motores no se soportan todavía. */
function assertEngine(kind: string): void {
  if (kind !== 'mysql' && kind !== 'postgres')
    throw new Error(`The Drizzle integration does not support the ${kind} driver yet`);
}

export interface DrizzleMigratorOptions {
  drizzle: DrizzleFactory;
  migrate: DrizzleMigrate;
  /** Carpeta generada por drizzle-kit (con `meta/_journal.json`). */
  migrationsFolder: string;
  /** Por defecto `__drizzle_migrations`. */
  migrationsTable?: string;
}

/** Migrador de Drizzle para las bases de los tenants (`migrations: { tenant: drizzleMigrator({...}) }`). */
export function drizzleMigrator(options: DrizzleMigratorOptions): TenancyMigrator {
  const table = options.migrationsTable ?? '__drizzle_migrations';
  const check = (context: MigrationContext | undefined): MigrationContext => {
    if (!context)
      throw new Error(
        'drizzleMigrator needs the migration context (use it through @tenancy-node/db)',
      );
    assertEngine(context.kind);
    // Drizzle migra con el pool nativo, que en modo schema no tiene el search_path del tenant:
    // las tablas terminarían en otro schema.
    if (context.schema)
      throw new Error('drizzleMigrator does not support isolation: "schema" yet');
    return context;
  };
  const read = async (
    db: Parameters<TenancyMigrator['status']>[0],
    context: MigrationContext | undefined,
  ): Promise<{ hash: string; created_at: string | number }[]> => {
    const ctx = check(context);
    // node-postgres guarda la tabla en el schema "drizzle"; mysql2 en la base actual.
    const source = ctx.kind === 'postgres' ? db.withSchema('drizzle') : db;
    try {
      return (await source
        .selectFrom(table)
        .select(['hash', 'created_at'])
        .orderBy('id')
        .execute()) as { hash: string; created_at: string | number }[];
    } catch {
      return []; // todavía no se aplicó ninguna migración: la tabla no existe
    }
  };
  return {
    async latest(db, context): Promise<MigrationRun> {
      const before = (await read(db, context)).length;
      await options.migrate(options.drizzle(check(context).native), {
        migrationsFolder: options.migrationsFolder,
        migrationsTable: table,
      });
      const after = await read(db, context);
      return { executed: after.slice(before).map((m) => m.hash) };
    },
    async rollback(): Promise<MigrationRun> {
      throw new Error(
        'Drizzle migrations are forward-only; write a new migration to revert changes',
      );
    },
    async status(db, context): Promise<MigrationStatus[]> {
      return (await read(db, context)).map((m) => ({
        name: m.hash,
        executedAt: new Date(Number(m.created_at)),
      }));
    },
  };
}
