import {
  TenantId,
  TenantInMaintenanceError,
  TenantNotFoundError,
  TenantNotReadyError,
  TenantSuspendedError,
  type Tenant,
} from '../domain/index.js';
import type { TenantReader } from '../ports/index.js';

export type TenantRef = string | TenantId;

/**
 * Acepta un id en texto o un `TenantId`. No usa `instanceof`: si el paquete quedó cargado dos
 * veces (ESM y CJS, versiones duplicadas), un `TenantId` de la otra copia también sirve.
 */
export function toTenantId(ref: TenantRef): TenantId | undefined {
  if (typeof ref === 'string') return TenantId.tryCreate(ref);
  const value = (ref as { value?: unknown } | null)?.value;
  return typeof value === 'string' ? TenantId.tryCreate(value) : undefined;
}

/** `true` si el valor es un `Tenant` (de esta u otra copia del paquete). */
export function isTenant(value: unknown): value is Tenant {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Tenant).toSnapshot === 'function' &&
    typeof (value as Tenant).id?.value === 'string'
  );
}

/** Busca el tenant o lanza `TenantNotFoundError`. Un id con formato inválido tampoco existe. */
export async function requireTenant(tenants: TenantReader, ref: TenantRef): Promise<Tenant> {
  const id = toTenantId(ref);
  const tenant = id ? await tenants.findById(id) : undefined;
  if (!tenant)
    throw new TenantNotFoundError(
      typeof ref === 'string' ? ref : String((ref as { value?: unknown }).value),
    );
  return tenant;
}

/** Lanza el error adecuado si el tenant no puede atender peticiones. */
export function assertTenantAccessible(tenant: Tenant): void {
  switch (tenant.status) {
    case 'active':
      return;
    case 'maintenance':
      throw new TenantInMaintenanceError(tenant.id.value, tenant.maintenanceMessage);
    case 'suspended':
      throw new TenantSuspendedError(tenant.id.value);
    default:
      throw new TenantNotReadyError(tenant.id.value, tenant.status);
  }
}
