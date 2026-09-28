import type { Domain } from '../entities/domain.js';
import type { Tenant } from '../entities/tenant.js';
import type { TenantStatus } from '../entities/tenant-status.js';
import type { ThemeProps } from '../entities/theme.js';
import type { DomainEvent } from './domain-event.js';

export interface TenantEventData {
  id: string;
  name: string;
  status: TenantStatus;
  plan: string | null;
  data: Record<string, unknown>;
}

export interface TenantUpdatedEventData extends TenantEventData {
  changes: string[];
}

export interface TenantMaintenanceEventData extends TenantEventData {
  message: string | null;
}

export interface TenantProvisioningFailedEventData extends TenantEventData {
  error: string;
}

export interface DomainEventData {
  tenantId: string;
  domain: string;
  isPrimary: boolean;
}

export interface ThemeUpdatedEventData {
  tenantId: string;
  theme: ThemeProps | null;
}

export interface DatabaseEventData {
  tenantId: string;
  serverId: string;
  database: string;
}

export interface DatabaseMovedEventData {
  tenantId: string;
  database: string;
  from: string;
  to: string;
  /** Filas copiadas por tabla. */
  rows: Record<string, number>;
  sourceDropped: boolean;
}

export interface TenancyLifecycleEventData {
  tenantId: string;
}

/**
 * Catálogo tipado de eventos. Tu aplicación puede agregar los suyos
 * con declaration merging:
 *
 * ```ts
 * declare module '@tenancy-node/core' {
 *   interface TenancyEventMap { 'pedido.creado': { pedidoId: number; total: number } }
 * }
 * ```
 */
export interface TenancyEventMap {
  'tenant.creating': TenantEventData;
  'tenant.created': TenantEventData;
  'tenant.updated': TenantUpdatedEventData;
  'tenant.deleted': TenantEventData;
  'tenant.suspended': TenantEventData;
  'tenant.activated': TenantEventData;
  'tenant.maintenance': TenantMaintenanceEventData;
  'tenant.provisioned': TenantEventData;
  'tenant.provisioning_failed': TenantProvisioningFailedEventData;
  'domain.created': DomainEventData;
  'domain.deleted': DomainEventData;
  'domain.primary_changed': DomainEventData;
  'database.created': DatabaseEventData;
  'database.migrated': DatabaseEventData;
  'database.seeded': DatabaseEventData;
  'database.deleted': DatabaseEventData;
  'database.moved': DatabaseMovedEventData;
  'theme.updated': ThemeUpdatedEventData;
  'tenancy.initialized': TenancyLifecycleEventData;
  'tenancy.ended': TenancyLifecycleEventData;
}

export type TenancyEventType = keyof TenancyEventMap;

type TenantEventType =
  | 'tenant.creating'
  | 'tenant.created'
  | 'tenant.deleted'
  | 'tenant.suspended'
  | 'tenant.activated'
  | 'tenant.provisioned';

export function tenantEventData(tenant: Tenant): TenantEventData {
  return {
    id: tenant.id.value,
    name: tenant.name,
    status: tenant.status,
    plan: tenant.plan,
    data: structuredClone(tenant.data as Record<string, unknown>),
  };
}

function event<T extends TenancyEventType>(
  type: T,
  tenantId: string,
  data: TenancyEventMap[T],
): DomainEvent<T, TenancyEventMap[T]> {
  return { type, tenantId, data };
}

/** Fábricas de los eventos del paquete. */
export const TenancyEvents = {
  tenant(type: TenantEventType, tenant: Tenant) {
    return event(type, tenant.id.value, tenantEventData(tenant));
  },
  tenantUpdated(tenant: Tenant, changes: string[]) {
    return event('tenant.updated', tenant.id.value, { ...tenantEventData(tenant), changes });
  },
  tenantMaintenance(tenant: Tenant) {
    return event('tenant.maintenance', tenant.id.value, {
      ...tenantEventData(tenant),
      message: tenant.maintenanceMessage,
    });
  },
  provisioningFailed(tenant: Tenant, error: unknown) {
    return event('tenant.provisioning_failed', tenant.id.value, {
      ...tenantEventData(tenant),
      error: error instanceof Error ? error.message : String(error),
    });
  },
  domain(type: 'domain.created' | 'domain.deleted' | 'domain.primary_changed', domain: Domain) {
    return event(type, domain.tenantId.value, {
      tenantId: domain.tenantId.value,
      domain: domain.domain.value,
      isPrimary: domain.isPrimary,
    });
  },
  themeUpdated(tenant: Tenant) {
    return event('theme.updated', tenant.id.value, {
      tenantId: tenant.id.value,
      theme: tenant.theme ? tenant.theme.toJSON() : null,
    });
  },
  database(
    type: 'database.created' | 'database.migrated' | 'database.seeded' | 'database.deleted',
    tenant: Tenant,
  ) {
    return event(type, tenant.id.value, {
      tenantId: tenant.id.value,
      serverId: tenant.database?.serverId ?? '',
      database: tenant.database?.name ?? '',
    });
  },
  databaseMoved(data: DatabaseMovedEventData) {
    return event('database.moved', data.tenantId, data);
  },
  lifecycle(type: 'tenancy.initialized' | 'tenancy.ended', tenantId: string) {
    return event(type, tenantId, { tenantId });
  },
};
