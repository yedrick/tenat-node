import {
  FontCatalog,
  TenancyEvents,
  Theme,
  type ThemePatch,
  type ThemeProps,
} from '../domain/index.js';
import type { Clock, EventBus, TenantRepository } from '../ports/index.js';
import { requireTenant, type TenantRef } from './shared.js';

export class UpdateThemeUseCase {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly events: EventBus,
    private readonly clock: Clock,
    private readonly themeDefaults: ThemeProps,
    private readonly fonts: FontCatalog = new FontCatalog(),
  ) {}

  /** Aplica un cambio parcial al tema del tenant. `null` vuelve al tema por defecto. */
  async execute(ref: TenantRef, patch: ThemePatch | null): Promise<Theme> {
    const tenant = await requireTenant(this.tenants, ref);
    const base = tenant.theme ?? Theme.create(this.themeDefaults);
    // La fuente se valida solo si cambia: un tema guardado antes de la lista (o con otras
    // mayúsculas) se puede seguir editando sin tocar la fuente.
    let fixed = patch;
    if (patch?.font) {
      const same = base.font !== undefined && base.font.toLowerCase() === patch.font.toLowerCase();
      const font =
        same && !this.fonts.get(patch.font) ? base.font! : this.fonts.canonical(patch.font);
      fixed = { ...patch, font };
    }
    const next = fixed === null ? null : base.merge(fixed);

    if (next === null ? tenant.theme === null : tenant.theme?.equals(next)) {
      return next ?? base;
    }

    tenant.changeTheme(next, this.clock.now());
    await this.tenants.save(tenant);
    await this.events.publish(TenancyEvents.themeUpdated(tenant));
    return next ?? base;
  }
}
