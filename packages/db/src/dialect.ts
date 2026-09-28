import type {
  DataTypeNode,
  ValueNode} from 'kysely';
import {
  OperationNodeTransformer,
  sql,
  type ReferencesNode,
  type ForeignKeyConstraintNode,
  type InsertQueryBuilder,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RawBuilder,
  type RootOperationNode,
  type UnknownRow,
} from 'kysely';
import type { DialectKind } from './drivers/driver.js';

/**
 * Inserta y devuelve el id generado, según el motor:
 * PostgreSQL `RETURNING`, SQL Server `OUTPUT inserted.id`, MySQL y SQLite el id insertado.
 */
export async function insertReturningId(
  kind: DialectKind,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert: InsertQueryBuilder<any, any, any>,
): Promise<number> {
  if (kind === 'postgres') return Number((await insert.returning('id').executeTakeFirstOrThrow()).id);
  if (kind === 'mssql') return Number((await insert.output('inserted.id').executeTakeFirstOrThrow()).id);
  return Number((await insert.executeTakeFirstOrThrow()).insertId);
}

/**
 * Límite y desplazamiento según el motor: SQL Server usa `OFFSET ... FETCH NEXT` (exige ORDER BY);
 * los demás, `LIMIT ... OFFSET`.
 */
export function paginate<Q extends { limit(n: number): Q; offset(n: number): Q; fetch(n: number): Q }>(
  kind: DialectKind,
  query: Q,
  limit: number,
  offset = 0,
): Q {
  if (kind === 'mssql') return query.offset(offset).fetch(limit);
  const limited = query.limit(limit);
  return offset > 0 ? limited.offset(offset) : limited;
}

/** `lower(col) LIKE pattern` con el escape `\\` explícito donde el motor no lo trae por defecto. */
export function likeLower(kind: DialectKind, column: string, pattern: string): RawBuilder<boolean> {
  const ref = sql.ref(column);
  return kind === 'sqlite' || kind === 'mssql' ? sql<boolean>`lower(${ref}) like ${pattern} escape '\\'` : sql<boolean>`lower(${ref}) like ${pattern}`;
}

class MssqlDdlTransformer extends OperationNodeTransformer {
  protected override transformDataType(node: DataTypeNode): DataTypeNode {
    const type = node.dataType as string;
    // Unicode real (incluidos emojis) y tipos que SQL Server no tiene.
    const mapped = type
      .replace(/^varchar\(/i, 'nvarchar(')
      .replace(/^text$/i, 'nvarchar(max)')
      .replace(/^boolean$/i, 'bit');
    return mapped === type ? node : ({ ...node, dataType: mapped } as DataTypeNode);
  }

  protected override transformReferences(node: ReferencesNode): ReferencesNode {
    // SQL Server no tiene RESTRICT: NO ACTION hace lo mismo (rechaza el borrado del padre).
    const transformed = super.transformReferences(node);
    return transformed.onDelete === 'restrict' ? ({ ...transformed, onDelete: 'no action' } as ReferencesNode) : transformed;
  }

  protected override transformForeignKeyConstraint(node: ForeignKeyConstraintNode): ForeignKeyConstraintNode {
    const transformed = super.transformForeignKeyConstraint(node);
    return transformed.onDelete === 'restrict' ? ({ ...transformed, onDelete: 'no action' } as ForeignKeyConstraintNode) : transformed;
  }

  protected override transformValue(node: ValueNode): ValueNode {
    // `DEFAULT true` / `WHERE x = true` no existen en T-SQL: bit usa 1 y 0.
    return typeof node.value === 'boolean' ? ({ ...node, value: node.value ? 1 : 0 } as ValueNode) : node;
  }
}

/** Adapta el DDL de las migraciones centrales a SQL Server. */
export class MssqlDdlPlugin implements KyselyPlugin {
  private readonly transformer = new MssqlDdlTransformer();
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.transformer.transformNode(args.node);
  }
  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}
