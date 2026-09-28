import * as v from 'valibot';
import { DomainName, InvalidConfigError, type ThemeProps } from './domain/index.js';
import type {
  Bootstrapper,
  CacheStore,
  Clock,
  DomainRepository,
  ErrorTracker,
  IdGenerator,
  Logger,
  ProvisioningPipeline,
  QueueDriver,
  EventTransport,
  InvalidationBus,
  StorageDriver,
  Telemetry,
  TenantRepository,
  TenantResolver,
} from './ports/index.js';
import type { LookupCacheOptions } from './infrastructure/cached-repositories.js';
import type { MemoryErrorTrackerOptions } from './observability/memory-error-tracker.js';
import type { ResolverName } from './resolvers/resolvers.js';
import type { TenancyPlugin } from './plugins.js';
import type { HttpRoutesOptions } from './http/routes.js';

export interface TenancyConfig {
  /** Dominios de la app central ('tuapp.com'). Nunca resuelven a un tenant. */
  centralDomains?: readonly string[];
  /** Cómo se identifica el tenant. Por defecto: dominio y luego subdominio. */
  resolver?: ResolverName | TenantResolver;
  /** Repositorio de tenants. Por defecto, en memoria. */
  tenants?: TenantRepository;
  /** Repositorio de dominios. Por defecto, en memoria. */
  domains?: DomainRepository;
  /** Caché cruda. Por defecto, en memoria. */
  cache?: CacheStore;
  /** Crea los recursos físicos del tenant. Por defecto no hace nada. */
  provisioning?: ProvisioningPipeline;
  /** Bootstrappers adicionales (base de datos, storage...). */
  bootstrappers?: readonly Bootstrapper[];
  /** Compatible con pino. Por defecto `ConsoleLogger` en nivel `info`. */
  logger?: Logger;
  /** Registro de errores por tenant. Por defecto en memoria (o sus opciones). */
  errorTracker?: ErrorTracker | MemoryErrorTrackerOptions;
  clock?: Clock;
  idGenerator?: IdGenerator;
  theme?: { defaults?: Partial<ThemeProps> };
  /** Caché de búsqueda de tenants y dominios. `false` la desactiva. */
  lookupCache?: false | LookupCacheOptions;
  /**
   * Con varias instancias de la app: avisa a las demás cuando cambia un tenant o dominio,
   * para que borren su caché de búsqueda al instante. `redisInvalidation()` de `@tenancy-node/cache-redis`.
   */
  invalidation?: InvalidationBus;
  /** Trazas y métricas: `openTelemetry()` de `@tenancy-node/otel`, `prometheus()` de `@tenancy-node/prometheus`. */
  telemetry?: Telemetry | readonly Telemetry[];
  /** Almacenamiento de archivos. Por defecto, disco local en `./storage`. */
  storage?: StorageDriver;
  /** Cola de trabajos. Por defecto, en memoria (se pierde al reiniciar). */
  queue?: QueueDriver;
  /** Rutas HTTP opcionales, todas apagadas por defecto. */
  http?: HttpRoutesOptions;
  /** Campos que `/tenancy/me` puede mostrar: `name`, `plan`, `status` o llaves de `data`. Por defecto `['name']`. */
  publicFields?: readonly string[];
  events?: {
    /** Transportes para `tenancy.events.forward` (webhook, RabbitMQ, Redis Streams...). */
    transports?: readonly EventTransport[];
    /** `source` de los CloudEvents. Por defecto `tenancy-node://<primer dominio central>`. */
    source?: string;
  };
  /** Plugins: base de datos (`@tenancy-node/db`), etc. */
  plugins?: readonly TenancyPlugin[];
}

export const DEFAULT_THEME: ThemeProps = { primary: '#2563EB', secondary: '#64748B' };

const withMethods = (...methods: string[]) =>
  v.custom<object>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      methods.every((m) => typeof (value as Record<string, unknown>)[m] === 'function'),
    `must implement ${methods.join(', ')}`,
  );

const positiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));

const ConfigSchema = v.object({
  centralDomains: v.optional(v.array(v.string())),
  resolver: v.optional(
    v.union([v.picklist(['domain', 'subdomain', 'path', 'header']), withMethods('resolve')]),
  ),
  tenants: v.optional(withMethods('findById', 'exists', 'list', 'save')),
  domains: v.optional(
    withMethods('findByName', 'listByTenant', 'create', 'setPrimary', 'delete', 'deleteByTenant'),
  ),
  cache: v.optional(withMethods('get', 'set', 'delete', 'flushTenant')),
  provisioning: v.optional(withMethods('provision', 'deprovision')),
  bootstrappers: v.optional(v.array(withMethods('bootstrap'))),
  logger: v.optional(withMethods('debug', 'info', 'warn', 'error', 'child')),
  errorTracker: v.optional(
    v.union([
      withMethods('record', 'recent', 'summary', 'clear'),
      v.object({ perTenant: v.optional(positiveInt), maxTenants: v.optional(positiveInt) }),
    ]),
  ),
  clock: v.optional(withMethods('now')),
  plugins: v.optional(v.array(withMethods('setup'))),
  storage: v.optional(withMethods('put', 'get', 'exists', 'delete', 'list', 'deletePrefix', 'url')),
  queue: v.optional(withMethods('enqueue', 'process', 'close')),
  http: v.optional(
    v.object({
      me: v.optional(v.boolean()),
      theme: v.optional(v.boolean()),
      assets: v.optional(v.boolean()),
      health: v.optional(v.boolean()),
      prefix: v.optional(v.pipe(v.string(), v.regex(/^\/[a-z0-9/_-]*$/i))),
      cacheControl: v.optional(v.string()),
    }),
  ),
  publicFields: v.optional(v.array(v.string())),
  events: v.optional(
    v.object({
      transports: v.optional(v.array(withMethods('send', 'close'))),
      source: v.optional(v.pipe(v.string(), v.minLength(1))),
    }),
  ),
  idGenerator: v.optional(withMethods('generate')),
  theme: v.optional(v.object({ defaults: v.optional(v.record(v.string(), v.unknown())) })),
  invalidation: v.optional(withMethods('publish', 'subscribe', 'close')),
  telemetry: v.optional(v.union([v.array(v.object({ name: v.string() })), v.object({ name: v.string() })])),
  lookupCache: v.optional(
    v.union([
      v.literal(false),
      v.object({
        max: v.optional(positiveInt),
        ttlMs: v.optional(v.pipe(v.number(), v.minValue(0))),
        now: v.optional(v.function()),
      }),
    ]),
  ),
});

/**
 * Declara la configuración con tipos y autocompletado. Conserva el tipo de los plugins,
 * así `createTenancy(config)` sabe qué métodos agregan (por ejemplo `tenancy.db()`).
 */
export function defineConfig<const P extends readonly TenancyPlugin[] = []>(
  config: TenancyConfig & { plugins?: P },
): TenancyConfig & { plugins?: P } {
  return config;
}

/** Valida la configuración y normaliza los dominios centrales. */
export function validateConfig(config: TenancyConfig): { centralDomains: string[] } {
  const result = v.safeParse(ConfigSchema, config);
  if (!result.success) {
    const issues = result.issues
      .map((issue) => `${v.getDotPath(issue) ?? '(root)'}: ${issue.message}`)
      .join('; ');
    throw new InvalidConfigError(`Invalid tenancy config: ${issues}`);
  }
  const centralDomains = (config.centralDomains ?? []).map((domain) => {
    const name = DomainName.tryCreate(domain);
    if (!name) throw new InvalidConfigError(`Invalid central domain "${domain}"`);
    return name.value;
  });
  return { centralDomains };
}
