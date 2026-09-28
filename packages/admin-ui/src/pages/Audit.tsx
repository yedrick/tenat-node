import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get } from '../api';
import { Button, Card, DataTable, ErrorBox, Input, PageHeader, formatDate } from '../components/ui';
import type { AuditEntry } from '../types';

export function Audit() {
  const [tenant, setTenant] = useState('');
  const [action, setAction] = useState('');
  const [filters, setFilters] = useState({ tenant: '', action: '' });
  const audit = useInfiniteQuery({
    queryKey: ['audit', filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        limit: '50',
        ...(filters.tenant ? { tenant: filters.tenant } : {}),
        ...(filters.action ? { action: filters.action } : {}),
        ...(pageParam ? { before: String(pageParam) } : {}),
      });
      return get<AuditEntry[]>(`/audit?${params}`);
    },
    getNextPageParam: (last) => (last.length === 50 ? last.at(-1)!.id : undefined),
  });
  const rows = audit.data?.pages.flat() ?? [];
  return (
    <>
      <PageHeader
        title="Auditoría"
        subtitle="Cada acción del panel, con quién la hizo y qué cambió"
      />
      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(e) => (e.preventDefault(), setFilters({ tenant, action }))}
      >
        <Input
          aria-label="Tenant"
          placeholder="Tenant"
          value={tenant}
          onChange={(e) => setTenant(e.target.value)}
          className="max-w-44"
        />
        <Input
          aria-label="Acción"
          placeholder="Acción (prefijo): tenant., auth."
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="max-w-64"
        />
        <Button type="submit">Filtrar</Button>
      </form>
      <ErrorBox error={audit.error} />
      <Card>
        <DataTable
          data={rows}
          empty={audit.isLoading ? 'Cargando…' : 'Sin registros'}
          columns={[
            { header: 'Cuándo', cell: ({ row }) => formatDate(row.original.createdAt) },
            {
              header: 'Acción',
              cell: ({ row }) => <span className="font-mono text-xs">{row.original.action}</span>,
            },
            {
              header: 'Usuario',
              cell: ({ row }) =>
                row.original.adminEmail ??
                (row.original.adminUserId ? `#${row.original.adminUserId}` : '—'),
            },
            { header: 'Tenant', cell: ({ row }) => row.original.tenantId ?? '—' },
            {
              header: 'Objetivo',
              cell: ({ row }) =>
                row.original.targetType
                  ? `${row.original.targetType} ${row.original.targetId ?? ''}`
                  : '—',
            },
            {
              header: 'Cambios',
              cell: ({ row }) =>
                row.original.changes ? (
                  <pre className="max-w-md overflow-x-auto text-xs">
                    {JSON.stringify(row.original.changes)}
                  </pre>
                ) : (
                  '—'
                ),
            },
            {
              header: 'IP',
              cell: ({ row }) => <span className="font-mono text-xs">{row.original.ip ?? ''}</span>,
            },
          ]}
        />
        {audit.hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button busy={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
              Cargar más
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
