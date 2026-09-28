import { sql } from 'kysely';
import type { DialectKind } from '../drivers/driver.js';
import type { AnyKysely } from '../kysely-any.js';
import { schemaTables } from '../schema/schema-tables.js';

export interface CopyProgress {
  table: string;
  copied: number;
  total: number;
}

export interface CopyOptions {
  /** Filas por lote (se reduce solo si la tabla tiene muchas columnas). Por defecto 1000. */
  batchSize?: number;
  onProgress?: (progress: CopyProgress) => void;
  /** Se llama al terminar cada tabla (para el log). */
  onTable?: (table: string, rows: number, durationMs: number) => void;
}

interface TableInfo {
  name: string;
  columns: string[];
  primaryKey: string[];
  /** Columnas JSON: los drivers las devuelven ya parseadas y hay que volver a serializarlas. */
  json: string[];
}

/** Parámetros por sentencia: PostgreSQL y MySQL aceptan 65 535; se deja margen. */
const MAX_PARAMS = 60_000;

/** Tablas del tenant (sin vistas) con sus columnas y su clave primaria. */
async function describeTables(
  db: AnyKysely,
  kind: DialectKind,
  schema: string,
): Promise<TableInfo[]> {
  // En PostgreSQL solo se leen las tablas del schema (en modo schema hay miles de tenants).
  const tables = (
    kind === 'postgres'
      ? await schemaTables(db, schema, { columns: true })
      : await db.introspection.getTables()
  ).filter((t) => !t.isView);
  const keys =
    kind === 'postgres'
      ? await sql<{ table_name: string; column_name: string }>`
          select kcu.table_name, kcu.column_name
          from information_schema.table_constraints tc
          join information_schema.key_column_usage kcu
            on kcu.constraint_schema = tc.constraint_schema and kcu.constraint_name = tc.constraint_name
          where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = ${schema}
          order by kcu.table_name, kcu.ordinal_position`.execute(db)
      : await sql<{ table_name: string; column_name: string }>`
          select table_name as table_name, column_name as column_name
          from information_schema.key_column_usage
          where table_schema = database() and constraint_name = 'PRIMARY'
          order by table_name, ordinal_position`.execute(db);
  const pk = new Map<string, string[]>();
  for (const row of keys.rows)
    pk.set(row.table_name, [...(pk.get(row.table_name) ?? []), row.column_name]);
  return tables.map((t) => ({
    name: t.name,
    columns: t.columns.map((c) => c.name),
    primaryKey: pk.get(t.name) ?? [],
    json: t.columns.filter((c) => /^jsonb?$/i.test(c.dataType)).map((c) => c.name),
  }));
}

/** Pares hijo → padre de las claves foráneas. */
async function foreignKeys(
  db: AnyKysely,
  kind: DialectKind,
  schema: string,
): Promise<[string, string][]> {
  const result =
    kind === 'postgres'
      ? await sql<{ child: string; parent: string }>`
          select distinct kcu.table_name as child, pk.table_name as parent
          from information_schema.referential_constraints rc
          join information_schema.key_column_usage kcu
            on kcu.constraint_schema = rc.constraint_schema and kcu.constraint_name = rc.constraint_name
          join information_schema.table_constraints pk
            on pk.constraint_schema = rc.unique_constraint_schema and pk.constraint_name = rc.unique_constraint_name
          where kcu.table_schema = ${schema}`.execute(db)
      : await sql<{ child: string; parent: string }>`
          select distinct table_name as child, referenced_table_name as parent
          from information_schema.key_column_usage
          where table_schema = database() and referenced_table_name is not null`.execute(db);
  return result.rows.map((r) => [r.child, r.parent]);
}

/**
 * Orden topológico: cada tabla va después de las que referencia. Las autorreferencias se
 * ignoran (se copian en orden de clave primaria). Un ciclo entre tablas distintas no se puede
 * copiar fila a fila sin desactivar las claves foráneas, así que se rechaza con un error claro.
 */
export function copyOrder(tables: readonly string[], edges: readonly [string, string][]): string[] {
  const known = new Set(tables);
  const parents = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const [child, parent] of edges) {
    if (child !== parent && known.has(child) && known.has(parent)) parents.get(child)!.add(parent);
  }
  const ordered: string[] = [];
  const done = new Set<string>();
  while (ordered.length < tables.length) {
    const ready = tables.filter(
      (t) => !done.has(t) && [...parents.get(t)!].every((p) => done.has(p)),
    );
    if (ready.length === 0) {
      const cycle = tables.filter((t) => !done.has(t));
      throw new Error(`Cyclic foreign keys between ${cycle.join(', ')}: cannot copy them in order`);
    }
    for (const t of ready.sort()) {
      ordered.push(t);
      done.add(t);
    }
  }
  return ordered;
}

async function count(db: AnyKysely, table: string): Promise<number> {
  const row = (await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll().as('n'))
    .executeTakeFirstOrThrow()) as { n: number | string | bigint };
  return Number(row.n);
}

/** Columnas `GENERATED ALWAYS AS IDENTITY`: no aceptan valores explícitos en un INSERT normal. */
async function alwaysIdentity(db: AnyKysely, schema: string): Promise<string[]> {
  const result = await sql<{ table_name: string; column_name: string }>`
    select table_name, column_name from information_schema.columns
    where table_schema = ${schema} and is_identity = 'YES' and identity_generation = 'ALWAYS'`.execute(
    db,
  );
  return result.rows.map((r) => `${r.table_name}.${r.column_name}`);
}

/** Tras copiar con ids explícitos, las secuencias de PostgreSQL siguen en 1: se adelantan al máximo. */
async function resetSequences(db: AnyKysely, schema: string): Promise<number> {
  const result = await sql<{ table_name: string; column_name: string; seq: string | null }>`
    select c.table_name, c.column_name,
      pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name) as seq
    from information_schema.columns c
    where c.table_schema = ${schema} and (c.column_default like 'nextval(%' or c.is_identity = 'YES')`.execute(
    db,
  );
  let reset = 0;
  for (const { table_name, column_name, seq } of result.rows) {
    if (!seq) continue;
    await sql`select setval(${seq}::regclass, coalesce((select max(${sql.ref(column_name)}) from ${sql.table(table_name)}), 0) + 1, false)`.execute(
      db,
    );
    reset++;
  }
  return reset;
}

export interface CopyResult {
  /** Filas copiadas por tabla, en el orden de copia. */
  rows: Record<string, number>;
  sequencesReset: number;
}

/**
 * Copia todas las tablas de la base de origen a la de destino (ya migrada): vacía el destino en
 * orden inverso de claves foráneas, copia por lotes en orden de clave primaria, adelanta las
 * secuencias y verifica que el número de filas coincida. Las tablas de control de migraciones
 * también se copian, así el destino queda con el mismo historial que el origen.
 */
export async function copyTenantData(
  source: AnyKysely,
  target: AnyKysely,
  kind: DialectKind,
  schema: string,
  options: CopyOptions = {},
): Promise<CopyResult> {
  if (kind !== 'postgres' && kind !== 'mysql')
    throw new Error(`Moving tenants is not supported for the ${kind} driver yet`);
  const [sourceTables, targetTables] = await Promise.all([
    describeTables(source, kind, schema),
    describeTables(target, kind, schema),
  ]);
  const targetNames = new Set(targetTables.map((t) => t.name));
  const missing = sourceTables.filter((t) => !targetNames.has(t.name)).map((t) => t.name);
  if (missing.length > 0)
    throw new Error(
      `Tables missing in the target after migrating: ${missing.join(', ')} (are all migrations in the migrator?)`,
    );
  if (kind === 'postgres') {
    const always = await alwaysIdentity(source, schema);
    if (always.length > 0)
      throw new Error(
        `Columns GENERATED ALWAYS AS IDENTITY cannot be copied yet: ${always.join(', ')}`,
      );
  }

  const order = copyOrder(
    sourceTables.map((t) => t.name),
    await foreignKeys(source, kind, schema),
  );
  const byName = new Map(sourceTables.map((t) => [t.name, t]));

  // El destino puede traer filas sembradas por las migraciones: se vacía primero (hijas antes que padres).
  for (const table of [...order].reverse()) await target.deleteFrom(table).execute();

  const rows: Record<string, number> = {};
  for (const table of order) {
    const info = byName.get(table)!;
    const started = performance.now();
    const total = await count(source, table);
    const batch = Math.max(
      1,
      Math.min(
        options.batchSize ?? 1000,
        Math.floor(MAX_PARAMS / Math.max(1, info.columns.length)),
      ),
    );
    // Sin clave primaria se ordena por todas las columnas: el origen está en mantenimiento, sin escrituras.
    const orderBy = info.primaryKey.length > 0 ? info.primaryKey : info.columns;
    let copied = 0;
    while (copied < total) {
      let query = source.selectFrom(table).selectAll();
      for (const column of orderBy) query = query.orderBy(column);
      const page = (await query.limit(batch).offset(copied).execute()) as Record<string, unknown>[];
      if (page.length === 0) break;
      const values =
        info.json.length === 0
          ? page
          : page.map((row) => {
              const copy = { ...row };
              for (const column of info.json)
                if (copy[column] !== null && copy[column] !== undefined)
                  copy[column] = JSON.stringify(copy[column]);
              return copy;
            });
      await target.insertInto(table).values(values).execute();
      copied += page.length;
      options.onProgress?.({ table, copied, total });
    }
    const inTarget = await count(target, table);
    if (inTarget !== total)
      throw new Error(
        `Row count mismatch in ${table}: ${total} in the source, ${inTarget} in the target`,
      );
    rows[table] = total;
    options.onTable?.(table, total, performance.now() - started);
  }
  const sequencesReset = kind === 'postgres' ? await resetSequences(target, schema) : 0;
  return { rows, sequencesReset };
}
