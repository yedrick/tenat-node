import type { PlanInput, PlatformPatch } from '@tenancy-node/core';
import * as v from 'valibot';
import type { AdminContext } from '../context.js';
import { AdminHttpError, route } from '../http.js';
import { IMAGE_TYPES } from './tenants.js';

const Price = v.nullable(
  v.object({
    currency: v.pipe(v.string(), v.regex(/^[A-Z]{3}$/)),
    monthly: v.optional(v.nullable(v.number())),
    yearly: v.optional(v.nullable(v.number())),
  }),
);
const PlanFields = {
  label: v.optional(v.string()),
  description: v.optional(v.nullable(v.string())),
  price: v.optional(Price),
  features: v.optional(v.union([v.literal('*'), v.array(v.string())])),
  limits: v.optional(v.record(v.string(), v.nullable(v.number()))),
  public: v.optional(v.boolean()),
  highlight: v.optional(v.boolean()),
};
const pickPlan = (b: Record<string, unknown>): PlanInput =>
  Object.fromEntries(
    Object.entries(b).filter(([k, val]) => k !== 'id' && val !== undefined),
  ) as PlanInput;

/** Favicon: además de las imágenes del logo, ICO. */
const ICO = {
  type: 'image/x-icon',
  ext: 'ico',
  test: (b: Buffer) => b.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])),
};

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
        const plans = await t.plans.describe();
        const known = new Set(plans.filter((p) => !p.archived).map((p) => p.id));
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
      method: 'POST',
      path: '/plans',
      permission: 'plans:write',
      tag: 'plans',
      summary: 'Crea un plan desde el panel (módulos solo del catálogo de código)',
      body: v.object({
        id: v.string(),
        ...PlanFields,
        label: v.string(),
        features: PlanFields.features.wrapped,
      }),
      async handler(request) {
        const b = request.body;
        const plan = await t.plans.create(
          b.id,
          { ...pickPlan(b), label: b.label, features: b.features },
          { by: request.user?.email ?? null },
        );
        await ctx.record(request, {
          action: 'plan.create',
          targetType: 'plan',
          targetId: b.id,
          changes: { after: plan },
        });
        return { status: 201, body: plan };
      },
    }),
    route({
      method: 'PATCH',
      path: '/plans/:id',
      permission: 'plans:write',
      tag: 'plans',
      summary: 'Cambia nombre, precio, módulos, límites o visibilidad de un plan (sin desplegar)',
      body: v.object(PlanFields),
      async handler(request) {
        const id = request.params.id!;
        const before = (await t.plans.describe()).find((p) => p.id === id) ?? null;
        const plan = await t.plans.update(id, pickPlan(request.body), {
          by: request.user?.email ?? null,
        });
        await ctx.record(request, {
          action: 'plan.update',
          targetType: 'plan',
          targetId: id,
          changes: { before, after: plan },
        });
        return { body: plan };
      },
    }),
    route({
      method: 'DELETE',
      path: '/plans/:id',
      permission: 'plans:write',
      tag: 'plans',
      summary:
        'Plan de la configuración: vuelve a sus valores de código. Plan del panel: lo archiva (409 si lo usan tenants)',
      async handler(request) {
        const id = request.params.id!;
        const result = await t.plans.remove(id, { by: request.user?.email ?? null });
        await ctx.record(request, {
          action: `plan.${result === 'reset' ? 'reset' : 'archive'}`,
          targetType: 'plan',
          targetId: id,
        });
        return { body: { id, result } };
      },
    }),
    route({
      method: 'GET',
      path: '/platform',
      permission: 'tenants:read',
      tag: 'platform',
      summary: 'Marca y contacto de la plataforma (incluye los correos de ventas)',
      async handler() {
        return { body: await t.platform.get() };
      },
    }),
    route({
      method: 'PATCH',
      path: '/platform',
      permission: 'platform:write',
      tag: 'platform',
      summary:
        'Cambia nombre, color, contacto (WhatsApp, email) y correos de ventas; null borra un campo',
      body: v.object({
        name: v.optional(v.nullable(v.string())),
        primary: v.optional(v.nullable(v.string())),
        logo: v.optional(v.nullable(v.string())),
        favicon: v.optional(v.nullable(v.string())),
        contact: v.optional(
          v.object({
            whatsapp: v.optional(v.nullable(v.string())),
            email: v.optional(v.nullable(v.string())),
          }),
        ),
        salesNotifyTo: v.optional(v.array(v.string())),
      }),
      async handler(request) {
        const before = await t.platform.get();
        const after = await t.platform.update(withoutUndefined(request.body) as PlatformPatch, {
          by: request.user?.email ?? null,
        });
        await ctx.record(request, {
          action: 'platform.update',
          changes: { before: pickKeys(before, request.body), after: pickKeys(after, request.body) },
        });
        return { body: after };
      },
    }),
    ...(['logo', 'favicon'] as const).map((kind) =>
      route({
        method: 'PUT',
        path: `/platform/${kind}`,
        permission: 'platform:write',
        tag: 'platform',
        summary: `Sube el ${kind} de la plataforma (PNG, JPEG, GIF o WebP${kind === 'favicon' ? ' o ICO' : ''}; sin SVG) al almacenamiento central`,
        upload: {
          maxBytes: ctx.options.logoMaxBytes,
          contentTypes: [
            ...IMAGE_TYPES.map((i) => i.type),
            ...(kind === 'favicon' ? [ICO.type] : []),
          ],
        },
        async handler(request) {
          const bytes = request.body as Buffer | undefined;
          if (!bytes)
            throw new AdminHttpError(
              422,
              'ADMIN_EMPTY_UPLOAD',
              'Send the image in the request body',
            );
          const types = kind === 'favicon' ? [...IMAGE_TYPES, ICO] : [...IMAGE_TYPES];
          const image = types.find((i) => i.test(bytes));
          if (!image)
            throw new AdminHttpError(
              415,
              'ADMIN_UNSUPPORTED_IMAGE',
              `The ${kind} must be a PNG, JPEG, GIF or WebP image`,
            );
          const before = (await t.platform.get())[kind];
          const after = await t.platform.upload(kind, bytes, image.ext, {
            contentType: image.type,
            by: request.user?.email ?? null,
          });
          await ctx.record(request, {
            action: `platform.${kind}_upload`,
            changes: {
              before: { [kind]: before },
              after: { [kind]: after[kind] },
              size: bytes.length,
              type: image.type,
            },
          });
          return { body: after };
        },
      }),
    ),
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

function pickKeys(value: object, keys: object) {
  return Object.fromEntries(
    Object.keys(keys).map((k) => [k, (value as Record<string, unknown>)[k]]),
  );
}

/** Quita las llaves `undefined` (también dentro de `contact`). */
function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [
        k,
        v && typeof v === 'object' && !Array.isArray(v)
          ? withoutUndefined(v as Record<string, unknown>)
          : v,
      ]),
  );
}
