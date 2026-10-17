import type { PlanOverride, PlatformSettings } from '../../domain/index.js';
import type { PlanSettingsRepository, PlatformSettingsRepository } from '../../ports/index.js';

/** Cambios de planes en memoria (tests; se pierden al reiniciar). */
export class InMemoryPlanSettingsRepository implements PlanSettingsRepository {
  private readonly rows = new Map<string, PlanOverride>();
  async list() {
    return [...this.rows.values()]
      .sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.planId.localeCompare(b.planId),
      )
      .map((o) => structuredClone(o));
  }
  async save(override: PlanOverride) {
    this.rows.set(override.planId, structuredClone(override));
  }
  async delete(planId: string) {
    return this.rows.delete(planId);
  }
}

/** Marca de la plataforma en memoria (tests; se pierde al reiniciar). */
export class InMemoryPlatformSettingsRepository implements PlatformSettingsRepository {
  private row:
    { settings: PlatformSettings; updatedAt: Date; updatedBy: string | null } | undefined;
  async get() {
    return this.row ? structuredClone(this.row) : undefined;
  }
  async save(settings: PlatformSettings, meta: { updatedAt: Date; updatedBy: string | null }) {
    this.row = structuredClone({ settings, ...meta });
  }
}
