import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorResponseBody, httpStatusFor, isTenancyError } from '@tenancy-node/core';
import * as v from 'valibot';
import type { Permission } from './auth/permissions.js';
import type { AdminUser } from './auth/users.js';

export class AdminHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AdminHttpError';
  }
}

export interface AdminRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  headers: IncomingMessage['headers'];
  ip: string | null;
  /** Usuario autenticado (rutas con permiso). */
  user: AdminUser | null;
  /** Id de la sesión (hash), para CSRF y logout. */
  sessionId: string | null;
  raw: IncomingMessage;
  res: ServerResponse;
}

export interface JsonResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RouteDefinition<TBody = unknown> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** `/tenants/:id/domains` */
  path: string;
  /** `null` = pública (login, health). */
  permission: Permission | null;
  summary: string;
  tag: string;
  body?: v.GenericSchema<unknown, TBody>;
  /** Parámetros de query documentados. */
  query?: Record<string, string>;
  /** La ruta escribe ella misma la respuesta (SSE). */
  streaming?: boolean;
  handler(request: AdminRequest & { body: TBody }): Promise<JsonResponse | void>;
}

export function route<TBody>(definition: RouteDefinition<TBody>): RouteDefinition<unknown> {
  return definition as unknown as RouteDefinition<unknown>;
}

interface CompiledRoute {
  definition: RouteDefinition;
  pattern: RegExp;
  keys: string[];
}

export function compile(definition: RouteDefinition): CompiledRoute {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${definition.path.replace(/\//g, '\\/').replace(/:([a-zA-Z]+)/g, (_, key: string) => {
      keys.push(key);
      return '([^/]+)';
    })}$`,
  );
  return { definition, pattern, keys };
}

export function match(routes: readonly CompiledRoute[], method: string, path: string) {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.pattern.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (r.definition.method !== method) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((key, i) => (params[key] = decodeURIComponent(m[i + 1]!)));
    return { route: r, params, pathMatched };
  }
  return { route: undefined, params: {}, pathMatched };
}

/** Lee el cuerpo JSON con un límite de tamaño. */
export function readJson(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  // Un body parser anterior (`express.json()`, `express.text()`...) ya leyó el stream: esperar
  // 'end' colgaría la petición para siempre. Se usa lo que ese parser dejó en `req.body`.
  if (req.readableEnded) return new Promise((resolve) => resolve(parsedBody(req)));
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] ?? '';
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limitBytes) {
        // Se deja de guardar, se responde 413 y la conexión se cierra después de la respuesta.
        tooLarge = true;
        chunks.length = 0;
        reject(
          new AdminHttpError(
            413,
            'ADMIN_PAYLOAD_TOO_LARGE',
            `Body larger than ${limitBytes} bytes`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (chunks.length === 0) return resolve(undefined);
      if (!type.includes('application/json')) {
        return reject(
          new AdminHttpError(
            415,
            'ADMIN_UNSUPPORTED_MEDIA_TYPE',
            'Use Content-Type: application/json',
          ),
        );
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new AdminHttpError(400, 'ADMIN_INVALID_JSON', 'The body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parsedBody(req: IncomingMessage): unknown {
  const body = (req as IncomingMessage & { body?: unknown }).body;
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) return body;
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new AdminHttpError(400, 'ADMIN_INVALID_JSON', 'The body is not valid JSON');
  }
}

export function validate<T>(schema: v.GenericSchema<unknown, T>, value: unknown): T {
  const result = v.safeParse(schema, value);
  if (result.success) return result.output;
  throw new AdminHttpError(
    422,
    'ADMIN_VALIDATION_FAILED',
    'Invalid request body',
    result.issues.map((i) => ({ path: v.getDotPath(i) ?? '', message: i.message })),
  );
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  const text =
    body === undefined
      ? ''
      : JSON.stringify(body, (_k, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        );
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(text ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(text);
}

/** Convierte cualquier error en `{ status, body }` sin filtrar detalles internos. */
export function errorToResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof AdminHttpError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }
  // Falta `encryptionKey`: es configuración del servidor, no un fallo interno. 501 con el mensaje
  // claro (2FA y webhooks cifran sus secretos); sigue siendo >= 500, así que queda en el log.
  if (isTenancyError(error) && error.code === 'TENANCY_ENCRYPTION_KEY_MISSING')
    return { status: 501, body: { error: { code: error.code, message: error.message } } };
  if (isTenancyError(error))
    return { status: httpStatusFor(error), body: errorResponseBody(error) };
  return {
    status: 500,
    body: { error: { code: 'ADMIN_INTERNAL_ERROR', message: 'Internal Server Error' } },
  };
}
