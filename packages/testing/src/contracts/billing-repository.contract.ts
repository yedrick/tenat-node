import type { BillingRepository, Invoice, Payment, Subscription } from '@tenancy-node/core';
import { beforeEach, describe, expect, it } from 'vitest';

type Factory<T> = () => T | Promise<T>;

/** Suite que todo `BillingRepository` debe pasar (sin FK a tenants: no hace falta crearlos). */
export function billingRepositoryContract(name: string, factory: Factory<BillingRepository>): void {
  describe(`BillingRepository contract: ${name}`, () => {
    let repo: BillingRepository;
    const t0 = new Date('2026-10-01T00:00:00.000Z');
    const at = (days: number) => new Date(t0.getTime() + days * 86_400_000);
    let seq = 0;
    const id = () => `01JBILL${String(++seq).padStart(19, '0')}`;

    const sub = (tenantId: string, over: Partial<Subscription> = {}): Subscription => ({
      tenantId,
      plan: 'basico',
      period: 'monthly',
      status: 'active',
      currency: 'BOB',
      amountCents: 15050,
      currentPeriodStart: at(0),
      currentPeriodEnd: at(31),
      provider: 'manual',
      providerRef: null,
      canceledAt: null,
      createdAt: at(0),
      updatedAt: at(0),
      ...over,
    });
    const invoice = (tenantId: string, over: Partial<Invoice> = {}): Invoice => ({
      id: id(),
      tenantId,
      description: 'Básico · octubre',
      currency: 'BOB',
      amountCents: 15050,
      paidCents: 0,
      status: 'open',
      periodStart: at(0),
      periodEnd: at(31),
      dueAt: at(7),
      paidAt: null,
      provider: null,
      providerRef: null,
      checkoutUrl: null,
      createdAt: at(0),
      updatedAt: at(0),
      ...over,
    });

    beforeEach(async () => {
      repo = await factory();
    });

    it('saves and updates subscriptions, filtering by status and end', async () => {
      await repo.saveSubscription(sub('bolivar'));
      await repo.saveSubscription(sub('tigre', { status: 'past_due', currentPeriodEnd: at(10) }));
      await repo.saveSubscription(
        sub('bolivar', { status: 'canceled', canceledAt: at(5), providerRef: 'cus_1' }),
      );
      expect(await repo.findSubscription('bolivar')).toEqual(
        sub('bolivar', { status: 'canceled', canceledAt: at(5), providerRef: 'cus_1' }),
      );
      expect(await repo.findSubscription('nadie')).toBeUndefined();
      expect(
        (await repo.listSubscriptions({ status: ['past_due'] })).items.map((s) => s.tenantId),
      ).toEqual(['tigre']);
      expect(
        (await repo.listSubscriptions({ endsBefore: at(20) })).items.map((s) => s.tenantId),
      ).toEqual(['tigre']);
      expect((await repo.listSubscriptions()).total).toBe(2);
    });

    it('stores invoices and payments with every field', async () => {
      const a = invoice('bolivar', { createdAt: at(1) });
      const b = invoice('bolivar', {
        description: 'Instalación',
        periodStart: null,
        periodEnd: null,
        dueAt: at(20),
        createdAt: at(2),
      });
      const c = invoice('tigre', {
        status: 'paid',
        paidCents: 15050,
        paidAt: at(3),
        createdAt: at(3),
      });
      for (const i of [a, b, c]) await repo.insertInvoice(i);
      expect(await repo.findInvoice(a.id)).toEqual(a);
      expect(await repo.findInvoice('nope')).toBeUndefined();
      expect((await repo.listInvoices({ tenantId: 'bolivar' })).items.map((i) => i.id)).toEqual([
        b.id,
        a.id,
      ]);
      expect((await repo.listInvoices({ status: ['paid'] })).items.map((i) => i.id)).toEqual([
        c.id,
      ]);
      expect(
        (await repo.listInvoices({ status: ['open'], dueBefore: at(10) })).items.map((i) => i.id),
      ).toEqual([a.id]);
      expect(
        (await repo.listInvoices({ tenantId: 'bolivar', periodStart: at(0) })).items.map(
          (i) => i.id,
        ),
      ).toEqual([a.id]);
      expect((await repo.listInvoices({ perPage: 1, page: 2 })).items).toHaveLength(1);

      const updated = {
        ...a,
        provider: 'stripe',
        providerRef: 'cs_123',
        checkoutUrl: 'https://pay/x',
        updatedAt: at(4),
      };
      await repo.saveInvoice(updated);
      expect(await repo.findInvoiceByProviderRef('stripe', 'cs_123')).toEqual(updated);
      expect(await repo.findInvoiceByProviderRef('qr', 'cs_123')).toBeUndefined();

      const payment = (over: Partial<Payment>): Payment => ({
        id: id(),
        invoiceId: a.id,
        tenantId: 'bolivar',
        amountCents: 5000,
        currency: 'BOB',
        method: 'transfer',
        reference: 'TRX-1',
        provider: 'manual',
        providerRef: null,
        paidAt: at(5),
        recordedBy: 'ana@tuapp.com',
        createdAt: at(5),
        ...over,
      });
      const p1 = payment({});
      const p2 = payment({ amountCents: 10050, paidAt: at(6), reference: null, recordedBy: null });
      const p3 = payment({ invoiceId: c.id, tenantId: 'tigre' });
      for (const p of [p1, p2, p3]) await repo.insertPayment(p);
      expect(await repo.listPayments({ invoiceId: a.id })).toEqual([p2, p1]);
      expect(await repo.listPayments({ tenantId: 'tigre' })).toEqual([p3]);
      expect(await repo.listPayments({ tenantId: 'bolivar', limit: 1 })).toEqual([p2]);
    });
  });
}
