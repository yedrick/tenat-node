import type { IncomingMessage } from 'node:http';
import type { Tenancy, Tenant } from '@tenancy-node/core';
import type { CentralAccess, DatabaseExtension } from '@tenancy-node/db';
import type { OutboxApi } from '@tenancy-node/outbox';
import type { WebhooksApi } from '@tenancy-node/transport-webhook';
import type { AuditInput, AuditLog } from './audit.js';
import type { Leads } from './leads.js';
import type { RateLimiter } from './auth/rate-limit.js';
import type { AdminSessions } from './auth/sessions.js';
import type { AdminUsers } from './auth/users.js';
import type { AdminRequest } from './http.js';

export type AdminTenancy = Tenancy &
  DatabaseExtension & { outbox?: OutboxApi; webhooks?: WebhooksApi };

/** Campo de `tenant.data` que el formulario "Nuevo tenant" pide (y el detalle permite editar). */
export interface TenantField {
  /** Llave en `tenant.data` (por ejemplo `adminEmail`). */
  key: string;
  label: string;
  /** Por defecto `text`. */
  type?: 'text' | 'email' | 'tel' | 'url' | 'number';
  required?: boolean;
  hint?: string;
  placeholder?: string;
}

/** Usuario de la app dentro de un tenant, tal como lo muestra el panel. */
export interface TenantUser {
  /** Lo que recibe "Entrar como" (`userIdentifier` en `consumeImpersonationToken`). */
  id: string;
  name: string;
  email?: string | null;
  role?: string | null;
  /** `false` = desactivado (no se puede entrar como él). Por defecto `true`. */
  active?: boolean;
  lastLoginAt?: string | Date | null;
}

export interface NewTenantUser {
  name: string;
  email: string;
  role?: string;
  /** Contraseña inicial. Si falta, la app decide (por ejemplo, cuenta "por activar"). */
  password?: string;
}

/**
 * Cómo ve y crea el panel los usuarios de la app dentro de cada tenant. Las funciones corren en
 * el contexto del tenant: `tenancy.db()`, `tenancy.pool()`... apuntan a su base.
 * Para responder un error al panel (email repetido, contraseña débil) lanza `AdminHttpError`.
 */
export interface TenantUsersAdapter {
  list(
    query: { search?: string; page: number; perPage: number },
    tenant: Tenant,
  ): Promise<{ items: TenantUser[]; total: number }>;
  /** Sin `create`, el panel solo lista. */
  create?(input: NewTenantUser, tenant: Tenant): Promise<TenantUser>;
  /** Roles para elegir al crear (por ejemplo `[{ value: 'ADMIN', label: 'Administrador' }]`). */
  roles?: readonly { value: string; label: string }[];
}

export interface AdminOptions {
  /** Secreto para los tokens CSRF (mínimo 32 caracteres). Usa una variable de entorno. */
  sessionSecret: string;
  /** Prefijo de la API. Por defecto `/admin/api`. */
  prefix?: string;
  /** Hosts desde los que responde. Por defecto los dominios centrales, `localhost` y `127.0.0.1`. */
  allowedHosts?: readonly string[];
  /** Cookies `Secure` (HTTPS). Por defecto `true`; desactívalo solo en desarrollo local. */
  secureCookies?: boolean;
  /** Duración de las sesiones. Por defecto 8 h. */
  sessionTtlMs?: number;
  cookieName?: string;
  /** Intentos de login fallidos antes de bloquear. Por defecto 5 cada 15 min (por IP y por email). */
  loginRateLimit?: { max: number; windowMs: number };
  /** Vida de los tokens de impersonación. Por defecto 60 s. */
  impersonationTtlSeconds?: number;
  /** URL que abre la sesión impersonada en la app del tenant. */
  impersonationUrl?: (input: { tenantId: string; domain: string | null; token: string }) => string;
  /** Columnas que el explorador de datos oculta. */
  maskedColumns?: RegExp;
  /** Tamaño máximo del body. Por defecto 1 MiB. */
  bodyLimitBytes?: number;
  /** Tamaño máximo del logo que se sube desde el editor de tema. Por defecto 2 MiB. */
  logoMaxBytes?: number;
  /** `/openapi.json` sin autenticación. Por defecto `true`. */
  publicDocs?: boolean;
  /** Nombre en la app de autenticación (2FA). Por defecto `tenancy-node`. */
  issuer?: string;
  /**
   * Servir la interfaz del panel en el prefijo sin `/api` (`/admin`). `true` usa
   * `@tenancy-node/admin-ui`; o la ruta de una UI compilada. Por defecto no se sirve.
   */
  ui?: boolean | string;
  /**
   * Detrás de un proxy (nginx, un balanceador), toma la IP del cliente de `X-Forwarded-For`
   * para el límite de intentos de login y la auditoría. `true` confía en todo el encabezado
   * (usa la primera IP); un número, en esa cantidad de proxies (cuenta desde la derecha).
   * Por defecto `false`: la IP es la del socket. Actívalo solo si el panel no es accesible
   * sin pasar por el proxy, porque el encabezado lo puede escribir cualquiera.
   */
  trustProxy?: boolean | number;
  /**
   * Campos de `tenant.data` que pide el formulario "Nuevo tenant" (por ejemplo el email del
   * administrador inicial, que después lee el `seed`). Además se pueden cargar datos libres.
   */
  tenantFields?: readonly TenantField[];
  /** Usuarios de la app en cada tenant: el panel los lista, los crea y entra como ellos. */
  tenantUsers?: TenantUsersAdapter;
  /** IP del cliente a mano (por ejemplo `req.ip` de Express). Tiene prioridad sobre `trustProxy`. */
  clientIp?: (req: IncomingMessage) => string | null | undefined;
  /**
   * Formulario público "Solicitar demo" de la web comercial: `POST <prefix>/leads` sin sesión.
   * Por defecto apagado (el panel igual lista y gestiona las solicitudes que crees con
   * `admin.leads.create()`). Cada solicitud publica el evento `lead.created`.
   */
  leads?: boolean | LeadsOptions;
}

export interface LeadsOptions {
  /** Envíos por IP. Por defecto 5 por hora. */
  rateLimit?: { max: number; windowMs: number };
  /** Exigir la casilla de consentimiento (`consent: true`). Por defecto `true`. */
  requireConsent?: boolean;
  /** Llaves extra aceptadas en `data` (máx. 20, valores de texto). Por defecto ninguna. */
  extraFields?: readonly string[];
}

export interface AdminContext {
  tenancy: AdminTenancy;
  central: CentralAccess;
  users: AdminUsers;
  sessions: AdminSessions;
  audit: AuditLog;
  limiter: RateLimiter;
  leads: Leads;
  options: Required<
    Omit<
      AdminOptions,
      | 'impersonationUrl'
      | 'allowedHosts'
      | 'ui'
      | 'clientIp'
      | 'trustProxy'
      | 'tenantFields'
      | 'tenantUsers'
      | 'leads'
    >
  > & {
    leads: Required<LeadsOptions> | null;
    impersonationUrl: AdminOptions['impersonationUrl'] | undefined;
    allowedHosts: readonly string[];
    tenantFields: readonly TenantField[];
    tenantUsers: TenantUsersAdapter | undefined;
  };
  /** Registra una acción del usuario autenticado en la auditoría. */
  record(request: AdminRequest, input: Omit<AuditInput, 'adminUserId' | 'ip'>): Promise<void>;
}
