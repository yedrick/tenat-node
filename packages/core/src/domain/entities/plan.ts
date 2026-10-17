import { InvalidConfigError, InvalidPlanError, InvalidTenantDataError } from '../errors/errors.js';

/**
 * Catálogo de módulos de tu aplicación, para autocompletar sus nombres (opcional):
 *
 * ```ts
 * declare module '@tenancy-node/core' {
 *   interface TenancyFeatureMap { reportes: true; agenda: true }
 *   interface TenancyLimitMap { usuarios: true }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TenancyFeatureMap {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TenancyLimitMap {}

/** Nombre de un módulo: `string`, o las llaves de `TenancyFeatureMap` si la declaraste. */
export type FeatureName = [keyof TenancyFeatureMap] extends [never]
  ? string
  : Extract<keyof TenancyFeatureMap, string>;
/** Nombre de un límite: `string`, o las llaves de `TenancyLimitMap` si la declaraste. */
export type LimitName = [keyof TenancyLimitMap] extends [never]
  ? string
  : Extract<keyof TenancyLimitMap, string>;

export interface FeatureDefinition {
  label: string;
  description?: string;
}

export interface PlanPrice {
  /** Moneda (`BOB`, `USD`...). */
  currency: string;
  monthly?: number | null;
  yearly?: number | null;
}

export interface PlanDefinition {
  label: string;
  description?: string;
  /** Precio que muestra la web comercial (`GET /tenancy/plans`). Sin precio: "a consultar". */
  price?: PlanPrice | null;
  /** Módulos del plan, o `'*'` para todos los del catálogo. */
  features: readonly string[] | '*';
  /** Límites del plan (`{ usuarios: 3 }`). `null` o sin la llave = sin límite. */
  limits?: Readonly<Record<string, number | null>>;
  /** Si aparece en `GET /tenancy/plans`. Por defecto `true`. */
  public?: boolean;
  /** Plan destacado en la web comercial ("el más elegido"). */
  highlight?: boolean;
}

/** Cambios de un tenant respecto de su plan: módulos sueltos y límites propios. */
export interface TenantFeatureOverrides {
  /** Módulos que se agregan al plan ("Básico + Reportes"). */
  add?: readonly string[] | undefined;
  /** Módulos del plan que este tenant no tiene. */
  remove?: readonly string[] | undefined;
  /** Límites propios: reemplazan los del plan. `null` = sin límite. */
  limits?: Readonly<Record<string, number | null>> | undefined;
}

/** Módulos y límites efectivos de un tenant (plan + cambios propios). */
export interface ResolvedFeatures {
  /** Plan efectivo (el del tenant, o `defaultPlan` si no tiene). */
  plan: string | null;
  planLabel: string | null;
  /** `false` si el tenant tiene un plan que ya no existe en la configuración. */
  knownPlan: boolean;
  /** El plan guardado que no existe en la configuración (se usa `defaultPlan` en su lugar). */
  unknownPlan: string | null;
  features: string[];
  limits: Record<string, number | null>;
}

export interface PublicPlan {
  id: string;
  label: string;
  description: string | null;
  price: PlanPrice | null;
  features: string[];
  limits: Record<string, number | null>;
  highlight: boolean;
  public: boolean;
}

/**
 * Cambios guardados desde el panel sobre un plan de la configuración (o un plan creado en el
 * panel). Un campo sin definir conserva el valor de la configuración.
 */
export interface PlanOverride {
  planId: string;
  label?: string;
  description?: string | null;
  /** `null` quita el precio ("a consultar"). */
  price?: PlanPrice | null;
  features?: readonly string[] | '*';
  limits?: Readonly<Record<string, number | null>>;
  public?: boolean;
  highlight?: boolean;
  /** Plan creado en el panel y archivado: no se ofrece ni se puede asignar. */
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
}

/** Plan tal como lo ve el panel: de dónde sale y si tiene cambios. */
export interface PlanInfo extends PublicPlan {
  /** `config`: definido en el código; `panel`: creado desde el panel. */
  source: 'config' | 'panel';
  /** Plan de la configuración con cambios guardados desde el panel. */
  customized: boolean;
  archived: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export interface FeatureInfo {
  id: string;
  label: string;
  description: string | null;
}

export interface PlanCatalogConfig {
  features?: Readonly<Record<string, string | FeatureDefinition>>;
  plans?: Readonly<Record<string, PlanDefinition>>;
  defaultPlan?: string;
}

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_OVERRIDES = 200;

/**
 * Catálogo de módulos y planes de la configuración. Es la única fuente: de aquí salen los
 * permisos de la API, `/tenancy/me`, el panel y los precios públicos.
 *
 * Sin `plans` el control está apagado: todo tenant tiene todos los módulos.
 */
export class PlanCatalog {
  private featureMap: ReadonlyMap<string, FeatureInfo>;
  private planMap: ReadonlyMap<string, PlanDefinition>;
  readonly defaultPlan: string | null;
  /** Configuración de código (sin cambios del panel). */
  private readonly base: PlanCatalogConfig;
  private overrides: ReadonlyMap<string, PlanOverride> = new Map();

  constructor(config: PlanCatalogConfig = {}) {
    this.base = config;
    const features = new Map<string, FeatureInfo>();
    for (const [id, value] of Object.entries(config.features ?? {})) {
      if (!KEY_PATTERN.test(id)) throw new InvalidConfigError(`features: invalid name "${id}"`);
      const def = typeof value === 'string' ? { label: value } : value;
      if (!def || typeof def.label !== 'string' || def.label.length === 0)
        throw new InvalidConfigError(`features.${id}: label is required`);
      features.set(id, { id, label: def.label, description: def.description ?? null });
    }
    const declared = features.size > 0;

    const plans = new Map<string, PlanDefinition>();
    for (const [id, plan] of Object.entries(config.plans ?? {})) {
      if (!KEY_PATTERN.test(id) || id.length > 50)
        throw new InvalidConfigError(`plans: invalid plan id "${id}"`);
      if (!plan || typeof plan.label !== 'string' || plan.label.length === 0)
        throw new InvalidConfigError(`plans.${id}: label is required`);
      if (plan.features !== '*') {
        if (!Array.isArray(plan.features))
          throw new InvalidConfigError(`plans.${id}.features: must be an array or '*'`);
        for (const feature of plan.features) {
          if (declared && !features.has(feature))
            throw new InvalidConfigError(
              `plans.${id}.features: "${feature}" is not in the features catalog`,
            );
          if (!KEY_PATTERN.test(feature))
            throw new InvalidConfigError(`plans.${id}.features: invalid name "${feature}"`);
          // Sin catálogo declarado, los módulos salen de los planes.
          if (!declared && !features.has(feature))
            features.set(feature, { id: feature, label: feature, description: null });
        }
      }
      validateLimits(
        plan.limits ?? {},
        (reason) => new InvalidConfigError(`plans.${id}.limits: ${reason}`),
      );
      if (plan.price) {
        if (typeof plan.price.currency !== 'string' || plan.price.currency.length === 0)
          throw new InvalidConfigError(`plans.${id}.price.currency is required`);
        for (const period of ['monthly', 'yearly'] as const) {
          const value = plan.price[period];
          if (value !== undefined && value !== null && (typeof value !== 'number' || value < 0))
            throw new InvalidConfigError(`plans.${id}.price.${period} must be a number >= 0`);
        }
      }
      plans.set(id, plan);
    }
    if (config.defaultPlan !== undefined && !plans.has(config.defaultPlan))
      throw new InvalidConfigError(`defaultPlan "${config.defaultPlan}" is not in plans`);

    this.featureMap = features;
    this.planMap = plans;
    this.defaultPlan = config.defaultPlan ?? null;
  }

  /**
   * Aplica los cambios guardados desde el panel (reemplaza los anteriores). Valida el resultado
   * como si fuera la configuración: si algo no cuadra, lanza `InvalidPlanError` y no cambia nada.
   */
  applyOverrides(overrides: readonly PlanOverride[]): void {
    const next = PlanCatalog.merge(this.base, this.featureMap, overrides);
    this.featureMap = next.featureMap;
    this.planMap = next.planMap;
    this.overrides = new Map(overrides.map((o) => [o.planId, o]));
  }

  /** Valida cómo quedaría el catálogo con estos cambios, sin aplicarlos. */
  check(overrides: readonly PlanOverride[]): void {
    PlanCatalog.merge(this.base, this.featureMap, overrides);
  }

  /** ¿El plan viene de la configuración de código? */
  isConfigPlan(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.base.plans ?? {}, id);
  }

  /** Planes para el panel (incluye los archivados), con su origen. */
  describe(): PlanInfo[] {
    const active = this.plans().map((p) => {
      const o = this.overrides.get(p.id);
      return {
        ...p,
        source: this.isConfigPlan(p.id) ? ('config' as const) : ('panel' as const),
        customized: this.isConfigPlan(p.id) && o !== undefined,
        archived: false,
        updatedAt: o?.updatedAt ?? null,
        updatedBy: o?.updatedBy ?? null,
      };
    });
    const archived = [...this.overrides.values()]
      .filter((o) => o.archived && !this.isConfigPlan(o.planId))
      .map((o) => ({
        id: o.planId,
        label: o.label ?? o.planId,
        description: o.description ?? null,
        price: o.price ? { ...o.price } : null,
        features: o.features === '*' ? [...this.featureMap.keys()] : [...(o.features ?? [])],
        limits: { ...o.limits },
        highlight: o.highlight ?? false,
        public: o.public !== false,
        source: 'panel' as const,
        customized: false,
        archived: true,
        updatedAt: o.updatedAt,
        updatedBy: o.updatedBy,
      }));
    return [...active, ...archived];
  }

  private static merge(
    base: PlanCatalogConfig,
    features: ReadonlyMap<string, FeatureInfo>,
    overrides: readonly PlanOverride[],
  ): PlanCatalog {
    const plans: Record<string, PlanDefinition> = { ...base.plans };
    // Los planes creados en el panel van después de los de código, en orden de creación.
    const sorted = [...overrides].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const o of sorted) {
      const current = plans[o.planId];
      if (!current) {
        if (o.archived) continue;
        if (!o.label || o.features === undefined)
          throw new InvalidPlanError(o.planId, 'a new plan needs label and features');
      }
      plans[o.planId] = {
        ...current,
        label: o.label ?? current!.label,
        features: o.features ?? current!.features,
        ...(o.description !== undefined ? { description: o.description ?? undefined } : {}),
        ...(o.price !== undefined ? { price: o.price } : {}),
        ...(o.limits !== undefined ? { limits: o.limits } : {}),
        ...(o.public !== undefined ? { public: o.public } : {}),
        ...(o.highlight !== undefined ? { highlight: o.highlight } : {}),
      } as PlanDefinition;
    }
    // El catálogo de módulos es el de código (o el derivado de los planes de código): el panel
    // no inventa módulos, porque la app los hace cumplir con requireFeature.
    const catalog = Object.fromEntries(
      [...features.values()].map((f) => [
        f.id,
        f.description ? { label: f.label, description: f.description } : f.label,
      ]),
    );
    try {
      return new PlanCatalog({
        features: catalog,
        plans,
        ...(base.defaultPlan !== undefined ? { defaultPlan: base.defaultPlan } : {}),
      });
    } catch (error) {
      if (error instanceof InvalidConfigError) throw new InvalidPlanError(null, error.message);
      throw error;
    }
  }

  /** `true` si hay planes configurados (el control de módulos está activo). */
  get enabled(): boolean {
    return this.planMap.size > 0;
  }

  features(): FeatureInfo[] {
    return [...this.featureMap.values()].map((f) => ({ ...f }));
  }

  hasFeature(id: string): boolean {
    return this.featureMap.has(id);
  }

  hasPlan(id: string): boolean {
    return this.planMap.has(id);
  }

  plan(id: string): PublicPlan | undefined {
    const def = this.planMap.get(id);
    return def ? this.toPublic(id, def) : undefined;
  }

  /** Planes en el orden de la configuración. `publicOnly` deja fuera los `public: false`. */
  plans(options: { publicOnly?: boolean } = {}): PublicPlan[] {
    return [...this.planMap.entries()]
      .filter(([, def]) => !options.publicOnly || def.public !== false)
      .map(([id, def]) => this.toPublic(id, def));
  }

  /** Módulos y límites efectivos para un plan y sus cambios. */
  resolve(plan: string | null, overrides: TenantFeatureOverrides | null): ResolvedFeatures {
    if (!this.enabled) {
      return {
        plan,
        planLabel: null,
        knownPlan: true,
        unknownPlan: null,
        features: [...this.featureMap.keys()],
        limits: { ...overrides?.limits },
      };
    }
    // Un plan que ya no existe se trata como "sin plan": usa defaultPlan (o ninguno).
    const unknown = plan !== null && !this.planMap.has(plan) ? plan : null;
    const id = unknown === null ? (plan ?? this.defaultPlan) : this.defaultPlan;
    const def = id === null ? undefined : this.planMap.get(id);
    const set = new Set(def ? this.planFeatures(def) : []);
    for (const f of overrides?.add ?? []) if (this.featureMap.has(f)) set.add(f);
    for (const f of overrides?.remove ?? []) set.delete(f);
    return {
      plan: id,
      planLabel: def?.label ?? null,
      knownPlan: unknown === null,
      unknownPlan: unknown,
      // Orden del catálogo: estable para menús y ETags.
      features: [...this.featureMap.keys()].filter((f) => set.has(f)),
      limits: { ...def?.limits, ...overrides?.limits },
    };
  }

  /** Lanza `InvalidTenantDataError` si hay planes configurados y `plan` no es uno de ellos. */
  validatePlan(plan: string | null | undefined): void {
    if (plan === null || plan === undefined || !this.enabled) return;
    if (!this.planMap.has(plan))
      throw new InvalidTenantDataError(
        'plan',
        `"${plan}" is not a configured plan (${[...this.planMap.keys()].join(', ')})`,
      );
  }

  /** Valida y normaliza los cambios propios de un tenant. `null` si no queda ninguno. */
  normalizeOverrides(
    overrides: TenantFeatureOverrides | null | undefined,
  ): TenantFeatureOverrides | null {
    const normalized = normalizeFeatureOverrides(overrides);
    if (!normalized || this.featureMap.size === 0) return normalized;
    for (const f of [...(normalized.add ?? []), ...(normalized.remove ?? [])]) {
      if (!this.featureMap.has(f))
        throw new InvalidTenantDataError('features', `"${f}" is not in the features catalog`);
    }
    return normalized;
  }

  private planFeatures(def: PlanDefinition): readonly string[] {
    return def.features === '*' ? [...this.featureMap.keys()] : def.features;
  }

  private toPublic(id: string, def: PlanDefinition): PublicPlan {
    const features = new Set(this.planFeatures(def));
    return {
      id,
      label: def.label,
      description: def.description ?? null,
      price: def.price ? { ...def.price } : null,
      features: [...this.featureMap.keys()].filter((f) => features.has(f)),
      limits: { ...def.limits },
      highlight: def.highlight ?? false,
      public: def.public !== false,
    };
  }
}

/** Valida la forma de los cambios propios (sin catálogo). `null` si quedan vacíos. */
export function normalizeFeatureOverrides(
  overrides: TenantFeatureOverrides | null | undefined,
): TenantFeatureOverrides | null {
  if (overrides === null || overrides === undefined) return null;
  const fail = (reason: string) => new InvalidTenantDataError('features', reason);
  if (typeof overrides !== 'object' || Array.isArray(overrides))
    throw fail('must be an object with add, remove and limits');
  const list = (name: 'add' | 'remove'): string[] => {
    const value = overrides[name];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw fail(`${name} must be an array of feature names`);
    for (const f of value)
      if (typeof f !== 'string' || !KEY_PATTERN.test(f))
        throw fail(`invalid feature name "${String(f)}"`);
    return [...new Set(value as string[])].sort();
  };
  const add = list('add');
  const remove = list('remove').filter((f) => !add.includes(f));
  const limits = { ...overrides.limits };
  validateLimits(limits, fail);
  if (add.length + remove.length + Object.keys(limits).length > MAX_OVERRIDES)
    throw fail(`at most ${MAX_OVERRIDES} entries are allowed`);
  const result: TenantFeatureOverrides = {};
  if (add.length > 0) result.add = add;
  if (remove.length > 0) result.remove = remove;
  if (Object.keys(limits).length > 0)
    result.limits = Object.fromEntries(
      Object.entries(limits).sort(([a], [b]) => a.localeCompare(b)),
    );
  return Object.keys(result).length > 0 ? result : null;
}

function validateLimits(
  limits: Readonly<Record<string, unknown>>,
  fail: (reason: string) => Error,
): void {
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits))
    throw fail('limits must be an object');
  for (const [key, value] of Object.entries(limits)) {
    if (!KEY_PATTERN.test(key)) throw fail(`invalid limit name "${key}"`);
    if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0))
      throw fail(`limit "${key}" must be an integer >= 0 or null`);
  }
}
