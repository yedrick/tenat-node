import type {
  Invoice,
  InvoiceStatus,
  Payment,
  Subscription,
  SubscriptionStatus,
  Tenant,
} from '../domain/index.js';
import type { Page } from './tenant-repository.js';

/** Suscripciones, facturas y pagos. La base central los guarda con `@tenancy-node/db`. */
export interface BillingRepository {
  findSubscription(tenantId: string): Promise<Subscription | undefined>;
  saveSubscription(subscription: Subscription): Promise<void>;
  /** Suscripciones por estado, o las que vencen antes de `endsBefore`. */
  listSubscriptions(query?: {
    status?: readonly SubscriptionStatus[];
    endsBefore?: Date;
    page?: number;
    perPage?: number;
  }): Promise<Page<Subscription>>;
  insertInvoice(invoice: Invoice): Promise<void>;
  saveInvoice(invoice: Invoice): Promise<void>;
  findInvoice(id: string): Promise<Invoice | undefined>;
  findInvoiceByProviderRef(provider: string, providerRef: string): Promise<Invoice | undefined>;
  /** Más nuevas primero. `dueBefore` filtra por vencimiento. */
  listInvoices(query?: {
    tenantId?: string;
    status?: readonly InvoiceStatus[];
    dueBefore?: Date;
    periodStart?: Date;
    page?: number;
    perPage?: number;
  }): Promise<Page<Invoice>>;
  insertPayment(payment: Payment): Promise<void>;
  /** Pagos de una factura o de un tenant, más nuevos primero. */
  listPayments(query: {
    invoiceId?: string;
    tenantId?: string;
    limit?: number;
  }): Promise<Payment[]>;
}

/** Lo que devuelve una pasarela al iniciar un cobro: un enlace de pago, un QR o los dos. */
export interface CheckoutSession {
  /** Id del cobro en la pasarela (para reconocer su webhook). */
  providerRef: string;
  url?: string;
  /** Contenido del QR (texto o imagen en data URL). */
  qr?: string;
  expiresAt?: Date;
}

/** Resultado de leer un webhook de la pasarela. */
export type PaymentWebhookResult =
  | {
      type: 'paid';
      /** El `providerRef` de `createCheckout`. */
      providerRef: string;
      amountCents?: number;
      reference?: string;
      paidAt?: Date;
    }
  | { type: 'failed'; providerRef: string; reason?: string }
  | { type: 'ignored' };

/**
 * Pasarela de pago (Stripe, Mercado Pago, un QR bancario...). La pasarela `manual` viene
 * incluida: el pago se registra a mano desde el panel o con `tenancy.billing.pay()`.
 */
export interface PaymentProvider {
  readonly name: string;
  /** Inicia el cobro de una factura. */
  createCheckout(input: {
    invoice: Invoice;
    tenant: Tenant;
    returnUrl?: string;
  }): Promise<CheckoutSession>;
  /** Verifica la firma del webhook y dice qué pasó. Debe lanzar si la firma no es válida. */
  parseWebhook(request: {
    headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    body: string;
  }): Promise<PaymentWebhookResult>;
}
