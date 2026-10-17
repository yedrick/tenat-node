import type { Invoice, Payment, Subscription } from '../../domain/index.js';
import type { BillingRepository, Page } from '../../ports/index.js';

const clone = <T>(value: T): T => structuredClone(value);

function paged<T>(items: T[], page = 1, perPage = 20): Page<T> {
  const p = Math.max(1, Math.floor(page));
  const size = Math.min(100, Math.max(1, Math.floor(perPage)));
  return {
    items: items.slice((p - 1) * size, p * size).map(clone),
    total: items.length,
    page: p,
    perPage: size,
  };
}

/** Cobros en memoria: tests y prototipos (se pierden al reiniciar). */
export class InMemoryBillingRepository implements BillingRepository {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly invoices = new Map<string, Invoice>();
  private readonly payments: Payment[] = [];

  async findSubscription(tenantId: string) {
    const s = this.subscriptions.get(tenantId);
    return s ? clone(s) : undefined;
  }

  async saveSubscription(subscription: Subscription) {
    this.subscriptions.set(subscription.tenantId, clone(subscription));
  }

  async listSubscriptions(query: Parameters<BillingRepository['listSubscriptions']>[0] = {}) {
    const items = [...this.subscriptions.values()]
      .filter((s) => !query.status || query.status.includes(s.status))
      .filter(
        (s) => !query.endsBefore || s.currentPeriodEnd.getTime() <= query.endsBefore.getTime(),
      )
      .sort(
        (a, b) =>
          a.currentPeriodEnd.getTime() - b.currentPeriodEnd.getTime() ||
          a.tenantId.localeCompare(b.tenantId),
      );
    return paged(items, query.page, query.perPage);
  }

  async insertInvoice(invoice: Invoice) {
    this.invoices.set(invoice.id, clone(invoice));
  }

  async saveInvoice(invoice: Invoice) {
    this.invoices.set(invoice.id, clone(invoice));
  }

  async findInvoice(id: string) {
    const i = this.invoices.get(id);
    return i ? clone(i) : undefined;
  }

  async findInvoiceByProviderRef(provider: string, providerRef: string) {
    const i = [...this.invoices.values()].find(
      (x) => x.provider === provider && x.providerRef === providerRef,
    );
    return i ? clone(i) : undefined;
  }

  async listInvoices(query: Parameters<BillingRepository['listInvoices']>[0] = {}) {
    const items = [...this.invoices.values()]
      .filter((i) => !query.tenantId || i.tenantId === query.tenantId)
      .filter((i) => !query.status || query.status.includes(i.status))
      .filter((i) => !query.dueBefore || i.dueAt.getTime() <= query.dueBefore.getTime())
      .filter((i) => !query.periodStart || i.periodStart?.getTime() === query.periodStart.getTime())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    return paged(items, query.page, query.perPage);
  }

  async insertPayment(payment: Payment) {
    if (
      payment.providerRef !== null &&
      this.payments.some(
        (p) => p.provider === payment.provider && p.providerRef === payment.providerRef,
      )
    )
      return false;
    this.payments.push(clone(payment));
    return true;
  }

  async listPayments(query: { invoiceId?: string; tenantId?: string; limit?: number }) {
    return this.payments
      .filter(
        (p) =>
          (!query.invoiceId || p.invoiceId === query.invoiceId) &&
          (!query.tenantId || p.tenantId === query.tenantId),
      )
      .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, query.limit ?? 100)
      .map(clone);
  }
}
