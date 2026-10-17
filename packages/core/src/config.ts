import * as v from 'valibot';
import {
  DomainName,
  InvalidConfigError,
  type FeatureDefinition,
  type FontDefinition,
  type NotificationChannel,
  type PlanDefinition,
  type ThemeProps,
} from './domain/index.js';
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
import type { BillingRepository, NotificationRepository, PaymentProvider } from './ports/index.js';

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
  theme?: {
    defaults?: Partial<ThemeProps>;
    /**
     * Fuentes que los tenants pueden elegir. Con lista, `theme.font` debe ser una de ellas y
     * `/tenancy/theme.css` ya trae su carga (`@import`). Sin lista, cualquier nombre válido.
     */
    fonts?: readonly FontDefinition[];
  };
  /**
   * Catálogo de módulos de tu app (`{ reportes: 'Reportes y PDF' }`). Si falta, sale de los
   * módulos que nombran los planes.
   */
  features?: Readonly<Record<string, string | FeatureDefinition>>;
  /**
   * Planes con sus módulos, límites y precio. De aquí salen `tenancy.features`, `requireFeature`,
   * `/tenancy/me`, el panel y `GET /tenancy/plans`. Sin planes, todo tenant tiene todos los módulos.
   */
  plans?: Readonly<Record<string, PlanDefinition>>;
  /** Plan de los tenants que no tienen uno (`plan: null`). */
  defaultPlan?: string;
  /** Cobros a los tenants: suscripción, facturas y pagos (`tenancy.billing`). */
  billing?: {
    /** Dónde se guardan. Por defecto, la base central (con `@tenancy-node/db`) o memoria. */
    repository?: BillingRepository;
    /** Pasarelas en línea (Stripe, QR...). El pago `manual` siempre está. */
    providers?: readonly PaymentProvider[];
    /** Moneda si el plan no tiene precio. Por defecto `USD`. */
    currency?: string;
    /** Días para pagar una factura. Por defecto 7. */
    dueDays?: number;
    /** Cuántos días antes de que venza el período se emite la factura siguiente. Por defecto 7. */
    invoiceDaysBefore?: number;
    /** Suspender al tenant N días después del vencimiento sin pagar. Por defecto `null` (nunca). */
    suspendAfterDays?: number | null;
  };
  /** Avisos de la plataforma a sus tenants (`tenancy.notifications`). */
  notifications?: {
    /** Dónde se guardan. Por defecto, la base central (con `@tenancy-node/db`) o memoria. */
    repository?: NotificationRepository;
    /** Canales de entrega fuera de la app: `firebase()` de `@tenancy-node/notify-firebase`, o el tuyo. */
    channels?: readonly NotificationChannel[];
    /**
     * Cómo se entrega por los canales: `'background'` (por defecto) en este proceso sin hacer
     * esperar a `send`; `'queue'` como trabajo de la cola (con reintentos; necesita un worker).
     */
    delivery?: 'background' | 'queue';
    /** Cuánto se cachean los avisos vigentes en este proceso. Por defecto 15 s. */
    cacheTtlMs?: number;
  };
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
      plans: v.optional(v.boolean()),
      notifications: v.optional(v.boolean()),
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
  theme: v.optional(
    v.object({
      defaults: v.optional(v.record(v.string(), v.unknown())),
      fonts: v.optional(v.array(v.object({ family: v.string() }))),
    }),
  ),
  features: v.optional(
    v.record(v.string(), v.union([v.string(), v.object({ label: v.string() })])),
  ),
  plans: v.optional(
    v.record(
      v.string(),
      v.object({
        label: v.string(),
        features: v.union([v.literal('*'), v.array(v.string())]),
      }),
    ),
  ),
  defaultPlan: v.optional(v.string()),
  billing: v.optional(
    v.object({
      repository: v.optional(withMethods('findSubscription', 'saveSubscription', 'insertInvoice', 'listInvoices')),
      providers: v.optional(v.array(withMethods('createCheckout', 'parseWebhook'))),
      currency: v.optional(v.pipe(v.string(), v.regex(/^[A-Z]{3}$/))),
      dueDays: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      invoiceDaysBefore: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      suspendAfterDays: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0)))),
    }),
  ),
  notifications: v.optional(
    v.object({
      repository: v.optional(withMethods('insert', 'findById', 'list', 'active', 'delete', 'markRead')),
      channels: v.optional(v.array(withMethods('send'))),
      delivery: v.optional(v.picklist(['background', 'queue'])),
      cacheTtlMs: v.optional(v.pipe(v.number(), v.minValue(0))),
    }),
  ),
  invalidation: v.optional(withMethods('publish', 'subscribe', 'close')),
  telemetry: v.optional(
    v.union([v.array(v.object({ name: v.string() })), v.object({ name: v.string() })]),
  ),
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
