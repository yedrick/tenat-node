import { InvalidBillingError } from '../errors/errors.js';

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'canceled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export const BILLING_PERIODS = ['monthly', 'yearly'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];
export const INVOICE_STATUSES = ['open', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * Suscripción de un tenant: qué paga, cada cuánto y hasta cuándo está pagado.
 * Los montos van en centavos (enteros) para no perder precisión: 150.50 BOB = 15050.
 */
export interface Subscription {
  tenantId: string;
  plan: string | null;
  period: BillingPeriod;
  status: SubscriptionStatus;
  currency: string;
  amountCents: number;
  /** Período pagado (o de prueba) actual. */
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  /** Pasarela con la que paga (`manual`, `stripe`...). */
  provider: string;
  /** Id del cliente o suscripción en la pasarela. */
  providerRef: string | null;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Invoice {
  id: string;
  tenantId: string;
  description: string;
  currency: string;
  amountCents: number;
  /** Lo pagado hasta ahora (pagos parciales). */
  paidCents: number;
  status: InvoiceStatus;
  /** Período que cubre (extiende la suscripción al pagarse). `null` = cobro suelto. */
  periodStart: Date | null;
  periodEnd: Date | null;
  dueAt: Date;
  paidAt: Date | null;
  /** Pasarela del último cobro en línea y su referencia (checkout, QR...). */
  provider: string | null;
  providerRef: string | null;
  checkoutUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Payment {
  id: string;
  invoiceId: string;
  tenantId: string;
  amountCents: number;
  currency: string;
  /** `transfer`, `qr`, `cash`, `card` o el nombre de la pasarela. */
  method: string;
  /** Nro. de transacción, comprobante... */
  reference: string | null;
  provider: string;
  providerRef: string | null;
  paidAt: Date;
  /** Quién lo registró (email del panel) o `null` si llegó por webhook. */
  recordedBy: string | null;
  createdAt: Date;
}

const CURRENCY = /^[A-Z]{3}$/;

export function validateCurrency(currency: string): string {
  if (typeof currency !== 'string' || !CURRENCY.test(currency))
    throw new InvalidBillingError('currency', 'must be an ISO 4217 code (BOB, USD...)');
  return currency;
}

export function validateCents(field: string, value: number, allowZero = true): number {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 1e13)
    throw new InvalidBillingError(
      field,
      `must be an integer number of cents${allowZero ? '' : ' > 0'}`,
    );
  return value;
}

/** Monto con decimales → centavos (`150.5` → `15050`). */
export function toCents(amount: number): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)
    throw new InvalidBillingError('amount', 'must be a number >= 0');
  return Math.round(amount * 100);
}

/** Suma un período a una fecha (fin de mes seguro: 31 ene + 1 mes = 28/29 feb). */
export function addPeriod(date: Date, period: BillingPeriod, count = 1): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  if (period === 'monthly') d.setUTCMonth(d.getUTCMonth() + count);
  else d.setUTCFullYear(d.getUTCFullYear() + count);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}
