import { createHash } from 'node:crypto';
import type { Tenant } from '../domain/index.js';
import { InvalidStoragePathError, type TenantStorage } from '../storage/tenant-storage.js';

export interface HttpRoutesOptions {
  /** `GET /tenancy/me`: datos públicos del tenant actual. */
  me?: boolean;
  /** `GET /tenancy/theme.css`: variables CSS del tema. */
  theme?: boolean;
  /** `GET /tenancy/assets/*`: archivos del tenant con los drivers `local` y `memory` (con S3 las URLs apuntan al bucket). */
  assets?: boolean;
  /** `GET /tenancy/health`: estado de la base central, caché, cola y almacenamiento. */
  health?: boolean;
  /** Prefijo de las rutas. Por defecto `/tenancy`. */
  prefix?: string;
  /** `Cache-Control` de theme.css, me y assets. Por defecto `public, max-age=300`. */
  cacheControl?: string;
}

export interface HttpRequestLike {
  method: string;
  path: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

export interface HealthReport {
  status: 'ok' | 'error';
  checks: Record<string, { ok: boolean; durationMs: number; error?: string }>;
}

/** Lo que las rutas necesitan del facade (sin depender de la clase concreta). */
export interface RoutesHost {
  current(): Tenant | undefined;
  theme(): {
    toCss(): string;
    etag(): string;
    toJson(): object;
    logoUrl(): Promise<string | undefined>;
  };
  storage(): TenantStorage;
  health(): Promise<HealthReport>;
  storageDriverName(): string;
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

const TENANT_FIELDS = new Set(['name', 'plan', 'status']);

/**
 * Rutas HTTP opcionales, independientes del framework: devuelven `{ status, headers, body }`
 * y cada adaptador (Fastify, Express, node:http) solo las conecta. Todas apagadas por defecto.
 */
export class TenancyHttpRoutes {
  readonly prefix: string;
  private readonly cacheControl: string;

  constructor(
    private readonly host: RoutesHost,
    private readonly options: HttpRoutesOptions,
    private readonly publicFields: readonly string[],
  ) {
    this.prefix = (options.prefix ?? '/tenancy').replace(/\/+$/, '');
    this.cacheControl = options.cacheControl ?? 'public, max-age=300';
  }

  get enabled(): boolean {
    return Boolean(
      this.options.me || this.options.theme || this.options.assets || this.options.health,
    );
  }

  /** `true` para la ruta de health (GET o HEAD): responde en cualquier host, antes de identificar al tenant. */
  isHealth(method: string, path: string): boolean {
    return (
      Boolean(this.options.health) &&
      (method === 'GET' || method === 'HEAD') &&
      path === `${this.prefix}/health`
    );
  }

  /** `true` si la ruta es de tenancy y está activada. */
  matches(method: string, path: string): boolean {
    if (method !== 'GET' && method !== 'HEAD') return false;
    if (this.isHealth('GET', path)) return true;
    if (this.options.me && path === `${this.prefix}/me`) return true;
    if (this.options.theme && path === `${this.prefix}/theme.css`) return true;
    return Boolean(this.options.assets) && path.startsWith(`${this.prefix}/assets/`);
  }

  /** Responde la ruta, o `undefined` si no es una ruta de tenancy activada. */
  async handle(request: HttpRequestLike): Promise<HttpResponse | undefined> {
    const { method, path } = request;
    if (!this.matches(method, path)) return undefined;
    if (this.isHealth(method, path)) {
      const health = await this.health();
      return method === 'HEAD' ? { ...health, body: '' } : health;
    }

    // Las rutas de tenant nunca responden en el contexto central.
    const tenant = this.host.current();
    if (!tenant)
      return json(404, {
        error: { code: 'TENANCY_TENANT_NOT_IDENTIFIED', message: 'No tenant for this host' },
      });

    let response: HttpResponse;
    if (path === `${this.prefix}/me`) response = await this.me(tenant);
    else if (path === `${this.prefix}/theme.css`) response = this.themeCss();
    else {
      // Un escape `%` mal formado es culpa del cliente: 400, no un URIError (500).
      let relative: string;
      try {
        relative = decodeURIComponent(path.slice(`${this.prefix}/assets/`.length));
      } catch {
        return json(400, {
          error: {
            code: 'TENANCY_INVALID_STORAGE_PATH',
            message: 'Invalid storage path: malformed percent-encoding',
          },
        });
      }
      response = await this.asset(relative);
    }

    if (response.status === 200 && notModified(request, response.headers.etag)) {
      return {
        status: 304,
        headers: {
          etag: response.headers.etag!,
          'cache-control': response.headers['cache-control']!,
        },
        body: '',
      };
    }
    return method === 'HEAD' ? { ...response, body: '' } : response;
  }

  private themeCss(): HttpResponse {
    const theme = this.host.theme();
    return {
      status: 200,
      headers: {
        'content-type': 'text/css; charset=utf-8',
        etag: theme.etag(),
        'cache-control': this.cacheControl,
        vary: 'Host',
      },
      body: theme.toCss(),
    };
  }

  private async me(tenant: Tenant): Promise<HttpResponse> {
    const theme = this.host.theme();
    const logo = await this.host.theme().logoUrl();
    const body: Record<string, unknown> = {
      id: tenant.id.value,
      theme: { ...theme.toJson(), ...(logo ? { logo } : {}) },
    };
    for (const field of this.publicFields) {
      if (field === 'id' || field === 'theme') continue;
      const value = TENANT_FIELDS.has(field)
        ? (tenant as unknown as Record<string, unknown>)[field]
        : tenant.data[field];
      if (value !== undefined) body[field] = value;
    }
    const text = JSON.stringify(body);
    return {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        etag: `"${createHash('sha1').update(text).digest('base64url')}"`,
        'cache-control': this.cacheControl,
        vary: 'Host',
      },
      body: text,
    };
  }

  private async asset(relative: string): Promise<HttpResponse> {
    // Solo se sirven archivos locales; con S3 las URLs apuntan directo al bucket.
    if (!['local', 'memory'].includes(this.host.storageDriverName()))
      return json(404, { error: { code: 'TENANCY_ASSET_NOT_FOUND', message: 'Not found' } });
    let data: Uint8Array | undefined;
    try {
      data = await this.host.storage().get(relative);
    } catch (error) {
      if (error instanceof InvalidStoragePathError)
        return json(400, { error: { code: error.code, message: error.message } });
      throw error;
    }
    if (!data)
      return json(404, { error: { code: 'TENANCY_ASSET_NOT_FOUND', message: 'Not found' } });
    return {
      status: 200,
      headers: {
        'content-type': contentTypeFor(relative),
        etag: `"${createHash('sha1').update(data).digest('base64url')}"`,
        'cache-control': this.cacheControl,
        'x-content-type-options': 'nosniff',
      },
      body: data,
    };
  }

  private async health(): Promise<HttpResponse> {
    const report = await this.host.health();
    return {
      status: report.status === 'ok' ? 200 : 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      body: JSON.stringify(report),
    };
  }
}

function json(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

function notModified(request: HttpRequestLike, etag: string | undefined): boolean {
  if (!etag) return false;
  const header = request.headers['if-none-match'];
  const value = Array.isArray(header) ? header.join(',') : (header as string | undefined);
  return value !== undefined && value.split(',').some((v) => v.trim() === etag || v.trim() === '*');
}
