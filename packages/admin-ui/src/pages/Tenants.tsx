import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get } from '../api';
import { useAuth } from '../auth';
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorBox,
  Input,
  PageHeader,
  Select,
  formatDate,
} from '../components/ui';
import { navigate } from '../router';
import type { Page, Tenant } from '../types';
import { NewTenant } from './NewTenant';

const STATUSES: [string, string][] = [
  ['', 'Todos los estados'],
  ['active', 'Activos'],
  ['provisioning', 'Aprovisionando'],
  ['maintenance', 'En mantenimiento'],
  ['suspended', 'Suspendidos'],
  ['failed', 'Con fallas'],
];

export function Tenants() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => (setDebounced(search), setPage(1)), 250);
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

  return (
    <>
      <PageHeader
        title="Tenants"
        subtitle={data ? `${data.total} en total` : undefined}
        actions={
          can('tenants:write') && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Nuevo tenant
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input
          aria-label="Buscar"
          placeholder="Buscar por id o nombre"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select
          aria-label="Estado"
          options={STATUSES}
          value={status}
          onChange={(e) => (setStatus(e.target.value), setPage(1))}
          className="max-w-xs"
        />
      </div>
      <ErrorBox error={tenants.error} />
      <Card>
        <DataTable
          data={data?.items ?? []}
          empty={tenants.isLoading ? 'Cargando…' : 'No hay tenants'}
          onRowClick={(t) => navigate(`/tenants/${t.id}`)}
          columns={[
            {
              header: 'Id',
              cell: ({ row }) => <span className="font-mono">{row.original.id}</span>,
            },
            { header: 'Nombre', cell: ({ row }) => row.original.name },
            { header: 'Estado', cell: ({ row }) => <Badge>{row.original.status}</Badge> },
            { header: 'Plan', cell: ({ row }) => row.original.plan ?? '—' },
            {
              header: 'Base',
              cell: ({ row }) => (
                <span className="font-mono text-xs">
                  {row.original.database
                    ? `${row.original.database.serverId}/${row.original.database.name}`
                    : '—'}
                </span>
              ),
            },
            { header: 'Creado', cell: ({ row }) => formatDate(row.original.createdAt) },
          ]}
        />
        {pages > 1 && (
          <div className="mt-3 flex items-center justify-end gap-2 text-sm">
            <Button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Anterior
            </Button>
            <span>
              Página {page} de {pages}
            </span>
            <Button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Siguiente
            </Button>
          </div>
        )}
      </Card>
      <NewTenant open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
