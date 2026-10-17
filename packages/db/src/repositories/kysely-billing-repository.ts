import type {
  BillingPeriod,
  BillingRepository,
  Invoice,
  InvoiceStatus,
  Page,
  Payment,
  Subscription,
  SubscriptionStatus,
} from '@tenancy-node/core';
import type { Selectable } from 'kysely';
import { paginate } from '../dialect.js';
import type {
  BillingInvoicesTable,
  BillingPaymentsTable,
  BillingSubscriptionsTable,
} from '../schema/central-tables.js';
import { toDate, toDateOrNull, type CentralDb } from './central-db.js';

const pageOf = (query: { page?: number; perPage?: number }) => {
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const perPage = Math.min(100, Math.max(1, Math.floor(query.perPage ?? 20)));
  return { page, perPage };
};

/** `BillingRepository` sobre `tenancy_billing_subscriptions`, `_invoices` y `_payments`. */
export class KyselyBillingRepository implements BillingRepository {
  constructor(private readonly central: CentralDb) {}

  private get db() {
    return this.central.db;
  }

  async findSubscription(tenantId: string): Promise<Subscription | undefined> {
    const row = await this.db
      .selectFrom('billing_subscriptions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    return row ? subscriptionFromRow(row) : undefined;
  }

  async saveSubscription(s: Subscription): Promise<void> {
    const values = {
      plan: s.plan,
      period: s.period,
      status: s.status,
      currency: s.currency,
      amount_cents: s.amountCents,
      current_period_start: s.currentPeriodStart,
      current_period_end: s.currentPeriodEnd,
      provider: s.provider,
      provider_ref: s.providerRef,
      canceled_at: s.canceledAt,
      updated_at: s.updatedAt,
    };
    const updated = await this.db
      .updateTable('billing_subscriptions')
      .set(values)
      .where('tenant_id', '=', s.tenantId)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) > 0) return;
    await this.db
      .insertInto('billing_subscriptions')
      .values({ tenant_id: s.tenantId, ...values, created_at: s.createdAt })
      .execute();
  }

  async listSubscriptions(
    query: Parameters<BillingRepository['listSubscriptions']>[0] = {},
  ): Promise<Page<Subscription>> {
    const { page, perPage } = pageOf(query);
    let base = this.db.selectFrom('billing_subscriptions');
    if (query.status) {
      if (query.status.length === 0) return { items: [], total: 0, page, perPage };
      base = base.where('status', 'in', [...query.status]);
    }
    if (query.endsBefore) base = base.where('current_period_end', '<=', query.endsBefore);
    const [count, rows] = await Promise.all([
      base.select((eb) => eb.fn.countAll<number | string>().as('total')).executeTakeFirstOrThrow(),
      base
        .selectAll()
        .orderBy('current_period_end')
        .orderBy('tenant_id')
        .$call((q) => paginate(this.central.kind, q, perPage, (page - 1) * perPage))
        .execute(),
    ]);
    return { items: rows.map(subscriptionFromRow), total: Number(count.total), page, perPage };
  }

  async insertInvoice(i: Invoice): Promise<void> {
    await this.db.insertInto('billing_invoices').values(invoiceToRow(i)).execute();
  }

  async saveInvoice(i: Invoice): Promise<void> {
    const { id, created_at: _created, ...values } = invoiceToRow(i);
    await this.db.updateTable('billing_invoices').set(values).where('id', '=', id).execute();
  }

  async findInvoice(id: string): Promise<Invoice | undefined> {
    const row = await this.db
      .selectFrom('billing_invoices')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? invoiceFromRow(row) : undefined;
  }

  async findInvoiceByProviderRef(
    provider: string,
    providerRef: string,
  ): Promise<Invoice | undefined> {
    const row = await this.db
      .selectFrom('billing_invoices')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_ref', '=', providerRef)
      .executeTakeFirst();
    return row ? invoiceFromRow(row) : undefined;
  }

  async listInvoices(
    query: Parameters<BillingRepository['listInvoices']>[0] = {},
  ): Promise<Page<Invoice>> {
    const { page, perPage } = pageOf(query);
    let base = this.db.selectFrom('billing_invoices');
    if (query.tenantId) base = base.where('tenant_id', '=', query.tenantId);
    if (query.status) {
      if (query.status.length === 0) return { items: [], total: 0, page, perPage };
      base = base.where('status', 'in', [...query.status]);
    }
    if (query.dueBefore) base = base.where('due_at', '<=', query.dueBefore);
    if (query.periodStart) base = base.where('period_start', '=', query.periodStart);
    const [count, rows] = await Promise.all([
      base.select((eb) => eb.fn.countAll<number | string>().as('total')).executeTakeFirstOrThrow(),
      base
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .$call((q) => paginate(this.central.kind, q, perPage, (page - 1) * perPage))
        .execute(),
    ]);
    return { items: rows.map(invoiceFromRow), total: Number(count.total), page, perPage };
  }

  async insertPayment(p: Payment): Promise<boolean> {
    try {
      await this.db
        .insertInto('billing_payments')
        .values({
          id: p.id,
          invoice_id: p.invoiceId,
          tenant_id: p.tenantId,
          amount_cents: p.amountCents,
          currency: p.currency,
          method: p.method,
          reference: p.reference,
          provider: p.provider,
          provider_ref: p.providerRef,
          paid_at: p.paidAt,
          recorded_by: p.recordedBy,
          created_at: p.createdAt,
        })
        .execute();
    } catch (error) {
      // UNIQUE(provider, provider_ref): el mismo pago de la pasarela ya está registrado.
      if (this.central.driver.isUniqueViolation(error)) return false;
      throw error;
    }
    return true;
  }

  async listPayments(query: {
    invoiceId?: string;
    tenantId?: string;
    limit?: number;
  }): Promise<Payment[]> {
    let q = this.db.selectFrom('billing_payments').selectAll();
    if (query.invoiceId) q = q.where('invoice_id', '=', query.invoiceId);
    if (query.tenantId) q = q.where('tenant_id', '=', query.tenantId);
    const rows = await q
      .orderBy('paid_at', 'desc')
      .orderBy('id', 'desc')
      .$call((x) => paginate(this.central.kind, x, Math.min(query.limit ?? 100, 1000)))
      .execute();
    return rows.map(paymentFromRow);
  }
}

function subscriptionFromRow(r: Selectable<BillingSubscriptionsTable>): Subscription {
  return {
    tenantId: r.tenant_id,
    plan: r.plan,
    period: r.period as BillingPeriod,
    status: r.status as SubscriptionStatus,
    currency: r.currency,
    amountCents: Number(r.amount_cents),
    currentPeriodStart: toDate(r.current_period_start),
    currentPeriodEnd: toDate(r.current_period_end),
    provider: r.provider,
    providerRef: r.provider_ref,
    canceledAt: toDateOrNull(r.canceled_at),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

function invoiceToRow(i: Invoice) {
  return {
    id: i.id,
    tenant_id: i.tenantId,
    description: i.description,
    currency: i.currency,
    amount_cents: i.amountCents,
    paid_cents: i.paidCents,
    status: i.status,
    period_start: i.periodStart,
    period_end: i.periodEnd,
    due_at: i.dueAt,
    paid_at: i.paidAt,
    provider: i.provider,
    provider_ref: i.providerRef,
    checkout_url: i.checkoutUrl,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
  };
}

function invoiceFromRow(r: Selectable<BillingInvoicesTable>): Invoice {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    description: r.description,
    currency: r.currency,
    amountCents: Number(r.amount_cents),
    paidCents: Number(r.paid_cents),
    status: r.status as InvoiceStatus,
    periodStart: toDateOrNull(r.period_start),
    periodEnd: toDateOrNull(r.period_end),
    dueAt: toDate(r.due_at),
    paidAt: toDateOrNull(r.paid_at),
    provider: r.provider,
    providerRef: r.provider_ref,
    checkoutUrl: r.checkout_url,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

function paymentFromRow(r: Selectable<BillingPaymentsTable>): Payment {
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    tenantId: r.tenant_id,
    amountCents: Number(r.amount_cents),
    currency: r.currency,
    method: r.method,
    reference: r.reference,
    provider: r.provider,
    providerRef: r.provider_ref,
    paidAt: toDate(r.paid_at),
    recordedBy: r.recorded_by,
    createdAt: toDate(r.created_at),
  };
}
