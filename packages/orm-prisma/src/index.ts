import { spawn } from 'node:child_process';
import type { Tenancy, TenancyPlugin } from '@tenancy-node/core';
import {
  TenantInstances,
  type DatabaseExtension,
  type MigrationContext,
  type MigrationRun,
  type TenancyMigrator,
} from '@tenancy-node/db';

/** Prisma se conecta con su propia URL: solo se generan URLs de MySQL y PostgreSQL. */
function assertEngine(kind: string): void {
  if (kind !== 'mysql' && kind !== 'postgres')
    throw new Error(`The Prisma integration does not support the ${kind} driver yet`);
}

/** URL para Prisma: su parámetro `schema` en lugar de `options=-c search_path`. */
function prismaUrl(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.delete('options');
  u.searchParams.set('schema', schema);
  return u.toString();
}

/** Lo mínimo que se usa de un `PrismaClient`. */
export interface PrismaClientLike {
  $disconnect(): Promise<void>;
}

export interface PrismaIntegrationOptions<C extends PrismaClientLike> {
  /** Tu clase generada: `import { PrismaClient } from '@prisma/client'`. */
  client: new (options: { datasourceUrl: string }) => C;
  /** Clientes vivos como máximo (son pesados). Por defecto 10. */
  maxClients?: number;
  /** Espera antes de desconectar un cliente descartado. Por defecto 30 s. */
  graceMs?: number;
}

export interface PrismaExtension<C> {
  /** PrismaClient conectado a la base del tenant actual. */
  prisma(): C;
}

/**
 * `tenancy.prisma()`: un PrismaClient por tenant (con `datasourceUrl`), en un LRU pequeño
 * porque cada cliente abre su propio pool.
 */
export function prismaIntegration<C extends PrismaClientLike>(
  options: PrismaIntegrationOptions<C>,
): TenancyPlugin<PrismaExtension<C>> {
  let clients: TenantInstances<C> | undefined;
  return {
    name: 'prisma',
    setup(context) {
      clients = new TenantInstances<C>({
        name: 'prisma',
        max: options.maxClients ?? 10,
        ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
        logger: context.logger,
        destroy: (c) => c.$disconnect(),
      });
      // Al borrar un tenant sus instancias se cierran; al moverlo, tras el tiempo de gracia.
      for (const type of ['tenant.deleted', 'database.moved'] as const) {
        context.events.on(
          type,
          async (event) =>
            clients?.evictWhere((key) => key.endsWith(`#${event.tenantId}`), {
              graceful: type === 'database.moved',
            }),
          { mode: 'sync' },
        );
      }
      return { close: async () => clients?.closeAll() };
    },
    extend(tenancy: Tenancy) {
      const db = tenancy as Tenancy & Partial<DatabaseExtension>;
      return {
        prisma: () => {
          if (!db.database)
            throw new Error('tenancy.prisma() needs the database plugin (@tenancy-node/db)');
          const info = db.database.connection();
          assertEngine(info.kind);
          // Modo schema: Prisma usa el parámetro `schema` de la URL.
          const url = info.schema ? prismaUrl(info.url, info.schema) : info.url;
          return clients!.get(`${info.key}#${info.tenant.id.value}`, () => new options.client({ datasourceUrl: url }));
        },
      };
    },
  };
}

export interface PrismaMigratorOptions {
  /** Ruta de `schema.prisma`. Por defecto la que use Prisma (`prisma/schema.prisma`). */
  schema?: string;
  /** Comando de Prisma. Por defecto `npx prisma`. */
  command?: string;
  cwd?: string;
}

/**
 * Migrador de Prisma: corre `prisma migrate deploy` con la `DATABASE_URL` de cada tenant.
 * El `schema.prisma` debe leer la URL de `env("DATABASE_URL")`.
 */
export function prismaMigrator(options: PrismaMigratorOptions = {}): TenancyMigrator {
  const run = (context: MigrationContext | undefined, args: string[]): Promise<string> => {
    if (!context)
      return Promise.reject(
        new Error('prismaMigrator needs the migration context (use it through @tenancy-node/db)'),
      );
    try {
      assertEngine(context.kind);
    } catch (error) {
      return Promise.reject(error);
    }
    const command = `${options.command ?? 'npx prisma'} ${args.join(' ')}${options.schema ? ` --schema "${options.schema}"` : ''}`;
    return new Promise((resolve, reject) => {
      let output = '';
      const child = spawn(command, {
        shell: true,
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, DATABASE_URL: context.schema ? prismaUrl(context.url, context.schema) : context.url },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (c: Buffer) => (output += c.toString()));
      child.stderr.on('data', (c: Buffer) => (output += c.toString()));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve(output)
          : reject(
              new Error(
                `prisma ${args[0]} ${args[1] ?? ''} failed (exit ${code}): ${output.trim().slice(-500)}`,
              ),
            ),
      );
    });
  };
  return {
    async latest(_db, context): Promise<MigrationRun> {
      const output = await run(context, ['migrate', 'deploy']);
      // "Applying migration `20250101_init`"
      return { executed: [...output.matchAll(/Applying migration `([^`]+)`/g)].map((m) => m[1]!) };
    },
    async rollback(): Promise<MigrationRun> {
      throw new Error(
        'Prisma migrations are forward-only; use `prisma migrate resolve` or a new migration',
      );
    },
    async status(db, context) {
      if (!context) throw new Error('prismaMigrator needs the migration context');
      assertEngine(context.kind);
      // Prisma registra cada migración aplicada en _prisma_migrations. Se lee con la conexión del
      // tenant (en modo schema ya apunta a su schema), no con el pool nativo compartido.
      try {
        const rows = (await db
          .selectFrom('_prisma_migrations')
          .select(['migration_name', 'finished_at'])
          .where('rolled_back_at', 'is', null)
          .orderBy('started_at')
          .execute()) as { migration_name: string; finished_at: Date | string | null }[];
        return rows.map((r) => ({
          name: r.migration_name,
          executedAt: r.finished_at ? new Date(r.finished_at) : null,
        }));
      } catch {
        return []; // todavía no se aplicó ninguna migración: la tabla no existe
      }
    },
  };
}
