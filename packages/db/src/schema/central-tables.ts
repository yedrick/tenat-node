import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | undefined, Date>;
type NullableTimestamp = ColumnType<Date | null, Date | null | undefined, Date | null>;
type Json<T> = ColumnType<T, string, string>;
type BigId = ColumnType<number | string, never, never>;
/** MySQL devuelve 0/1 en columnas BOOLEAN. */
type Bool = ColumnType<boolean | number, boolean | undefined, boolean>;

export interface DatabaseServersTable {
  id: string;
  driver: string;
  host: string;
  port: number;
  admin_username: string | null;
  admin_password_encrypted: string | null;
  max_tenants: number | null;
  tenant_count: ColumnType<number, number | undefined, number>;
  weight: ColumnType<number, number | undefined, number>;
  is_active: Bool;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TenantsTable {
  id: string;
  name: string;
  status: string;
  plan: string | null;
  data: Json<unknown>;
  theme: Json<unknown> | null;
  database_server_id: string | null;
  database_name: string | null;
  schema_name: string | null;
  database_username: string | null;
  database_password_encrypted: string | null;
  maintenance_message: string | null;
  provisioned_at: NullableTimestamp;
  suspended_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: NullableTimestamp;
}

export interface DomainsTable {
  id: Generated<number | string>;
  tenant_id: string;
  domain: string;
  is_primary: Bool;
  verified_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProvisioningStepsTable {
  id: Generated<number | string>;
  tenant_id: string;
  run_id: string;
  step: string;
  status: string;
  attempt: number;
  error: string | null;
  started_at: NullableTimestamp;
  finished_at: NullableTimestamp;
  duration_ms: number | null;
  created_at: Timestamp;
}

export interface WebhookEndpointsTable {
  id: Generated<number | string>;
  tenant_id: string | null;
  name: string;
  url: string;
  events: Json<unknown>;
  secret_encrypted: string;
  is_active: Bool;
  circuit_state: string;
  consecutive_failures: number;
  paused_until: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EventOutboxTable {
  id: string;
  type: string;
  tenant_id: string | null;
  /** CloudEvent completo. */
  payload: Json<unknown>;
  status: string;
  attempts: ColumnType<number, number | undefined, number>;
  available_at: Timestamp;
  locked_until: NullableTimestamp;
  published_at: NullableTimestamp;
  last_error: string | null;
  destination: string;
  routing_key: string | null;
  created_at: Timestamp;
}

export interface WebhookDeliveriesTable {
  id: Generated<number | string>;
  endpoint_id: number | string;
  event_id: string;
  status: string;
  attempt: ColumnType<number, number | undefined, number>;
  http_status: number | null;
  response_ms: number | null;
  response_body: string | null;
  next_retry_at: NullableTimestamp;
  payload: Json<unknown> | null;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AdminUsersTable {
  id: Generated<number | string>;
  email: string;
  name: string;
  password_hash: string;
  role: string;
  two_factor_secret_encrypted: string | null;
  is_active: Bool;
  last_login_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AdminSessionsTable {
  /** SHA-256 del token: el token real nunca se guarda. */
  id: string;
  admin_user_id: number | string;
  ip: string | null;
  user_agent: string | null;
  expires_at: Timestamp;
  created_at: Timestamp;
}

export interface ImpersonationTokensTable {
  token_hash: string;
  tenant_id: string;
  user_identifier: string;
  admin_user_id: number | string;
  redirect_path: string;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface AuditLogTable {
  id: Generated<number | string>;
  admin_user_id: number | string | null;
  action: string;
  tenant_id: string | null;
  target_type: string | null;
  target_id: string | null;
  changes: Json<unknown> | null;
  ip: string | null;
  created_at: Timestamp;
}

/** Tablas centrales con nombres cortos; `TablePrefixPlugin` agrega el prefijo. */
export interface CentralTables {
  database_servers: DatabaseServersTable;
  tenants: TenantsTable;
  domains: DomainsTable;
  provisioning_steps: ProvisioningStepsTable;
  webhook_endpoints: WebhookEndpointsTable;
  webhook_deliveries: WebhookDeliveriesTable;
  event_outbox: EventOutboxTable;
  admin_users: AdminUsersTable;
  admin_sessions: AdminSessionsTable;
  impersonation_tokens: ImpersonationTokensTable;
  audit_log: AuditLogTable;
}

/** Todas las tablas que crea `install()` (sin prefijo). */
export const CENTRAL_TABLES = [
  'database_servers',
  'tenants',
  'domains',
  'provisioning_steps',
  'event_outbox',
  'webhook_endpoints',
  'webhook_deliveries',
  'admin_users',
  'admin_sessions',
  'impersonation_tokens',
  'audit_log',
] as const;

export type BigIdColumn = BigId;
