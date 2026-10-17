import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { del, get, patch, post } from '../api';
import { useAuth } from '../auth';
import { DataEditor, dataFromRows, rowsFromData, type DataRow } from '../components/DataEditor';
import { EnterTenant } from '../components/EnterTenant';
import {
  IconAlert,
  IconChevronLeft,
  IconDatabase,
  IconExternal,
  IconGlobe,
  IconLogin,
} from '../components/icons';
import {
  Avatar,
  Badge,
  Button,
  Card,
  DataTable,
  ErrorBox,
  Field,
  Input,
  Modal,
  PageHeader,
  RelativeTime,
  Spinner,
  StatusBadge,
  StepBadge,
  Tabs,
  formatDate,
  useToast,
} from '../components/ui';
import { Link, navigate } from '../router';
import type { TenantDetail as Detail } from '../types';
import { PlanEditor } from './PlanEditor';
import { TenantBilling } from './TenantBilling';
import { DataExplorer } from './DataExplorer';
import { TenantUsers } from './TenantUsers';
import { ThemeEditor } from './ThemeEditor';

export function TenantDetail({ id }: { id: string }) {
  const { can, session } = useAuth();
  const initialTab = new URLSearchParams(window.location.search).get('tab') ?? 'overview';
  const [tab, setTab] = useState(initialTab);
  const [entering, setEntering] = useState(false);
  const detail = useQuery({
    queryKey: ['tenant', id],
    queryFn: () => get<Detail>(`/tenants/${encodeURIComponent(id)}`),
  });
  if (detail.isLoading)
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  if (detail.error) return <ErrorBox error={detail.error} />;
  const d = detail.data!;
  const t = d.tenant;
  const primary = d.domains.find((x) => x.isPrimary) ?? d.domains[0];
  const tabs: [string, string][] = [
    ['overview', 'Resumen'],
    ...(session?.config?.tenantUsers !== undefined
      ? ([['users', 'Usuarios']] as [string, string][])
      : []),
    ['domains', 'Dominios'],
    ['theme', 'Tema'],
    ...(can('billing:read') ? ([['billing', 'Cobros']] as [string, string][]) : []),
    ['database', 'Base de datos'],
    ...(can('data:read') ? ([['data', 'Datos']] as [string, string][]) : []),
    ['errors', `Errores (${d.errors.length})`],
  ];
  return (
    <>
      <Link
        to="/tenants"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
      >
        <IconChevronLeft /> Tenants
      </Link>
      <PageHeader
        leading={
          <Avatar
            name={t.name}
            color={String(d.effectiveTheme?.primary ?? '')}
            src={d.logoUrl}
            size="lg"
          />
        }
        title={t.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge status={t.status} />
            <span className="font-mono text-xs">{t.id}</span>
            {primary && (
              <a
                href={`https://${primary.domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-brand"
              >
                <IconGlobe /> {primary.domain}
              </a>
            )}
            {d.plan?.enabled && d.plan.planLabel ? (
              <Badge tone="info">{d.plan.planLabel}</Badge>
            ) : (
              t.plan && <Badge tone="info">{t.plan}</Badge>
            )}
          </span>
        }
        actions={
          <>
            {primary && (
              <a
                href={`https://${primary.domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-panel px-3.5 text-sm font-medium shadow-sm hover:bg-subtle"
              >
                <IconExternal /> Abrir sitio
              </a>
            )}
            {can('impersonate') && t.status === 'active' && (
              <Button variant="primary" icon={<IconLogin />} onClick={() => setEntering(true)}>
                Entrar
              </Button>
            )}
          </>
        }
      />
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === 'overview' && <Overview detail={d} />}
      {tab === 'users' && <TenantUsers tenantId={id} tenantActive={t.status === 'active'} />}
      {tab === 'domains' && <Domains detail={d} />}
      {tab === 'theme' && (
        <ThemeEditor
          tenantId={id}
          effectiveTheme={d.effectiveTheme ?? t.theme ?? {}}
          defaultTheme={d.defaultTheme ?? {}}
          logoUrl={d.logoUrl ?? null}
          previewDomain={d.previewDomain ?? null}
          canEdit={can('tenants:write')}
          fonts={d.fonts ?? []}
        />
      )}
      {tab === 'billing' && can('billing:read') && <TenantBilling tenantId={id} plan={t.plan} />}
      {tab === 'database' && <Database id={id} />}
      {tab === 'data' && <DataExplorer tenantId={id} />}
      {tab === 'errors' && <Errors detail={d} />}
      <EnterTenant tenant={t} open={entering} onClose={() => setEntering(false)} />
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

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function Overview({ detail }: { detail: Detail }) {
  const { can } = useAuth();
  const t = detail.tenant;
  const action = useTenantAction(t.id);
  const [maintenance, setMaintenance] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState('');
  const toast = useToast();

  const remove = useMutation({
    mutationFn: () => del(`/tenants/${encodeURIComponent(t.id)}`, { confirm: typed }),
    onSuccess: () => (toast(`Tenant ${t.id} eliminado`), navigate('/tenants')),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {t.maintenanceMessage && t.status === 'maintenance' && (
          <div className="flex gap-2.5 rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 text-sm text-warn">
            <IconAlert className="mt-0.5 shrink-0" />
            <p>
              En mantenimiento: <span className="text-fg">{t.maintenanceMessage}</span>
            </p>
          </div>
        )}
        <Card title="Información">
          <dl className="grid gap-5 sm:grid-cols-2">
            <Info label="Plan">
              {detail.plan?.enabled
                ? (detail.plan.planLabel ?? detail.plan.plan ?? 'Sin plan') +
                  (t.plan === null && detail.plan.plan ? ' (por defecto)' : '')
                : (t.plan ?? '—')}
            </Info>
            <Info label="Base de datos">
              {t.database ? (
                <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                  <IconDatabase className="text-muted" />
                  {t.database.serverId} / {t.database.name}
                  {t.database.username ? ` · ${t.database.username}` : ''}
                </span>
              ) : (
                '—'
              )}
            </Info>
            <Info label="Creado">
              <RelativeTime value={t.createdAt} />
            </Info>
            <Info label="Aprovisionado">
              <RelativeTime value={t.provisionedAt} />
            </Info>
          </dl>
        </Card>
        {detail.plan?.enabled && <PlanEditor detail={detail} canEdit={can('tenants:write')} />}
        <Card title="Datos" description="tenant.data: lo recibe el seed y la app.">
          <TenantData id={t.id} data={t.data} canEdit={can('tenants:write')} />
        </Card>
        <Card title="Último aprovisionamiento" flush>
          <DataTable
            data={detail.provisioning}
            empty="Sin registros"
            columns={[
              { header: 'Paso', cell: ({ row }) => row.original.step },
              { header: 'Estado', cell: ({ row }) => <StepBadge status={row.original.status} /> },
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
      </div>
      <div className="space-y-6">
        <Card title="Acciones">
          <div className="flex flex-col gap-2">
            {can('tenants:write') && t.status === 'active' && (
              <>
                <Button onClick={() => action.mutate({ path: '/suspend' })}>Suspender</Button>
                <Button onClick={() => setMaintenance(true)}>Poner en mantenimiento</Button>
              </>
            )}
            {can('tenants:write') && (t.status === 'suspended' || t.status === 'maintenance') && (
              <Button variant="primary" onClick={() => action.mutate({ path: '/activate' })}>
                Reactivar
              </Button>
            )}
            {can('tenants:write') && t.status === 'failed' && (
              <Button variant="primary" onClick={() => action.mutate({ path: '/retry' })}>
                Reintentar aprovisionamiento
              </Button>
            )}
            {can('cache:flush') && (
              <Button onClick={() => action.mutate({ path: '/cache/flush' })}>Vaciar caché</Button>
            )}
          </div>
        </Card>
        {can('tenants:delete') && (
          <Card title="Zona de peligro" className="border-danger/30">
            <p className="mb-3 text-sm text-muted">
              Borra la base, su usuario, sus dominios y sus archivos. No se puede deshacer.
            </p>
            <Button variant="danger" className="w-full" onClick={() => setConfirmDelete(true)}>
              Eliminar tenant
            </Button>
          </Card>
        )}
      </div>

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
        <div className="mt-4 flex justify-end">
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
        <p className="mb-4 text-sm">
          Se borran la base <span className="font-mono">{t.database?.name ?? '—'}</span>, su usuario
          y sus dominios. <strong>No se puede deshacer.</strong>
        </p>
        <ErrorBox error={remove.error} />
        <Field label={`Escribe "${t.id}" para confirmar`}>
          {(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} />}
        </Field>
        <div className="mt-4 flex justify-end">
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

/** `tenant.data`: se ve como JSON y se edita llave por llave (PATCH combina; removeData borra). */
function TenantData({
  id,
  data,
  canEdit,
}: {
  id: string;
  data: Record<string, unknown>;
  canEdit: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [rows, setRows] = useState<DataRow[] | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const next = dataFromRows(rows ?? []);
      const removeData = Object.keys(data).filter((key) => !(key in next));
      return patch(`/tenants/${encodeURIComponent(id)}`, { data: next, removeData });
    },
    onSuccess: () => {
      toast('Datos guardados');
      setRows(null);
      void client.invalidateQueries({ queryKey: ['tenant', id] });
    },
  });
  if (rows === null)
    return (
      <div className="space-y-2">
        <pre className="overflow-x-auto rounded bg-surface p-2 text-xs">
          {JSON.stringify(data, null, 2)}
        </pre>
        {canEdit && <Button onClick={() => setRows(rowsFromData(data))}>Editar datos</Button>}
      </div>
    );
  return (
    <div className="space-y-2">
      <ErrorBox error={save.error} />
      <DataEditor rows={rows} onChange={setRows} disabled={save.isPending} />
      <div className="flex justify-end gap-2">
        <Button onClick={() => (setRows(null), save.reset())}>Cancelar</Button>
        <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
          Guardar datos
        </Button>
      </div>
    </div>
  );
}
