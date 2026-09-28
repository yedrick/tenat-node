import type { Tenant } from '@tenancy-node/core';
import type { DatabaseServer } from '../repositories/server-repository.js';

export interface PlacementContext {
  tenant: Tenant;
  /** Servidores activos, del mismo motor y con lugar libre. */
  servers: readonly DatabaseServer[];
}

/**
 * Dónde se crea la base de un tenant nuevo (Strategy):
 * - `'least-tenants'` (por defecto): el servidor con menos tenants.
 * - `'weighted'`: reparte según el peso de cada servidor.
 * - `{ fixed: 'mysql-2' }`: siempre ese servidor.
 * - una función propia (por plan, por país...) que devuelve el id del servidor.
 */
export type PlacementStrategy =
  | 'least-tenants'
  | 'weighted'
  | { fixed: string }
  | ((context: PlacementContext) => string | Promise<string>);

/** Devuelve los candidatos en orden de preferencia. */
export async function rankServers(
  strategy: PlacementStrategy,
  context: PlacementContext,
): Promise<string[]> {
  const byId = (a: DatabaseServer, b: DatabaseServer) => a.id.localeCompare(b.id);
  if (typeof strategy === 'function') return [await strategy(context)];
  if (typeof strategy === 'object') return [strategy.fixed];
  const sorted = [...context.servers].sort(
    strategy === 'weighted'
      ? (a, b) =>
          a.tenantCount / Math.max(1, a.weight) - b.tenantCount / Math.max(1, b.weight) ||
          b.weight - a.weight ||
          byId(a, b)
      : (a, b) => a.tenantCount - b.tenantCount || byId(a, b),
  );
  return sorted.map((s) => s.id);
}

export function hasCapacity(server: DatabaseServer): boolean {
  return server.isActive && (server.maxTenants === null || server.tenantCount < server.maxTenants);
}
