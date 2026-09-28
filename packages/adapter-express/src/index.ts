import {
  errorResponseBody,
  errorTenantId,
  httpStatusFor,
  isTenancyError,
  requestLikeFromNode,
  type Tenancy,
  type Tenant,
} from '@tenancy-node/core';
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';

/**
 * Ruta completa sin query. `req.path` es relativo al punto de montaje (`app.use('/api', ...)`),
 * así que las rutas de tenancy y el log usan siempre `req.originalUrl`.
 */
function fullPath(req: Request): string {
  return (req.originalUrl || req.url).split('?', 1)[0]!;
}

async function sendRoute(tenancy: Tenancy, req: Request, res: Response): Promise<boolean> {
  const response = await tenancy.http.handle({
    method: req.method,
    path: fullPath(req),
    headers: req.headers,
  });
  if (!response) return false;
  res.status(response.status).set(response.headers);
  res.end(typeof response.body === 'string' ? response.body : Buffer.from(response.body));
  return true;
}

export interface TenancyMiddlewareOptions {
  /** Qué hacer si la petición no pertenece a ningún tenant ni a un dominio central. Por defecto `'error'` (404). */
  onUnidentified?: 'error' | 'central';
  /** Confiar en `X-Forwarded-Host`. Úsalo solo detrás de tu propio proxy. */
  trustProxy?: boolean;
  /** Peticiones que no pasan por tenancy (por ejemplo, `/health`). */
  skip?: (req: Request) => boolean;
  /** Escribir una línea de log por petición con `tenantId`, ruta, código y duración. Por defecto `true`. */
  logRequests?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Tenant de la petición; `null` en el contexto central. */
      tenant?: Tenant | null;
    }
  }
}

function logContext(req: Request) {
  return {
    tenantId: req.tenant?.id.value ?? null,
    method: req.method,
    path: fullPath(req),
    host: req.headers.host,
    // Solo se conoce después del router; en el middleware queda `undefined`.
    route: req.route ? `${req.baseUrl}${String((req.route as { path: unknown }).path)}` : undefined,
    ...(typeof req.headers['x-request-id'] === 'string'
      ? { requestId: req.headers['x-request-id'] }
      : {}),
  };
}

/**
 * Middleware de Express: identifica el tenant y ejecuta el resto de la cadena en su contexto.
 *
 * Móntalo **después** de los body parsers (`express.json()`), porque leer el body
 * con eventos del stream pierde el contexto asíncrono.
 */
export function tenancyMiddleware(
  tenancy: Tenancy,
  options: TenancyMiddlewareOptions = {},
): RequestHandler {
  const logRequests = options.logRequests ?? true;
  return (req, res, next) => {
    if (options.skip?.(req)) return next();
    const started = performance.now();
    const log = () => {
      if (!logRequests) return;
      tenancy.logRequest({
        ...logContext(req),
        statusCode: res.writableFinished ? res.statusCode : 499,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      });
    };
    // /tenancy/health responde en cualquier host, antes de identificar al tenant.
    if (tenancy.http.isHealth(req.method, fullPath(req))) {
      res.once('close', log);
      sendRoute(tenancy, req, res).catch(next);
      return;
    }
    tenancy
      .openRequestScope(requestLikeFromNode(req, { trustProxy: options.trustProxy ?? false }), {
        onUnidentified: options.onUnidentified ?? 'error',
      })
      .then(
        (scope) => {
          req.tenant = scope.tenant;
          res.once('close', () => {
            log();
            void scope.close();
          });
          if (tenancy.http.matches(req.method, fullPath(req))) {
            scope.run(() => void sendRoute(tenancy, req, res).catch(next));
            return;
          }
          scope.run(() => next());
        },
        (error: unknown) => {
          if (logRequests) {
            tenancy.logRequest({
              ...logContext(req),
              tenantId: errorTenantId(error) ?? null,
              statusCode: httpStatusFor(error),
              durationMs: Math.round((performance.now() - started) * 100) / 100,
            });
          }
          res.status(httpStatusFor(error)).json(errorResponseBody(error));
        },
      );
  };
}

/**
 * Manejador de errores: registra cada error con su tenant y responde los errores del paquete
 * con su código HTTP. Los demás errores pasan al siguiente manejador.
 */
export function tenancyErrorHandler(tenancy: Tenancy): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    const status = httpStatusFor(error);
    tenancy.reportRequestError(error, { ...logContext(req), statusCode: status });
    if (!isTenancyError(error) || res.headersSent) return next(error);
    res.status(status).json(errorResponseBody(error));
  };
}
