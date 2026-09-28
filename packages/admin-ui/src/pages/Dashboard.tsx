import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import {
  Badge,
  Card,
  DataTable,
  ErrorBox,
  PageHeader,
  Spinner,
  formatDate,
} from '../components/ui';
import { navigate } from '../router';

interface Metrics {
  tenants: { byStatus: Record<string, number>; createdLast30Days: number };
  pools: Record<string, { open: number; inUse: number; maxOpenPools: number }>;
  health: {
    status: 'ok' | 'error';
    checks: Record<string, { ok: boolean; durationMs: number; error?: string }>;
  };
  errors: {
    tenantId: string | null;
    total: number;
    byCode: Record<string, number>;
    lastErrorAt: string | null;
  }[];
  outbox: { pending: number; processing: number; published: number; failed: number } | null;
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'danger' | 'warn';
}) {
  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <p className="text-xs uppercase text-muted">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold ${tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : ''}`}
      >
        {value}
      </p>
    </div>
  );
}

export function Dashboard() {
  const metrics = useQuery({
    queryKey: ['metrics'],
    queryFn: () => get<Metrics>('/metrics'),
    refetchInterval: 15_000,
  });
  if (metrics.isLoading) return <Spinner />;
  if (metrics.error) return <ErrorBox error={metrics.error} />;
  const m = metrics.data!;
  const s = m.tenants.byStatus;
  const total = Object.values(s).reduce((a, b) => a + b, 0);
  return (
    <>
      <PageHeader title="Dashboard" subtitle="Estado general de la plataforma" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Tenants" value={total} />
        <Stat label="Activos" value={s.active ?? 0} />
        <Stat label="Nuevos (30 días)" value={m.tenants.createdLast30Days} />
        <Stat
          label="Suspendidos / mant."
          value={(s.suspended ?? 0) + (s.maintenance ?? 0)}
          tone={(s.suspended ?? 0) + (s.maintenance ?? 0) > 0 ? 'warn' : undefined}
        />
        <Stat
          label="Con fallas"
          value={s.failed ?? 0}
          tone={(s.failed ?? 0) > 0 ? 'danger' : undefined}
        />
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card
          title={
            <span>
              Salud{' '}
              <Badge tone={m.health.status === 'ok' ? 'active' : 'failed'}>{m.health.status}</Badge>
            </span>
          }
        >
          <ul className="space-y-2 text-sm">
            {Object.entries(m.health.checks).map(([name, check]) => (
              <li key={name} className="flex items-center justify-between gap-2">
                <span>{name}</span>
                <span className="text-right">
                  <Badge tone={check.ok ? 'active' : 'failed'}>{check.ok ? 'ok' : 'error'}</Badge>{' '}
                  <span className="text-xs text-muted">{check.durationMs} ms</span>
                  {check.error && <p className="text-xs text-danger">{check.error}</p>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Eventos (outbox)">
          {m.outbox ? (
            <div className="grid grid-cols-4 gap-2 text-center text-sm">
              {(['pending', 'processing', 'published', 'failed'] as const).map((k) => (
                <div key={k}>
                  <p
                    className={`text-xl font-semibold ${k === 'failed' && m.outbox![k] > 0 ? 'text-danger' : ''}`}
                  >
                    {m.outbox![k]}
                  </p>
                  <p className="text-xs text-muted">{k}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">La outbox no está instalada.</p>
          )}
          <div className="mt-4 text-sm">
            <p className="mb-1 text-xs uppercase text-muted">Pools de conexión</p>
            {Object.keys(m.pools).length === 0 && (
              <p className="text-muted">Sin pools abiertos todavía.</p>
            )}
            {Object.entries(m.pools).map(([server, p]) => (
              <p key={server}>
                {server}: {p.open} abiertos, {p.inUse} en uso (máx. {p.maxOpenPools})
              </p>
            ))}
          </div>
        </Card>
      </div>
      <Card title="Errores por tenant" className="mt-4">
        <DataTable
          data={m.errors}
          empty="Sin errores registrados"
          onRowClick={(row) => row.tenantId && navigate(`/tenants/${row.tenantId}?tab=errors`)}
          columns={[
            {
              header: 'Tenant',
              cell: ({ row }) =>
                row.original.tenantId ?? <span className="text-muted">central</span>,
            },
            { header: 'Total', cell: ({ row }) => row.original.total },
            {
              header: 'Códigos',
              cell: ({ row }) =>
                Object.entries(row.original.byCode).map(([code, n]) => (
                  <span key={code} className="mr-2 font-mono text-xs">
                    {code}×{n}
                  </span>
                )),
            },
            { header: 'Último', cell: ({ row }) => formatDate(row.original.lastErrorAt) },
          ]}
        />
      </Card>
    </>
  );
}
