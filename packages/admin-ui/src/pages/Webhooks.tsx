import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { del, get, patch, post } from '../api';
import { useAuth } from '../auth';
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorBox,
  Field,
  Input,
  Modal,
  PageHeader,
  formatDate,
  useToast,
} from '../components/ui';
import type { Delivery, Webhook } from '../types';

export function Webhooks() {
  const { can } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => get<Webhook[]>('/webhooks') });
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Webhook | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ['webhooks'] });
  const toggle = useMutation({
    mutationFn: (w: Webhook) => patch(`/webhooks/${w.id}`, { active: !w.isActive }),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: (w: Webhook) =>
      post<{ ok: boolean; status: number | null; ms: number; error?: string }>(
        `/webhooks/${w.id}/test`,
      ),
    onSuccess: (r) =>
      toast(
        r.ok ? `Prueba OK (${r.status}, ${r.ms} ms)` : `Prueba fallida: ${r.error ?? r.status}`,
        r.ok ? 'ok' : 'error',
      ),
  });
  const remove = useMutation({
    mutationFn: (w: Webhook) => del(`/webhooks/${w.id}`),
    onSuccess: () => (setSelected(null), refresh()),
  });

  return (
    <>
      <PageHeader
        title="Webhooks"
        subtitle="Eventos firmados con HMAC hacia otros sistemas"
        actions={
          can('webhooks:write') && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Nuevo webhook
            </Button>
          )
        }
      />
      <ErrorBox error={hooks.error ?? toggle.error ?? remove.error} />
      <Card>
        <DataTable
          data={hooks.data ?? []}
          empty={hooks.isLoading ? 'Cargando…' : 'Sin webhooks'}
          onRowClick={setSelected}
          columns={[
            { header: 'Nombre', cell: ({ row }) => row.original.name },
            {
              header: 'Tenant',
              cell: ({ row }) =>
                row.original.tenantId ?? <span className="text-muted">global</span>,
            },
            {
              header: 'URL',
              cell: ({ row }) => (
                <span className="break-all font-mono text-xs">{row.original.url}</span>
              ),
            },
            {
              header: 'Eventos',
              cell: ({ row }) => (
                <span className="font-mono text-xs">{row.original.events.join(', ')}</span>
              ),
            },
            {
              header: 'Estado',
              cell: ({ row }) =>
                row.original.isActive ? (
                  <Badge>{row.original.circuitState}</Badge>
                ) : (
                  <Badge tone="skipped">inactivo</Badge>
                ),
            },
            {
              header: '',
              id: 'actions',
              cell: ({ row }) =>
                can('webhooks:write') && (
                  <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                    <Button onClick={() => test.mutate(row.original)}>Probar</Button>
                    <Button onClick={() => toggle.mutate(row.original)}>
                      {row.original.isActive ? 'Desactivar' : 'Activar'}
                    </Button>
                  </div>
                ),
            },
          ]}
        />
      </Card>
      {selected && (
        <Deliveries
          webhook={selected}
          onClose={() => setSelected(null)}
          onDelete={() => remove.mutate(selected)}
        />
      )}
      <CreateWebhook open={creating} onClose={() => (setCreating(false), refresh())} />
    </>
  );
}

function Deliveries({
  webhook,
  onClose,
  onDelete,
}: {
  webhook: Webhook;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { can } = useAuth();
  const client = useQueryClient();
  const deliveries = useQuery({
    queryKey: ['deliveries', webhook.id],
    queryFn: () => get<Delivery[]>(`/webhooks/${webhook.id}/deliveries`),
    refetchInterval: 5000,
  });
  const redeliver = useMutation({
    mutationFn: (d: Delivery) => post(`/webhooks/deliveries/${d.id}/redeliver`),
    onSuccess: () => client.invalidateQueries({ queryKey: ['deliveries', webhook.id] }),
  });
  return (
    <Card
      className="mt-4"
      title={`Entregas de "${webhook.name}"`}
      actions={
        <>
          {can('webhooks:write') && (
            <Button variant="danger" onClick={onDelete}>
              Eliminar webhook
            </Button>
          )}
          <Button onClick={onClose}>Cerrar</Button>
        </>
      }
    >
      {webhook.circuitState !== 'closed' && (
        <p role="alert" className="mb-3 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          Circuito {webhook.circuitState}: {webhook.consecutiveFailures} fallos seguidos
          {webhook.pausedUntil ? `, en pausa hasta ${formatDate(webhook.pausedUntil)}` : ''}.
        </p>
      )}
      <ErrorBox error={deliveries.error ?? redeliver.error} />
      <DataTable
        data={deliveries.data ?? []}
        empty="Sin entregas todavía"
        columns={[
          {
            header: 'Evento',
            cell: ({ row }) => <span className="font-mono text-xs">{row.original.eventType}</span>,
          },
          { header: 'Estado', cell: ({ row }) => <Badge>{row.original.status}</Badge> },
          { header: 'Intento', cell: ({ row }) => row.original.attempt },
          { header: 'HTTP', cell: ({ row }) => row.original.httpStatus ?? '—' },
          {
            header: 'Tiempo',
            cell: ({ row }) =>
              row.original.responseMs != null ? `${row.original.responseMs} ms` : '—',
          },
          {
            header: 'Error',
            cell: ({ row }) => (
              <span className="text-xs text-danger">{row.original.lastError ?? ''}</span>
            ),
          },
          { header: 'Próximo intento', cell: ({ row }) => formatDate(row.original.nextRetryAt) },
          {
            header: '',
            id: 'redeliver',
            cell: ({ row }) =>
              can('webhooks:write') &&
              (row.original.status === 'dead' || row.original.status === 'failed') && (
                <Button onClick={() => redeliver.mutate(row.original)}>Reenviar</Button>
              ),
          },
        ]}
      />
    </Card>
  );
}

function CreateWebhook({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ name: '', url: '', events: 'tenant.*', tenant: '' });
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      post<{ secret: string }>('/webhooks', {
        name: form.name,
        url: form.url,
        events: form.events
          .split(',')
          .map((e) => e.trim())
          .filter(Boolean),
        tenant: form.tenant || null,
      }),
    onSuccess: (r) => setSecret(r.secret),
  });
  const close = () => (
    setSecret(null),
    setForm({ name: '', url: '', events: 'tenant.*', tenant: '' }),
    create.reset(),
    onClose()
  );
  return (
    <Modal title="Nuevo webhook" open={open} onClose={close}>
      {secret ? (
        <div className="space-y-3 text-sm">
          <p>
            Guarda este secreto: el receptor lo usa para verificar la firma (
            <span className="font-mono">X-Tenancy-Signature</span>).{' '}
            <strong>No se vuelve a mostrar.</strong>
          </p>
          <p
            data-testid="webhook-secret"
            className="break-all rounded bg-surface p-2 font-mono text-xs"
          >
            {secret}
          </p>
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>
              Listo
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => (e.preventDefault(), create.mutate())}
        >
          <ErrorBox error={create.error} />
          <Field label="Nombre">
            {(id) => (
              <Input
                id={id}
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            )}
          </Field>
          <Field
            label="URL"
            hint="https://… Las direcciones internas están bloqueadas (protección SSRF)."
          >
            {(id) => (
              <Input
                id={id}
                required
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
            )}
          </Field>
          <Field label="Eventos" hint="Separados por coma: tenant.created, pedido.*, *">
            {(id) => (
              <Input
                id={id}
                required
                value={form.events}
                onChange={(e) => setForm({ ...form, events: e.target.value })}
              />
            )}
          </Field>
          <Field label="Tenant" hint="Vacío = webhook global (todos los tenants).">
            {(id) => (
              <Input
                id={id}
                value={form.tenant}
                onChange={(e) => setForm({ ...form, tenant: e.target.value })}
              />
            )}
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={close}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" busy={create.isPending}>
              Crear
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
