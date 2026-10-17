import type { InvoiceStatus, Invoice, SubscriptionStatus } from './types';

/** Centavos → "Bs 150,50" (según la moneda). */
export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toLocaleString('es', { minimumFractionDigits: 2 })} ${currency}`;
  }
}

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  open: 'Abierta',
  paid: 'Pagada',
  void: 'Anulada',
};

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trialing: 'En prueba',
  active: 'Al día',
  past_due: 'En mora',
  canceled: 'Cancelada',
};

export const SUBSCRIPTION_TONES: Record<SubscriptionStatus, string> = {
  trialing: 'info',
  active: 'ok',
  past_due: 'danger',
  canceled: 'neutral',
};

export const PAYMENT_METHODS: [string, string][] = [
  ['transfer', 'Transferencia'],
  ['qr', 'QR'],
  ['cash', 'Efectivo'],
  ['card', 'Tarjeta'],
  ['otro', 'Otro'],
];

export const methodLabel = (method: string) =>
  PAYMENT_METHODS.find(([value]) => value === method)?.[1] ?? method;

/** Abierta y con el vencimiento pasado. */
export const isOverdue = (invoice: Invoice, now = Date.now()) =>
  invoice.status === 'open' && new Date(invoice.dueAt).getTime() < now;

/** Fecha sin hora: "17/10/2026". */
export function formatDay(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('es', { dateStyle: 'short' });
}

/** Valor de un `<input type="datetime-local">` → ISO 8601 (o `undefined` si está vacío). */
export function localToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
