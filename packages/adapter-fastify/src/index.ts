import {
  errorResponseBody,
  errorTenantId,
  httpStatusFor,
  isTenancyError,
  requestLikeFromNode,
  type Tenancy,
  type Tenant,
  type TenantScope,
} from '@tenancy-node/core';
import type { AsyncResource } from 'node:async_hooks';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

export interface TenancyPluginOptions {
  tenancy: Tenancy;
  /** Qué hacer si la petición no pertenece a ningún tenant ni a un dominio central. Por defecto `'error'` (404). */
  onUnidentified?: 'error' | 'central';
  /** Confiar en `X-Forwarded-Host`. Úsalo solo detrás de tu propio proxy. */
  trustProxy?: boolean;
  /** Peticiones que no pasan por tenancy (por ejemplo, `/health`). */
  skip?: (request: FastifyRequest) => boolean;
  /** Escribir una línea de log por petición con `tenantId`, ruta, código y duración. Por defecto `true`. */
  logRequests?: boolean;
  /**
   * Responder los errores del paquete (`TenancyError`) lanzados en las rutas con su código HTTP
   * y el mismo cuerpo que los demás adaptadores. Por defecto `true`. Un `setErrorHandler` propio
   * siempre manda: si lo registras (antes o después del plugin), este no se usa.
   */
  errorHandler?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Tenant de la petición; `null` en el contexto central. */
    tenant: Tenant | null;
  }
}

const kScope = Symbol('tenancy.scope');
const kResource = Symbol('tenancy.resource');
const kStarted = Symbol('tenancy.started');
const kErrorTenant = Symbol('tenancy.errorTenant');
const kError = Symbol('tenancy.error');

interface TenancyRequestState {
  [kScope]?: TenantScope;
  [kResource]?: AsyncResource;
  [kStarted]?: number;
  [kErrorTenant]?: string;
  [kError]?: { error: unknown };
}

const state = (request: FastifyRequest) => request as unknown as TenancyRequestState;

/**
 * Marca interna de Fastify que indica "ya hay un error handler en este scope". Se usa para que el
 * handler del plugin cuente como valor por defecto: un `setErrorHandler` posterior del usuario lo
 * reemplaza sin la advertencia FSTWRN004 (ni el error con `allowErrorHandlerOverride: false`).
 */
function errorHandlerFlag(instance: FastifyInstance): symbol | undefined {
  for (let o: object | null = instance; o; o = Object.getPrototypeOf(o) as object | null) {
    const flag = Object.getOwnPropertySymbols(o).find(
      (s) => s.description === 'fastify.errorHandlerAlreadySet',
    );
    if (flag) return flag;
  }
  return undefined;
}

/** Instala el error handler de tenancy salvo que el usuario ya tenga uno en este scope. */
function installErrorHandler(fastify: FastifyInstance): void {
  const flag = errorHandlerFlag(fastify);
  const flags = fastify as unknown as Record<symbol, boolean | undefined>;
  if (flag && flags[flag]) return;
  fastify.setErrorHandler((error, _request, reply) => {
    // Los errores ajenos al paquete siguen al handler padre (el de Fastify por defecto).
    if (!isTenancyError(error)) {
      reply.send(error);
      return;
    }
    void reply.code(httpStatusFor(error)).send(errorResponseBody(error));
  });
  if (flag) flags[flag] = false;
}

const plugin: FastifyPluginCallback<TenancyPluginOptions> = (fastify, options, done) => {
  const { tenancy } = options;
  const logRequests = options.logRequests ?? true;
  fastify.decorateRequest('tenant', null);
  if (options.errorHandler ?? true) installErrorHandler(fastify);

  const context = (request: FastifyRequest) => ({
    tenantId: request.tenant?.id.value ?? state(request)[kErrorTenant] ?? null,
    requestId: String(request.id),
    method: request.method,
    path: request.url.split('?', 1)[0]!,
    host: request.headers.host,
    route: request.routeOptions?.url,
  });

  const path = (request: FastifyRequest) => request.url.split('?', 1)[0]!;
  const sendRoute = async (request: FastifyRequest, reply: FastifyReply) => {
    const response = await tenancy.http.handle({
      method: request.method,
      path: path(request),
      headers: request.headers,
    });
    if (!response) return false;
    await reply
      .code(response.status)
      .headers(response.headers)
      .send(typeof response.body === 'string' ? response.body : Buffer.from(response.body));
    return true;
  };

  fastify.addHook('onRequest', (request, reply, next) => {
    if (options.skip?.(request)) return next();
    state(request)[kStarted] = performance.now();
    // /tenancy/health responde en cualquier host, antes de identificar al tenant.
    if (tenancy.http.isHealth(request.method, path(request))) {
      void sendRoute(request, reply);
      return;
    }
    tenancy
      .openRequestScope(
        requestLikeFromNode(request.raw, { trustProxy: options.trustProxy ?? false }),
        { onUnidentified: options.onUnidentified ?? 'error' },
      )
      .then(
        (scope) => {
          request.tenant = scope.tenant;
          state(request)[kScope] = scope;
          state(request)[kResource] = scope.bind();
          if (tenancy.http.matches(request.method, path(request))) {
            scope.run(
              () => void sendRoute(request, reply).catch((error: unknown) => reply.send(error)),
            );
            return;
          }
          // Todo lo que sigue en la cadena de Fastify corre dentro del contexto del tenant.
          scope.run(() => next());
        },
        (error: unknown) => {
          // tenancy.resolve ya dejó el error registrado con su tenant.
          const tenantId = errorTenantId(error);
          if (tenantId) state(request)[kErrorTenant] = tenantId;
          void reply.code(httpStatusFor(error)).send(errorResponseBody(error));
        },
      );
  });

  // Leer el body usa eventos del stream, que pierden el contexto: se restaura antes de validar y del handler.
  const restore = (request: FastifyRequest, _reply: unknown, next: () => void) => {
    const resource = state(request)[kResource];
    if (resource) resource.runInAsyncScope(next);
    else next();
  };
  fastify.addHook('preValidation', restore);
  fastify.addHook('preHandler', restore);

  // onError corre antes del error handler (el nuestro o el del usuario), cuando el código de la
  // respuesta todavía no está fijado: el error se guarda y se registra en onResponse con el código enviado.
  fastify.addHook('onError', (request, _reply, error, next) => {
    state(request)[kError] = { error };
    next();
  });

  const finish = async (request: FastifyRequest, statusCode: number) => {
    const s = state(request);
    const scope = s[kScope];
    if (s[kError]) {
      tenancy.reportRequestError(s[kError].error, { ...context(request), statusCode });
      delete s[kError];
    }
    if (logRequests && s[kStarted] !== undefined) {
      tenancy.logRequest({
        ...context(request),
        statusCode,
        durationMs: Math.round((performance.now() - s[kStarted]) * 100) / 100,
      });
      delete s[kStarted];
    }
    if (scope) await scope.close();
  };
  fastify.addHook('onResponse', (request, reply) => finish(request, reply.statusCode));
  fastify.addHook('onRequestAbort', (request) => finish(request, 499));

  done();
};

/** Plugin de Fastify: identifica el tenant de cada petición y abre su contexto. */
export const tenancyPlugin = fp(plugin, { name: '@tenancy-node/adapter-fastify', fastify: '5.x' });
export default tenancyPlugin;
