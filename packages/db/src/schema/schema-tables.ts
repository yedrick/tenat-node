import { sql, type DatabaseIntrospector, type TableMetadata } from 'kysely';
import type { AnyKysely } from '../kysely-any.js';

/**
 * Tablas de UN schema de PostgreSQL, leídas de `information_schema` con filtro por schema.
 *
 * `db.introspection.getTables()` de Kysely lista las tablas de todos los schemas: en modo schema,
 * con miles de tenants, cada llamada recorre las tablas de todos (y crear o migrar N tenants
 * cuesta O(N²)). Esto lee solo las del tenant.
 */
export async function schemaTables(
  db: AnyKysely,
  schema: string,
  options: { columns?: boolean } = {},
): Promise<TableMetadata[]> {
  const tables = await sql<{ name: string; type: string }>`
    select table_name as name, table_type as type from information_schema.tables
    where table_schema = ${schema} order by table_name`.execute(db);
  const columns = options.columns
    ? await sql<{
        table_name: string;
        name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
        is_identity: string;
      }>`
        select table_name, column_name as name, udt_name as data_type, is_nullable, column_default, is_identity
        from information_schema.columns where table_schema = ${schema}
        order by table_name, ordinal_position`.execute(db)
    : { rows: [] };
  const byTable = new Map<string, TableMetadata['columns'][number][]>();
  for (const c of columns.rows) {
    const autoIncrement =
      c.is_identity === 'YES' || (c.column_default ?? '').startsWith('nextval(');
    byTable.set(c.table_name, [
      ...(byTable.get(c.table_name) ?? []),
      {
        name: c.name,
        dataType: c.data_type,
        isNullable: c.is_nullable === 'YES',
        isAutoIncrementing: autoIncrement,
        hasDefaultValue: c.column_default !== null || autoIncrement,
      },
    ]);
  }
  return tables.rows.map((t) => ({
    name: t.name,
    schema,
    isView: t.type === 'VIEW',
    columns: byTable.get(t.name) ?? [],
  }));
}

/**
 * La misma conexión, pero con una introspección que solo ve `schema`. Se la damos al `Migrator`
 * de Kysely, que la usa para saber si ya existen sus tablas de control.
 */
export function withSchemaIntrospection(db: AnyKysely, schema: string): AnyKysely {
  const introspector: DatabaseIntrospector = {
    getSchemas: async () =>
      (
        await sql<{ name: string }>`
          select schema_name as name from information_schema.schemata where schema_name = ${schema}`.execute(
          db,
        )
      ).rows,
    getTables: () => schemaTables(db, schema),
    getMetadata: async () => ({ tables: await schemaTables(db, schema) }),
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'introspection') return introspector;
      const value: unknown = Reflect.get(target, prop, target);
      // Kysely usa campos privados (#props): los métodos deben correr sobre el objeto real.
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
