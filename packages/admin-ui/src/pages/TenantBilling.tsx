import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { get, post, put } from '../api';
import { useAuth } from '../auth';
import { formatDay, formatMoney, methodLabel } from '../billing';
import { IconInbox, IconPlus } from '../components/icons';
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  cx,
  formatDate,
  useToast,
} from '../components/ui';
import { planLabel, usePlans } from '../plans';
import type { BillingPeriod, Subscription, TenantBilling as Data } from '../types';
import {
  InvoiceActions,
  InvoiceAmount,
  InvoiceStatusBadge,
  SubscriptionStatusBadge,
} from './BillingParts';

const PERIODS: [BillingPeriod, string][] = [
  ['monthly', 'Mensual'],
  ['yearly', 'Anual'],
];

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** Pestaña "Cobros" de un tenant: suscripción, facturas y pagos. */
export function TenantBilling({ tenantId, plan }: { tenantId: string; plan: string | null }) {
  const { can } = useAuth();
  const path = `/tenants/${encodeURIComponent(tenantId)}/billing`;
  const billing = useQuery({
    queryKey: ['billing', 'tenant', tenantId],
    queryFn: () => get<Data>(path),
  });
  const [editing, setEditing] = useState(false);
  const [invoicing, setInvoicing] = useState(false);
  if (billing.isLoading)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  if (billing.error) return <ErrorBox error={billing.error} />;
  const d = billing.data!;
  const sub = d.subscription;
  const canWrite = can('billing:write');

  return (
    <div className="space-y-6">
      <SubscriptionCard
        tenantId={tenantId}
        subscription={sub}
        canWrite={canWrite}
        onEdit={() => setEditing(true)}
      />
      <Card
        title="Facturas"
        description="Las más nuevas primero."
        flush
        actions={
          canWrite && (
            <Button size="sm" icon={<IconPlus />} onClick={() => setInvoicing(true)}>
              Nueva factura
            </Button>
          )
        }
      >
        <DataTable
          data={d.invoices}
          empty="Sin facturas"
          emptyIcon={<IconInbox />}
          columns={[
            { header: 'Concepto', accessorKey: 'description' },
            { header: 'Monto', cell: ({ row }) => <InvoiceAmount invoice={row.original} /> },
            {
              header: 'Vence',
              cell: ({ row }) => (
                <span className="text-muted">{formatDay(row.original.dueAt)}</span>
              ),
            },
            {
              header: 'Estado',
              cell: ({ row }) => <InvoiceStatusBadge invoice={row.original} />,
            },
            {
              header: '',
              id: 'actions',
              cell: ({ row }) => <InvoiceActions invoice={row.original} providers={d.providers} />,
            },
          ]}
        />
      </Card>
      <Card title="Pagos" flush>
        <DataTable
          data={d.payments}
          empty="Sin pagos registrados"
          columns={[
            {
              header: 'Fecha',
              cell: ({ row }) => formatDay(row.original.paidAt),
            },
            {
              header: 'Monto',
              cell: ({ row }) => (
                <span className="tabular-nums">
                  {formatMoney(row.original.amountCents, row.original.currency)}
                </span>
              ),
            },
            { header: 'Método', cell: ({ row }) => methodLabel(row.original.method) },
            {
              header: 'Referencia',
              cell: ({ row }) =>
                row.original.reference ? (
                  <span className="font-mono text-xs">{row.original.reference}</span>
                ) : (
                  <span className="text-muted">—</span>
                ),
            },
            {
              header: 'Registrado por',
              cell: ({ row }) =>
                row.original.recordedBy ?? (
                  <span className="text-muted">{row.original.provider} (webhook)</span>
                ),
            },
          ]}
        />
      </Card>
      {editing && (
        <SubscriptionForm
          path={path}
          subscription={sub}
          tenantPlan={plan}
          providers={d.providers}
          onClose={() => setEditing(false)}
        />
      )}
      {invoicing && (
        <NewInvoice path={path} subscription={sub} onClose={() => setInvoicing(false)} />
      )}
    </div>
  );
}

function SubscriptionCard({
  tenantId,
  subscription: sub,
  canWrite,
  onEdit,
}: {
  tenantId: string;
  subscription: Subscription | null;
  canWrite: boolean;
  onEdit: () => void;
}) {
  const plans = usePlans();
  const client = useQueryClient();
  const toast = useToast();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancel = useMutation({
    mutationFn: () => post(`/tenants/${encodeURIComponent(tenantId)}/billing/cancel`),
    onSuccess: () => {
      toast('Suscripción cancelada');
      setConfirmCancel(false);
      void client.invalidateQueries({ queryKey: ['billing'] });
    },
  });
  if (!sub)
    return (
      <Card title="Suscripción">
        <EmptyState
          action={
            canWrite && (
              <Button variant="primary" onClick={onEdit}>
                Crear suscripción
              </Button>
            )
          }
        >
          Este tenant todavía no tiene suscripción: no se le factura nada.
        </EmptyState>
      </Card>
    );
  return (
    <Card
      title="Suscripción"
      actions={
        canWrite && (
          <>
            {sub.status !== 'canceled' && !confirmCancel && (
              <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(true)}>
                Cancelar suscripción
              </Button>
            )}
            <Button size="sm" onClick={onEdit}>
              {sub.status === 'canceled' ? 'Reactivar' : 'Editar'}
            </Button>
          </>
        )
      }
    >
      <ErrorBox error={cancel.error} />
      {confirmCancel && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm"
        >
          <span>
            ¿Cancelar la suscripción? Se deja de facturar; el tenant sigue con lo ya pagado.
          </span>
          <span className="flex gap-2">
            <Button size="sm" onClick={() => setConfirmCancel(false)}>
              No
            </Button>
            <Button
              size="sm"
              variant="danger"
              busy={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Sí, cancelar
            </Button>
          </span>
        </div>
      )}
      <dl className="grid gap-4 sm:grid-cols-3">
        <Info label="Estado">
          <SubscriptionStatusBadge status={sub.status} />
        </Info>
        <Info label="Plan">{planLabel(plans.data, sub.plan) ?? '—'}</Info>
        <Info label="Monto">
          <span className="tabular-nums">
            {formatMoney(sub.amountCents, sub.currency)} /{' '}
            {sub.period === 'monthly' ? 'mes' : 'año'}
          </span>
        </Info>
        <Info label={sub.status === 'trialing' ? 'Prueba' : 'Período actual'}>
          {formatDay(sub.currentPeriodStart)} – {formatDay(sub.currentPeriodEnd)}
        </Info>
        <Info label="Pasarela">{sub.provider === 'manual' ? 'Pago manual' : sub.provider}</Info>
        {sub.canceledAt && <Info label="Cancelada">{formatDate(sub.canceledAt)}</Info>}
      </dl>
    </Card>
  );
}

function SubscriptionForm({
  path,
  subscription: sub,
  tenantPlan,
  providers,
  onClose,
}: {
  path: string;
  subscription: Subscription | null;
  tenantPlan: string | null;
  providers: string[];
  onClose: () => void;
}) {
  const plans = usePlans();
  const client = useQueryClient();
  const toast = useToast();
  const fresh = !sub || sub.status === 'canceled';
  const [plan, setPlan] = useState(sub?.plan ?? tenantPlan ?? '');
  const [period, setPeriod] = useState<BillingPeriod>(sub?.period ?? 'monthly');
  const [amount, setAmount] = useState(sub && !fresh ? String(sub.amountCents / 100) : '');
  const [currency, setCurrency] = useState(sub?.currency ?? '');
  const [trialDays, setTrialDays] = useState('');
  const [provider, setProvider] = useState(sub?.provider ?? 'manual');
  const enabled = plans.data?.enabled ?? false;
  const chosen = plans.data?.plans.find((p) => p.id === plan);
  const planPrice = chosen?.price?.[period];
  const save = useMutation({
    mutationFn: () =>
      put<Subscription>(`${path}/subscription`, {
        ...(enabled && plan !== (sub?.plan ?? tenantPlan ?? '') ? { plan: plan || null } : {}),
        period,
        ...(amount.trim() !== '' ? { amount: Number(amount) } : {}),
        ...(currency.trim() !== '' ? { currency: currency.trim().toUpperCase() } : {}),
        ...(fresh && trialDays.trim() !== '' ? { trialDays: Number(trialDays) } : {}),
        provider,
      }),
    onSuccess: () => {
      toast(fresh ? 'Suscripción creada' : 'Suscripción guardada');
      void client.invalidateQueries({ queryKey: ['billing'] });
      void client.invalidateQueries({ queryKey: ['tenant'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      title={fresh ? 'Nueva suscripción' : 'Editar suscripción'}
      description={
        fresh
          ? 'Sin días de prueba, se emite la factura del primer período.'
          : 'Los cambios aplican desde la próxima factura.'
      }
      onClose={onClose}
      size="lg"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <ErrorBox error={save.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          {enabled && (
            <Field label="Plan" hint="Cambiarlo cambia también los módulos del tenant.">
              {(id) => (
                <Select
                  id={id}
                  value={plan}
                  onChange={(e) => setPlan(e.target.value)}
                  options={[
                    ['', 'Sin plan'],
                    ...(plans.data?.plans.map((p) => [p.id, p.label] as [string, string]) ?? []),
                  ]}
                />
              )}
            </Field>
          )}
          <Field label="Período">
            {(id) => (
              <Select
                id={id}
                value={period}
                onChange={(e) => setPeriod(e.target.value as BillingPeriod)}
                options={PERIODS}
              />
            )}
          </Field>
          <Field
            label="Monto por período"
            hint={
              planPrice != null
                ? `Vacío = precio del plan (${planPrice} ${chosen?.price?.currency ?? ''}).`
                : 'El plan no tiene precio para este período: escribe el monto.'
            }
          >
            {(id) => (
              <Input
                id={id}
                type="number"
                min="0"
                step="0.01"
                value={amount}
                placeholder={planPrice != null ? String(planPrice) : ''}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          <Field label="Moneda" hint="Código de 3 letras (BOB, USD). Vacío = la del plan.">
            {(id) => (
              <Input
                id={id}
                value={currency}
                maxLength={3}
                placeholder={chosen?.price?.currency ?? 'USD'}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            )}
          </Field>
          {fresh && (
            <Field label="Días de prueba" hint="Opcional: sin cobro durante la prueba.">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min="0"
                  step="1"
                  value={trialDays}
                  onChange={(e) => setTrialDays(e.target.value)}
                />
              )}
            </Field>
          )}
          <Field label="Pasarela">
            {(id) => (
              <Select
                id={id}
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                options={providers.map(
                  (p) => [p, p === 'manual' ? 'Pago manual' : p] as [string, string],
                )}
              />
            )}
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            {fresh ? 'Crear suscripción' : 'Guardar'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function NewInvoice({
  path,
  subscription: sub,
  onClose,
}: {
  path: string;
  subscription: Subscription | null;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const canPeriod = !!sub && sub.status !== 'canceled';
  const [mode, setMode] = useState<'period' | 'oneoff'>(canPeriod ? 'period' : 'oneoff');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const create = useMutation({
    mutationFn: () =>
      post(
        `${path}/invoices`,
        mode === 'period' ? {} : { description: description.trim(), amount: Number(amount) },
      ),
    onSuccess: () => {
      toast('Factura emitida');
      void client.invalidateQueries({ queryKey: ['billing'] });
      onClose();
    },
  });
  const valid = mode === 'period' || (description.trim() !== '' && Number(amount) > 0);
  return (
    <Modal open title="Nueva factura" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) create.mutate();
        }}
      >
        <ErrorBox error={create.error} />
        <div role="radiogroup" aria-label="Tipo de factura" className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ['period', 'Próximo período', 'Según la suscripción'],
              ['oneoff', 'Cobro suelto', 'Instalación, capacitación…'],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              disabled={value === 'period' && !canPeriod}
              onClick={() => setMode(value)}
              className={cx(
                'rounded-lg border p-3 text-left text-sm transition-colors disabled:opacity-50',
                mode === value ? 'border-brand bg-brand/5' : 'border-line hover:bg-subtle',
              )}
            >
              <span className="block font-medium">{label}</span>
              <span className="text-xs text-muted">{hint}</span>
            </button>
          ))}
        </div>
        {mode === 'period' && sub && (
          <p className="text-sm text-muted">
            Desde {formatDay(sub.currentPeriodEnd)} por {formatMoney(sub.amountCents, sub.currency)}
            . Si ya existe, no se duplica.
          </p>
        )}
        {mode === 'oneoff' && (
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <Field label="Concepto">
              {(id) => (
                <Input
                  id={id}
                  value={description}
                  maxLength={255}
                  required
                  onChange={(e) => setDescription(e.target.value)}
                />
              )}
            </Field>
            <Field label={`Monto${sub ? ` (${sub.currency})` : ''}`}>
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
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" disabled={!valid} busy={create.isPending}>
            Emitir factura
          </Button>
        </div>
      </form>
    </Modal>
  );
}
