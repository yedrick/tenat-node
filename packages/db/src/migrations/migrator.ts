import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  FileMigrationProvider,
  Migrator,
  NO_MIGRATIONS,
  sql,
  type Migration,
  type MigrationProvider,
  type MigrationResult,
} from 'kysely';
import { MigrationFailedError } from '../errors.js';
import type { Tenant } from '@tenancy-node/core';
import type { ConnectionOptions } from '../connection.js';
import type { DialectKind } from '../drivers/driver.js';
import type { AnyKysely } from '../kysely-any.js';
import { withSchemaIntrospection } from '../schema/schema-tables.js';

export interface MigrationRun {
  /** Migraciones que se ejecutaron en esta llamada. */
  executed: string[];
}

export interface MigrationStatus {
  name: string;
  executedAt: Date | null;
}

/** Conexión de la base que se migra, para migradores que no usan Kysely (Knex, Prisma, Drizzle). */
export interface MigrationContext {
  /** Tenant dueño de la base; `null` en la base central. */
  tenant: Tenant | null;
  kind: DialectKind;
  connection: ConnectionOptions;
  /** URL con credenciales (`postgres://user:pass@host/db`). */
  url: string;
  /** Pool nativo (mysql2 / pg) de esa base. */
  native: unknown;
  /** Modo schema: schema del tenant (la tabla de control de migraciones vive ahí). */
  schema?: string | null;
}

/**
 * Puerto `Migrator`: aplica las migraciones de una base (la de un tenant o la central).
 * Se puede implementar con la herramienta que ya use el proyecto (Knex, Prisma, Drizzle...).
 */
export interface TenancyMigrator {
  latest(db: AnyKysely, context?: MigrationContext): Promise<MigrationRun>;
  rollback(
    db: AnyKysely,
    options?: { steps?: number; all?: boolean },
    context?: MigrationContext,
  ): Promise<MigrationRun>;
  status(db: AnyKysely, context?: MigrationContext): Promise<MigrationStatus[]>;
}

export interface KyselyMigratorOptions {
  /** Tabla de control. Por defecto `tenancy_migrations`. */
  tableName?: string;
}

/** Migrador sobre el `Migrator` de Kysely (cualquier `MigrationProvider`). */
export class KyselyMigrator implements TenancyMigrator {
  private readonly tableName: string;

  constructor(
    private readonly provider: MigrationProvider,
    options: KyselyMigratorOptions = {},
  ) {
    this.tableName = options.tableName ?? 'tenancy_migrations';
  }

  private migrator(db: AnyKysely, schema?: string | null): Migrator {
    return new Migrator({
      // En modo schema, la introspección de Kysely recorrería los schemas de todos los tenants.
      db: schema ? withSchemaIntrospection(db, schema) : db,
      provider: this.provider,
      migrationTableName: this.tableName,
      migrationLockTableName: `${this.tableName}_lock`,
      // En modo schema, cada tenant tiene su propia tabla de control en su schema.
      ...(schema ? { migrationTableSchema: schema } : {}),
    });
  }

  async latest(db: AnyKysely, context?: MigrationContext): Promise<MigrationRun> {
    return unwrap(await this.migrator(db, context?.schema).migrateToLatest());
  }

  async rollback(
    db: AnyKysely,
    options: { steps?: number; all?: boolean } = {},
    context?: MigrationContext,
  ): Promise<MigrationRun> {
    const migrator = this.migrator(db, context?.schema);
    if (options.all) return unwrap(await migrator.migrateTo(NO_MIGRATIONS));
    const executed: string[] = [];
    for (let i = 0; i < (options.steps ?? 1); i++) {
      const run = unwrap(await migrator.migrateDown());
      if (run.executed.length === 0) break;
      executed.push(...run.executed);
    }
    return { executed };
  }

  async status(db: AnyKysely, context?: MigrationContext): Promise<MigrationStatus[]> {
    const migrations = await this.migrator(db, context?.schema).getMigrations();
    return migrations.map((m) => ({ name: m.name, executedAt: m.executedAt ?? null }));
  }
}

function unwrap(result: { error?: unknown; results?: MigrationResult[] }): MigrationRun {
  const failed = result.results?.find((r) => r.status === 'Error');
  if (result.error) throw new MigrationFailedError(failed?.migrationName, result.error);
  return {
    executed: (result.results ?? [])
      .filter((r) => r.status === 'Success')
      .map((r) => r.migrationName),
  };
}

/** Migraciones escritas en código: `{ '001_productos': { up, down } }`. */
export function migrationsFromObject(migrations: Record<string, Migration>): MigrationProvider {
  return { getMigrations: async () => migrations };
}

/** Carpeta con archivos `.ts`/`.js` que exportan `up` y `down`. */
export function migrationsFromFolder(folder: string): MigrationProvider {
  return new FileMigrationProvider({ fs, path, migrationFolder: path.resolve(folder) });
}

/**
 * Carpeta con archivos `.sql`, aplicados en orden alfabético. `001_x.down.sql` es el rollback opcional.
 * Cada sentencia termina con `;` al final de una línea.
 */
export function migrationsFromSqlFolder(folder: string): MigrationProvider {
  return {
    async getMigrations() {
      const dir = path.resolve(folder);
      const files = (await fs.readdir(dir))
        .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
        .sort();
      const all = new Set(await fs.readdir(dir));
      const migrations: Record<string, Migration> = {};
      for (const file of files) {
        const name = file.slice(0, -4);
        const upSql = await fs.readFile(path.join(dir, file), 'utf8');
        const downFile = `${name}.down.sql`;
        const downSql = all.has(downFile)
          ? await fs.readFile(path.join(dir, downFile), 'utf8')
          : undefined;
        migrations[name] = {
          up: (db) => runStatements(db, upSql),
          ...(downSql !== undefined ? { down: (db: AnyKysely) => runStatements(db, downSql) } : {}),
        };
      }
      return migrations;
    },
  };
}

/** Divide un script en sentencias (`;` al final de la línea) y las ejecuta en orden. */
export function splitSqlStatements(script: string): string[] {
  const withoutComments = script
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  return withoutComments
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function runStatements(db: AnyKysely, script: string): Promise<void> {
  for (const statement of splitSqlStatements(script)) {
    await sql.raw(statement).execute(db);
  }
}

export type MigrationsInput = TenancyMigrator | Record<string, Migration> | string;

/** Acepta un migrador, un objeto de migraciones o una ruta (carpeta de `.sql` o de módulos). */
export async function toMigrator(
  input: MigrationsInput,
  tableName: string,
): Promise<TenancyMigrator> {
  if (typeof input === 'object' && 'latest' in input && typeof input.latest === 'function') {
    return input as TenancyMigrator;
  }
  if (typeof input === 'string') {
    const files = await fs.readdir(path.resolve(input));
    const provider = files.some((f) => f.endsWith('.sql'))
      ? migrationsFromSqlFolder(input)
      : migrationsFromFolder(input);
    return new KyselyMigrator(provider, { tableName });
  }
  return new KyselyMigrator(migrationsFromObject(input as Record<string, Migration>), {
    tableName,
  });
}
