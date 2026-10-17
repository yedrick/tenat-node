import { TenantId, TenantNotFoundError, type InvoiceStatus } from '@tenancy-node/core';
import * as v from 'valibot';
import type { AdminContext } from '../context.js';
import { AdminHttpError, route } from '../http.js';

const isoDate = v.pipe(v.string(), v.isoTimestamp());
const tenantParam = (value: string) => {
  if (!TenantId.isValid(value)) throw new TenantNotFoundError(value);
  return value;
};
const INVOICE_STATUSES = ['open', 'paid', 'void'] as const;

export function billingRoutes(ctx: AdminContext) {
  const b = ctx.tenancy.billing;
  return [
    route({
      method: 'GET',
      path: '/billing/invoices',
      permission: 'billing:read',
      tag: 'billing',
      summary: 'Facturas de todos los tenants (las vencidas con ?overdue=1)',
      query: {
        status: 'open | paid | void',
        tenant: 'id del tenant',
        overdue: '1 = vencidas',
        page: 'página',
        perPage: 'por página',
      },
      async handler(request) {
        const status = request.query.get('status') || undefined;
        if (status && !INVOICE_STATUSES.includes(status as InvoiceStatus))
          throw new AdminHttpError(422, 'ADMIN_INVALID_STATUS', `Unknown status ${status}`);
        const tenant = request.query.get('tenant') || undefined;
        const overdue = request.query.get('overdue') === '1';
        const result = await b.invoices({
          page: Number(request.query.get('page') ?? 1) || 1,
          perPage: Number(request.query.get('perPage') ?? 20) || 20,
          ...(overdue
            ? { status: ['open'], dueBefore: new Date() }
            : status
              ? { status: [status as InvoiceStatus] }
              : {}),
          ...(tenant ? { tenantId: tenant } : {}),
        });
        const pastDue = await b.subscriptions({ status: ['past_due'], perPage: 1 });
        const open = await b.invoices({ status: ['open'], perPage: 1 });
        const overdueCount = await b.invoices({
          status: ['open'],
          dueBefore: new Date(),
          perPage: 1,
        });
        return {
          body: {
            ...result,
            summary: {
              open: open.total,
              overdue: overdueCount.total,
              pastDueSubscriptions: pastDue.total,
            },
            providers: b.providers,
          },
        };
      },
    }),
    route({
      method: 'GET',
      path: '/tenants/:id/billing',
      permission: 'billing:read',
      tag: 'billing',
      summary: 'Suscripción, facturas y pagos de un tenant',
      async handler(request) {
        const id = tenantParam(request.params.id!);
        await ctx.tenancy.tenants.findOrFail(id);
        const [subscription, invoices, payments] = await Promise.all([
          b.subscription(id),
          b.invoices({ tenantId: id, perPage: 50 }),
          b.payments({ tenantId: id, limit: 50 }),
        ]);
        return {
          body: {
            subscription: subscription ?? null,
            invoices: invoices.items,
            payments,
            providers: b.providers,
          },
        };
      },
    }),
    route({
      method: 'PUT',
      path: '/tenants/:id/billing/subscription',
      permission: 'billing:write',
      tag: 'billing',
      summary:
        'Crea o cambia la suscripción (plan, período, monto, prueba); sin prueba factura el primer período',
      body: v.object({
        plan: v.optional(v.nullable(v.string())),
        period: v.optional(v.picklist(['monthly', 'yearly'])),
        amount: v.optional(v.number()),
        currency: v.optional(v.string()),
        startsAt: v.optional(isoDate),
        trialDays: v.optional(v.number()),
        provider: v.optional(v.string()),
      }),
      async handler(request) {
        const id = tenantParam(request.params.id!);
        const body = request.body;
        const before = (await b.subscription(id)) ?? null;
        const sub = await b.subscribe(id, {
          ...(body.plan !== undefined ? { plan: body.plan } : {}),
          ...(body.period ? { period: body.period } : {}),
          ...(body.amount !== undefined ? { amount: body.amount } : {}),
          ...(body.currency ? { currency: body.currency } : {}),
          ...(body.startsAt ? { startsAt: new Date(body.startsAt) } : {}),
          ...(body.trialDays !== undefined ? { trialDays: body.trialDays } : {}),
          ...(body.provider ? { provider: body.provider } : {}),
        });
        await ctx.record(request, {
          action: 'billing.subscribe',
          tenantId: id,
          changes: {
            before: before && {
              plan: before.plan,
              period: before.period,
              amountCents: before.amountCents,
              status: before.status,
            },
            after: {
              plan: sub.plan,
              period: sub.period,
              amountCents: sub.amountCents,
              status: sub.status,
            },
          },
        });
        return { body: sub };
      },
    }),
    route({
      method: 'POST',
      path: '/tenants/:id/billing/cancel',
      permission: 'billing:write',
      tag: 'billing',
      summary: 'Cancela la suscripción (deja de facturar)',
      async handler(request) {
        const id = tenantParam(request.params.id!);
        const sub = await b.cancel(id);
        await ctx.record(request, { action: 'billing.cancel', tenantId: id });
        return { body: sub };
      },
    }),
    route({
      method: 'POST',
      path: '/tenants/:id/billing/invoices',
      permission: 'billing:write',
      tag: 'billing',
      summary:
        'Emite una factura: el próximo período (sin body) o un cobro suelto { description, amount }',
      body: v.optional(
        v.object({
          description: v.optional(v.string()),
          amount: v.optional(v.number()),
          currency: v.optional(v.string()),
          dueAt: v.optional(isoDate),
        }),
        {},
      ),
      async handler(request) {
        const id = tenantParam(request.params.id!);
        const body = request.body;
        const invoice = await b.invoice(id, {
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.amount !== undefined ? { amount: body.amount } : {}),
          ...(body.currency ? { currency: body.currency } : {}),
          ...(body.dueAt ? { dueAt: new Date(body.dueAt) } : {}),
        });
        await ctx.record(request, {
          action: 'billing.invoice',
          tenantId: id,
          targetType: 'invoice',
          targetId: invoice.id,
          changes: {
            after: { amountCents: invoice.amountCents, description: invoice.description },
          },
        });
        return { status: 201, body: invoice };
      },
    }),
    route({
      method: 'POST',
      path: '/billing/invoices/:id/payments',
      permission: 'billing:write',
      tag: 'billing',
      summary: 'Registra un pago manual (transferencia, QR, efectivo...) de una factura',
      body: v.optional(
        v.object({
          amount: v.optional(v.number()),
          method: v.optional(v.string()),
          reference: v.optional(v.nullable(v.string())),
          paidAt: v.optional(isoDate),
        }),
        {},
      ),
      async handler(request) {
        const body = request.body;
        const { invoice, payment } = await b.pay(request.params.id!, {
          ...(body.amount !== undefined ? { amount: body.amount } : {}),
          ...(body.method ? { method: body.method } : {}),
          ...(body.reference !== undefined ? { reference: body.reference } : {}),
          ...(body.paidAt ? { paidAt: new Date(body.paidAt) } : {}),
          recordedBy: request.user?.email ?? null,
        });
        await ctx.record(request, {
          action: 'billing.payment',
          tenantId: invoice.tenantId,
          targetType: 'invoice',
          targetId: invoice.id,
          changes: {
            after: {
              amountCents: payment.amountCents,
              method: payment.method,
              reference: payment.reference,
              status: invoice.status,
            },
          },
        });
        return { status: 201, body: { invoice, payment } };
      },
    }),
    route({
      method: 'POST',
      path: '/billing/invoices/:id/void',
      permission: 'billing:write',
      tag: 'billing',
      summary: 'Anula una factura sin pagos',
      async handler(request) {
        const invoice = await b.void(request.params.id!);
        await ctx.record(request, {
          action: 'billing.void',
          tenantId: invoice.tenantId,
          targetType: 'invoice',
          targetId: invoice.id,
        });
        return { body: invoice };
      },
    }),
    route({
      method: 'POST',
      path: '/billing/invoices/:id/checkout',
      permission: 'billing:write',
      tag: 'billing',
      summary: 'Genera el enlace de pago o el QR con una pasarela',
      body: v.optional(
        v.object({ provider: v.optional(v.string()), returnUrl: v.optional(v.string()) }),
        {},
      ),
      async handler(request) {
        const body = request.body;
        const session = await b.checkout(request.params.id!, {
          ...(body.provider ? { provider: body.provider } : {}),
          ...(body.returnUrl ? { returnUrl: body.returnUrl } : {}),
        });
        return { body: session };
      },
    }),
    route({
      method: 'POST',
      path: '/billing/run',
      permission: 'billing:write',
      tag: 'billing',
      summary: 'Corre el ciclo de cobro ahora (facturas por vencer, vencidas y suspensiones)',
      async handler(request) {
        const result = await b.run();
        await ctx.record(request, { action: 'billing.run', changes: { after: result } });
        return { body: result };
      },
    }),
    route({
      method: 'POST',
      path: '/billing/webhooks/:provider',
      permission: null,
      tag: 'billing',
      summary: 'Webhook de la pasarela de pago (la pasarela verifica la firma)',
      upload: {
        maxBytes: 1024 * 1024,
        contentTypes: ['application/json', 'application/x-www-form-urlencoded', 'text/plain'],
      },
      async handler(request) {
        const provider = request.params.provider!;
        if (!b.providers.includes(provider) || provider === 'manual')
          throw new AdminHttpError(404, 'ADMIN_NOT_FOUND', 'Not found');
        const body = (request.body as Buffer | undefined)?.toString('utf8') ?? '';
        try {
          const result = await b.webhook(provider, { headers: request.headers, body });
          return { body: { received: true, handled: result.handled } };
        } catch (error) {
          ctx.tenancy.observability.report('billing.webhook', error, { provider });
          throw new AdminHttpError(400, 'ADMIN_WEBHOOK_INVALID', 'Invalid webhook');
        }
      },
    }),
  ];
}
