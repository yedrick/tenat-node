import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post } from '../api';
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
  Spinner,
  Tabs,
  formatDate,
  useToast,
} from '../components/ui';
import { Link, navigate } from '../router';
import type { TenantDetail as Detail } from '../types';
import { DataExplorer } from './DataExplorer';
import { ThemeEditor } from './ThemeEditor';

export function TenantDetail({ id }: { id: string }) {
  const { can } = useAuth();
  const initialTab = new URLSearchParams(window.location.search).get('tab') ?? 'overview';
  const [tab, setTab] = useState(initialTab);
  const detail = useQuery({
    queryKey: ['tenant', id],
    queryFn: () => get<Detail>(`/tenants/${encodeURIComponent(id)}`),
  });
  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  const d = detail.data!;
  const tabs: [string, string][] = [
    ['overview', 'Resumen'],
    ['domains', 'Dominios'],
    ['theme', 'Tema'],
    ['database', 'Base de datos'],
    ...(can('data:read') ? ([['data', 'Datos']] as [string, string][]) : []),
    ['errors', `Errores (${d.errors.length})`],
  ];
  return (
    <>
      <p className="mb-2 text-sm">
        <Link to="/tenants" className="text-muted hover:text-fg">
          ← Tenants
        </Link>
      </p>
      <PageHeader
        title={
          <span>
            {d.tenant.name} <Badge>{d.tenant.status}</Badge>
          </span>
        }
        subtitle={<span className="font-mono">{d.tenant.id}</span>}
      />
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === 'overview' && <Overview detail={d} />}
      {tab === 'domains' && <Domains detail={d} />}
      {tab === 'theme' && (
        <ThemeEditor tenantId={id} theme={d.tenant.theme} canEdit={can('tenants:write')} />
      )}
      {tab === 'database' && <Database id={id} />}
      {tab === 'data' && <DataExplorer tenantId={id} />}
      {tab === 'errors' && <Errors detail={d} />}
    </>
  );
}

function useTenantAction(id: string) {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({
      path,
      body,
      method = 'POST',
    }: {
      path: string;
      body?: unknown;
      method?: 'POST' | 'DELETE';
    }) =>
      method === 'DELETE'
        ? del(`/tenants/${encodeURIComponent(id)}${path}`, body)
        : post(`/tenants/${encodeURIComponent(id)}${path}`, body),
    onSuccess: (_d, v) => {
      void client.invalidateQueries({ queryKey: ['tenant', id] });
      void client.invalidateQueries({ queryKey: ['tenants'] });
      toast(v.path === '/cache/flush' ? 'Caché vaciada' : 'Listo');
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Error', 'error'),
  });
}

function Overview({ detail }: { detail: Detail }) {
  const { can } = useAuth();
  const t = detail.tenant;
  const action = useTenantAction(t.id);
  const [maintenance, setMaintenance] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState('');
  const [impersonate, setImpersonate] = useState(false);
  const [user, setUser] = useState('');
  const [link, setLink] = useState<{ url: string | null; token: string; expiresAt: string } | null>(
    null,
  );
  const toast = useToast();

  const remove = useMutation({
    mutationFn: () => del(`/tenants/${encodeURIComponent(t.id)}`, { confirm: typed }),
    onSuccess: () => (toast(`Tenant ${t.id} eliminado`), navigate('/tenants')),
  });
  const impersonation = useMutation({
    mutationFn: () =>
      post<{ url: string | null; token: string; expiresAt: string }>(
        `/tenants/${encodeURIComponent(t.id)}/impersonate`,
        { user },
      ),
    onSuccess: setLink,
  });

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card title="Datos" className="md:col-span-2">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted">Plan</dt>
          <dd>{t.plan ?? '—'}</dd>
          <dt className="text-muted">Base de datos</dt>
          <dd className="font-mono text-xs">
            {t.database
              ? `${t.database.serverId} / ${t.database.name}${t.database.username ? ` (usuario ${t.database.username})` : ''}`
              : '—'}
          </dd>
          <dt className="text-muted">Creado</dt>
          <dd>{formatDate(t.createdAt)}</dd>
          <dt className="text-muted">Aprovisionado</dt>
          <dd>{formatDate(t.provisionedAt)}</dd>
          {t.maintenanceMessage && (
            <>
              <dt className="text-muted">Mensaje</dt>
              <dd>{t.maintenanceMessage}</dd>
            </>
          )}
          <dt className="text-muted">Datos</dt>
          <dd>
            <pre className="overflow-x-auto rounded bg-surface p-2 text-xs">
              {JSON.stringify(t.data, null, 2)}
            </pre>
          </dd>
        </dl>
        <h3 className="mb-2 mt-4 text-sm font-semibold">Último aprovisionamiento</h3>
        <DataTable
          data={detail.provisioning}
          empty="Sin registros"
          columns={[
            { header: 'Paso', cell: ({ row }) => row.original.step },
            { header: 'Estado', cell: ({ row }) => <Badge>{row.original.status}</Badge> },
            { header: 'Intento', cell: ({ row }) => row.original.attempt },
            {
              header: 'Duración',
              cell: ({ row }) =>
                row.original.durationMs != null ? `${row.original.durationMs} ms` : '—',
            },
            {
              header: 'Error',
              cell: ({ row }) => (
                <span className="text-xs text-danger">{row.original.error ?? ''}</span>
              ),
            },
          ]}
        />
      </Card>
      <Card title="Acciones">
        <div className="flex flex-col gap-2">
          {can('tenants:write') && t.status === 'active' && (
            <>
              <Button onClick={() => action.mutate({ path: '/suspend' })}>Suspender</Button>
              <Button onClick={() => setMaintenance(true)}>Poner en mantenimiento</Button>
            </>
          )}
          {can('tenants:write') && (t.status === 'suspended' || t.status === 'maintenance') && (
            <Button onClick={() => action.mutate({ path: '/activate' })}>Reactivar</Button>
          )}
          {can('tenants:write') && t.status === 'failed' && (
            <Button variant="primary" onClick={() => action.mutate({ path: '/retry' })}>
              Reintentar aprovisionamiento
            </Button>
          )}
          {can('cache:flush') && (
            <Button onClick={() => action.mutate({ path: '/cache/flush' })}>Vaciar caché</Button>
          )}
          {can('impersonate') && t.status === 'active' && (
            <Button onClick={() => (setLink(null), setImpersonate(true))}>Entrar como…</Button>
          )}
          {can('tenants:delete') && (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Eliminar tenant
            </Button>
          )}
        </div>
      </Card>

      <Modal title="Mantenimiento" open={maintenance} onClose={() => setMaintenance(false)}>
        <Field label="Mensaje para los usuarios">
          {(id) => (
            <Input
              id={id}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Volvemos en 10 minutos"
            />
          )}
        </Field>
        <div className="mt-3 flex justify-end">
          <Button
            variant="primary"
            onClick={() => (
              action.mutate({ path: '/maintenance', body: { message: message || null } }),
              setMaintenance(false)
            )}
          >
            Confirmar
          </Button>
        </div>
      </Modal>

      <Modal
        title={`Eliminar ${t.id}`}
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
      >
        <p className="mb-3 text-sm">
          Se borran la base <span className="font-mono">{t.database?.name ?? '—'}</span>, su usuario
          y sus dominios. <strong>No se puede deshacer.</strong>
        </p>
        <ErrorBox error={remove.error} />
        <Field label={`Escribe "${t.id}" para confirmar`}>
          {(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} />}
        </Field>
        <div className="mt-3 flex justify-end">
          <Button
            variant="danger"
            disabled={typed !== t.id}
            busy={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Eliminar definitivamente
          </Button>
        </div>
      </Modal>

      <Modal
        title="Entrar como un usuario"
        open={impersonate}
        onClose={() => setImpersonate(false)}
      >
        {link ? (
          <div className="space-y-2 text-sm">
            <p>Enlace de un solo uso, válido hasta {formatDate(link.expiresAt)}:</p>
            {link.url ? (
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all font-mono text-xs text-brand underline"
              >
                {link.url}
              </a>
            ) : (
              <p className="break-all font-mono text-xs">{link.token}</p>
            )}
            <p className="text-xs text-muted">La acción queda en la auditoría.</p>
          </div>
        ) : (
          <>
            <ErrorBox error={impersonation.error} />
            <Field label="Usuario (id o email en la app del tenant)">
              {(id) => <Input id={id} value={user} onChange={(e) => setUser(e.target.value)} />}
            </Field>
            <div className="mt-3 flex justify-end">
              <Button
                variant="primary"
                disabled={!user}
                busy={impersonation.isPending}
                onClick={() => impersonation.mutate()}
              >
                Generar enlace
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

function Domains({ detail }: { detail: Detail }) {
  const { can } = useAuth();
  const client = useQueryClient();
  const [domain, setDomain] = useState('');
  const refresh = () => client.invalidateQueries({ queryKey: ['tenant', detail.tenant.id] });
  const add = useMutation({
    mutationFn: () => post(`/tenants/${detail.tenant.id}/domains`, { domain }),
    onSuccess: () => (setDomain(''), refresh()),
  });
  const change = useMutation({
    mutationFn: ({ name, primary }: { name: string; primary: boolean }) =>
      primary
        ? post(`/domains/${encodeURIComponent(name)}/primary`)
        : del(`/domains/${encodeURIComponent(name)}`),
    onSuccess: refresh,
  });
  return (
    <Card title="Dominios">
      <ErrorBox error={add.error ?? change.error} />
      <DataTable
        data={detail.domains}
        empty="Sin dominios"
        columns={[
          {
            header: 'Dominio',
            cell: ({ row }) => <span className="font-mono">{row.original.domain}</span>,
          },
          {
            header: '',
            id: 'primary',
            cell: ({ row }) => row.original.isPrimary && <Badge tone="active">principal</Badge>,
          },
          {
            header: '',
            id: 'actions',
            cell: ({ row }) =>
              can('tenants:write') && (
                <div className="flex justify-end gap-2">
                  {!row.original.isPrimary && (
                    <Button
                      onClick={() => change.mutate({ name: row.original.domain, primary: true })}
                    >
                      Hacer principal
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => change.mutate({ name: row.original.domain, primary: false })}
                  >
                    Quitar
                  </Button>
                </div>
              ),
          },
        ]}
      />
      {can('tenants:write') && (
        <form className="mt-4 flex gap-2" onSubmit={(e) => (e.preventDefault(), add.mutate())}>
          <Input
            aria-label="Nuevo dominio"
            placeholder="clubbolivar.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
          <Button type="submit" variant="primary" disabled={!domain} busy={add.isPending}>
            Agregar
          </Button>
        </form>
      )}
    </Card>
  );
}

function Database({ id }: { id: string }) {
  const { can } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const status = useQuery({
    queryKey: ['migrations', id],
    queryFn: () => get<{ name: string; executedAt: string | null }[]>(`/tenants/${id}/migrations`),
  });
  const run = useMutation({
    mutationFn: (action: 'migrate' | 'seed') => post(`/tenants/${id}/${action}`),
    onSuccess: (_d, action) => (
      toast(action === 'migrate' ? 'Migraciones aplicadas' : 'Seed ejecutado'),
      client.invalidateQueries({ queryKey: ['migrations', id] })
    ),
  });
  const pending = status.data?.filter((m) => !m.executedAt).length ?? 0;
  return (
    <Card
      title={`Migraciones${pending ? ` (${pending} pendientes)` : ''}`}
      actions={
        can('migrations:run') && (
          <>
            <Button
              busy={run.isPending && run.variables === 'seed'}
              onClick={() => run.mutate('seed')}
            >
              Correr seed
            </Button>
            <Button
              variant="primary"
              busy={run.isPending && run.variables === 'migrate'}
              onClick={() => run.mutate('migrate')}
            >
              Migrar
            </Button>
          </>
        )
      }
    >
      <ErrorBox error={status.error ?? run.error} />
      <DataTable
        data={status.data ?? []}
        empty={status.isLoading ? 'Cargando…' : 'Sin migraciones configuradas'}
        columns={[
          {
            header: 'Migración',
            cell: ({ row }) => <span className="font-mono">{row.original.name}</span>,
          },
          {
            header: 'Ejecutada',
            cell: ({ row }) =>
              row.original.executedAt ? (
                formatDate(row.original.executedAt)
              ) : (
                <Badge tone="pending">pendiente</Badge>
              ),
          },
        ]}
      />
    </Card>
  );
}

function Errors({ detail }: { detail: Detail }) {
  return (
    <Card title="Errores recientes (de este proceso)">
      <DataTable
        data={detail.errors}
        empty="Sin errores"
        columns={[
          { header: 'Cuándo', cell: ({ row }) => formatDate(row.original.time) },
          {
            header: 'Operación',
            cell: ({ row }) => <span className="font-mono text-xs">{row.original.operation}</span>,
          },
          {
            header: 'Código',
            cell: ({ row }) => <span className="font-mono text-xs">{row.original.code}</span>,
          },
          { header: 'Mensaje', cell: ({ row }) => row.original.message },
        ]}
      />
    </Card>
  );
}
