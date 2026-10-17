import type { IncomingMessage } from 'node:http';
import { TenancyError } from '../domain/index.js';
import type { RequestLike } from '../ports/index.js';

const STATUS_BY_CODE: Record<string, number> = {
  TENANCY_TENANT_NOT_FOUND: 404,
  TENANCY_TENANT_NOT_IDENTIFIED: 404,
  TENANCY_DOMAIN_NOT_FOUND: 404,
  TENANCY_TENANT_ALREADY_EXISTS: 409,
  TENANCY_DOMAIN_TAKEN: 409,
  TENANCY_INVALID_STATUS_TRANSITION: 409,
  TENANCY_TENANT_SUSPENDED: 423,
  TENANCY_TENANT_IN_MAINTENANCE: 503,
  TENANCY_TENANT_NOT_READY: 503,
  TENANCY_INVALID_TENANT_ID: 422,
  TENANCY_INVALID_DOMAIN: 422,
  TENANCY_INVALID_COLOR: 422,
  TENANCY_INVALID_THEME: 422,
  TENANCY_INVALID_TENANT_DATA: 422,
  TENANCY_INVALID_NOTIFICATION: 422,
  TENANCY_INVALID_BILLING: 422,
  TENANCY_INVALID_PLAN: 422,
  TENANCY_PLAN_NOT_FOUND: 404,
  TENANCY_PLAN_CONFLICT: 409,
  TENANCY_INVALID_PLATFORM: 422,
  TENANCY_BILLING_NOT_FOUND: 404,
  TENANCY_BILLING_CONFLICT: 409,
  TENANCY_BILLING_NO_PROVIDER: 422,
  TENANCY_NOTIFICATION_NOT_FOUND: 404,
  TENANCY_FEATURE_NOT_IN_PLAN: 403,
  TENANCY_PLAN_LIMIT_REACHED: 403,
};

/** Errores cuyos detalles (módulo, límite, plan) van en la respuesta: el frontend los muestra. */
const PUBLIC_DETAILS = new Set(['TENANCY_FEATURE_NOT_IN_PLAN', 'TENANCY_PLAN_LIMIT_REACHED']);

export function isTenancyError(error: unknown): error is TenancyError {
  return error instanceof TenancyError;
}

/** Código HTTP para un error. Lo usan todos los adaptadores. */
export function httpStatusFor(error: unknown): number {
  return isTenancyError(error) ? (STATUS_BY_CODE[error.code] ?? 500) : 500;
}

export interface ErrorResponseBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** Cuerpo JSON de error. Los errores que no son del paquete no filtran su mensaje. */
export function errorResponseBody(error: unknown): ErrorResponseBody {
  if (isTenancyError(error) && httpStatusFor(error) < 500) {
    return PUBLIC_DETAILS.has(error.code)
      ? { error: { code: error.code, message: error.message, details: { ...error.details } } }
      : { error: { code: error.code, message: error.message } };
  }
  if (isTenancyError(error) && STATUS_BY_CODE[error.code] === 503) {
    return { error: { code: error.code, message: error.message } };
  }
  return { error: { code: 'TENANCY_INTERNAL_ERROR', message: 'Internal Server Error' } };
}

export interface NodeRequestOptions {
  /** Confiar en `X-Forwarded-Host` (solo detrás de un proxy propio). */
  trustProxy?: boolean;
}

/** Convierte un `IncomingMessage` de node:http en un `RequestLike`. */
export function requestLikeFromNode(
  req: IncomingMessage,
  options: NodeRequestOptions = {},
): RequestLike {
  const forwarded = options.trustProxy ? firstHeader(req.headers['x-forwarded-host']) : undefined;
  const url = req.url ?? '/';
  const query = url.indexOf('?');
  return {
    host: forwarded?.split(',')[0]?.trim() ?? req.headers.host,
    path: query >= 0 ? url.slice(0, query) : url,
    headers: req.headers,
  };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
