import type { TableNode } from 'kysely';
import {
  IdentifierNode,
  OperationNodeTransformer,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from 'kysely';

class PrefixTransformer extends OperationNodeTransformer {
  constructor(private readonly prefix: string) {
    super();
  }

  protected override transformTable(node: TableNode): TableNode {
    const transformed = super.transformTable(node);
    const name = transformed.table.identifier.name;
    // Pseudo-tablas de SQL Server en OUTPUT: no son tablas del paquete.
    if (name === 'inserted' || name === 'deleted') return transformed;
    return {
      ...transformed,
      table: { ...transformed.table, identifier: IdentifierNode.create(this.prefix + name) },
    };
  }
}

/**
 * Agrega el prefijo (`tenancy_`) a cada tabla de las consultas del paquete,
 * así el código usa nombres cortos y tipados ('tenants') y la base ve `tenancy_tenants`.
 */
export class TablePrefixPlugin implements KyselyPlugin {
  private readonly transformer: PrefixTransformer;

  constructor(readonly prefix: string) {
    this.transformer = new PrefixTransformer(prefix);
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.transformer.transformNode(args.node);
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}
