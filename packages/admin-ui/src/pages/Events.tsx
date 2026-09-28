import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../api';
import { useAuth } from '../auth';
import {
  Button,
  Card,
  DataTable,
  ErrorBox,
  PageHeader,
  formatDate,
  useToast,
} from '../components/ui';

interface Outbox {
  stats: Record<'pending' | 'processing' | 'published' | 'failed', number>;
  failed: {
    id: string;
    type: string;
    tenantId: string | null;
    destination: string;
    attempts: number;
    lastError: string | null;
    createdAt: string;
  }[];
}

export function Events() {
  const { can } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const outbox = useQuery({
    queryKey: ['outbox'],
    queryFn: () => get<Outbox>('/events/outbox'),
    refetchInterval: 10_000,
  });
  const retry = useMutation({
    mutationFn: (body: { id: string } | { all: true }) =>
      post<{ retried: number }>('/events/outbox/retry', body),
    onSuccess: (r) => (
      toast(`${r.retried} evento(s) de vuelta en la cola`),
      client.invalidateQueries({ queryKey: ['outbox'] })
    ),
  });
  const data = outbox.data;
  return (
    <>
      <PageHeader
        title="Eventos"
        subtitle="Outbox: eventos pendientes de salir y dead-letter"
        actions={
          can('events:retry') &&
          data &&
          data.failed.length > 0 && (
            <Button variant="primary" onClick={() => retry.mutate({ all: true })}>
              Reintentar todos
            </Button>
          )
        }
      />
      <ErrorBox error={outbox.error ?? retry.error} />
      {data && (
        <div className="mb-4 grid grid-cols-4 gap-3">
          {Object.entries(data.stats).map(([k, v]) => (
            <div key={k} className="rounded-lg border border-line bg-panel p-4">
              <p className="text-xs uppercase text-muted">{k}</p>
              <p
                className={`text-2xl font-semibold ${k === 'failed' && v > 0 ? 'text-danger' : ''}`}
              >
                {v}
              </p>
            </div>
          ))}
        </div>
      )}
      <Card title="Dead-letter">
        <DataTable
          data={data?.failed ?? []}
          empty="Ningún evento fallido"
          columns={[
            {
              header: 'Evento',
              cell: ({ row }) => <span className="font-mono text-xs">{row.original.type}</span>,
            },
            { header: 'Tenant', cell: ({ row }) => row.original.tenantId ?? '—' },
            { header: 'Destino', cell: ({ row }) => row.original.destination },
            { header: 'Intentos', cell: ({ row }) => row.original.attempts },
            {
              header: 'Último error',
              cell: ({ row }) => (
                <span className="text-xs text-danger">{row.original.lastError}</span>
              ),
            },
            { header: 'Creado', cell: ({ row }) => formatDate(row.original.createdAt) },
            {
              header: '',
              id: 'retry',
              cell: ({ row }) =>
                can('events:retry') && (
                  <Button onClick={() => retry.mutate({ id: row.original.id })}>Reintentar</Button>
                ),
            },
          ]}
        />
      </Card>
    </>
  );
}
