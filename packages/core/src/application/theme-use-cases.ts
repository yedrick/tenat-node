import { TenancyEvents, Theme, type ThemePatch, type ThemeProps } from '../domain/index.js';
import type { Clock, EventBus, TenantRepository } from '../ports/index.js';
import { requireTenant, type TenantRef } from './shared.js';

export class UpdateThemeUseCase {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly events: EventBus,
    private readonly clock: Clock,
    private readonly themeDefaults: ThemeProps,
  ) {}

  /** Aplica un cambio parcial al tema del tenant. `null` vuelve al tema por defecto. */
  async execute(ref: TenantRef, patch: ThemePatch | null): Promise<Theme> {
    const tenant = await requireTenant(this.tenants, ref);
    const base = tenant.theme ?? Theme.create(this.themeDefaults);
    const next = patch === null ? null : base.merge(patch);

    if (next === null ? tenant.theme === null : tenant.theme?.equals(next)) {
      return next ?? base;
    }

    tenant.changeTheme(next, this.clock.now());
    await this.tenants.save(tenant);
    await this.events.publish(TenancyEvents.themeUpdated(tenant));
    return next ?? base;
  }
}
