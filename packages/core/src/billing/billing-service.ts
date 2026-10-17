import {
  BILLING_PERIODS,
  BillingError,
  InvalidBillingError,
  addPeriod,
  toCents,
  validateCents,
  validateCurrency,
  type BillingPeriod,
  type Invoice,
  type Payment,
  type PublicPlan,
  type Subscription,
  type Tenant,
} from '../domain/index.js';
import type {
  BillingRepository,
  CheckoutSession,
  Clock,
  IdGenerator,
  Page,
  PaymentProvider,
} from '../ports/index.js';

export interface SubscribeInput {
  /** Cambia también el plan del tenant. Por defecto, el plan que ya tiene. */
  plan?: string | null;
  /** Por defecto `monthly`. */
  period?: BillingPeriod;
  /** Monto por período (con decimales: `150.5`). Por defecto, el precio del plan. */
  amount?: number;
  /** Por defecto, la moneda del precio del plan o `billing.currency`. */
  currency?: string;
  /** Inicio. Por defecto, ahora. */
  startsAt?: Date;
  /** Días de prueba sin cobro. */
  trialDays?: number;
  /** Por defecto `manual`. */
  provider?: string;
  providerRef?: string | null;
}

export interface InvoiceInput {
  /** Cobro suelto: descripción y monto. Sin `amount`, factura el próximo período de la suscripción. */
  description?: string;
  amount?: number;
  currency?: string;
  dueAt?: Date;
}

export interface PayInput {
  /** Por defecto, lo que falta pagar. */
  amount?: number;
  /** `transfer`, `qr`, `cash`, `card`... Por defecto `manual`. */
  method?: string;
  reference?: string | null;
  paidAt?: Date;
  recordedBy?: string | null;
  provider?: string;
  providerRef?: string | null;
}

export interface BillingRunResult {
  invoiced: string[];
  pastDue: string[];
  suspended: string[];
}

export interface BillingApi {
  /** Pasarelas configuradas (`manual` siempre está). */
  readonly providers: readonly string[];
  /** Crea o cambia la suscripción de un tenant. Sin prueba, emite la factura del primer período. */
  subscribe(tenant: string, input?: SubscribeInput): Promise<Subscription>;
  subscription(tenant: string): Promise<Subscription | undefined>;
  /** Cancela: deja de facturar. El tenant sigue con lo ya pagado. */
  cancel(tenant: string): Promise<Subscription>;
  /** Emite una factura (cobro suelto o el próximo período). Idempotente por período. */
  invoice(tenant: string, input?: InvoiceInput): Promise<Invoice>;
  getInvoice(id: string): Promise<Invoice | undefined>;
  invoices(query?: Parameters<BillingRepository['listInvoices']>[0]): Promise<Page<Invoice>>;
  subscriptions(
    query?: Parameters<BillingRepository['listSubscriptions']>[0],
  ): Promise<Page<Subscription>>;
  payments(query: { invoiceId?: string; tenantId?: string; limit?: number }): Promise<Payment[]>;
  /** Registra un pago (manual o de la pasarela). Al completarse, la factura queda pagada y la suscripción se extiende. */
  pay(invoiceId: string, input?: PayInput): Promise<{ invoice: Invoice; payment: Payment }>;
  /** Anula una factura sin pagos. */
  void(invoiceId: string): Promise<Invoice>;
  /** Inicia el cobro en línea con una pasarela (enlace de pago o QR). */
  checkout(
    invoiceId: string,
    options?: { provider?: string; returnUrl?: string },
  ): Promise<CheckoutSession>;
  /** Procesa el webhook de una pasarela: si confirma un pago, lo registra (idempotente). */
  webhook(
    provider: string,
    request: Parameters<PaymentProvider['parseWebhook']>[0],
  ): Promise<{ handled: boolean; invoice?: Invoice }>;
  /**
   * Ciclo de cobro (córrelo una vez al día: `tenancy billing:run`): factura los períodos que
   * vienen, marca `past_due` las suscripciones con facturas vencidas y, con `suspendAfterDays`,
   * suspende a quien no pagó.
   */
  run(options?: { now?: Date }): Promise<BillingRunResult>;
}

export interface BillingServiceDeps {
  repository: BillingRepository;
  providers: readonly PaymentProvider[];
  clock: Clock;
  ids: IdGenerator;
  currency: string;
  dueDays: number;
  invoiceDaysBefore: number;
  suspendAfterDays: number | null;
  findTenant(id: string): Promise<Tenant>;
  plan(id: string): PublicPlan | undefined;
  assignPlan(tenant: string, plan: string | null): Promise<Tenant>;
  suspend(tenant: string): Promise<void>;
  activate(tenant: string): Promise<void>;
  publish(type: string, data: unknown): Promise<unknown>;
}

const DAY = 86_400_000;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function invoiceEventData(i: Invoice) {
  return {
    id: i.id,
    tenantId: i.tenantId,
    description: i.description,
    currency: i.currency,
    amountCents: i.amountCents,
    paidCents: i.paidCents,
    status: i.status,
    periodStart: iso(i.periodStart),
    periodEnd: iso(i.periodEnd),
    dueAt: iso(i.dueAt)!,
    paidAt: iso(i.paidAt),
  };
}

export function createBillingService(deps: BillingServiceDeps): BillingApi {
  const repo = deps.repository;
  const providers = new Map<string, PaymentProvider>(deps.providers.map((p) => [p.name, p]));
  const now = () => deps.clock.now();

  const requireSubscription = async (tenantId: string) => {
    const sub = await repo.findSubscription(tenantId);
    if (!sub)
      throw new BillingError('NOT_FOUND', `Tenant "${tenantId}" has no subscription`, { tenantId });
    return sub;
  };
  const requireInvoice = async (id: string) => {
    const invoice = await repo.findInvoice(id);
    if (!invoice)
      throw new BillingError('NOT_FOUND', `Invoice "${id}" not found`, { invoiceId: id });
    return invoice;
  };
  const provider = (name: string) => {
    const p = providers.get(name);
    if (!p)
      throw new BillingError('NO_PROVIDER', `Payment provider "${name}" is not configured`, {
        provider: name,
      });
    return p;
  };

  /** Factura del período que empieza en `start` (si ya existe, la devuelve). */
  const periodInvoice = async (sub: Subscription, start: Date): Promise<Invoice> => {
    const existing = await repo.listInvoices({
      tenantId: sub.tenantId,
      periodStart: start,
      status: ['open', 'paid'],
      perPage: 1,
    });
    if (existing.items[0]) return existing.items[0];
    const end = addPeriod(start, sub.period);
    const created = now();
    const label = sub.plan ? (deps.plan(sub.plan)?.label ?? sub.plan) : 'Suscripción';
    const invoice: Invoice = {
      id: deps.ids.generate(),
      tenantId: sub.tenantId,
      description: `${label} · ${start.toISOString().slice(0, 10)} a ${end.toISOString().slice(0, 10)}`,
      currency: sub.currency,
      amountCents: sub.amountCents,
      paidCents: 0,
      status: 'open',
      periodStart: start,
      periodEnd: end,
      dueAt: new Date(Math.max(start.getTime(), created.getTime()) + deps.dueDays * DAY),
      paidAt: null,
      provider: null,
      providerRef: null,
      checkoutUrl: null,
      createdAt: created,
      updatedAt: created,
    };
    await repo.insertInvoice(invoice);
    await deps.publish('billing.invoice_created', invoiceEventData(invoice));
    return invoice;
  };

  const api: BillingApi = {
    providers: ['manual', ...providers.keys()].filter((v, i, a) => a.indexOf(v) === i),

    async subscribe(tenantRef, input = {}) {
      let tenant = await deps.findTenant(tenantRef);
      if (input.plan !== undefined && input.plan !== tenant.plan)
        tenant = await deps.assignPlan(tenant.id.value, input.plan);
      const previous = await repo.findSubscription(tenant.id.value);
      const period = input.period ?? previous?.period ?? 'monthly';
      if (!BILLING_PERIODS.includes(period))
        throw new InvalidBillingError('period', `must be one of ${BILLING_PERIODS.join(', ')}`);
      const plan = tenant.plan ? deps.plan(tenant.plan) : undefined;
      const planAmount = plan?.price?.[period];
      const amountCents =
        input.amount !== undefined
          ? toCents(input.amount)
          : planAmount !== undefined && planAmount !== null
            ? toCents(planAmount)
            : previous?.amountCents;
      if (amountCents === undefined)
        throw new InvalidBillingError(
          'amount',
          `plan "${tenant.plan ?? '—'}" has no ${period} price: pass amount`,
        );
      const currency = validateCurrency(
        input.currency ?? plan?.price?.currency ?? previous?.currency ?? deps.currency,
      );
      const providerName = input.provider ?? previous?.provider ?? 'manual';
      if (providerName !== 'manual') provider(providerName);
      if (
        input.trialDays !== undefined &&
        (!Number.isInteger(input.trialDays) || input.trialDays < 0)
      )
        throw new InvalidBillingError('trialDays', 'must be an integer >= 0');

      const at = now();
      const start = input.startsAt ?? previous?.currentPeriodStart ?? at;
      const trial = input.trialDays ?? 0;
      const sub: Subscription =
        previous && previous.status !== 'canceled'
          ? {
              ...previous,
              plan: tenant.plan,
              period,
              currency,
              amountCents: validateCents('amount', amountCents),
              provider: providerName,
              providerRef:
                input.providerRef !== undefined ? input.providerRef : previous.providerRef,
              updatedAt: at,
            }
          : {
              tenantId: tenant.id.value,
              plan: tenant.plan,
              period,
              status: trial > 0 ? 'trialing' : 'active',
              currency,
              amountCents: validateCents('amount', amountCents),
              currentPeriodStart: start,
              currentPeriodEnd:
                trial > 0 ? new Date(start.getTime() + trial * DAY) : addPeriod(start, period),
              provider: providerName,
              providerRef: input.providerRef ?? null,
              canceledAt: null,
              createdAt: previous?.createdAt ?? at,
              updatedAt: at,
            };
      await repo.saveSubscription(sub);
      await deps.publish('billing.subscription_updated', subscriptionEventData(sub));
      // Sin prueba, el primer período se factura al suscribir.
      if (!previous || previous.status === 'canceled') {
        if (trial === 0) await periodInvoice(sub, start);
      }
      return sub;
    },

    subscription: (tenant) => repo.findSubscription(tenant),

    async cancel(tenant) {
      const sub = await requireSubscription(tenant);
      if (sub.status === 'canceled') return sub;
      const next = { ...sub, status: 'canceled' as const, canceledAt: now(), updatedAt: now() };
      await repo.saveSubscription(next);
      await deps.publish('billing.subscription_updated', subscriptionEventData(next));
      return next;
    },

    async invoice(tenantRef, input = {}) {
      const tenant = await deps.findTenant(tenantRef);
      if (input.amount === undefined) {
        const sub = await requireSubscription(tenant.id.value);
        if (sub.status === 'canceled')
          throw new BillingError('CONFLICT', `The subscription of "${sub.tenantId}" is canceled`);
        return periodInvoice(sub, sub.currentPeriodEnd);
      }
      const description = (input.description ?? '').trim();
      if (description.length === 0 || description.length > 255)
        throw new InvalidBillingError('description', 'must have 1 to 255 characters');
      const sub = await repo.findSubscription(tenant.id.value);
      const at = now();
      const invoice: Invoice = {
        id: deps.ids.generate(),
        tenantId: tenant.id.value,
        description,
        currency: validateCurrency(input.currency ?? sub?.currency ?? deps.currency),
        amountCents: validateCents('amount', toCents(input.amount), false),
        paidCents: 0,
        status: 'open',
        periodStart: null,
        periodEnd: null,
        dueAt: input.dueAt ?? new Date(at.getTime() + deps.dueDays * DAY),
        paidAt: null,
        provider: null,
        providerRef: null,
        checkoutUrl: null,
        createdAt: at,
        updatedAt: at,
      };
      await repo.insertInvoice(invoice);
      await deps.publish('billing.invoice_created', invoiceEventData(invoice));
      return invoice;
    },

    getInvoice: (id) => repo.findInvoice(id),
    invoices: (query) => repo.listInvoices(query),
    subscriptions: (query) => repo.listSubscriptions(query),
    payments: (query) => repo.listPayments(query),

    async pay(invoiceId, input = {}) {
      const invoice = await requireInvoice(invoiceId);
      if (invoice.status !== 'open')
        throw new BillingError('CONFLICT', `Invoice "${invoiceId}" is ${invoice.status}`, {
          invoiceId,
          status: invoice.status,
        });
      const remaining = invoice.amountCents - invoice.paidCents;
      const amountCents =
        input.amount === undefined
          ? remaining
          : validateCents('amount', toCents(input.amount), false);
      const method = (input.method ?? 'manual').trim();
      if (method.length === 0 || method.length > 30)
        throw new InvalidBillingError('method', 'must have 1 to 30 characters');
      if (input.reference && input.reference.length > 191)
        throw new InvalidBillingError('reference', 'must have at most 191 characters');
      const at = now();
      const payment: Payment = {
        id: deps.ids.generate(),
        invoiceId,
        tenantId: invoice.tenantId,
        amountCents,
        currency: invoice.currency,
        method,
        reference: input.reference ?? null,
        provider: input.provider ?? 'manual',
        providerRef: input.providerRef ?? null,
        paidAt: input.paidAt ?? at,
        recordedBy: input.recordedBy ?? null,
        createdAt: at,
      };
      await repo.insertPayment(payment);
      const paidCents = invoice.paidCents + amountCents;
      const paid = paidCents >= invoice.amountCents;
      const next: Invoice = {
        ...invoice,
        paidCents,
        status: paid ? 'paid' : 'open',
        paidAt: paid ? payment.paidAt : null,
        updatedAt: at,
      };
      await repo.saveInvoice(next);
      await deps.publish('billing.payment_recorded', {
        ...invoiceEventData(next),
        paymentId: payment.id,
        paymentCents: amountCents,
        method,
        reference: payment.reference,
      });
      if (paid) {
        const sub = await repo.findSubscription(invoice.tenantId);
        if (sub && invoice.periodEnd) {
          const wasPastDue = sub.status === 'past_due';
          const extended: Subscription = {
            ...sub,
            status: sub.status === 'canceled' ? 'canceled' : 'active',
            currentPeriodStart:
              invoice.periodEnd.getTime() > sub.currentPeriodEnd.getTime()
                ? invoice.periodStart!
                : sub.currentPeriodStart,
            currentPeriodEnd: new Date(
              Math.max(sub.currentPeriodEnd.getTime(), invoice.periodEnd.getTime()),
            ),
            updatedAt: at,
          };
          await repo.saveSubscription(extended);
          // Si el ciclo de cobro lo había suspendido, vuelve a estar activo.
          if (wasPastDue && deps.suspendAfterDays !== null) {
            const tenant = await deps.findTenant(invoice.tenantId);
            if (tenant.status === 'suspended') await deps.activate(invoice.tenantId);
          }
        }
        await deps.publish('billing.invoice_paid', invoiceEventData(next));
      }
      return { invoice: next, payment };
    },

    async void(invoiceId) {
      const invoice = await requireInvoice(invoiceId);
      if (invoice.status !== 'open' || invoice.paidCents > 0)
        throw new BillingError(
          'CONFLICT',
          `Invoice "${invoiceId}" cannot be voided (${invoice.status}, paid ${invoice.paidCents})`,
        );
      const next = { ...invoice, status: 'void' as const, updatedAt: now() };
      await repo.saveInvoice(next);
      return next;
    },

    async checkout(invoiceId, options = {}) {
      const invoice = await requireInvoice(invoiceId);
      if (invoice.status !== 'open')
        throw new BillingError('CONFLICT', `Invoice "${invoiceId}" is ${invoice.status}`);
      const name = options.provider ?? deps.providers[0]?.name;
      if (!name) throw new BillingError('NO_PROVIDER', 'No online payment provider is configured');
      const tenant = await deps.findTenant(invoice.tenantId);
      const session = await provider(name).createCheckout({
        invoice,
        tenant,
        ...(options.returnUrl ? { returnUrl: options.returnUrl } : {}),
      });
      await repo.saveInvoice({
        ...invoice,
        provider: name,
        providerRef: session.providerRef,
        checkoutUrl: session.url ?? null,
        updatedAt: now(),
      });
      return session;
    },

    async webhook(name, request) {
      const result = await provider(name).parseWebhook(request);
      if (result.type === 'ignored') return { handled: false };
      const invoice = await repo.findInvoiceByProviderRef(name, result.providerRef);
      if (!invoice) return { handled: false };
      if (result.type === 'failed') {
        await deps.publish('billing.payment_failed', {
          ...invoiceEventData(invoice),
          provider: name,
          reason: result.reason ?? null,
        });
        return { handled: true, invoice };
      }
      // La pasarela reintenta los webhooks: un pago ya registrado no se repite.
      if (invoice.status !== 'open') return { handled: true, invoice };
      const { invoice: paid } = await api.pay(invoice.id, {
        ...(result.amountCents !== undefined ? { amount: result.amountCents / 100 } : {}),
        method: name,
        provider: name,
        providerRef: result.providerRef,
        ...(result.reference ? { reference: result.reference } : {}),
        ...(result.paidAt ? { paidAt: result.paidAt } : {}),
      });
      return { handled: true, invoice: paid };
    },

    async run(options = {}) {
      const at = options.now ?? now();
      const result: BillingRunResult = { invoiced: [], pastDue: [], suspended: [] };
      const horizon = new Date(at.getTime() + deps.invoiceDaysBefore * DAY);
      for (let page = 1; ; page++) {
        const subs = await repo.listSubscriptions({
          status: ['active', 'trialing', 'past_due'],
          endsBefore: horizon,
          page,
          perPage: 100,
        });
        for (const sub of subs.items) {
          const before = await repo.listInvoices({
            tenantId: sub.tenantId,
            periodStart: sub.currentPeriodEnd,
            perPage: 1,
          });
          if (before.total > 0) continue;
          await periodInvoice(sub, sub.currentPeriodEnd);
          result.invoiced.push(sub.tenantId);
        }
        if (page * 100 >= subs.total) break;
      }
      const overdue = new Map<string, Invoice>();
      for (let page = 1; ; page++) {
        const list = await repo.listInvoices({
          status: ['open'],
          dueBefore: at,
          page,
          perPage: 100,
        });
        for (const i of list.items) {
          const prev = overdue.get(i.tenantId);
          if (!prev || i.dueAt.getTime() < prev.dueAt.getTime()) overdue.set(i.tenantId, i);
        }
        if (page * 100 >= list.total) break;
      }
      for (const [tenantId, invoice] of overdue) {
        const sub = await repo.findSubscription(tenantId);
        if (sub && (sub.status === 'active' || sub.status === 'trialing')) {
          const next = { ...sub, status: 'past_due' as const, updatedAt: at };
          await repo.saveSubscription(next);
          await deps.publish('billing.subscription_past_due', {
            ...subscriptionEventData(next),
            invoiceId: invoice.id,
          });
          result.pastDue.push(tenantId);
        }
        if (
          deps.suspendAfterDays !== null &&
          invoice.dueAt.getTime() + deps.suspendAfterDays * DAY <= at.getTime()
        ) {
          const tenant = await deps.findTenant(tenantId).catch(() => undefined);
          if (tenant?.status === 'active') {
            await deps.suspend(tenantId);
            await deps.publish('billing.tenant_suspended', { tenantId, invoiceId: invoice.id });
            result.suspended.push(tenantId);
          }
        }
      }
      return result;
    },
  };
  return api;
}

export function subscriptionEventData(s: Subscription) {
  return {
    tenantId: s.tenantId,
    plan: s.plan,
    period: s.period,
    status: s.status,
    currency: s.currency,
    amountCents: s.amountCents,
    currentPeriodStart: s.currentPeriodStart.toISOString(),
    currentPeriodEnd: s.currentPeriodEnd.toISOString(),
    provider: s.provider,
  };
}
