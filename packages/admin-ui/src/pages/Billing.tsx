import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { get, post } from '../api';
import { useAuth } from '../auth';
import { formatDay, formatMoney } from '../billing';
import { IconActivity, IconAlert, IconInbox, IconWallet } from '../components/icons';
import {
  Button,
  Card,
  DataTable,
  ErrorBox,
  Input,
  PageHeader,
  cx,
  useToast,
} from '../components/ui';
import { Link } from '../router';
import type { BillingRunResult, InvoicesPage } from '../types';
import { InvoiceActions, InvoiceAmount, InvoiceStatusBadge } from './BillingParts';

type Filter = '' | 'open' | 'overdue' | 'paid' | 'void';
const FILTERS: [Filter, string][] = [
  ['', 'Todas'],
  ['open', 'Abiertas'],
  ['overdue', 'Vencidas'],
  ['paid', 'Pagadas'],
  ['void', 'Anuladas'],
];

function SummaryCard({
  label,
  value,
  icon,
  alert,
}: {
  label: string;
  value: number | undefined;
  icon: ReactNode;
  alert?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-panel p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">{label}</p>
        <span
          className={cx(
            'flex h-8 w-8 items-center justify-center rounded-lg',
            alert ? 'bg-danger/10 text-danger' : 'bg-brand/10 text-brand',
          )}
        >
          {icon}
        </span>
      </div>
      <p className={cx('mt-2 text-3xl font-semibold tabular-nums', alert && 'text-danger')}>
        {value ?? '—'}
      </p>
    </div>
  );
}

/** Facturas de todos los tenants y el ciclo de cobro. */
export function Billing() {
  const { can } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('open');
  const [tenant, setTenant] = useState('');
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({
    page: String(page),
    perPage: '20',
    ...(filter === 'overdue' ? { overdue: '1' } : filter ? { status: filter } : {}),
    ...(tenant.trim() ? { tenant: tenant.trim() } : {}),
  });
  const invoices = useQuery({
    queryKey: ['billing', 'invoices', params.toString()],
    queryFn: () => get<InvoicesPage>(`/billing/invoices?${params}`),
    placeholderData: keepPreviousData,
  });
  const run = useMutation({
    mutationFn: () => post<BillingRunResult>('/billing/run'),
    onSuccess: (r) => {
      toast(
        `${r.invoiced.length} facturas nuevas · ${r.pastDue.length} en mora · ${r.suspended.length} suspendidos`,
      );
      void client.invalidateQueries({ queryKey: ['billing'] });
    },
  });
  const data = invoices.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;
  const providers = data?.providers ?? ['manual'];

  return (
    <>
      <PageHeader
        title="Cobros"
        subtitle={
          <>
            Facturas y pagos de los tenants · pasarelas:{' '}
            {providers.filter((p) => p !== 'manual').join(', ') || 'solo pago manual'}
          </>
        }
        actions={
          can('billing:write') && (
            <Button
              icon={<IconActivity />}
              busy={run.isPending}
              onClick={() => run.mutate()}
              title="Factura los períodos por vencer, marca morosos y suspende si está configurado"
            >
              Correr ciclo de cobro
            </Button>
          )
        }
      />
      <ErrorBox error={invoices.error ?? run.error} />
      {run.data && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-line bg-subtle px-4 py-3 text-sm"
        >
          <strong>Ciclo de cobro:</strong> {run.data.invoiced.length} facturas nuevas
          {run.data.invoiced.length > 0 && ` (${run.data.invoiced.join(', ')})`} ·{' '}
          {run.data.pastDue.length} en mora
          {run.data.pastDue.length > 0 && ` (${run.data.pastDue.join(', ')})`} ·{' '}
          {run.data.suspended.length} suspendidos
          {run.data.suspended.length > 0 && ` (${run.data.suspended.join(', ')})`}
        </div>
      )}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <SummaryCard label="Facturas abiertas" value={data?.summary.open} icon={<IconWallet />} />
        <SummaryCard
          label="Vencidas"
          value={data?.summary.overdue}
          icon={<IconAlert />}
          alert={(data?.summary.overdue ?? 0) > 0}
        />
        <SummaryCard
          label="Suscripciones en mora"
          value={data?.summary.pastDueSubscriptions}
          icon={<IconAlert />}
          alert={(data?.summary.pastDueSubscriptions ?? 0) > 0}
        />
      </div>
      <Card flush>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
          <Input
            aria-label="Filtrar por tenant"
            placeholder="Id del tenant"
            value={tenant}
            onChange={(e) => (setTenant(e.target.value), setPage(1))}
            className="max-w-48"
          />
          <div role="radiogroup" aria-label="Estado" className="flex flex-wrap gap-1">
            {FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={filter === value}
                onClick={() => (setFilter(value), setPage(1))}
                className={cx(
                  'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  filter === value
                    ? 'bg-fg text-panel'
                    : 'text-muted ring-1 ring-inset ring-line hover:bg-subtle hover:text-fg',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <DataTable
          data={data?.items ?? []}
          empty={invoices.isLoading ? 'Cargando…' : 'No hay facturas'}
          emptyIcon={<IconInbox />}
          columns={[
            {
              header: 'Tenant',
              cell: ({ row }) => (
                <Link
                  to={`/tenants/${row.original.tenantId}?tab=billing`}
                  className="font-mono text-xs text-brand hover:underline"
                >
                  {row.original.tenantId}
                </Link>
              ),
            },
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
              cell: ({ row }) => <InvoiceActions invoice={row.original} providers={providers} />,
            },
          ]}
        />
        {pages > 1 && (
          <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3 text-sm">
            <span className="text-muted">
              Página {page} de {pages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Anterior
              </Button>
              <Button size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Siguiente
              </Button>
            </div>
          </div>
        )}
      </Card>
      {data && data.total > 0 && (
        <p className="mt-3 text-xs text-muted">
          {data.total} factura{data.total === 1 ? '' : 's'}
          {filter === 'open' &&
          data.items.length > 0 &&
          data.items.every((i) => i.currency === data.items[0]!.currency)
            ? ` · en esta página: ${formatMoney(
                data.items.reduce((s, i) => s + i.amountCents - i.paidCents, 0),
                data.items[0]!.currency,
              )} por cobrar`
            : ''}
        </p>
      )}
    </>
  );
}
