import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { get } from '../api';
import {
  IconActivity,
  IconAlert,
  IconBuilding,
  IconCheck,
  IconDatabase,
  IconSparkles,
} from '../components/icons';
import {
  Badge,
  Card,
  DataTable,
  ErrorBox,
  PageHeader,
  RelativeTime,
  Spinner,
  cx,
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

type StatTone = 'brand' | 'ok' | 'info' | 'warn' | 'danger';
const STAT_TONES: Record<StatTone, string> = {
  brand: 'bg-brand/10 text-brand',
  ok: 'bg-ok/10 text-ok',
  info: 'bg-info/10 text-info',
  warn: 'bg-warn/10 text-warn',
  danger: 'bg-danger/10 text-danger',
};

function Stat({
  label,
  value,
  icon,
  tone = 'brand',
  alert,
}: {
  label: string;
  value: number | string;
  icon: ReactNode;
  tone?: StatTone;
  /** Resalta el número (fallas, suspendidos). */
  alert?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-panel p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">{label}</p>
        <span
          className={cx('flex h-8 w-8 items-center justify-center rounded-lg', STAT_TONES[tone])}
        >
          {icon}
        </span>
      </div>
      <p
        className={cx(
          'mt-3 text-3xl font-semibold tracking-tight tabular-nums',
          alert && (tone === 'danger' ? 'text-danger' : 'text-warn'),
        )}
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
  if (metrics.isLoading)
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  if (metrics.error) return <ErrorBox error={metrics.error} />;
  const m = metrics.data!;
  const s = m.tenants.byStatus;
  const total = Object.values(s).reduce((a, b) => a + b, 0);
  const paused = (s.suspended ?? 0) + (s.maintenance ?? 0);
  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Estado general de la plataforma"
        actions={
          <Badge tone={m.health.status === 'ok' ? 'ok' : 'danger'} dot>
            {m.health.status === 'ok' ? 'Todo funciona' : 'Hay servicios con problemas'}
          </Badge>
        }
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Tenants" value={total} icon={<IconBuilding />} />
        <Stat label="Activos" value={s.active ?? 0} icon={<IconCheck />} tone="ok" />
        <Stat
          label="Nuevos (30 días)"
          value={m.tenants.createdLast30Days}
          icon={<IconSparkles />}
          tone="info"
        />
        <Stat
          label="Suspendidos / mant."
          value={paused}
          icon={<IconActivity />}
          tone="warn"
          alert={paused > 0}
        />
        <Stat
          label="Con fallas"
          value={s.failed ?? 0}
          icon={<IconAlert />}
          tone="danger"
          alert={(s.failed ?? 0) > 0}
        />
      </div>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Card title="Servicios" description="Lo mismo que responde /health.">
          <ul className="divide-y divide-line text-sm">
            {Object.entries(m.health.checks).map(([name, check]) => (
              <li
                key={name}
                className="flex items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
              >
                <span className="flex items-center gap-2 capitalize">
                  <IconDatabase className="text-muted" />
                  {name}
                </span>
                <span className="text-right">
                  <span className="mr-2 text-xs tabular-nums text-muted">
                    {check.durationMs} ms
                  </span>
                  <Badge tone={check.ok ? 'ok' : 'danger'} dot>
                    {check.ok ? 'ok' : 'error'}
                  </Badge>
                  {check.error && <p className="text-xs text-danger">{check.error}</p>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Eventos" description="Outbox y pools de conexión.">
          {m.outbox ? (
            <div className="grid grid-cols-4 gap-2 rounded-lg bg-subtle p-3 text-center text-sm">
              {(['pending', 'processing', 'published', 'failed'] as const).map((k) => (
                <div key={k}>
                  <p
                    className={cx(
                      'text-xl font-semibold tabular-nums',
                      k === 'failed' && m.outbox![k] > 0 && 'text-danger',
                    )}
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
      <Card title="Errores por tenant" className="mt-6" flush>
        <DataTable
          data={m.errors}
          empty="Sin errores registrados"
          emptyIcon={<IconCheck />}
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
            {
              header: 'Último',
              cell: ({ row }) => <RelativeTime value={row.original.lastErrorAt} />,
            },
          ]}
        />
      </Card>
    </>
  );
}
