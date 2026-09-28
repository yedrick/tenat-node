import { sql } from 'kysely';
import type { DialectKind } from '../drivers/driver.js';
import type { AnyKysely } from '../kysely-any.js';

export interface ColumnInfo {
  name: string;
  /** Tipo del motor en minúsculas: varchar, int, bigint, datetime, timestamp with time zone, jsonb... */
  type: string;
  nullable: boolean;
  length: number | null;
  primaryKey: boolean;
  autoIncrement: boolean;
  /** Columna calculada por la base (no se escribe). */
  generated: boolean;
  hasDefault: boolean;
}

export interface TableInfo {
  /** Nombre real ('tenancy_tenants'). */
  name: string;
  /** Sin prefijo ('tenants'). */
  shortName: string;
  columns: ColumnInfo[];
}

export type SchemaFormat = 'prisma' | 'drizzle' | 'typeorm';

/** Lee de `information_schema` las tablas con el prefijo (sin las de control de migraciones). */
export async function introspectTables(
  db: AnyKysely,
  kind: DialectKind,
  prefix: string,
): Promise<TableInfo[]> {
  if (kind === 'sqlite' || kind === 'mssql') {
    // Lee information_schema con la sintaxis de MySQL y PostgreSQL.
    throw new Error(`tenancy schema is not available for ${kind} yet (only mysql and postgres)`);
  }
  const schemaFilter =
    kind === 'mysql' ? sql`c.table_schema = DATABASE()` : sql`c.table_schema = current_schema()`;
  const extra =
    kind === 'mysql'
      ? sql`c.extra AS extra, 'NO' AS is_identity`
      : sql`COALESCE(c.is_generated, 'NEVER') AS extra, c.is_identity AS is_identity`;
  const columns = await sql<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    length: number | string | null;
    column_default: string | null;
    extra: string | null;
    is_identity: string | null;
  }>`SELECT c.table_name AS table_name, c.column_name AS column_name, c.data_type AS data_type, c.is_nullable AS is_nullable,
       c.character_maximum_length AS length, c.column_default AS column_default, ${extra}
     FROM information_schema.columns c
     WHERE ${schemaFilter} AND c.table_name LIKE ${`${prefix.replace(/_/g, '\\_')}%`}
     ORDER BY c.table_name, c.ordinal_position`.execute(db);
  const keys = await sql<{
    table_name: string;
    column_name: string;
  }>`SELECT k.table_name AS table_name, k.column_name AS column_name
     FROM information_schema.table_constraints t
     JOIN information_schema.key_column_usage k
       ON k.constraint_name = t.constraint_name AND k.table_schema = t.table_schema AND k.table_name = t.table_name
     WHERE t.constraint_type = 'PRIMARY KEY' AND ${kind === 'mysql' ? sql`t.table_schema = DATABASE()` : sql`t.table_schema = current_schema()`}`.execute(
    db,
  );
  const pk = new Set(keys.rows.map((k) => `${k.table_name}.${k.column_name}`));

  // MariaDB guarda JSON como LONGTEXT con CHECK (json_valid(col)): se reconoce por la restricción.
  const jsonColumns = new Set<string>();
  if (kind === 'mysql') {
    try {
      const checks = await sql<{
        table_name: string;
        check_clause: string;
      }>`SELECT tc.table_name AS table_name, cc.check_clause AS check_clause
         FROM information_schema.table_constraints tc
         JOIN information_schema.check_constraints cc
           ON cc.constraint_schema = tc.constraint_schema AND cc.constraint_name = tc.constraint_name
         WHERE tc.constraint_type = 'CHECK' AND tc.table_schema = DATABASE()`.execute(db);
      for (const check of checks.rows) {
        for (const match of check.check_clause.matchAll(/json_valid\(`?(\w+)`?\)/gi))
          jsonColumns.add(`${check.table_name}.${match[1]}`);
      }
    } catch {
      // Versiones sin information_schema.check_constraints: se sigue con el tipo declarado.
    }
  }

  const tables = new Map<string, TableInfo>();
  for (const row of columns.rows) {
    const name = row.table_name;
    if (/_migrations(_lock)?$/.test(name)) continue;
    const extraText = (row.extra ?? '').toLowerCase();
    const table = tables.get(name) ?? { name, shortName: name.slice(prefix.length), columns: [] };
    table.columns.push({
      name: row.column_name,
      type: jsonColumns.has(`${name}.${row.column_name}`) ? 'json' : row.data_type.toLowerCase(),
      nullable: row.is_nullable === 'YES',
      length: row.length === null ? null : Number(row.length),
      primaryKey: pk.has(`${name}.${row.column_name}`),
      autoIncrement: extraText.includes('auto_increment') || row.is_identity === 'YES',
      generated: extraText.includes('generated') || extraText === 'always',
      hasDefault: row.column_default !== null,
    });
    tables.set(name, table);
  }
  return [...tables.values()];
}

type Kind = 'string' | 'int' | 'bigint' | 'boolean' | 'date' | 'json';

function kindOf(column: ColumnInfo): Kind {
  const t = column.type;
  if (t === 'tinyint' || t === 'boolean') return 'boolean';
  if (t === 'bigint') return 'bigint';
  if (t === 'int' || t === 'integer' || t === 'smallint' || t === 'mediumint') return 'int';
  if (t.startsWith('timestamp') || t === 'datetime' || t === 'date') return 'date';
  if (t === 'json' || t === 'jsonb') return 'json';
  return 'string';
}

/** CHAR fijo (no confundir con `character varying`, que es VARCHAR en PostgreSQL). */
const isFixedChar = (type: string) => type === 'char' || type === 'character' || type === 'bpchar';

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const pascal = (s: string) => camel(s).replace(/^./, (c) => c.toUpperCase());

const HEADER = (format: string) =>
  `Generado por \`tenancy schema --${format}\`. Tablas del paquete tenancy-node.\n` +
  'Para escribir usa la API (tenancy.tenants.*, tenancy.domains.*): dispara eventos, actualiza la caché y respeta las reglas.';

/** Modelos de las tablas centrales para Prisma, Drizzle o TypeORM. */
export function generateSchema(
  tables: readonly TableInfo[],
  format: SchemaFormat,
  kind: DialectKind,
): string {
  if (format === 'prisma') return prisma(tables);
  if (format === 'drizzle') return drizzle(tables, kind);
  return typeorm(tables, kind);
}

function prisma(tables: readonly TableInfo[]): string {
  const types: Record<Kind, string> = {
    string: 'String',
    int: 'Int',
    bigint: 'BigInt',
    boolean: 'Boolean',
    date: 'DateTime',
    json: 'Json',
  };
  const models = tables.map((table) => {
    const lines = table.columns.map((c) => {
      const attrs: string[] = [];
      if (c.primaryKey) attrs.push('@id');
      if (c.autoIncrement) attrs.push('@default(autoincrement())');
      else if (c.hasDefault && kindOf(c) === 'date') attrs.push('@default(now())');
      if (camel(c.name) !== c.name) attrs.push(`@map("${c.name}")`);
      if (c.generated) attrs.push('@ignore');
      if (kindOf(c) === 'string' && c.length)
        attrs.push(`@db.${isFixedChar(c.type) ? 'Char' : 'VarChar'}(${c.length})`);
      return `  ${camel(c.name)} ${types[kindOf(c)]}${c.nullable ? '?' : ''}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
    });
    return `model Tenancy${pascal(table.shortName)} {\n${lines.join('\n')}\n\n  @@map("${table.name}")\n}`;
  });
  return `${HEADER('prisma').replace(/^/gm, '// ')}\n\n${models.join('\n\n')}\n`;
}

function drizzle(tables: readonly TableInfo[], kind: DialectKind): string {
  const mysql = kind === 'mysql';
  const used = new Set<string>([mysql ? 'mysqlTable' : 'pgTable']);
  const column = (c: ColumnInfo): string => {
    let expr: string;
    const k = kindOf(c);
    const fn = (name: string, args = '') => (used.add(name), `${name}('${c.name}'${args})`);
    if (k === 'string')
      expr = isFixedChar(c.type)
        ? fn('char', c.length ? `, { length: ${c.length} }` : '')
        : c.length
          ? fn('varchar', `, { length: ${c.length} }`)
          : fn('text');
    else if (k === 'int')
      expr = c.autoIncrement && !mysql ? fn('serial') : fn(mysql ? 'int' : 'integer');
    else if (k === 'bigint') expr = fn('bigint', ", { mode: 'number' }");
    else if (k === 'boolean') expr = fn('boolean');
    else if (k === 'date')
      expr = mysql
        ? fn('datetime', ', { fsp: 3 }')
        : fn('timestamp', ', { withTimezone: true, precision: 3 }');
    else expr = fn(mysql ? 'json' : 'jsonb');
    if (c.primaryKey) expr += '.primaryKey()';
    if (c.autoIncrement && (mysql || k === 'bigint'))
      expr += mysql ? '.autoincrement()' : '.generatedAlwaysAsIdentity()';
    if (!c.nullable && !c.primaryKey) expr += '.notNull()';
    if (c.hasDefault && !c.autoIncrement && k === 'date') expr += '.defaultNow()';
    return `  ${camel(c.name)}: ${expr},${c.generated ? ' // columna generada por la base: no la escribas' : ''}`;
  };
  const bodies = tables.map(
    (t) =>
      `export const tenancy${pascal(t.shortName)} = ${mysql ? 'mysqlTable' : 'pgTable'}('${t.name}', {\n${t.columns.map(column).join('\n')}\n});`,
  );
  const header = HEADER('drizzle').replace(/^/gm, '// ');
  return `${header}\nimport { ${[...used].sort().join(', ')} } from 'drizzle-orm/${mysql ? 'mysql-core' : 'pg-core'}';\n\n${bodies.join('\n\n')}\n`;
}

function typeorm(tables: readonly TableInfo[], kind: DialectKind): string {
  const ts: Record<Kind, string> = {
    string: 'string',
    int: 'number',
    bigint: 'string',
    boolean: 'boolean',
    date: 'Date',
    json: 'unknown',
  };
  const entities = tables.map((table) => {
    const fields = table.columns.map((c) => {
      const opts = [
        `name: '${c.name}'`,
        `type: '${kind === 'postgres' && c.type === 'timestamp with time zone' ? 'timestamptz' : c.type === 'character varying' ? 'varchar' : c.type}'`,
      ];
      if (c.length) opts.push(`length: ${c.length}`);
      if (c.nullable) opts.push('nullable: true');
      if (c.generated) opts.push('insert: false', 'update: false');
      const decorator = c.primaryKey
        ? c.autoIncrement
          ? `@PrimaryGeneratedColumn({ name: '${c.name}', type: '${c.type}' })`
          : `@PrimaryColumn({ ${opts.join(', ')} })`
        : `@Column({ ${opts.join(', ')} })`;
      return `  ${decorator}\n  ${camel(c.name)}!: ${ts[kindOf(c)]}${c.nullable ? ' | null' : ''};`;
    });
    return `@Entity('${table.name}')\nexport class Tenancy${pascal(table.shortName)} {\n${fields.join('\n\n')}\n}`;
  });
  const header = HEADER('typeorm').replace(/^/gm, '// ');
  return `${header}\nimport { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';\n\n${entities.join('\n\n')}\n`;
}
