import type { PlanOverride, PlatformSettings } from '../domain/index.js';

/** Cambios de planes hechos desde el panel. La base central los guarda con `@tenancy-node/db`. */
export interface PlanSettingsRepository {
  list(): Promise<PlanOverride[]>;
  /** Crea o reemplaza los cambios de un plan. */
  save(override: PlanOverride): Promise<void>;
  /** `true` si existía. */
  delete(planId: string): Promise<boolean>;
}

/** Marca de la plataforma (una sola fila lógica, guardada como clave → JSON). */
export interface PlatformSettingsRepository {
  /** `undefined` si nunca se guardó. */
  get(): Promise<{ settings: PlatformSettings; updatedAt: Date; updatedBy: string | null } | undefined>;
  save(settings: PlatformSettings, meta: { updatedAt: Date; updatedBy: string | null }): Promise<void>;
}
