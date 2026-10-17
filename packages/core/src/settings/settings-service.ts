import {
  EMPTY_PLATFORM,
  InvalidPlanError,
  PlanConflictError,
  PlanNotFoundError,
  mergePlatform,
  type PlanCatalog,
  type PlanInfo,
  type PlanOverride,
  type PlanPrice,
  type PlatformPatch,
  type PlatformSettings,
} from '../domain/index.js';
import type {
  Clock,
  Logger,
  PlanSettingsRepository,
  PlatformSettingsRepository,
  StorageDriver,
} from '../ports/index.js';

/** Campos de un plan que se editan desde el panel. `null` en `description`/`price` los quita. */
export interface PlanInput {
  label?: string;
  description?: string | null;
  price?: PlanPrice | null;
  features?: readonly string[] | '*';
  limits?: Readonly<Record<string, number | null>>;
  public?: boolean;
  highlight?: boolean;
}

/** Lo que muestra la web comercial (sin los correos internos). */
export interface PublicPlatform {
  name: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primary: string | null;
  contact: { whatsapp: string | null; email: string | null };
}

export interface PlatformInfo extends PlatformSettings {
  logoUrl: string | null;
  faviconUrl: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export interface PlansAdminApi {
  /** Vuelve a leer de la base los cambios de planes (y la marca). */
  reload(): Promise<void>;
  /** Planes con su origen (config/panel), cambios y archivados. Para el panel. */
  describe(): Promise<PlanInfo[]>;
  /** Crea un plan desde el panel (módulos solo del catálogo de código). */
  create(
    id: string,
    input: PlanInput & { label: string; features: readonly string[] | '*' },
    options?: { by?: string | null },
  ): Promise<PlanInfo>;
  /** Cambia un plan (de la config o del panel). Lo que no se pasa queda igual. */
  update(id: string, patch: PlanInput, options?: { by?: string | null }): Promise<PlanInfo>;
  /**
   * Plan de la config: borra sus cambios (vuelve a la configuración) → `'reset'`.
   * Plan del panel: lo archiva → `'archived'` (409 si es el plan por defecto o lo usan tenants).
   */
  remove(id: string, options?: { by?: string | null }): Promise<'reset' | 'archived'>;
}

export interface PlatformApi {
  /** Marca y contacto (con `salesNotifyTo`). */
  get(): Promise<PlatformInfo>;
  /** Lo público, para la web comercial y `GET /tenancy/platform`. */
  public(): Promise<PublicPlatform>;
  update(patch: PlatformPatch, options?: { by?: string | null }): Promise<PlatformInfo>;
  /** Guarda el logo o el favicon en el almacenamiento central (`platform/…`) y lo asigna. */
  upload(
    kind: 'logo' | 'favicon',
    body: Uint8Array,
    extension: string,
    options?: { by?: string | null; contentType?: string },
  ): Promise<PlatformInfo>;
  reload(): Promise<void>;
}

export interface SettingsServiceDeps {
  catalog: PlanCatalog;
  plans: PlanSettingsRepository;
  platform: PlatformSettingsRepository;
  platformDefaults: PlatformPatch;
  storage: StorageDriver;
  clock: Clock;
  logger: Logger;
  /** Tenants (sin borrar) con ese plan. */
  countTenants(plan: string): Promise<number>;
  publish(type: string, data: unknown): Promise<unknown>;
  /** Avisa a las demás instancias que recarguen. */
  invalidate(kind: 'plans' | 'platform'): void;
  /** URL pública de un archivo de `platform/` en el almacenamiento central. */
  assetUrl(path: string): Promise<string>;
  refreshMs: number;
}

const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,49}$/;
const EXT = /^[a-z0-9]{1,5}$/;

export function createSettingsService(deps: SettingsServiceDeps) {
  const defaults = mergePlatform(EMPTY_PLATFORM, deps.platformDefaults);
  let platform: { settings: PlatformSettings; updatedAt: Date | null; updatedBy: string | null } = {
    settings: defaults,
    updatedAt: null,
    updatedBy: null,
  };
  let loaded: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let warned = false;

  const loadPlans = async () => deps.catalog.applyOverrides(await deps.plans.list());
  const loadPlatform = async () => {
    const row = await deps.platform.get();
    platform = row ?? { settings: defaults, updatedAt: null, updatedBy: null };
  };
  const loadAll = async () => {
    try {
      await Promise.all([loadPlans(), loadPlatform()]);
      warned = false;
    } catch (error) {
      // Tablas todavía sin crear (antes de `tenancy install`) o base caída: se sigue con la
      // configuración de código y se reintenta en la próxima recarga.
      if (!warned)
        deps.logger.warn(
          { tenantId: null, operation: 'settings.load', err: error },
          `Plan and platform settings could not be loaded: using the code configuration (${error instanceof Error ? error.message : String(error)})`,
        );
      warned = true;
    }
  };

  /** Carga inicial (una sola vez, la esperan las peticiones) y recarga periódica. */
  const ensure = (): Promise<void> => {
    if (!loaded) {
      loaded = loadAll();
      if (deps.refreshMs > 0) {
        timer = setInterval(() => void loadAll(), deps.refreshMs);
        timer.unref();
      }
    }
    return loaded;
  };

  const info = async (id: string): Promise<PlanInfo> => {
    const plan = deps.catalog.describe().find((p) => p.id === id);
    if (!plan) throw new PlanNotFoundError(id);
    return plan;
  };

  const validateInput = (id: string, input: PlanInput): PlanInput => {
    const fail = (reason: string) => new InvalidPlanError(id, reason);
    const out: PlanInput = {};
    if (input.label !== undefined) {
      const label = String(input.label).trim();
      if (label.length === 0 || label.length > 60) throw fail('label must have 1 to 60 characters');
      out.label = label;
    }
    if (input.description !== undefined) {
      const d = input.description === null ? null : String(input.description).trim();
      if (d !== null && d.length > 500) throw fail('description must have at most 500 characters');
      out.description = d || null;
    }
    if (input.price !== undefined) out.price = input.price;
    if (input.features !== undefined) out.features = input.features;
    if (input.limits !== undefined) out.limits = input.limits;
    if (input.public !== undefined) out.public = Boolean(input.public);
    if (input.highlight !== undefined) out.highlight = Boolean(input.highlight);
    return out;
  };

  /** Valida con el catálogo completo, guarda, recarga y avisa. */
  const commit = async (next: PlanOverride, action: string, by: string | null) => {
    const others = (await deps.plans.list()).filter((o) => o.planId !== next.planId);
    deps.catalog.check([...others, next]);
    await deps.plans.save(next);
    await loadPlans();
    deps.invalidate('plans');
    await deps.publish('plan.updated', { planId: next.planId, action, by });
  };

  const plansApi: PlansAdminApi = {
    async reload() {
      await ensure();
      await loadAll();
    },
    async describe() {
      await ensure();
      return deps.catalog.describe();
    },
    async create(id, input, options = {}) {
      await ensure();
      if (!ID.test(id))
        throw new InvalidPlanError(
          id,
          'id must start with a letter and use a-z, 0-9, "_", "." or "-" (up to 50)',
        );
      const existing = (await deps.plans.list()).find((o) => o.planId === id);
      if (deps.catalog.isConfigPlan(id) || existing)
        throw new PlanConflictError(
          id,
          existing?.archived ? 'an archived plan uses this id' : 'already exists',
        );
      const now = deps.clock.now();
      const values = validateInput(id, input);
      if (!values.label || values.features === undefined)
        throw new InvalidPlanError(id, 'label and features are required');
      await commit(
        {
          planId: id,
          ...values,
          archived: false,
          createdAt: now,
          updatedAt: now,
          updatedBy: options.by ?? null,
        },
        'created',
        options.by ?? null,
      );
      return info(id);
    },
    async update(id, patch, options = {}) {
      await ensure();
      const current = (await deps.plans.list()).find((o) => o.planId === id);
      if (!deps.catalog.isConfigPlan(id) && (!current || current.archived))
        throw new PlanNotFoundError(id);
      const now = deps.clock.now();
      await commit(
        {
          ...(current ?? { planId: id, archived: false, createdAt: now }),
          ...validateInput(id, patch),
          updatedAt: now,
          updatedBy: options.by ?? null,
        },
        'updated',
        options.by ?? null,
      );
      return info(id);
    },
    async remove(id, options = {}) {
      await ensure();
      const by = options.by ?? null;
      if (deps.catalog.isConfigPlan(id)) {
        await deps.plans.delete(id);
        await loadPlans();
        deps.invalidate('plans');
        await deps.publish('plan.updated', { planId: id, action: 'reset', by });
        return 'reset';
      }
      const current = (await deps.plans.list()).find((o) => o.planId === id);
      if (!current || current.archived) throw new PlanNotFoundError(id);
      if (deps.catalog.defaultPlan === id) throw new PlanConflictError(id, 'is the default plan');
      const tenants = await deps.countTenants(id);
      if (tenants > 0) throw new PlanConflictError(id, `${tenants} tenant(s) use this plan`);
      await deps.plans.save({
        ...current,
        archived: true,
        updatedAt: deps.clock.now(),
        updatedBy: by,
      });
      await loadPlans();
      deps.invalidate('plans');
      await deps.publish('plan.updated', { planId: id, action: 'archived', by });
      return 'archived';
    },
  };

  const urlOf = async (value: string | null) =>
    value === null ? null : /^(https?:)?\/\//.test(value) ? value : deps.assetUrl(value);

  const platformInfo = async (): Promise<PlatformInfo> => ({
    ...structuredClone(platform.settings),
    logoUrl: await urlOf(platform.settings.logo),
    faviconUrl: await urlOf(platform.settings.favicon),
    updatedAt: platform.updatedAt,
    updatedBy: platform.updatedBy,
  });

  const save = async (settings: PlatformSettings, by: string | null, fields: string[]) => {
    const updatedAt = deps.clock.now();
    await deps.platform.save(settings, { updatedAt, updatedBy: by });
    platform = { settings, updatedAt, updatedBy: by };
    deps.invalidate('platform');
    await deps.publish('platform.updated', { fields, by });
  };

  const platformApi: PlatformApi = {
    async get() {
      await ensure();
      return platformInfo();
    },
    async public() {
      await ensure();
      const p = await platformInfo();
      return {
        name: p.name,
        logoUrl: p.logoUrl,
        faviconUrl: p.faviconUrl,
        primary: p.primary,
        contact: { ...p.contact },
      };
    },
    async update(patch, options = {}) {
      await ensure();
      await loadPlatform();
      const next = mergePlatform(platform.settings, patch);
      await save(next, options.by ?? null, Object.keys(patch));
      return platformInfo();
    },
    async upload(kind, body, extension, options = {}) {
      await ensure();
      if (!EXT.test(extension)) throw new InvalidPlanError(null, 'invalid file extension');
      const { createHash } = await import('node:crypto');
      const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
      const path = `platform/${kind}-${hash}.${extension}`;
      await deps.storage.put(
        `central/${path}`,
        body,
        options.contentType ? { contentType: options.contentType } : {},
      );
      await loadPlatform();
      await save(mergePlatform(platform.settings, { [kind]: path }), options.by ?? null, [kind]);
      return platformInfo();
    },
    async reload() {
      await ensure();
      await loadPlatform();
    },
  };

  return {
    plans: plansApi,
    platform: platformApi,
    ensure,
    /** Otra instancia avisó un cambio. */
    onInvalidation: (kind: 'plans' | 'platform') =>
      void (kind === 'plans' ? loadPlans() : loadPlatform()).catch(() => undefined),
    close: () => {
      if (timer) clearInterval(timer);
    },
  };
}
