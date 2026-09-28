import {
  ActivateTenantUseCase,
  AddDomainUseCase,
  CreateTenantUseCase,
  DeleteTenantUseCase,
  FindTenantUseCase,
  ListDomainsUseCase,
  ListTenantsUseCase,
  PutTenantInMaintenanceUseCase,
  RemoveDomainUseCase,
  ResolveTenantUseCase,
  RetryProvisioningUseCase,
  SetPrimaryDomainUseCase,
  SuspendTenantUseCase,
  UpdateTenantUseCase,
  UpdateThemeUseCase,
  isTenant,
  requireTenant,
  type CreateTenantInput,
  type Resolution,
  type TenantRef,
} from './application/index.js';
import { CACHE_RESOURCE, CacheBootstrapper, type TenantCache } from './cache/tenant-cache.js';
import { validateConfig, DEFAULT_THEME, type TenancyConfig } from './config.js';
import { BootstrapperRegistry } from './context/bootstrapper-registry.js';
import { createFrame, TenancyContext, type ContextFrame } from './context/tenancy-context.js';
import { TenantScope } from './context/tenant-scope.js';
import type { Tenant } from './domain/index.js';
import {
  TenancyEvents,
  TenantNotIdentifiedError,
  Theme,
  type Domain,
  type TenancyEventMap,
  type TenantChanges,
  type TenantStatus,
  type ThemePatch,
  type ThemeProps,
} from './domain/index.js';
import { InProcessEventBus } from './events/in-process-event-bus.js';
import { httpStatusFor } from './http/http.js';
import {
  CachedDomainRepository,
  CachedTenantRepository,
} from './infrastructure/cached-repositories.js';
import { InMemoryDomainRepository } from './infrastructure/memory/in-memory-domain-repository.js';
import { InMemoryTenantRepository } from './infrastructure/memory/in-memory-tenant-repository.js';
import { MemoryCacheStore } from './infrastructure/memory/memory-cache-store.js';
import { NoopProvisioning } from './infrastructure/memory/noop-provisioning.js';
import { ContextualLogger } from './observability/contextual-logger.js';
import { MemoryErrorTracker } from './observability/memory-error-tracker.js';
import { Observer, type ReportContext } from './observability/observer.js';
import * as v from 'valibot';
import { TenancyError } from './domain/index.js';
import type {
  EventTransport,
  CacheStore,
  JobBackoff,
  JobOptions,
  QueueDriver,
  QueueWorker,
  QueuedJob,
  StorageDriver,
  Clock,
  DomainRepository,
  ErrorSummary,
  ErrorTracker,
  EventEnvelope,
  EventListener,
  ListenerOptions,
  Logger,
  Page,
  RequestLike,
  TenantListQuery,
  TenantRepository,
  TrackedError,
  IdGenerator,
  Invalidation,
  InvalidationBus,
  Telemetry,
} from './ports/index.js';
import { resolverFromName, chain, byDomain, bySubdomain } from './resolvers/resolvers.js';
import { SystemClock } from './support/clock.js';
import { forEachConcurrent } from './support/concurrency.js';
import { ConsoleLogger } from './support/loggers.js';
import { UlidGenerator } from './support/ulid.js';
import { ThemeRenderer } from './theme/theme-renderer.js';
import { TenancyHttpRoutes, type HealthReport } from './http/routes.js';
import { LocalStorage } from './storage/local-storage.js';
import {
  CENTRAL_STORAGE_PREFIX,
  STORAGE_RESOURCE,
  StorageBootstrapper,
  TenantStorage,
} from './storage/tenant-storage.js';
import { MemoryQueue } from './queue/memory-queue.js';
import { errorMessage } from './observability/error-details.js';
import type { PluginContribution, PluginExtensions, TenancyPlugin } from './plugins.js';
import { InvalidConfigError } from './domain/index.js';

/** Campos estándar que los adaptadores agregan a los logs de cada petición. */
export interface RequestLogContext extends ReportContext {
  tenantId?: string | null | undefined;
  requestId?: string | undefined;
  method?: string | undefined;
  path?: string | undefined;
  host?: string | undefined;
  /** Plantilla de la ruta (`/pedidos/:id`), para métricas sin explosión de series. */
  route?: string | undefined;
}

export interface RunForEachOptions {
  /** Tenants en paralelo. Por defecto 5. */
  concurrency?: number;
  /** Estados a recorrer. Por defecto solo `active`. */
  status?: TenantStatus | readonly TenantStatus[];
  /** Detenerse en el primer error. Por defecto `false`: se sigue y se reporta al final. */
  stopOnError?: boolean;
}

export interface RunForEachResult {
  succeeded: string[];
  failed: { tenantId: string; error: unknown }[];
}

/** Tema del contexto actual, listo para renderizar. */
export interface CurrentTheme {
  readonly theme: Theme;
  toCss(): string;
  toJson(): ThemeProps;
  etag(): string;
  /** URL del logo (del almacenamiento del tenant, o la URL absoluta guardada en el tema). */
  logoUrl(): Promise<string | undefined>;
}

export interface ThemeApi {
  /** Tema del tenant actual (o el tema por defecto en el contexto central). */
  (): CurrentTheme;
  /** Cambia parte del tema de un tenant. */
  update(tenant: TenantRef, patch: ThemePatch): Promise<Theme>;
  /** Vuelve al tema por defecto. */
  reset(tenant: TenantRef): Promise<Theme>;
  readonly defaults: Theme;
}

type EventName = keyof TenancyEventMap;

/**
 * Listener que se ejecuta en un worker (cola): la petición no espera y hay reintentos.
 * `name` identifica al listener entre procesos; por defecto `patrón#n` (orden de registro).
 */
export interface QueueListenerOptions {
  mode: 'queue';
  name?: string;
  /** Reintentos después del primer intento. Por defecto 3. */
  retries?: number;
  /** Por defecto exponencial desde 1 s. */
  backoff?: 'fixed' | 'exponential' | JobBackoff;
}

export type EventListenerOptions = ListenerOptions | QueueListenerOptions;

export interface JobContext {
  /** Tenant del trabajo (`null` = central). El handler ya corre en su contexto. */
  tenant: Tenant | null;
  job: QueuedJob;
}

export type JobHandler<T = unknown> = (data: T, context: JobContext) => void | Promise<void>;

export interface JobsApi {
  /** Registra un tipo de trabajo. Debe hacerse igual en la app y en el worker. */
  define<T = unknown>(name: string, handler: JobHandler<T>, defaults?: JobOptions): void;
  /** Encola un trabajo para el tenant del contexto actual. Devuelve el id del trabajo. */
  dispatch(name: string, data?: unknown, options?: JobOptions): Promise<string>;
  /** Nombres registrados. */
  names(): string[];
}

export interface WorkerOptions {
  /** Trabajos en paralelo. Por defecto 5. */
  concurrency?: number;
}

export interface EventsApi {
  on<K extends EventName>(
    type: K,
    listener: EventListener<TenancyEventMap[K], K>,
    options?: EventListenerOptions,
  ): () => void;
  /** Eventos propios de la app o patrones con comodín (`tenant.*`, `*`). */
  on(pattern: string, listener: EventListener, options?: EventListenerOptions): () => void;
  /** Publica un evento propio; el `tenantId` se toma del contexto actual. */
  publish<K extends EventName>(
    type: K,
    data: TenancyEventMap[K],
  ): Promise<EventEnvelope<TenancyEventMap[K], K>>;
  publish(type: string, data: unknown): Promise<EventEnvelope>;
  /** Espera a que terminen los listeners `async` en curso. */
  flush(): Promise<void>;
  /**
   * Envía los eventos que coinciden con `pattern` a uno o más transportes (webhook, RabbitMQ...).
   * Con outbox, el evento se guarda antes de enviarse (no se pierde si el transporte está caído).
   * `'*'` no incluye `tenancy.initialized/ended` (uno por petición); reenvíalos de forma explícita si los necesitas.
   */
  forward(pattern: string, options: ForwardOptions): () => void;
  /** Valida el `data` de un evento propio con un esquema Valibot al publicarlo. */
  define(type: string, schema: v.GenericSchema): void;
  /** Transporte registrado por nombre. */
  transport(name: string): EventTransport | undefined;
  /** `source` de los CloudEvents que salen (`tenancy-node://tuapp.com`). */
  readonly source: string;
}

export interface ForwardOptions {
  transport: string | readonly string[];
  /**
   * Destino dentro del transporte. Si no se indica, cada transporte usa su valor por defecto:
   * - RabbitMQ: clave de enrutamiento; por defecto el tipo del evento (`tenant.created`).
   * - NATS: subject; por defecto `<subjectPrefix>.<tipo>` (`tenancy.tenant.created`).
   * - Redis Streams: stream; por defecto el `stream` configurado (`tenancy:events`).
   * - Kafka: topic; por defecto el `topic` configurado (`tenancy.events`).
   * - Webhooks: no se usa (los endpoints se eligen por tipo de evento).
   */
  routingKey?: string;
}

export class InvalidEventDataError extends TenancyError {
  constructor(
    readonly eventType: string,
    reason: string,
  ) {
    super('TENANCY_INVALID_EVENT_DATA', `Invalid data for event "${eventType}": ${reason}`, {
      eventType,
    });
  }
}

const LIFECYCLE_EVENTS = new Set(['tenancy.initialized', 'tenancy.ended']);

export interface ObservabilityApi {
  /** Logger que agrega `tenantId` del contexto a cada línea. */
  readonly logger: Logger;
  /** Errores recientes, los más nuevos primero. `tenantId: null` = central. */
  errors(options?: { tenantId?: string | null; limit?: number }): TrackedError[];
  /** Totales de errores por tenant y por código. */
  summary(): ErrorSummary[];
  /** Registra un error de tu aplicación con el tenant actual. */
  report(operation: string, error: unknown, context?: ReportContext): TrackedError;
  clear(tenantId?: string | null): void;
}

/**
 * Facade principal. Se crea con `createTenancy(config)`.
 *
 * ```ts
 * const tenancy = createTenancy({ centralDomains: ['tuapp.com'] });
 * await tenancy.tenants.create({ id: 'bolivar', domain: 'bolivar.tuapp.com' });
 * await tenancy.run('bolivar', () => tenancy.currentId()); // 'bolivar'
 * ```
 */
export class Tenancy {
  readonly tenants;
  readonly domains;
  readonly theme: ThemeApi;
  readonly events: EventsApi;
  readonly observability: ObservabilityApi;
  readonly jobs: JobsApi;
  /** Rutas HTTP opcionales (`/tenancy/me`, `theme.css`, `assets`, `health`). Las usan los adaptadores. */
  readonly http: TenancyHttpRoutes;
  readonly centralDomains: readonly string[];

  private readonly context = new TenancyContext();
  private readonly registry: BootstrapperRegistry;
  private readonly rootFrame: ContextFrame = createFrame(null);
  private readonly bus: InProcessEventBus;
  private readonly observer: Observer;
  private readonly tenantRepo: TenantRepository;
  private readonly resolveUseCase: ResolveTenantUseCase;
  private readonly renderer = new ThemeRenderer();
  private readonly defaultTheme: Theme;
  private readonly logger: Logger;
  private readonly cacheStore: CacheStore;
  private readonly storageDriver: StorageDriver;
  private readonly queueDriver: QueueDriver;
  private readonly jobHandlers = new Map<string, { handler: JobHandler; defaults: JobOptions }>();
  private readonly workers: QueueWorker[] = [];
  private healthChecks: { name: string; check: () => Promise<void> }[] = [];
  private readonly transports = new Map<string, EventTransport>();
  private eventSource = '';

  constructor(config: TenancyConfig = {}) {
    const { centralDomains } = validateConfig(config);
    this.centralDomains = centralDomains;

    // ── Composition root ─────────────────────────────────────────────
    const clock: Clock = config.clock ?? new SystemClock();
    const ids = config.idGenerator ?? new UlidGenerator();
    const currentTenantId = () => this.currentId() ?? null;
    this.logger = new ContextualLogger(
      (config.logger ?? new ConsoleLogger()).child({ component: 'tenancy' }),
      currentTenantId,
    );
    const tracker: ErrorTracker =
      config.errorTracker && 'record' in config.errorTracker
        ? config.errorTracker
        : new MemoryErrorTracker(config.errorTracker ?? {});
    const telemetry = config.telemetry
      ? Array.isArray(config.telemetry)
        ? (config.telemetry as readonly Telemetry[])
        : [config.telemetry as Telemetry]
      : [];
    this.observer = new Observer({ logger: this.logger, tracker, ids, clock, currentTenantId, telemetry });

    this.bus = new InProcessEventBus({
      ids,
      clock,
      logger: this.logger,
      currentTenantId,
      onListenerError: (error, event) =>
        this.observer.reportError('events.listener', error, {
          tenantId: event.tenantId,
          eventId: event.id,
          eventType: event.type,
        }),
    });

    // Plugins: aportan repositorios, aprovisionamiento y bootstrappers.
    const contributed = this.setupPlugins(config.plugins ?? [], {
      logger: this.logger,
      observer: this.observer,
      clock,
      ids,
      events: this.bus,
      centralDomains,
      currentTenant: () => this.current(),
    });

    const lookup = config.lookupCache;
    const rawTenants = config.tenants ?? contributed.tenants ?? new InMemoryTenantRepository();
    const rawDomains = config.domains ?? contributed.domains ?? new InMemoryDomainRepository();
    const forward = config.invalidation ? this.setupInvalidation(config.invalidation, ids) : undefined;
    const cachedTenants =
      lookup === false ? undefined : new CachedTenantRepository(rawTenants, lookup ?? {}, forward);
    const cachedDomains =
      lookup === false ? undefined : new CachedDomainRepository(rawDomains, lookup ?? {}, forward);
    this.lookupCaches = { tenants: cachedTenants, domains: cachedDomains };
    this.tenantRepo = cachedTenants ?? rawTenants;
    const domainRepo: DomainRepository = cachedDomains ?? rawDomains;

    const provisioning = config.provisioning ?? contributed.provisioning ?? new NoopProvisioning();
    const cacheStore: CacheStore = config.cache ?? new MemoryCacheStore();
    this.cacheStore = cacheStore;
    this.storageDriver = config.storage ?? new LocalStorage();
    this.queueDriver = config.queue ?? new MemoryQueue();
    for (const transport of [
      ...(contributed.transports ?? []),
      ...(config.events?.transports ?? []),
    ]) {
      if (this.transports.has(transport.name))
        throw new InvalidConfigError(`Duplicate event transport "${transport.name}"`);
      this.transports.set(transport.name, transport);
    }
    this.healthChecks = [
      ...(contributed.healthChecks ?? []),
      ...[...this.transports.values()].flatMap((t) =>
        t.ping ? [{ name: `transport:${t.name}`, check: () => t.ping!() }] : [],
      ),
      ...(cacheStore.ping ? [{ name: 'cache', check: () => cacheStore.ping!() }] : []),
      ...(config.invalidation?.ping
        ? [{ name: 'invalidation', check: () => config.invalidation!.ping!() }]
        : []),
      ...(this.queueDriver.ping ? [{ name: 'queue', check: () => this.queueDriver.ping!() }] : []),
      ...(this.storageDriver.ping
        ? [{ name: 'storage', check: () => this.storageDriver.ping!() }]
        : []),
    ];
    this.registry = new BootstrapperRegistry(
      [
        new CacheBootstrapper(cacheStore),
        new StorageBootstrapper(this.storageDriver),
        ...(contributed.bootstrappers ?? []),
        ...(config.bootstrappers ?? []),
      ],
      this.logger,
    );

    const themeDefaults: ThemeProps = { ...DEFAULT_THEME, ...config.theme?.defaults };
    this.defaultTheme = Theme.create(themeDefaults);

    const resolver =
      typeof config.resolver === 'string'
        ? resolverFromName(config.resolver)
        : (config.resolver ?? chain([byDomain(), bySubdomain()]));
    this.resolveUseCase = new ResolveTenantUseCase(
      resolver,
      this.tenantRepo,
      domainRepo,
      centralDomains,
    );

    const repo = this.tenantRepo;
    const bus = this.bus;
    const createTenant = new CreateTenantUseCase(
      repo,
      domainRepo,
      provisioning,
      bus,
      clock,
      themeDefaults,
    );
    const retryProvisioning = new RetryProvisioningUseCase(repo, provisioning, bus, clock);
    const findTenant = new FindTenantUseCase(repo);
    const listTenants = new ListTenantsUseCase(repo);
    const updateTenant = new UpdateTenantUseCase(repo, bus, clock);
    const suspendTenant = new SuspendTenantUseCase(repo, bus, clock);
    const activateTenant = new ActivateTenantUseCase(repo, bus, clock);
    const maintenance = new PutTenantInMaintenanceUseCase(repo, bus, clock);
    const deleteTenant = new DeleteTenantUseCase(repo, domainRepo, provisioning, bus, clock);
    const addDomain = new AddDomainUseCase(repo, domainRepo, bus, clock);
    const removeDomain = new RemoveDomainUseCase(domainRepo, bus, clock);
    const setPrimary = new SetPrimaryDomainUseCase(domainRepo, bus, clock);
    const listDomains = new ListDomainsUseCase(repo, domainRepo);
    const updateTheme = new UpdateThemeUseCase(repo, bus, clock, themeDefaults);

    // Cada operación queda en el log con tenantId, duración y resultado.
    const write = <T>(operation: string, ref: TenantRef | undefined, fn: () => Promise<T>) =>
      this.observer.trace(operation, ref === undefined ? {} : { tenantId: refId(ref) }, fn, {
        isExpected: isClientError,
      });
    const read = <T>(operation: string, ref: TenantRef | undefined, fn: () => Promise<T>) =>
      this.observer.trace(operation, ref === undefined ? {} : { tenantId: refId(ref) }, fn, {
        isExpected: isClientError,
        successLevel: 'debug',
      });

    this.tenants = {
      create: (input: CreateTenantInput): Promise<Tenant> =>
        write('tenants.create', input.id, () => createTenant.execute(input)),
      retryProvisioning: (ref: TenantRef): Promise<Tenant> =>
        write('tenants.retryProvisioning', ref, () => retryProvisioning.execute(ref)),
      find: (ref: TenantRef): Promise<Tenant | undefined> =>
        read('tenants.find', ref, () => findTenant.execute(ref)),
      findOrFail: (ref: TenantRef): Promise<Tenant> =>
        read('tenants.findOrFail', ref, () => requireTenant(repo, ref)),
      list: (query?: TenantListQuery): Promise<Page<Tenant>> =>
        read('tenants.list', undefined, () => listTenants.execute(query)),
      update: (ref: TenantRef, changes: TenantChanges): Promise<Tenant> =>
        write('tenants.update', ref, () => updateTenant.execute(ref, changes)),
      suspend: (ref: TenantRef): Promise<Tenant> =>
        write('tenants.suspend', ref, () => suspendTenant.execute(ref)),
      activate: (ref: TenantRef): Promise<Tenant> =>
        write('tenants.activate', ref, () => activateTenant.execute(ref)),
      maintenance: (ref: TenantRef, message?: string | null): Promise<Tenant> =>
        write('tenants.maintenance', ref, () => maintenance.execute(ref, message ?? null)),
      delete: (ref: TenantRef): Promise<void> =>
        write('tenants.delete', ref, () => deleteTenant.execute(ref)),
      /**
       * Olvida el tenant en la caché de búsqueda de esta instancia y, con un bus de
       * invalidación, en las demás. Úsalo si cambiaste el tenant por fuera de `tenancy.tenants`.
       */
      invalidate: (ref: TenantRef): void => {
        this.lookupCaches.tenants?.evict(typeof ref === 'string' ? ref : ref.value);
      },
    };

    this.domains = {
      add: (ref: TenantRef, domain: string, options?: { primary?: boolean }): Promise<Domain> =>
        write('domains.add', ref, () => addDomain.execute(ref, domain, options)),
      remove: (domain: string): Promise<void> =>
        this.observer.trace('domains.remove', { domain }, () => removeDomain.execute(domain), {
          isExpected: isClientError,
        }),
      setPrimary: (domain: string): Promise<Domain> =>
        this.observer.trace('domains.setPrimary', { domain }, () => setPrimary.execute(domain), {
          isExpected: isClientError,
        }),
      list: (ref: TenantRef): Promise<Domain[]> =>
        read('domains.list', ref, () => listDomains.execute(ref)),
    };

    this.theme = Object.assign(() => this.currentTheme(), {
      update: (ref: TenantRef, patch: ThemePatch) =>
        write('theme.update', ref, () => updateTheme.execute(ref, patch)),
      reset: (ref: TenantRef) => write('theme.reset', ref, () => updateTheme.execute(ref, null)),
      defaults: this.defaultTheme,
    });

    const queueListenerCount = new Map<string, number>();
    const eventSchemas = new Map<string, v.GenericSchema>();
    const transports = this.transports;
    const sink = contributed.eventSink;
    const source = config.events?.source ?? `tenancy-node://${centralDomains[0] ?? 'localhost'}`;
    this.eventSource = source;
    this.events = {
      on: (pattern: string, listener: EventListener, options?: EventListenerOptions) => {
        if (options?.mode !== 'queue')
          return bus.on(pattern, listener, options as ListenerOptions | undefined);
        // Modo cola: el evento se encola (sync, así se sabe que quedó guardado) y lo procesa un worker.
        const n = (queueListenerCount.get(pattern) ?? 0) + 1;
        queueListenerCount.set(pattern, n);
        const jobName = `event:${options.name ?? `${pattern}#${n}`}`;
        const backoff: JobBackoff =
          typeof options.backoff === 'object'
            ? options.backoff
            : { type: options.backoff ?? 'exponential', delayMs: 1000 };
        this.jobs.define<EventEnvelope & { time: string }>(jobName, (data) =>
          listener(Object.freeze({ ...data, time: new Date(data.time) })),
        );
        return bus.on(
          pattern,
          async (envelope) => {
            await this.enqueue(jobName, envelope.tenantId, envelope, {
              attempts: (options.retries ?? 3) + 1,
              backoff,
            });
          },
          { mode: 'sync' },
        );
      },
      publish: async (type: string, data: unknown) => {
        const schema = eventSchemas.get(type);
        if (schema) {
          const result = v.safeParse(schema, data);
          if (!result.success) {
            throw new InvalidEventDataError(
              type,
              result.issues.map((i) => `${v.getDotPath(i) ?? '(root)'}: ${i.message}`).join('; '),
            );
          }
        }
        return bus.publish({ type, data });
      },
      flush: () => bus.flush(),
      define: (type: string, schema: v.GenericSchema) => {
        eventSchemas.set(type, schema);
      },
      transport: (name: string) => transports.get(name),
      source,
      forward: (pattern: string, options: ForwardOptions) => {
        const names = ([] as string[]).concat(options.transport);
        for (const name of names) {
          if (!transports.has(name))
            throw new InvalidConfigError(`Unknown event transport "${name}"`);
        }
        const destinations = names.map((transport) => ({
          transport,
          ...(options.routingKey ? { routingKey: options.routingKey } : {}),
        }));
        const skip = (type: string) => pattern === '*' && LIFECYCLE_EVENTS.has(type);
        if (sink) {
          // Con outbox: se guarda antes de seguir (sync). Si la outbox falla, la operación falla.
          return bus.on(
            pattern,
            async (event) => {
              if (!skip(event.type)) await sink.accept(event, destinations);
            },
            { mode: 'sync' },
          );
        }
        // Sin outbox: envío directo fuera del camino de la petición, con 3 intentos.
        return bus.on(
          pattern,
          async (event) => {
            if (skip(event.type)) return;
            for (const destination of destinations) await this.sendWithRetry(event, destination);
          },
          { mode: 'async' },
        );
      },
    } as EventsApi;

    this.jobs = {
      define: <T>(name: string, handler: JobHandler<T>, defaults: JobOptions = {}) => {
        if (this.jobHandlers.has(name))
          throw new InvalidConfigError(`Job "${name}" is already defined`);
        this.jobHandlers.set(name, { handler: handler as JobHandler, defaults });
      },
      dispatch: async (name: string, data?: unknown, options: JobOptions = {}) => {
        const definition = this.jobHandlers.get(name);
        if (!definition)
          throw new InvalidConfigError(`Job "${name}" is not defined (tenancy.jobs.define)`);
        return this.enqueue(name, this.currentId() ?? null, data, {
          ...definition.defaults,
          ...options,
        });
      },
      names: () => [...this.jobHandlers.keys()],
    };

    // Al borrar un tenant, su caché ya no sirve.
    bus.on(
      'tenant.deleted',
      async (event) => {
        await cacheStore.flushTenant(event.tenantId!);
      },
      { mode: 'async' },
    );
    // Y sus archivos tampoco. Si falla, el borrado del tenant sigue siendo válido: queda en el log.
    bus.on(
      'tenant.deleted',
      async (event) => {
        const tenantId = event.tenantId!;
        const files = new TenantStorage(this.storageDriver, tenantId);
        // Un tenant llamado `central` compartiría la carpeta del contexto central: no se toca.
        if (files.prefix === CENTRAL_STORAGE_PREFIX) return;
        try {
          await files.deleteAll();
        } catch (error) {
          this.observer.reportError('storage.delete_tenant', error, {
            tenantId,
            eventId: event.id,
            prefix: files.prefix,
          });
        }
      },
      { mode: 'async' },
    );

    this.http = new TenancyHttpRoutes(
      {
        current: () => this.current(),
        theme: () => this.currentTheme(),
        storage: () => this.storage(),
        health: () => this.health(),
        storageDriverName: () => this.storageDriver.name,
      },
      config.http ?? {},
      config.publicFields ?? ['name'],
    );

    this.observability = {
      logger: this.logger,
      errors: (options) => tracker.recent(options),
      summary: () => tracker.summary(),
      report: (operation, error, context) => this.observer.reportError(operation, error, context),
      clear: (tenantId) => tracker.clear(tenantId),
    };
  }

  // ── Contexto ─────────────────────────────────────────────────────────

  /** Tenant del contexto actual, o `undefined` en el contexto central. */
  current(): Tenant | undefined {
    return this.context.current();
  }

  /** Tenant del contexto actual; lanza `TenantNotIdentifiedError` si no hay. */
  currentOrFail(): Tenant {
    const tenant = this.current();
    if (!tenant) throw new TenantNotIdentifiedError();
    return tenant;
  }

  currentId(): string | undefined {
    return this.current()?.id.value;
  }

  /** `true` fuera de cualquier tenant (dominio central, admin, scripts). */
  isCentral(): boolean {
    return this.current() === undefined;
  }

  /** Ejecuta `fn` en el contexto de un tenant. Al salir, el contexto anterior vuelve solo. */
  async run<T>(tenant: TenantRef | Tenant, fn: () => T | Promise<T>): Promise<T> {
    const resolved = isTenant(tenant) ? tenant : await requireTenant(this.tenantRepo, tenant);
    return this.runInScope(resolved, fn);
  }

  /** Ejecuta `fn` en el contexto central aunque se esté dentro de un tenant. */
  central<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.runInScope(null, fn);
  }

  /** Recorre tenants (página por página) con concurrencia limitada. */
  async runForEach(
    fn: (tenant: Tenant) => unknown,
    options: RunForEachOptions = {},
  ): Promise<RunForEachResult> {
    const result: RunForEachResult = { succeeded: [], failed: [] };
    const status = options.status ?? 'active';
    const repo = this.tenantRepo;

    async function* allTenants(): AsyncGenerator<Tenant> {
      for (let page = 1; ; page++) {
        const batch = await repo.list({ status, page, perPage: 100 });
        yield* batch.items;
        if (page * batch.perPage >= batch.total || batch.items.length === 0) return;
      }
    }

    await this.observer.trace('tenancy.runForEach', {}, async () => {
      await forEachConcurrent(allTenants(), options.concurrency ?? 5, async (tenant) => {
        try {
          await this.runInScope(tenant, () => fn(tenant));
          result.succeeded.push(tenant.id.value);
        } catch (error) {
          result.failed.push({ tenantId: tenant.id.value, error });
          this.observer.reportError('tenancy.runForEach.item', error, {
            tenantId: tenant.id.value,
          });
          if (options.stopOnError) throw error;
        }
      });
    });
    return result;
  }

  // ── Recursos ─────────────────────────────────────────────────────────

  /** Caché aislada del contexto actual (prefijo `tenant:{id}:`). */
  cache(): TenantCache {
    return this.resource<TenantCache>(CACHE_RESOURCE);
  }

  /** Archivos aislados del contexto actual (prefijo `{id}/`). */
  storage(): TenantStorage {
    return this.resource<TenantStorage>(STORAGE_RESOURCE);
  }

  // ── Colas ────────────────────────────────────────────────────────────

  /**
   * Procesa trabajos de la cola: cada uno corre en el contexto de su tenant. Cada intento queda
   * en el log (`operation: queue.job`); un trabajo que agota sus intentos se registra como error.
   */
  async worker(options: WorkerOptions = {}): Promise<QueueWorker> {
    const worker = await this.queueDriver.process(
      async (job) => {
        const definition = this.jobHandlers.get(job.name);
        const context = {
          tenantId: job.tenantId,
          job: job.name,
          jobId: job.id,
          attempt: job.attempt,
          maxAttempts: job.maxAttempts,
        };
        if (!definition) {
          const error = new InvalidConfigError(`No handler for job "${job.name}" in this worker`);
          this.observer.reportError('queue.job', error, context);
          throw error;
        }
        const last = job.attempt >= job.maxAttempts;
        await this.observer.trace(
          'queue.job',
          context,
          async () => {
            const tenant =
              job.tenantId === null ? null : await requireTenant(this.tenantRepo, job.tenantId);
            await this.runInScope(tenant, () => definition.handler(job.data, { tenant, job }));
          },
          // Un intento con reintentos pendientes es `warn`; el último intento fallido es `error`.
          { isExpected: () => !last },
        );
      },
      { concurrency: options.concurrency ?? 5 },
    );
    this.workers.push(worker);
    return worker;
  }

  // ── Salud ────────────────────────────────────────────────────────────

  /** Estado de la base central, la caché, la cola y el almacenamiento (cada chequeo con límite de 3 s). */
  async health(): Promise<HealthReport> {
    const checks: HealthReport['checks'] = {};
    await Promise.all(
      this.healthChecks.map(async ({ name, check }) => {
        const started = performance.now();
        try {
          await withTimeout(check(), 3000, name);
          checks[name] = { ok: true, durationMs: Math.round(performance.now() - started) };
        } catch (error) {
          checks[name] = {
            ok: false,
            durationMs: Math.round(performance.now() - started),
            error: errorMessage(error),
          };
          this.observer.reportError('health.check', error, { tenantId: null, check: name });
        }
      }),
    );
    return { status: Object.values(checks).every((c) => c.ok) ? 'ok' : 'error', checks };
  }

  /** Envío directo a un transporte (sin outbox): 3 intentos con espera; si falla, queda registrado. */
  private async sendWithRetry(
    event: EventEnvelope,
    destination: { transport: string; routingKey?: string },
  ): Promise<void> {
    const transport = this.transports.get(destination.transport)!;
    const context = {
      tenantId: event.tenantId,
      eventId: event.id,
      eventType: event.type,
      transport: transport.name,
    };
    for (let attempt = 1; ; attempt++) {
      try {
        await transport.send(event, {
          source: this.eventSource,
          ...(destination.routingKey ? { routingKey: destination.routingKey } : {}),
        });
        this.logger.debug(
          { ...context, operation: 'events.transport', outcome: 'success', attempt },
          `Event sent to ${transport.name}`,
        );
        return;
      } catch (error) {
        const last = attempt >= 3;
        this.observer.reportError('events.transport', error, { ...context, attempt }, !last);
        if (last) return;
        await new Promise((r) => setTimeout(r, 200 * 5 ** (attempt - 1)));
      }
    }
  }

  private async enqueue(
    name: string,
    tenantId: string | null,
    data: unknown,
    options: JobOptions,
  ): Promise<string> {
    const id = await this.queueDriver.enqueue({ name, tenantId, data, options });
    this.logger.debug(
      { tenantId, operation: 'queue.dispatch', job: name, jobId: id },
      `Job ${name} queued`,
    );
    return id;
  }

  /** Recurso de un bootstrapper para el contexto actual (lo crea la primera vez). */
  resource<T>(name: string): T {
    return this.registry.resource<T>(this.context.frame() ?? this.rootFrame, name);
  }

  // ── Integración con adaptadores ─────────────────────────────────────

  /** Identifica el tenant de una petición. Los errores de estado (suspendido, mantenimiento) se lanzan. */
  resolve(request: RequestLike): Promise<Resolution> {
    return this.resolveUseCase.execute(request).catch((error: unknown) => {
      this.observer.reportError(
        'tenancy.resolve',
        error,
        { host: request.host, path: request.path },
        isClientError(error),
      );
      throw error;
    });
  }

  /**
   * Abre un contexto para un tenant (o `null` = central). Hay que cerrarlo con `scope.close()`.
   * Lo usan los adaptadores HTTP; en tu código normalmente basta con `run()`.
   */
  async openScope(tenant: Tenant | null): Promise<TenantScope> {
    await this.registry.prepare(tenant);
    const scope = new TenantScope(this.context, this.registry, tenant, async (closed) => {
      if (closed.tenant && this.bus.hasListeners('tenancy.ended')) {
        await this.bus.publish(TenancyEvents.lifecycle('tenancy.ended', closed.tenant.id.value));
      }
    });
    if (tenant && this.bus.hasListeners('tenancy.initialized')) {
      await scope.run(() =>
        this.bus.publish(TenancyEvents.lifecycle('tenancy.initialized', tenant.id.value)),
      );
    }
    return scope;
  }

  /**
   * Resuelve el tenant de una petición y abre su contexto. Lo usan los adaptadores HTTP.
   * Con `onUnidentified: 'error'` (por defecto) una petición sin tenant lanza `TenantNotIdentifiedError`;
   * con `'central'` se atiende en el contexto central.
   */
  async openRequestScope(
    request: RequestLike,
    options: { onUnidentified?: 'error' | 'central' } = {},
  ): Promise<TenantScope> {
    const resolution = await this.resolve(request);
    if (resolution.kind === 'unidentified' && (options.onUnidentified ?? 'error') === 'error') {
      const error = new TenantNotIdentifiedError(
        `No tenant found for host "${request.host ?? ''}"`,
      );
      this.observer.reportError(
        'tenancy.resolve',
        error,
        { tenantId: null, host: request.host, path: request.path },
        true,
      );
      throw error;
    }
    const tenant = resolution.kind === 'tenant' ? resolution.tenant : null;
    this.observer.tenantResolved(tenant?.id.value ?? null);
    return this.openScope(tenant);
  }

  /** Registra un error de una petición HTTP con su contexto. Lo usan los adaptadores. */
  reportRequestError(error: unknown, context: RequestLogContext): TrackedError {
    return this.observer.reportError('http.request', error, context, isClientError(error));
  }

  /** Escribe la línea de log de una petición terminada (nivel según el código HTTP). */
  logRequest(context: RequestLogContext & { statusCode: number; durationMs: number }): void {
    const level = context.statusCode >= 500 ? 'error' : context.statusCode >= 400 ? 'warn' : 'info';
    this.observer.recordRequest({
      tenantId: context.tenantId ?? null,
      method: context.method ?? 'GET',
      route: context.route,
      statusCode: context.statusCode,
      durationMs: context.durationMs,
    });
    this.logger[level](
      {
        operation: 'http.request',
        outcome: context.statusCode >= 400 ? 'error' : 'success',
        ...this.observer.correlation(),
        ...context,
        tenantId: context.tenantId ?? null,
      },
      `${context.method ?? ''} ${context.path ?? ''} ${context.statusCode}`.trim(),
    );
  }

  /** Espera los eventos pendientes y libera los recursos del contexto raíz. */
  async close(): Promise<void> {
    for (const worker of this.workers.splice(0)) await worker.close();
    await this.bus.flush();
    await this.invalidation?.flush();
    await this.invalidation?.bus.close();
    await this.registry.revert(this.rootFrame);
    for (const close of this.closers.reverse()) await close();
    this.closers = [];
    await this.queueDriver.close();
    for (const transport of this.transports.values()) await transport.close();
    await this.cacheStore.close?.();
    await this.storageDriver.close?.();
  }

  private closers: (() => Promise<void>)[] = [];

  private lookupCaches: {
    tenants: CachedTenantRepository | undefined;
    domains: CachedDomainRepository | undefined;
  } = { tenants: undefined, domains: undefined };

  private invalidation: { bus: InvalidationBus; flush(): Promise<void> } | undefined;

  /**
   * Junta las invalidaciones de una misma operación en un solo mensaje y aplica las que
   * llegan de otras instancias. Si el bus falla, la escritura no falla: queda en el log y
   * la caché se corrige sola al vencer el TTL.
   */
  private setupInvalidation(bus: InvalidationBus, ids: IdGenerator): (item: Invalidation) => void {
    const origin = ids.generate();
    let pending: Invalidation[] = [];
    let inflight: Promise<void> = Promise.resolve();
    const send = () => {
      const items = pending;
      pending = [];
      inflight = inflight
        .then(() => bus.publish({ origin, items }))
        .catch((error: unknown) => {
          this.observer.reportError('cache.invalidation.publish', error, {
            tenantId: null,
            items: items.length,
          });
        });
    };
    this.invalidation = { bus, flush: () => inflight };
    bus
      .subscribe((message) => {
        if (message.origin === origin) return;
        for (const item of message.items) this.applyInvalidation(item);
        this.logger.debug(
          { operation: 'cache.invalidation.received', from: message.origin, items: message.items },
          'lookup cache invalidated by another instance',
        );
      })
      .catch((error: unknown) =>
        this.observer.reportError('cache.invalidation.subscribe', error, { tenantId: null }),
      );
    return (item) => {
      if (pending.length === 0) queueMicrotask(send);
      pending.push(item);
    };
  }

  private applyInvalidation(item: Invalidation): void {
    const { tenants, domains } = this.lookupCaches;
    switch (item.kind) {
      case 'tenant':
        tenants?.invalidate(item.tenantId);
        break;
      case 'domain':
        domains?.invalidate(item.domain);
        break;
      case 'domains-of':
        domains?.invalidateTenant(item.tenantId);
        break;
      case 'all':
        tenants?.clear();
        domains?.clear();
        this.renderer.clear();
        break;
    }
  }

  private setupPlugins(
    plugins: readonly TenancyPlugin[],
    context: Parameters<TenancyPlugin['setup']>[0],
  ): PluginContribution {
    const merged: PluginContribution & {
      bootstrappers: NonNullable<PluginContribution['bootstrappers']>;
    } = {
      bootstrappers: [],
    };
    const owners: Partial<Record<'tenants' | 'domains' | 'provisioning', string>> = {};
    for (const plugin of plugins) {
      const contribution = plugin.setup(context);
      for (const key of ['tenants', 'domains', 'provisioning'] as const) {
        if (contribution[key] === undefined) continue;
        if (owners[key]) {
          throw new InvalidConfigError(
            `Plugins "${owners[key]}" and "${plugin.name}" both provide "${key}"`,
          );
        }
        owners[key] = plugin.name;
        (merged as unknown as Record<string, unknown>)[key] = contribution[key];
      }
      merged.bootstrappers = [...merged.bootstrappers, ...(contribution.bootstrappers ?? [])];
      merged.healthChecks = [...(merged.healthChecks ?? []), ...(contribution.healthChecks ?? [])];
      merged.transports = [...(merged.transports ?? []), ...(contribution.transports ?? [])];
      if (contribution.eventSink) {
        if (merged.eventSink)
          throw new InvalidConfigError(`Plugin "${plugin.name}" registers a second event sink`);
        merged.eventSink = contribution.eventSink;
      }
      if (contribution.close) this.closers.push(contribution.close.bind(contribution));
    }
    return merged;
  }

  private currentTheme(): CurrentTheme {
    const tenant = this.current();
    const theme = tenant?.theme ?? this.defaultTheme;
    const key = tenant ? `${tenant.id.value}:${tenant.updatedAt.getTime()}` : '\0default';
    const rendered = () => this.renderer.render(key, theme);
    return {
      theme,
      toCss: () => rendered().css,
      toJson: () => rendered().json,
      etag: () => rendered().etag,
      logoUrl: async () => (theme.logo ? this.storage().url(theme.logo) : undefined),
    };
  }

  private async runInScope<T>(tenant: Tenant | null, fn: () => T | Promise<T>): Promise<T> {
    const scope = await this.openScope(tenant);
    try {
      return await scope.run(fn);
    } finally {
      await scope.close();
    }
  }
}

/** Composition root: crea el facade `tenancy` con los adaptadores y plugins de la configuración. */
export function createTenancy<const P extends readonly TenancyPlugin[] = []>(
  config: TenancyConfig & { plugins?: P } = {},
): Tenancy & PluginExtensions<P> {
  const tenancy = new Tenancy(config);
  for (const plugin of config.plugins ?? []) {
    const extension = plugin.extend?.(tenancy);
    if (!extension) continue;
    for (const key of Object.keys(extension)) {
      if (key in tenancy) {
        throw new InvalidConfigError(`Plugin "${plugin.name}" cannot redefine tenancy.${key}`);
      }
    }
    Object.assign(tenancy, extension);
  }
  return tenancy as Tenancy & PluginExtensions<P>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${name} health check timed out after ${ms} ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function refId(ref: TenantRef): string {
  return typeof ref === 'string' ? ref : String((ref as { value?: unknown }).value);
}

/** Errores de cliente (4xx) se registran como `warn`; el resto como `error`. */
function isClientError(error: unknown): boolean {
  const status = httpStatusFor(error);
  return status >= 400 && status < 500;
}
