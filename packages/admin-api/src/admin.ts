import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostnameOf, InvalidConfigError, type Tenancy } from '@tenancy-node/core';
import type { DatabaseExtension } from '@tenancy-node/db';
import { toJsonSchema } from '@valibot/to-json-schema';
import { AuditLog } from './audit.js';
import { can } from './auth/permissions.js';
import { RateLimiter } from './auth/rate-limit.js';
import { AdminSessions } from './auth/sessions.js';
import { AdminUsers } from './auth/users.js';
import type { AdminContext, AdminOptions, AdminTenancy } from './context.js';
import {
  AdminHttpError,
  compile,
  errorToResponse,
  match,
  readJson,
  sendJson,
  validate,
  type AdminRequest,
  type RouteDefinition,
} from './http.js';
import { authRoutes } from './routes/auth.js';
import { eventRoutes, systemRoutes } from './routes/system.js';
import { tenantRoutes } from './routes/tenants.js';
import { resolveUiRoot, serveUi } from './ui.js';

const UI_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

export interface AdminApi {
  /** Ruta de la interfaz (`/admin`) si se sirve. */
  readonly uiPath: string | undefined;
  /**
   * Atiende la petición si su ruta empieza con el prefijo. Devuelve `false` si no es del panel
   * (así se puede usar como middleware: `if (!(await admin.handle(req, res))) next()`).
   */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Documento OpenAPI 3.1 de la API. */
  openapi(): Record<string, unknown>;
  readonly prefix: string;
  /** Contexto interno (usuarios, auditoría): lo usa el CLI (`tenancy admin:user`). */
  readonly context: AdminContext;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

/** Crea la Admin API. Requiere el plugin de base de datos (usa las tablas `tenancy_admin_*`). */
export function createAdminApi(tenancy: Tenancy, options: AdminOptions): AdminApi {
  const t = tenancy as AdminTenancy & Partial<DatabaseExtension>;
  if (!t.database)
    throw new InvalidConfigError('The admin API needs the database plugin (@tenancy-node/db)');
  if (!options.sessionSecret || options.sessionSecret.length < 32) {
    throw new InvalidConfigError('admin sessionSecret must have at least 32 characters');
  }
  const central = t.database.central();
  const resolved: AdminContext['options'] = {
    sessionSecret: options.sessionSecret,
    prefix: (options.prefix ?? '/admin/api').replace(/\/+$/, ''),
    allowedHosts: options.allowedHosts ?? [
      ...tenancy.centralDomains,
      'localhost',
      '127.0.0.1',
      '::1',
    ],
    secureCookies: options.secureCookies ?? true,
    sessionTtlMs: options.sessionTtlMs ?? 8 * 3_600_000,
    cookieName: options.cookieName ?? 'tenancy_admin',
    loginRateLimit: options.loginRateLimit ?? { max: 5, windowMs: 15 * 60_000 },
    impersonationTtlSeconds: options.impersonationTtlSeconds ?? 60,
    impersonationUrl: options.impersonationUrl,
    maskedColumns: options.maskedColumns ?? /(password|secret|token|hash|salt|api_?key|otp|2fa)/i,
    bodyLimitBytes: options.bodyLimitBytes ?? 1024 * 1024,
    publicDocs: options.publicDocs ?? true,
    issuer: options.issuer ?? 'tenancy-node',
  };
  const audit = new AuditLog(central);
  const context: AdminContext = {
    tenancy: t as AdminTenancy,
    central,
    users: new AdminUsers(central),
    sessions: new AdminSessions(central, options.sessionSecret, resolved.sessionTtlMs),
    audit,
    limiter: new RateLimiter(resolved.loginRateLimit.max, resolved.loginRateLimit.windowMs),
    options: resolved,
    record: (request, input) =>
      audit.record({ ...input, adminUserId: request.user?.id ?? null, ip: request.ip }),
  };

  const definitions: RouteDefinition[] = [
    ...authRoutes(context),
    ...tenantRoutes(context),
    ...eventRoutes(context),
    ...systemRoutes(context),
  ];
  const openapi = () => buildOpenApi(definitions, resolved.prefix);
  definitions.push({
    method: 'GET',
    path: '/openapi.json',
    permission: resolved.publicDocs ? null : 'self',
    tag: 'system',
    summary: 'Esta especificación OpenAPI',
    handler: async () => ({ body: openapi() }),
  });
  const routes = definitions.map(compile);
  const allowedHosts = new Set(resolved.allowedHosts.map((h) => h.toLowerCase()));
  const logger = tenancy.observability.logger;

  const uiRoot = options.ui ? resolveUiRoot(options.ui === true ? true : options.ui) : undefined;
  const uiBase = resolved.prefix.replace(/\/api$/, '') || '/admin';

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://admin.local');
    const isApi =
      url.pathname === resolved.prefix || url.pathname.startsWith(`${resolved.prefix}/`);
    if (
      !isApi &&
      uiRoot &&
      (url.pathname === uiBase || url.pathname.startsWith(`${uiBase}/`)) &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      const host = hostnameOf(req.headers.host);
      if (!host || !allowedHosts.has(host)) {
        sendJson(res, 404, { error: { code: 'ADMIN_NOT_FOUND', message: 'Not found' } });
        return true;
      }
      serveUi(uiRoot, uiBase, req, res, UI_HEADERS);
      return true;
    }
    if (!isApi) return false;
    const started = performance.now();
    const method = req.method ?? 'GET';
    const path = url.pathname.slice(resolved.prefix.length) || '/';
    const request: AdminRequest = {
      method,
      path,
      params: {},
      query: url.searchParams,
      body: undefined,
      headers: req.headers,
      ip: req.socket.remoteAddress ?? null,
      user: null,
      sessionId: null,
      raw: req,
      res,
    };
    let routePath = path;
    let status = 500;
    try {
      // El panel solo responde en los dominios centrales, nunca en el de un tenant.
      const host = hostnameOf(req.headers.host);
      if (!host || !allowedHosts.has(host))
        throw new AdminHttpError(404, 'ADMIN_NOT_FOUND', 'Not found');

      const found = match(routes, method, path);
      if (!found.route) {
        throw found.pathMatched
          ? new AdminHttpError(405, 'ADMIN_METHOD_NOT_ALLOWED', `${method} is not allowed here`)
          : new AdminHttpError(404, 'ADMIN_NOT_FOUND', 'Not found');
      }
      const definition = found.route.definition;
      routePath = definition.path;
      request.params = found.params;

      if (definition.permission) {
        const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
        const fromCookie = cookieValue(req.headers.cookie, resolved.cookieName);
        const session = await context.sessions.resolve(bearer ?? fromCookie ?? '');
        if (!session) throw new AdminHttpError(401, 'ADMIN_UNAUTHENTICATED', 'Login required');
        request.user = session.user;
        request.sessionId = session.sessionId;
        if (!can(session.user.role, definition.permission)) {
          throw new AdminHttpError(
            403,
            'ADMIN_FORBIDDEN',
            `Your role (${session.user.role}) cannot do this (${definition.permission})`,
          );
        }
        // CSRF: con cookie, toda petición que cambia algo debe traer el token de la sesión.
        if (
          !bearer &&
          method !== 'GET' &&
          !context.sessions.verifyCsrf(
            session.sessionId,
            req.headers['x-csrf-token'] as string | undefined,
          )
        ) {
          throw new AdminHttpError(403, 'ADMIN_CSRF', 'Missing or invalid X-CSRF-Token header');
        }
      }

      if (method !== 'GET' && method !== 'HEAD') {
        const raw = await readJson(req, resolved.bodyLimitBytes);
        request.body = definition.body ? validate(definition.body, raw) : raw;
      }

      const response = await definition.handler(request);
      if (definition.streaming) {
        status = 200;
      } else {
        status = response?.status ?? 200;
        const headers = { ...response?.headers };
        if (status === 429)
          headers['retry-after'] = String(
            (response?.body as { retryAfter?: number })?.retryAfter ?? 60,
          );
        sendJson(res, status, response?.body, headers);
      }
    } catch (error) {
      const { status: code, body } = errorToResponse(error);
      status = code;
      const headers: Record<string, string> = {};
      if (code === 413) {
        headers.connection = 'close';
        res.once('finish', () => req.socket.destroy());
      }
      if (error instanceof AdminHttpError && code === 429)
        headers['retry-after'] = String(
          (error.details as { retryAfter?: number })?.retryAfter ?? 60,
        );
      sendJson(res, code, body, headers);
      if (code >= 500) {
        tenancy.observability.report('admin.request', error, {
          tenantId: request.params.id ?? null,
          method,
          path: routePath,
          adminUserId: request.user?.id ?? null,
        });
      }
    } finally {
      const fields = {
        tenantId: request.params.id ?? null,
        operation: 'admin.request',
        method,
        path: routePath,
        statusCode: status,
        adminUserId: request.user?.id ?? null,
        durationMs: Math.round(performance.now() - started),
      };
      if (status >= 500) logger.error(fields, `admin ${method} ${routePath} ${status}`);
      else if (status >= 400) logger.warn(fields, `admin ${method} ${routePath} ${status}`);
      else logger.info(fields, `admin ${method} ${routePath} ${status}`);
    }
    return true;
  };

  return { handle, openapi, prefix: resolved.prefix, context, uiPath: uiRoot ? uiBase : undefined };
}

function buildOpenApi(
  definitions: readonly RouteDefinition[],
  prefix: string,
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const d of definitions) {
    const openPath = prefix + d.path.replace(/:([a-zA-Z]+)/g, '{$1}');
    const params = [...d.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const query = Object.entries(d.query ?? {}).map(([name, description]) => ({
      name,
      in: 'query',
      required: false,
      description,
      schema: { type: 'string' },
    }));
    let schema: unknown;
    if (d.body) {
      try {
        schema = toJsonSchema(d.body, { errorMode: 'ignore' });
      } catch {
        schema = { type: 'object' };
      }
    }
    (paths[openPath] ??= {})[d.method.toLowerCase()] = {
      summary: d.summary,
      tags: [d.tag],
      ...(d.permission
        ? {
            security: [{ cookieAuth: [], csrf: [] }, { bearerAuth: [] }],
            'x-permission': d.permission,
          }
        : { security: [] }),
      ...(params.length + query.length > 0 ? { parameters: [...params, ...query] } : {}),
      ...(schema
        ? { requestBody: { required: true, content: { 'application/json': { schema } } } }
        : {}),
      responses: d.streaming
        ? { '200': { description: 'text/event-stream' } }
        : {
            '200': { description: 'OK', content: { 'application/json': {} } },
            ...(d.permission
              ? {
                  '401': { description: 'Sin sesión' },
                  '403': { description: 'Sin permiso o sin token CSRF' },
                }
              : {}),
            ...(d.body ? { '422': { description: 'Body inválido' } } : {}),
          },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'tenancy-node Admin API',
      version: '1.0.0',
      description: 'API del panel de administración de tenancy-node.',
    },
    paths,
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'tenancy_admin' },
        csrf: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
  };
}

export interface ServeAdminOptions extends AdminOptions {
  port?: number;
  /** Por defecto `127.0.0.1`: el panel no queda expuesto; se entra por VPN o túnel SSH. */
  host?: string;
}

/** Levanta la Admin API en su propio proceso y puerto (recomendado en producción). */
export async function serveAdmin(
  tenancy: Tenancy,
  options: ServeAdminOptions,
): Promise<{ server: Server; url: string; api: AdminApi; close(): Promise<void> }> {
  const api = createAdminApi(tenancy, options);
  const server = createServer((req, res) => {
    void api.handle(req, res).then((handled) => {
      if (!handled)
        sendJson(res, 404, { error: { code: 'ADMIN_NOT_FOUND', message: 'Not found' } });
    });
  });
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port ?? 4000, host, resolve));
  const address = server.address() as { port: number };
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}${api.prefix}`;
  tenancy.observability.logger.info(
    { tenantId: null, operation: 'admin.serve', url },
    `Admin API listening on ${url}`,
  );
  // Limpieza periódica de sesiones vencidas
  const timer = setInterval(
    () => void api.context.sessions.purgeExpired().catch(() => undefined),
    3_600_000,
  );
  timer.unref();
  return {
    server,
    url,
    api,
    close: () =>
      new Promise((resolve) => {
        clearInterval(timer);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
