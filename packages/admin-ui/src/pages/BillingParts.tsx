import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { post } from '../api';
import { useAuth } from '../auth';
import {
  INVOICE_STATUS_LABELS,
  PAYMENT_METHODS,
  SUBSCRIPTION_STATUS_LABELS,
  SUBSCRIPTION_TONES,
  formatMoney,
  isOverdue,
} from '../billing';
import {
  Badge,
  Button,
  CopyButton,
  ErrorBox,
  Field,
  Input,
  Modal,
  Select,
  useToast,
} from '../components/ui';
import type { CheckoutSession, Invoice, SubscriptionStatus } from '../types';

export function InvoiceStatusBadge({ invoice }: { invoice: Invoice }) {
  if (isOverdue(invoice))
    return (
      <Badge tone="danger" dot>
        Vencida
      </Badge>
    );
  const tone = invoice.status === 'paid' ? 'ok' : invoice.status === 'open' ? 'warn' : 'neutral';
  return (
    <Badge tone={tone} dot>
      {INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}
      {invoice.status === 'open' && invoice.paidCents > 0 ? ' (parcial)' : ''}
    </Badge>
  );
}

export function SubscriptionStatusBadge({ status }: { status: SubscriptionStatus }) {
  return (
    <Badge tone={SUBSCRIPTION_TONES[status] ?? 'neutral'} dot>
      {SUBSCRIPTION_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/** Monto, y lo pagado si es un pago parcial. */
export function InvoiceAmount({ invoice }: { invoice: Invoice }) {
  return (
    <span className="tabular-nums">
      {formatMoney(invoice.amountCents, invoice.currency)}
      {invoice.status === 'open' && invoice.paidCents > 0 && (
        <span className="block text-xs text-muted">
          pagado {formatMoney(invoice.paidCents, invoice.currency)}
        </span>
      )}
    </span>
  );
}

const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

/** Registrar un pago manual (transferencia, QR, efectivo...). */
function PayModal({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const remaining = (invoice.amountCents - invoice.paidCents) / 100;
  const [amount, setAmount] = useState(String(remaining));
  const [method, setMethod] = useState('transfer');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(today());
  const pay = useMutation({
    mutationFn: () =>
      post(`/billing/invoices/${invoice.id}/payments`, {
        amount: Number(amount),
        method,
        reference: reference.trim() === '' ? null : reference.trim(),
        ...(date ? { paidAt: new Date(`${date}T12:00:00`).toISOString() } : {}),
      }),
    onSuccess: () => {
      toast('Pago registrado');
      void client.invalidateQueries({ queryKey: ['billing'] });
      onClose();
    },
  });
  const valid = Number(amount) > 0 && Number.isFinite(Number(amount));
  return (
    <Modal
      open
      title="Registrar pago"
      description={`${invoice.description} · falta ${formatMoney(invoice.amountCents - invoice.paidCents, invoice.currency)}`}
      onClose={onClose}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) pay.mutate();
        }}
      >
        <ErrorBox error={pay.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`Monto (${invoice.currency})`}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min="0.01"
                step="0.01"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          <Field label="Método">
            {(id) => (
              <Select
                id={id}
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                options={PAYMENT_METHODS}
              />
            )}
          </Field>
          <Field label="Referencia" hint="Nro. de transacción o comprobante (opcional).">
            {(id) => (
              <Input
                id={id}
                value={reference}
                maxLength={191}
                onChange={(e) => setReference(e.target.value)}
              />
            )}
          </Field>
          <Field label="Fecha del pago">
            {(id) => (
              <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" disabled={!valid} busy={pay.isPending}>
            Registrar pago
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Enlace de pago o QR de la pasarela. */
function CheckoutModal({
  invoice,
  providers,
  onClose,
}: {
  invoice: Invoice;
  providers: string[];
  onClose: () => void;
}) {
  const online = providers.filter((p) => p !== 'manual');
  const [provider, setProvider] = useState(online[0] ?? '');
  const checkout = useMutation({
    mutationFn: () =>
      post<CheckoutSession>(`/billing/invoices/${invoice.id}/checkout`, { provider }),
  });
  const session = checkout.data;
  return (
    <Modal
      open
      title="Cobrar en línea"
      description={`${invoice.description} · ${formatMoney(invoice.amountCents - invoice.paidCents, invoice.currency)}`}
      onClose={onClose}
    >
      <div className="space-y-4">
        <ErrorBox error={checkout.error} />
        {!session ? (
          <>
            {online.length > 1 && (
              <Field label="Pasarela">
                {(id) => (
                  <Select
                    id={id}
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    options={online}
                  />
                )}
              </Field>
            )}
            <p className="text-sm text-muted">
              Genera un enlace de pago o un QR con <strong>{provider}</strong>. Cuando el cliente
              pague, la pasarela avisa por webhook y la factura queda pagada sola.
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={onClose}>Cancelar</Button>
              <Button
                variant="primary"
                disabled={!provider}
                busy={checkout.isPending}
                onClick={() => checkout.mutate()}
              >
                Generar cobro
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-4" data-testid="checkout-session">
            {session.url && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Enlace de pago</p>
                <div className="flex items-center gap-2">
                  <a
                    href={session.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 truncate text-sm text-brand hover:underline"
                  >
                    {session.url}
                  </a>
                  <CopyButton text={session.url} />
                </div>
              </div>
            )}
            {session.qr &&
              (session.qr.startsWith('data:image/') ? (
                <img
                  src={session.qr}
                  alt="QR de pago"
                  className="mx-auto h-56 w-56 rounded-lg border border-line bg-white p-2"
                />
              ) : (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Contenido del QR</p>
                  <p className="break-all rounded-lg bg-subtle p-3 font-mono text-xs">
                    {session.qr}
                  </p>
                  <CopyButton text={session.qr} />
                </div>
              ))}
            <p className="text-xs text-muted">
              Referencia en la pasarela: <span className="font-mono">{session.providerRef}</span>
            </p>
            <div className="flex justify-end">
              <Button variant="primary" onClick={onClose}>
                Listo
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Botones de una factura: registrar pago, cobrar en línea y anular (con confirmación). */
export function InvoiceActions({ invoice, providers }: { invoice: Invoice; providers: string[] }) {
  const { can } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const [modal, setModal] = useState<'pay' | 'checkout' | null>(null);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const voidInvoice = useMutation({
    mutationFn: () => post(`/billing/invoices/${invoice.id}/void`),
    onSuccess: () => {
      toast('Factura anulada');
      setConfirmVoid(false);
      void client.invalidateQueries({ queryKey: ['billing'] });
    },
    onError: (error) => toast(error instanceof Error ? error.message : String(error), 'error'),
  });
  if (!can('billing:write') || invoice.status !== 'open') return null;
  const online = providers.some((p) => p !== 'manual');
  return (
    <div className="flex flex-wrap justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
      {confirmVoid ? (
        <span role="alert" className="flex items-center gap-1.5 text-xs">
          ¿Anular?
          <Button size="sm" onClick={() => setConfirmVoid(false)}>
            No
          </Button>
          <Button
            size="sm"
            variant="danger"
            busy={voidInvoice.isPending}
            onClick={() => voidInvoice.mutate()}
          >
            Sí, anular
          </Button>
        </span>
      ) : (
        <>
          <Button size="sm" variant="primary" onClick={() => setModal('pay')}>
            Registrar pago
          </Button>
          {online && (
            <Button size="sm" onClick={() => setModal('checkout')}>
              Cobrar en línea
            </Button>
          )}
          {invoice.paidCents === 0 && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmVoid(true)}>
              Anular
            </Button>
          )}
        </>
      )}
      {modal === 'pay' && <PayModal invoice={invoice} onClose={() => setModal(null)} />}
      {modal === 'checkout' && (
        <CheckoutModal invoice={invoice} providers={providers} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
