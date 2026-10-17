import { billingRepositoryContract, createTestTenancy } from '@tenancy-node/testing';
import { describe, expect, it } from 'vitest';
import {
  BillingError,
  InMemoryBillingRepository,
  InvalidBillingError,
  InvalidConfigError,
  addPeriod,
  toCents,
  type EventEnvelope,
  type PaymentProvider,
  type TenancyConfig,
} from '../src/index.js';

billingRepositoryContract('InMemoryBillingRepository', () => new InMemoryBillingRepository());

const DAY = 86_400_000;

const PLANS: TenancyConfig = {
  plans: {
    basico: {
      label: 'Básico',
      price: { currency: 'BOB', monthly: 150.5, yearly: 1500 },
      features: [],
    },
    pro: { label: 'Pro', price: { currency: 'BOB', monthly: 300 }, features: [] },
    gratis: { label: 'Gratis', features: [] },
  },
};

/** Pasarela de prueba: un "QR" con webhook firmado con un secreto fijo. */
function fakeQr(): PaymentProvider & { sessions: string[] } {
  const sessions: string[] = [];
  return {
    name: 'qr',
    sessions,
    async createCheckout({ invoice, returnUrl }) {
      const ref = `qr_${invoice.id}`;
      sessions.push(ref);
      return {
        providerRef: ref,
        url: `https://pagos.test/${ref}?back=${returnUrl ?? ''}`,
        qr: `QR:${ref}`,
      };
    },
    async parseWebhook({ headers, body }) {
      if (headers['x-firma'] !== 'secreto') throw new Error('bad signature');
      const event = JSON.parse(body) as { type: string; ref: string; monto?: number; trx?: string };
      if (event.type === 'pagado')
        return {
          type: 'paid',
          providerRef: event.ref,
          ...(event.monto !== undefined ? { amountCents: event.monto } : {}),
          ...(event.trx ? { reference: event.trx } : {}),
        };
      if (event.type === 'rechazado')
        return { type: 'failed', providerRef: event.ref, reason: 'fondos' };
      return { type: 'ignored' };
    },
  };
}

async function setup(config: TenancyConfig = {}) {
  const test = createTestTenancy({ ...PLANS, ...config });
  test.clock.set(new Date('2026-01-31T12:00:00.000Z'));
  const events: EventEnvelope[] = [];
  test.tenancy.events.on('billing.*', (e) => void events.push(e), { mode: 'sync' });
  await test.tenancy.tenants.create({ id: 'clinica', plan: 'basico' });
  return { ...test, events };
}

describe('billing helpers', () => {
  it('adds months safely and converts to cents', () => {
    expect(addPeriod(new Date('2026-01-31T00:00:00Z'), 'monthly').toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    expect(addPeriod(new Date('2024-01-31T00:00:00Z'), 'monthly').toISOString()).toBe(
      '2024-02-29T00:00:00.000Z',
    );
    expect(addPeriod(new Date('2024-02-29T00:00:00Z'), 'yearly').toISOString()).toBe(
      '2025-02-28T00:00:00.000Z',
    );
    expect(toCents(150.5)).toBe(15050);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(() => toCents(-1)).toThrow(InvalidBillingError);
  });
});

describe('tenancy.billing', () => {
  it('subscribes with the plan price, invoices the first period and extends it when paid', async () => {
    const { tenancy, events } = await setup();
    const sub = await tenancy.billing.subscribe('clinica');
    expect(sub).toMatchObject({
      plan: 'basico',
      period: 'monthly',
      status: 'active',
      currency: 'BOB',
      amountCents: 15050,
      provider: 'manual',
      currentPeriodEnd: new Date('2026-02-28T12:00:00.000Z'),
    });
    const [first] = (await tenancy.billing.invoices({ tenantId: 'clinica' })).items;
    expect(first).toMatchObject({
      status: 'open',
      amountCents: 15050,
      description: 'Básico · 2026-01-31 a 2026-02-28',
      dueAt: new Date('2026-02-07T12:00:00.000Z'),
    });
    // Idempotente: suscribir otra vez no duplica la factura.
    await tenancy.billing.subscribe('clinica', { period: 'monthly' });
    expect((await tenancy.billing.invoices({ tenantId: 'clinica' })).total).toBe(1);

    // Pago parcial y después el resto.
    const partial = await tenancy.billing.pay(first!.id, {
      amount: 50,
      method: 'transfer',
      reference: 'TRX-1',
      recordedBy: 'ana',
    });
    expect(partial.invoice).toMatchObject({ status: 'open', paidCents: 5000 });
    const done = await tenancy.billing.pay(first!.id, { method: 'qr' });
    expect(done.payment.amountCents).toBe(10050);
    expect(done.invoice).toMatchObject({ status: 'paid', paidCents: 15050 });
    expect((await tenancy.billing.payments({ invoiceId: first!.id })).map((p) => p.method)).toEqual(
      ['qr', 'transfer'],
    );
    await expect(tenancy.billing.pay(first!.id)).rejects.toThrow(BillingError);

    // Factura del período siguiente y pago: la suscripción avanza un mes.
    const next = await tenancy.billing.invoice('clinica');
    expect(next.periodStart).toEqual(new Date('2026-02-28T12:00:00.000Z'));
    expect(await tenancy.billing.invoice('clinica')).toEqual(next);
    await tenancy.billing.pay(next.id);
    expect((await tenancy.billing.subscription('clinica'))!.currentPeriodEnd).toEqual(
      new Date('2026-03-28T12:00:00.000Z'),
    );
    expect(events.map((e) => e.type)).toEqual([
      'billing.subscription_updated',
      'billing.invoice_created',
      'billing.subscription_updated',
      'billing.payment_recorded',
      'billing.payment_recorded',
      'billing.invoice_paid',
      'billing.invoice_created',
      'billing.payment_recorded',
      'billing.invoice_paid',
    ]);
  });

  it('supports trials, yearly periods, custom amounts, plan changes and one-off invoices', async () => {
    const { tenancy } = await setup();
    const trial = await tenancy.billing.subscribe('clinica', { trialDays: 14, period: 'yearly' });
    expect(trial).toMatchObject({ status: 'trialing', amountCents: 150000 });
    expect(trial.currentPeriodEnd.getTime() - trial.currentPeriodStart.getTime()).toBe(14 * DAY);
    expect((await tenancy.billing.invoices({ tenantId: 'clinica' })).total).toBe(0);

    const changed = await tenancy.billing.subscribe('clinica', { plan: 'pro', period: 'monthly' });
    expect(changed).toMatchObject({ plan: 'pro', amountCents: 30000, status: 'trialing' });
    expect((await tenancy.tenants.findOrFail('clinica')).plan).toBe('pro');

    await tenancy.tenants.create({ id: 'otra', plan: 'gratis' });
    await expect(tenancy.billing.subscribe('otra')).rejects.toThrow(/has no monthly price/);
    expect(await tenancy.billing.subscribe('otra', { amount: 99, currency: 'USD' })).toMatchObject({
      amountCents: 9900,
      currency: 'USD',
    });
    await expect(tenancy.billing.subscribe('otra', { period: 'weekly' as never })).rejects.toThrow(
      /period/,
    );
    await expect(tenancy.billing.subscribe('otra', { trialDays: -1 })).rejects.toThrow(/trialDays/);
    await expect(tenancy.billing.subscribe('otra', { currency: 'bs' })).rejects.toThrow(/currency/);
    await expect(tenancy.billing.subscribe('otra', { provider: 'stripe' })).rejects.toThrow(
      /not configured/,
    );

    const oneOff = await tenancy.billing.invoice('clinica', {
      description: 'Instalación',
      amount: 200,
    });
    expect(oneOff).toMatchObject({ periodStart: null, amountCents: 20000, currency: 'BOB' });
    await expect(tenancy.billing.invoice('clinica', { amount: 10 })).rejects.toThrow(/description/);
    await expect(
      tenancy.billing.invoice('clinica', { description: 'x', amount: 0 }),
    ).rejects.toThrow(/amount/);
    expect((await tenancy.billing.void(oneOff.id)).status).toBe('void');
    await expect(tenancy.billing.void(oneOff.id)).rejects.toThrow(BillingError);
    await expect(tenancy.billing.pay('nope')).rejects.toThrow(/not found/);
    await expect(tenancy.billing.pay(oneOff.id)).rejects.toThrow(/void/);

    await tenancy.tenants.create({ id: 'sin-sub' });
    await expect(tenancy.billing.invoice('sin-sub')).rejects.toThrow(/no subscription/);
    await expect(tenancy.billing.cancel('sin-sub')).rejects.toThrow(/no subscription/);
    const canceled = await tenancy.billing.cancel('clinica');
    expect(canceled.status).toBe('canceled');
    expect(await tenancy.billing.cancel('clinica')).toEqual(canceled);
    await expect(tenancy.billing.invoice('clinica')).rejects.toThrow(/canceled/);
    // Volver a suscribirse después de cancelar empieza de nuevo y factura.
    const again = await tenancy.billing.subscribe('clinica');
    expect(again.status).toBe('active');
    expect((await tenancy.billing.invoices({ tenantId: 'clinica', status: ['open'] })).total).toBe(
      1,
    );
    await expect(tenancy.billing.pay(oneOff.id, { method: '' })).rejects.toThrow();
  });

  it('runs the billing cycle: invoices upcoming periods, marks past due and suspends', async () => {
    const { tenancy, clock, events } = await setup({ billing: { suspendAfterDays: 5 } });
    await tenancy.billing.subscribe('clinica');
    const [first] = (await tenancy.billing.invoices({ tenantId: 'clinica' })).items;

    // Antes del vencimiento no pasa nada.
    expect(await tenancy.billing.run()).toEqual({ invoiced: [], pastDue: [], suspended: [] });

    clock.advance(8 * DAY); // vencida (dueAt + 1 día)
    expect(await tenancy.billing.run()).toEqual({
      invoiced: [],
      pastDue: ['clinica'],
      suspended: [],
    });
    expect((await tenancy.billing.subscription('clinica'))!.status).toBe('past_due');
    expect(await tenancy.billing.run()).toEqual({ invoiced: [], pastDue: [], suspended: [] });

    clock.advance(5 * DAY);
    expect((await tenancy.billing.run()).suspended).toEqual(['clinica']);
    expect((await tenancy.tenants.findOrFail('clinica')).status).toBe('suspended');

    // Paga: vuelve a estar activo.
    await tenancy.billing.pay(first!.id);
    expect((await tenancy.tenants.findOrFail('clinica')).status).toBe('active');
    expect((await tenancy.billing.subscription('clinica'))!.status).toBe('active');

    // 7 días antes del fin del período se emite la factura siguiente (una sola vez).
    clock.set(new Date('2026-02-22T12:00:00.000Z'));
    expect((await tenancy.billing.run()).invoiced).toEqual(['clinica']);
    expect((await tenancy.billing.run()).invoiced).toEqual([]);
    expect(events.some((e) => e.type === 'billing.tenant_suspended')).toBe(true);
    expect(events.some((e) => e.type === 'billing.subscription_past_due')).toBe(true);
  });

  it('charges online through a provider and records the webhook payment once', async () => {
    const qr = fakeQr();
    const { tenancy, events } = await setup({ billing: { providers: [qr] } });
    expect(tenancy.billing.providers).toEqual(['manual', 'qr']);
    await tenancy.billing.subscribe('clinica', { provider: 'qr' });
    const [invoice] = (await tenancy.billing.invoices({ tenantId: 'clinica' })).items;

    const session = await tenancy.billing.checkout(invoice!.id, { returnUrl: '/gracias' });
    expect(session).toMatchObject({ providerRef: `qr_${invoice!.id}`, qr: `QR:qr_${invoice!.id}` });
    expect((await tenancy.billing.getInvoice(invoice!.id))!.checkoutUrl).toContain('back=/gracias');

    const hook = (body: object, firma = 'secreto') =>
      tenancy.billing.webhook('qr', { headers: { 'x-firma': firma }, body: JSON.stringify(body) });
    await expect(hook({ type: 'pagado', ref: session.providerRef }, 'falsa')).rejects.toThrow(
      /signature/,
    );
    expect(await hook({ type: 'otro' })).toEqual({ handled: false });
    expect(await hook({ type: 'pagado', ref: 'desconocido' })).toEqual({ handled: false });
    expect((await hook({ type: 'rechazado', ref: session.providerRef })).handled).toBe(true);
    // Dos webhooks iguales en paralelo: un solo pago.
    await Promise.all([
      hook({ type: 'pagado', ref: session.providerRef, trx: 'BNB-77' }),
      hook({ type: 'pagado', ref: session.providerRef, trx: 'BNB-77' }),
    ]);
    expect((await tenancy.billing.getInvoice(invoice!.id))!).toMatchObject({
      status: 'paid',
      paidCents: 15050,
    });
    // La pasarela reintenta: no se registra dos veces.
    await hook({ type: 'pagado', ref: session.providerRef });
    const payments = await tenancy.billing.payments({ tenantId: 'clinica' });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      method: 'qr',
      provider: 'qr',
      reference: 'BNB-77',
      recordedBy: null,
    });
    expect(events.filter((e) => e.type === 'billing.payment_failed')).toHaveLength(1);

    await expect(tenancy.billing.checkout(invoice!.id)).rejects.toThrow(/paid/);
    // Dos pagos manuales parciales en paralelo: la suma no se pisa.
    const extra = await tenancy.billing.invoice('clinica', { description: 'Extra', amount: 100 });
    await Promise.all([
      tenancy.billing.pay(extra.id, { amount: 40 }),
      tenancy.billing.pay(extra.id, { amount: 60 }),
    ]);
    expect(await tenancy.billing.getInvoice(extra.id)).toMatchObject({
      status: 'paid',
      paidCents: 10000,
    });
    await expect(tenancy.billing.webhook('stripe', { headers: {}, body: '' })).rejects.toThrow(
      /not configured/,
    );
    const { tenancy: sinPasarela } = await setup();
    await sinPasarela.billing.subscribe('clinica');
    const [i] = (await sinPasarela.billing.invoices()).items;
    await expect(sinPasarela.billing.checkout(i!.id)).rejects.toThrow(/No online payment provider/);
    expect(() =>
      createTestTenancy({ billing: { providers: [{ ...qr, name: 'manual' }] } }),
    ).toThrow(InvalidConfigError);
  });
});
