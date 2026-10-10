export type TenantStatus =
  'provisioning' | 'active' | 'maintenance' | 'suspended' | 'failed' | 'deleting';

export interface Tenant {
  id: string;
  name: string;
  status: TenantStatus;
  plan: string | null;
  data: Record<string, unknown>;
  theme: Record<string, unknown> | null;
  database: { serverId: string; name: string; username: string | null } | null;
  maintenanceMessage: string | null;
  provisionedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

export interface ProvisioningStep {
  id: number;
  runId: string;
  step: string;
  status: string;
  attempt: number;
  error: string | null;
  durationMs: number | null;
}

export interface TrackedError {
  id: string;
  tenantId: string | null;
  operation: string;
  code: string;
  message: string;
  time: string;
  context: Record<string, unknown>;
}

export interface TenantDetail {
  tenant: Tenant;
  /** El tema que ve el tenant: el suyo o el `theme.defaults` de la app. */
  effectiveTheme: Record<string, unknown>;
  defaultTheme: Record<string, unknown>;
  logoUrl: string | null;
  /** Dominio principal del tenant (o `<id>.<dominio central>`) para la vista previa. */
  previewDomain: string | null;
  domains: { id: number; domain: string; isPrimary: boolean; verifiedAt: string | null }[];
  provisioning: ProvisioningStep[];
  errors: TrackedError[];
}

export interface Webhook {
  id: number;
  tenantId: string | null;
  name: string;
  url: string;
  events: string[];
  isActive: boolean;
  circuitState: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  pausedUntil: string | null;
  createdAt: string;
}

export interface Delivery {
  id: number;
  eventId: string;
  eventType: string | null;
  status: string;
  attempt: number;
  httpStatus: number | null;
  responseMs: number | null;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  adminUserId: number | null;
  adminEmail: string | null;
  action: string;
  tenantId: string | null;
  targetType: string | null;
  targetId: string | null;
  changes: unknown;
  ip: string | null;
  createdAt: string;
}

/** Campo de `tenant.data` declarado por la app (`createAdminApi({ tenantFields })`). */
export interface TenantField {
  key: string;
  label: string;
  type?: 'text' | 'email' | 'tel' | 'url' | 'number';
  required?: boolean;
  hint?: string;
  placeholder?: string;
}

/** Usuario de la app dentro de un tenant (`createAdminApi({ tenantUsers })`). */
export interface TenantUser {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  active: boolean;
  lastLoginAt: string | null;
}

export interface AdminConfig {
  centralDomains: string[];
  tenantFields: TenantField[];
  /** `null`: la app no configuró `tenantUsers`. Falta en servidores anteriores. */
  tenantUsers?: { canCreate: boolean; roles: { value: string; label: string }[] } | null;
}
