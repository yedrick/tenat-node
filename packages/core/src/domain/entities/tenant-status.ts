export const TENANT_STATUSES = [
  'provisioning',
  'active',
  'maintenance',
  'suspended',
  'failed',
  'deleting',
] as const;

export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** Transiciones de estado permitidas. Cualquier otra es un error de negocio. */
const TRANSITIONS: Record<TenantStatus, readonly TenantStatus[]> = {
  provisioning: ['active', 'failed', 'deleting'],
  active: ['maintenance', 'suspended', 'deleting'],
  maintenance: ['active', 'suspended', 'deleting'],
  suspended: ['active', 'deleting'],
  failed: ['provisioning', 'deleting'],
  deleting: [],
};

export function canTransition(from: TenantStatus, to: TenantStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTenantStatus(value: unknown): value is TenantStatus {
  return typeof value === 'string' && (TENANT_STATUSES as readonly string[]).includes(value);
}
