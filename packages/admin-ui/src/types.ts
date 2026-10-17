export type TenantStatus =
  'provisioning' | 'active' | 'maintenance' | 'suspended' | 'failed' | 'deleting';

export interface Tenant {
  id: string;
  name: string;
  status: TenantStatus;
  plan: string | null;
  /** Módulos sueltos y límites propios (sobre el plan). Falta en servidores anteriores a 0.11. */
  features?: FeatureOverrides | null;
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
  /** Plan efectivo (plan + módulos sueltos). Falta en servidores anteriores a 0.11. */
  plan?: ResolvedPlan;
  /** Fuentes permitidas (`theme.fonts`). Vacío = cualquier nombre. */
  fonts?: FontInfo[];
}

/** Módulos sueltos y límites propios de un tenant. */
export interface FeatureOverrides {
  add?: string[];
  remove?: string[];
  /** `null` = sin límite. */
  limits?: Record<string, number | null>;
}

export interface ResolvedPlan {
  /** `false` sin `plans` en la configuración: todo tenant tiene todos los módulos. */
  enabled: boolean;
  plan: string | null;
  planLabel: string | null;
  /** `false` si el plan del tenant ya no está en la configuración. */
  knownPlan: boolean;
  features: string[];
  limits: Record<string, number | null>;
}

export interface FeatureInfo {
  id: string;
  label: string;
  description: string | null;
}

export interface PlanPrice {
  currency: string;
  monthly?: number | null;
  yearly?: number | null;
}

export interface PlanInfo {
  id: string;
  label: string;
  description: string | null;
  price: PlanPrice | null;
  features: string[];
  /** Sin la llave o `null` = sin límite. */
  limits: Record<string, number | null>;
  highlight: boolean;
  public: boolean;
  /** Tenants con este plan (incluye los sin plan si es el plan por defecto). */
  tenants: number;
}

/** `GET /plans` */
export interface PlansResponse {
  enabled: boolean;
  defaultPlan: string | null;
  features: FeatureInfo[];
  plans: PlanInfo[];
  /** Tenants sin plan cuando no hay plan por defecto. */
  withoutPlan: number;
  /** Planes guardados en tenants que ya no están en la configuración. */
  unknown: { plan: string; tenants: number }[];
}

export interface FontInfo {
  family: string;
  label: string;
  source: 'google' | 'system' | 'url';
  weights: number[];
  /** CSS que carga la fuente; `null` en las de sistema. */
  cssUrl: string | null;
  /** Valor completo de `font-family`. */
  stack: string;
}

export type LeadStatus = 'new' | 'contacted' | 'converted' | 'discarded';

/** Solicitud de la web comercial ("Solicitar demo"). */
export interface Lead {
  id: number;
  name: string;
  company: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  plan: string | null;
  message: string | null;
  data: Record<string, string>;
  status: LeadStatus;
  notes: string | null;
  tenantId: string | null;
  ip: string | null;
  consentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /leads` */
export interface LeadsPage extends Page<Lead> {
  counts: Record<LeadStatus, number>;
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

export type NotificationLevel = 'info' | 'success' | 'warning' | 'critical';

export type NotificationAudience =
  { type: 'all' } | { type: 'tenants'; tenants: string[] } | { type: 'plans'; plans: string[] };

/** Aviso de la plataforma a sus tenants (`GET /notifications`). */
export interface PlatformNotification {
  id: string;
  title: string;
  body: string;
  level: NotificationLevel;
  audience: NotificationAudience;
  roles: string[] | null;
  link: { url: string; label: string } | null;
  startsAt: string | null;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
  /** Cuántos tenants y usuarios lo leyeron. */
  reads: { tenants: number; users: number };
}

/** `GET /notifications` */
export interface NotificationsPage extends Page<PlatformNotification> {
  /** Canales de entrega configurados (`firebase`...). */
  channels: string[];
}

/** Resultado de `POST /notifications/:id/deliver` (uno por canal). */
export interface NotificationDelivery {
  notificationId: string;
  channel: string;
  tenants: number;
  devices: number;
  sent: number;
  failed: number;
  removedTokens: number;
}

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';
export type BillingPeriod = 'monthly' | 'yearly';
export type InvoiceStatus = 'open' | 'paid' | 'void';

/** Montos en centavos (enteros). */
export interface Subscription {
  tenantId: string;
  plan: string | null;
  period: BillingPeriod;
  status: SubscriptionStatus;
  currency: string;
  amountCents: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  provider: string;
  providerRef: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Invoice {
  id: string;
  tenantId: string;
  description: string;
  currency: string;
  amountCents: number;
  paidCents: number;
  status: InvoiceStatus;
  periodStart: string | null;
  periodEnd: string | null;
  dueAt: string;
  paidAt: string | null;
  provider: string | null;
  providerRef: string | null;
  checkoutUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  invoiceId: string;
  tenantId: string;
  amountCents: number;
  currency: string;
  method: string;
  reference: string | null;
  provider: string;
  providerRef: string | null;
  paidAt: string;
  recordedBy: string | null;
  createdAt: string;
}

/** `GET /billing/invoices` */
export interface InvoicesPage extends Page<Invoice> {
  summary: { open: number; overdue: number; pastDueSubscriptions: number };
  /** Pasarelas configuradas (`manual` siempre está). */
  providers: string[];
}

/** `GET /tenants/:id/billing` */
export interface TenantBilling {
  subscription: Subscription | null;
  invoices: Invoice[];
  payments: Payment[];
  providers: string[];
}

/** `POST /billing/invoices/:id/checkout` */
export interface CheckoutSession {
  providerRef: string;
  url?: string;
  qr?: string;
  expiresAt?: string;
}

/** `POST /billing/run` */
export interface BillingRunResult {
  invoiced: string[];
  pastDue: string[];
  suspended: string[];
}
