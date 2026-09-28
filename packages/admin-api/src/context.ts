import type { Tenancy } from '@tenancy-node/core';
import type { CentralAccess, DatabaseExtension } from '@tenancy-node/db';
import type { OutboxApi } from '@tenancy-node/outbox';
import type { WebhooksApi } from '@tenancy-node/transport-webhook';
import type { AuditInput, AuditLog } from './audit.js';
import type { RateLimiter } from './auth/rate-limit.js';
import type { AdminSessions } from './auth/sessions.js';
import type { AdminUsers } from './auth/users.js';
import type { AdminRequest } from './http.js';

export type AdminTenancy = Tenancy &
  DatabaseExtension & { outbox?: OutboxApi; webhooks?: WebhooksApi };

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
  /** `/openapi.json` sin autenticación. Por defecto `true`. */
  publicDocs?: boolean;
  /** Nombre en la app de autenticación (2FA). Por defecto `tenancy-node`. */
  issuer?: string;
  /**
   * Servir la interfaz del panel en el prefijo sin `/api` (`/admin`). `true` usa
   * `@tenancy-node/admin-ui`; o la ruta de una UI compilada. Por defecto no se sirve.
   */
  ui?: boolean | string;
}

export interface AdminContext {
  tenancy: AdminTenancy;
  central: CentralAccess;
  users: AdminUsers;
  sessions: AdminSessions;
  audit: AuditLog;
  limiter: RateLimiter;
  options: Required<Omit<AdminOptions, 'impersonationUrl' | 'allowedHosts' | 'ui'>> & {
    impersonationUrl: AdminOptions['impersonationUrl'] | undefined;
    allowedHosts: readonly string[];
  };
  /** Registra una acción del usuario autenticado en la auditoría. */
  record(request: AdminRequest, input: Omit<AuditInput, 'adminUserId' | 'ip'>): Promise<void>;
}
