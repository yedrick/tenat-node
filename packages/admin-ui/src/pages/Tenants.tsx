import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get } from '../api';
import { useAuth } from '../auth';
import { EnterTenant } from '../components/EnterTenant';
import { IconBuilding, IconLogin, IconPlus, IconSearch } from '../components/icons';
import {
  Avatar,
  Badge,
  Button,
  Card,
  DataTable,
  ErrorBox,
  Input,
  PageHeader,
  RelativeTime,
  StatusBadge,
  cx,
} from '../components/ui';
import { navigate, useQueryParam } from '../router';
import type { Page, Tenant } from '../types';
import { NewTenant } from './NewTenant';

const STATUSES: [string, string][] = [
  ['', 'Todos'],
  ['active', 'Activos'],
  ['provisioning', 'Aprovisionando'],
  ['maintenance', 'Mantenimiento'],
  ['suspended', 'Suspendidos'],
  ['failed', 'Con fallas'],
];

export function Tenants() {
  const { can } = useAuth();
  const fromUrl = useQueryParam('search') ?? '';
  const [search, setSearch] = useState(fromUrl);
  const [debounced, setDebounced] = useState(fromUrl);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [entering, setEntering] = useState<Tenant | null>(null);
  // El buscador de la barra superior cambia `?search=`.
  useEffect(() => setSearch(fromUrl), [fromUrl]);
  useEffect(() => {
    const t = setTimeout(() => (setDebounced(search.trim()), setPage(1)), 250);
    return () => clearTimeout(t);
  }, [search]);

  const params = new URLSearchParams({
    page: String(page),
    perPage: '20',
    ...(debounced ? { search: debounced } : {}),
    ...(status ? { status } : {}),
  });
  const tenants = useQuery({
    queryKey: ['tenants', params.toString()],
    queryFn: () => get<Page<Tenant>>(`/tenants?${params}`),
    placeholderData: keepPreviousData,
  });
  const data = tenants.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;
  const canEnter = can('impersonate');

  return (
    <>
      <PageHeader
        title="Tenants"
        subtitle={
          data ? `${data.total} ${data.total === 1 ? 'tenant' : 'tenants'} en total` : undefined
        }
        actions={
          can('tenants:write') && (
            <Button variant="primary" icon={<IconPlus />} onClick={() => setCreating(true)}>
              Nuevo tenant
            </Button>
          )
        }
      />
      <ErrorBox error={tenants.error} />
      <Card flush>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
          <div className="relative w-full max-w-xs">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input
              aria-label="Buscar"
              placeholder="Buscar por id o nombre"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div role="radiogroup" aria-label="Estado" className="flex flex-wrap gap-1">
            {STATUSES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={status === value}
                onClick={() => (setStatus(value), setPage(1))}
                className={cx(
                  'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  status === value
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
          empty={tenants.isLoading ? 'Cargando…' : 'No hay tenants'}
          emptyIcon={<IconBuilding />}
          onRowClick={(t) => navigate(`/tenants/${t.id}`)}
          columns={[
            {
              header: 'Tenant',
              cell: ({ row }) => (
                <div className="flex items-center gap-3">
                  <Avatar
                    name={row.original.name}
                    color={String(row.original.theme?.primary ?? '')}
                    size="sm"
                  />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{row.original.name}</p>
                    <p className="truncate font-mono text-xs text-muted">{row.original.id}</p>
                  </div>
                </div>
              ),
            },
            { header: 'Estado', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
            {
              header: 'Plan',
              cell: ({ row }) =>
                row.original.plan ? (
                  <Badge tone="info">{row.original.plan}</Badge>
                ) : (
                  <span className="text-muted">—</span>
                ),
            },
            {
              header: 'Base de datos',
              cell: ({ row }) => (
                <span className="font-mono text-xs text-muted">
                  {row.original.database
                    ? `${row.original.database.serverId}/${row.original.database.name}`
                    : '—'}
                </span>
              ),
            },
            {
              header: 'Creado',
              cell: ({ row }) => (
                <span className="text-muted">
                  <RelativeTime value={row.original.createdAt} />
                </span>
              ),
            },
            {
              id: 'actions',
              header: '',
              cell: ({ row }) =>
                canEnter &&
                row.original.status === 'active' && (
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      icon={<IconLogin />}
                      aria-label={`Entrar a ${row.original.name}`}
                      onClick={(e) => (e.stopPropagation(), setEntering(row.original))}
                    >
                      Entrar
                    </Button>
                  </div>
                ),
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
      <NewTenant open={creating} onClose={() => setCreating(false)} />
      {entering && <EnterTenant tenant={entering} open onClose={() => setEntering(null)} />}
    </>
  );
}
