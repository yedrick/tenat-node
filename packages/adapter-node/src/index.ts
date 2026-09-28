import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  errorResponseBody,
  errorTenantId,
  httpStatusFor,
  requestLikeFromNode,
  type Tenancy,
  type Tenant,
} from '@tenancy-node/core';

export interface WithTenancyOptions {
  /** Qué hacer si la petición no pertenece a ningún tenant ni a un dominio central. Por defecto `'error'` (404). */
  onUnidentified?: 'error' | 'central';
  /** Confiar en `X-Forwarded-Host`. Úsalo solo detrás de tu propio proxy. */
  trustProxy?: boolean;
  /** Escribir una línea de log por petición con `tenantId`, ruta, código y duración. Por defecto `true`. */
  logRequests?: boolean;
}

export type TenancyRequest = IncomingMessage & { tenant: Tenant | null };

export type TenancyHandler = (req: TenancyRequest, res: ServerResponse) => void | Promise<void>;

/**
 * Envuelve un handler de `node:http`: identifica el tenant, ejecuta el handler en su contexto
 * y responde los errores con su código HTTP (y los deja en el log con su tenant).
 */
export function withTenancy(
  tenancy: Tenancy,
  handler: TenancyHandler,
  options: WithTenancyOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const logRequests = options.logRequests ?? true;

  return (req, res) => {
    const started = performance.now();
    const request = requestLikeFromNode(req, { trustProxy: options.trustProxy ?? false });
    const tenantReq = req as TenancyRequest;
    tenantReq.tenant = null;
    let errorTenant: string | undefined;
    const context = () => ({
      tenantId: tenantReq.tenant?.id.value ?? errorTenant ?? null,
      method: req.method ?? 'GET',
      path: request.path ?? '/',
      host: request.host,
    });

    const fail = (error: unknown, report: boolean) => {
      if (report)
        tenancy.reportRequestError(error, { ...context(), statusCode: httpStatusFor(error) });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(httpStatusFor(error), { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(errorResponseBody(error)));
    };

    res.once('close', () => {
      if (!logRequests) return;
      tenancy.logRequest({
        ...context(),
        statusCode: res.writableFinished ? res.statusCode : 499,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      });
    });

    const route = async (): Promise<boolean> => {
      const response = await tenancy.http.handle({
        method: req.method ?? 'GET',
        path: request.path ?? '/',
        headers: req.headers,
      });
      if (!response) return false;
      res.writeHead(response.status, response.headers);
      res.end(typeof response.body === 'string' ? response.body : Buffer.from(response.body));
      return true;
    };
    // /tenancy/health responde en cualquier host, antes de identificar al tenant.
    if (tenancy.http.isHealth(req.method ?? 'GET', request.path ?? '/')) {
      route().catch((error: unknown) => fail(error, true));
      return;
    }

    tenancy.openRequestScope(request, { onUnidentified: options.onUnidentified ?? 'error' }).then(
      (scope) => {
        tenantReq.tenant = scope.tenant;
        res.once('close', () => void scope.close());
        return scope
          .run(async () => {
            if (await route()) return;
            await handler(tenantReq, res);
          })
          .catch((error: unknown) => fail(error, true));
      },
      (error: unknown) => {
        errorTenant = errorTenantId(error);
        fail(error, false);
      },
    );
  };
}
