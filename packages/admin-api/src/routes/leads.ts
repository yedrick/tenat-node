import { RateLimiter } from '../auth/rate-limit.js';
import type { AdminContext } from '../context.js';
import { AdminHttpError, route } from '../http.js';
import { LEAD_STATUSES, type Lead, type LeadStatus, type NewLead } from '../leads.js';
import * as v from 'valibot';

declare module '@tenancy-node/core' {
  interface TenancyEventMap {
    /** Llegó una solicitud de la web comercial: avisa por correo, WhatsApp o al CRM. */
    'lead.created': {
      id: number;
      name: string;
      company: string | null;
      city: string | null;
      phone: string | null;
      email: string | null;
      plan: string | null;
      message: string | null;
      /** Correos de ventas de la plataforma (`platform.salesNotifyTo`), para el aviso. */
      notifyTo: string[];
    };
  }
}

const text = (max: number) =>
  v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(max))));

/** Cuerpo del formulario público. `website` es el campo trampa: un humano lo deja vacío. */
const LeadBody = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(150)),
  company: text(150),
  city: text(100),
  phone: v.optional(
    v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(50), v.regex(/^[0-9+()\s.-]*$/))),
  ),
  email: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(191), v.email()))),
  plan: text(50),
  message: text(2000),
  consent: v.optional(v.boolean()),
  website: v.optional(v.string()),
  data: v.optional(v.record(v.string(), v.pipe(v.string(), v.maxLength(500)))),
});

const LeadPatch = v.object({
  status: v.optional(v.picklist(LEAD_STATUSES)),
  notes: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(5000)))),
  tenantId: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(40)))),
});

const leadId = (value: string) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1)
    throw new AdminHttpError(404, 'ADMIN_LEAD_NOT_FOUND', 'Lead not found');
  return id;
};

/**
 * Crea una solicitud y publica `lead.created`. La usan la ruta pública y `admin.leads.create()`
 * (para un formulario que tu app atiende en su propio servidor).
 */
export async function createLead(ctx: AdminContext, input: NewLead): Promise<Lead> {
  const t = ctx.tenancy;
  // Un plan que no existe (o un formulario viejo) no rompe la solicitud: queda sin plan.
  const plan = input.plan && (!t.features.enabled || t.plans.get(input.plan)) ? input.plan : null;
  const lead = await ctx.leads.create({ ...input, plan });
  const notifyTo = (await t.platform.get()).salesNotifyTo;
  await t.central(() =>
    t.events.publish('lead.created', {
      id: lead.id,
      name: lead.name,
      company: lead.company,
      city: lead.city,
      phone: lead.phone,
      email: lead.email,
      plan: lead.plan,
      message: lead.message,
      notifyTo,
    }),
  );
  return lead;
}

export function leadRoutes(ctx: AdminContext) {
  const options = ctx.options.leads;
  const limiter = options
    ? new RateLimiter(options.rateLimit.max, options.rateLimit.windowMs)
    : null;

  const publicRoutes = options
    ? [
        route({
          method: 'POST',
          path: '/leads',
          permission: null,
          tag: 'leads',
          summary:
            'Formulario público "Solicitar demo" (sin sesión, límite por IP, campo trampa `website`)',
          body: LeadBody,
          async handler(request) {
            const b = request.body;
            const key = `lead:${request.ip ?? 'unknown'}`;
            if (!limiter!.allowed(key))
              throw new AdminHttpError(429, 'ADMIN_TOO_MANY_REQUESTS', 'Too many requests', {
                retryAfter: limiter!.retryAfterSeconds(key),
              });
            // Bot: se responde igual que a un humano, pero no se guarda nada (y cuenta para el límite).
            if (b.website) {
              limiter!.fail(key);
              return { status: 201, body: { ok: true } };
            }
            const errors: { path: string; message: string }[] = [];
            if (!b.email && !b.phone)
              errors.push({ path: 'email', message: 'Email or phone is required' });
            if (options!.requireConsent && b.consent !== true)
              errors.push({ path: 'consent', message: 'Consent is required' });
            const extra = Object.entries(b.data ?? {});
            const unknown = extra.filter(([k]) => !options!.extraFields.includes(k));
            for (const [k] of unknown) errors.push({ path: `data.${k}`, message: 'Unknown field' });
            if (errors.length > 0)
              throw new AdminHttpError(
                422,
                'ADMIN_VALIDATION_FAILED',
                'Invalid request body',
                errors,
              );
            // Solo cuentan los envíos válidos: corregir un campo no gasta intentos.
            limiter!.fail(key);
            await createLead(ctx, {
              name: b.name,
              company: b.company ?? null,
              city: b.city ?? null,
              phone: b.phone || null,
              email: b.email || null,
              plan: b.plan ?? null,
              message: b.message ?? null,
              data: Object.fromEntries(extra),
              ip: request.ip,
              consent: b.consent === true,
            });
            return { status: 201, body: { ok: true } };
          },
        }),
      ]
    : [];

  return [
    ...publicRoutes,
    route({
      method: 'GET',
      path: '/leads',
      permission: 'leads:read',
      tag: 'leads',
      summary: 'Solicitudes de la web comercial, más nuevas primero',
      query: {
        status: LEAD_STATUSES.join(' | '),
        search: 'nombre, clínica, email o ciudad',
        page: 'página',
        perPage: 'por página (máx. 100)',
      },
      async handler(request) {
        const status = request.query.get('status') || undefined;
        if (status && !LEAD_STATUSES.includes(status as LeadStatus))
          throw new AdminHttpError(422, 'ADMIN_INVALID_STATUS', `Unknown status ${status}`);
        const search = request.query.get('search') || undefined;
        const result = await ctx.leads.list({
          page: Number(request.query.get('page') ?? 1) || 1,
          perPage: Number(request.query.get('perPage') ?? 20) || 20,
          ...(status ? { status: status as LeadStatus } : {}),
          ...(search ? { search } : {}),
        });
        return { body: { ...result, counts: await ctx.leads.countByStatus() } };
      },
    }),
    route({
      method: 'GET',
      path: '/leads/:id',
      permission: 'leads:read',
      tag: 'leads',
      summary: 'Detalle de una solicitud',
      async handler(request) {
        const lead = await ctx.leads.find(leadId(request.params.id!));
        if (!lead) throw new AdminHttpError(404, 'ADMIN_LEAD_NOT_FOUND', 'Lead not found');
        return { body: lead };
      },
    }),
    route({
      method: 'PATCH',
      path: '/leads/:id',
      permission: 'leads:write',
      tag: 'leads',
      summary: 'Cambia el estado, las notas o el tenant creado a partir de la solicitud',
      body: LeadPatch,
      async handler(request) {
        const id = leadId(request.params.id!);
        const before = await ctx.leads.find(id);
        if (!before) throw new AdminHttpError(404, 'ADMIN_LEAD_NOT_FOUND', 'Lead not found');
        const b = request.body;
        const after = (await ctx.leads.update(id, {
          ...(b.status !== undefined ? { status: b.status } : {}),
          ...(b.notes !== undefined ? { notes: b.notes } : {}),
          ...(b.tenantId !== undefined ? { tenantId: b.tenantId } : {}),
        }))!;
        await ctx.record(request, {
          action: 'lead.update',
          tenantId: after.tenantId,
          targetType: 'lead',
          targetId: id,
          changes: {
            before: { status: before.status, tenantId: before.tenantId },
            after: { status: after.status, tenantId: after.tenantId },
          },
        });
        return { body: after };
      },
    }),
    route({
      method: 'DELETE',
      path: '/leads/:id',
      permission: 'leads:write',
      tag: 'leads',
      summary: 'Borra una solicitud (spam)',
      async handler(request) {
        const id = leadId(request.params.id!);
        if (!(await ctx.leads.delete(id)))
          throw new AdminHttpError(404, 'ADMIN_LEAD_NOT_FOUND', 'Lead not found');
        await ctx.record(request, { action: 'lead.delete', targetType: 'lead', targetId: id });
        return { status: 204 };
      },
    }),
  ];
}
