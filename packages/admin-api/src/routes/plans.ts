import type { AdminContext } from '../context.js';
import { route } from '../http.js';

/** Tenants (sin borrar) por plan. La llave `''` cuenta los que no tienen plan. */
export async function tenantsByPlan(ctx: AdminContext): Promise<Record<string, number>> {
  const rows = await ctx.central.db
    .selectFrom('tenants')
    .select(['plan', (eb) => eb.fn.countAll<number | string>().as('n')])
    .where('deleted_at', 'is', null)
    .groupBy('plan')
    .execute();
  return Object.fromEntries(rows.map((r) => [r.plan ?? '', Number(r.n)]));
}

export function planRoutes(ctx: AdminContext) {
  const t = ctx.tenancy;
  return [
    route({
      method: 'GET',
      path: '/plans',
      permission: 'tenants:read',
      tag: 'plans',
      summary: 'Planes de la configuración, catálogo de módulos y cuántos tenants tiene cada plan',
      async handler() {
        const counts = await tenantsByPlan(ctx);
        const plans = t.plans.list();
        const known = new Set(plans.map((p) => p.id));
        const defaultPlan = t.plans.defaultPlan;
        return {
          body: {
            enabled: t.features.enabled,
            defaultPlan,
            features: t.features.catalog(),
            plans: plans.map((p) => ({
              ...p,
              // Los tenants sin plan usan el plan por defecto.
              tenants: (counts[p.id] ?? 0) + (p.id === defaultPlan ? (counts[''] ?? 0) : 0),
            })),
            withoutPlan: defaultPlan === null ? (counts[''] ?? 0) : 0,
            // Planes guardados en tenants que ya no están en la configuración.
            unknown: Object.entries(counts)
              .filter(([plan]) => plan !== '' && !known.has(plan))
              .map(([plan, tenants]) => ({ plan, tenants })),
          },
        };
      },
    }),
    route({
      method: 'GET',
      path: '/fonts',
      permission: 'tenants:read',
      tag: 'theme',
      summary: 'Fuentes permitidas para el tema (theme.fonts), con la URL de su CSS',
      async handler() {
        const fonts = t.theme.fonts();
        return { body: { restricted: fonts.length > 0, fonts } };
      },
    }),
  ];
}
