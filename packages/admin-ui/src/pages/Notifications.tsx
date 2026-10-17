import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { del, get, post } from '../api';
import { useAuth } from '../auth';
import { localToIso } from '../billing';
import { IconBell, IconPlus, IconSearch, IconSend, IconTrash, IconX } from '../components/icons';
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
  RelativeTime,
  Textarea,
  cx,
  formatDate,
  useToast,
} from '../components/ui';
import { planLabel, usePlans } from '../plans';
import type {
  NotificationAudience,
  NotificationDelivery,
  NotificationLevel,
  NotificationsPage,
  Page,
  PlansResponse,
  PlatformNotification,
  Tenant,
} from '../types';

export const LEVELS: Record<NotificationLevel, { label: string; tone: string; box: string }> = {
  info: { label: 'Información', tone: 'info', box: 'border-info/30 bg-info/5' },
  success: { label: 'Novedad', tone: 'ok', box: 'border-ok/30 bg-ok/5' },
  warning: { label: 'Atención', tone: 'warn', box: 'border-warn/40 bg-warn/5' },
  critical: { label: 'Urgente', tone: 'danger', box: 'border-danger/40 bg-danger/5' },
};

/** "Todos los tenants", "3 tenants: a, b, c", "Plan Básico". */
export function audienceSummary(
  audience: NotificationAudience,
  plans: PlansResponse | undefined,
): string {
  if (audience.type === 'all') return 'Todos los tenants';
  if (audience.type === 'tenants') {
    const n = audience.tenants.length;
    const list = audience.tenants.slice(0, 3).join(', ') + (n > 3 ? '…' : '');
    return `${n} tenant${n === 1 ? '' : 's'}: ${list}`;
  }
  const names = audience.plans.map((p) => planLabel(plans, p) ?? p);
  return `${names.length === 1 ? 'Plan' : 'Planes'} ${names.join(', ')}`;
}

/** Programado, vigente o vencido, según las fechas. */
export function validity(
  n: Pick<PlatformNotification, 'startsAt' | 'expiresAt'>,
  now = Date.now(),
) {
  if (n.startsAt && new Date(n.startsAt).getTime() > now)
    return { label: 'Programado', tone: 'info' };
  if (n.expiresAt && new Date(n.expiresAt).getTime() <= now)
    return { label: 'Vencido', tone: 'neutral' };
  return { label: 'Vigente', tone: 'ok' };
}

/** Avisos de la plataforma a sus tenants. */
export function Notifications() {
  const { can } = useAuth();
  const plans = usePlans();
  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState(false);
  const list = useQuery({
    queryKey: ['notifications', page],
    queryFn: () => get<NotificationsPage>(`/notifications?page=${page}&perPage=20`),
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;
  const channels = data?.channels ?? [];
  return (
    <>
      <PageHeader
        title="Avisos"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            Mensajes de la plataforma a sus tenants ·
            {channels.length > 0 ? (
              <Badge tone="ok" dot>
                Push: {channels.join(', ')}
              </Badge>
            ) : (
              <Badge tone="neutral">Sin canales push configurados</Badge>
            )}
          </span>
        }
        actions={
          can('notifications:send') && (
            <Button variant="primary" icon={<IconPlus />} onClick={() => setComposing(true)}>
              Nuevo aviso
            </Button>
          )
        }
      />
      <ErrorBox error={list.error} />
      <Card flush>
        <DataTable
          data={data?.items ?? []}
          empty={list.isLoading ? 'Cargando…' : 'Todavía no se envió ningún aviso'}
          emptyIcon={<IconBell />}
          columns={[
            {
              header: 'Aviso',
              cell: ({ row }) => (
                <div className="min-w-0 max-w-sm">
                  <p className="flex items-center gap-2 font-medium">
                    <Badge tone={LEVELS[row.original.level].tone}>
                      {LEVELS[row.original.level].label}
                    </Badge>
                    <span className="truncate">{row.original.title}</span>
                  </p>
                  {row.original.body && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted">{row.original.body}</p>
                  )}
                </div>
              ),
            },
            {
              header: 'Para',
              cell: ({ row }) => (
                <div className="text-xs">
                  <p>{audienceSummary(row.original.audience, plans.data)}</p>
                  {row.original.roles && (
                    <p className="text-muted">Roles: {row.original.roles.join(', ')}</p>
                  )}
                </div>
              ),
            },
            {
              header: 'Vigencia',
              cell: ({ row }) => {
                const v = validity(row.original);
                return (
                  <div className="text-xs">
                    <Badge tone={v.tone}>{v.label}</Badge>
                    <p className="mt-1 text-muted">
                      {row.original.startsAt ? formatDate(row.original.startsAt) : 'Desde el envío'}{' '}
                      →{' '}
                      {row.original.expiresAt
                        ? formatDate(row.original.expiresAt)
                        : 'sin vencimiento'}
                    </p>
                  </div>
                );
              },
            },
            {
              header: 'Leído',
              cell: ({ row }) => (
                <span className="text-xs tabular-nums">
                  {row.original.reads.tenants} tenants · {row.original.reads.users} usuarios
                </span>
              ),
            },
            {
              header: 'Enviado',
              cell: ({ row }) => (
                <div className="text-xs text-muted">
                  <RelativeTime value={row.original.createdAt} />
                  {row.original.createdBy && <p>{row.original.createdBy}</p>}
                </div>
              ),
            },
            {
              header: '',
              id: 'actions',
              cell: ({ row }) => <RowActions notification={row.original} channels={channels} />,
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
      {composing && <Compose onClose={() => setComposing(false)} />}
    </>
  );
}

function RowActions({
  notification,
  channels,
}: {
  notification: PlatformNotification;
  channels: string[];
}) {
  const { can } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const deliver = useMutation({
    mutationFn: () => post<NotificationDelivery[]>(`/notifications/${notification.id}/deliver`),
    onSuccess: (results) =>
      toast(
        results.map((r) => `${r.channel}: ${r.sent} enviados, ${r.failed} fallidos`).join(' · ') ||
          'Sin canales',
      ),
    onError: (error) => toast(error instanceof Error ? error.message : String(error), 'error'),
  });
  const remove = useMutation({
    mutationFn: () => del(`/notifications/${notification.id}`),
    onSuccess: () => {
      toast('Aviso retirado');
      void client.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error) => toast(error instanceof Error ? error.message : String(error), 'error'),
  });
  if (!can('notifications:send')) return null;
  if (confirm)
    return (
      <span role="alert" className="flex items-center justify-end gap-1.5 text-xs">
        ¿Retirar de todos los tenants?
        <Button size="sm" onClick={() => setConfirm(false)}>
          No
        </Button>
        <Button size="sm" variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
          Sí, retirar
        </Button>
      </span>
    );
  return (
    <div className="flex justify-end gap-1.5">
      {channels.length > 0 && (
        <Button
          size="sm"
          icon={<IconSend />}
          busy={deliver.isPending}
          onClick={() => deliver.mutate()}
        >
          Reenviar push
        </Button>
      )}
      <Button size="sm" variant="ghost" icon={<IconTrash />} onClick={() => setConfirm(true)}>
        Retirar
      </Button>
    </div>
  );
}

/** Vista previa: cómo lo ve un usuario dentro de la app del tenant. */
export function NotificationPreview({
  level,
  title,
  body,
  link,
}: {
  level: NotificationLevel;
  title: string;
  body: string;
  link: { url: string; label: string } | null;
}) {
  return (
    <div
      data-testid="notification-preview"
      className={cx('rounded-xl border p-4 shadow-sm', LEVELS[level].box)}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-fg">
          <IconBell />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{title || 'Título del aviso'}</p>
          {body && <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{body}</p>}
          {link && (
            <span className="mt-2 inline-block text-sm font-medium text-brand underline">
              {link.label || 'Ver más'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

type AudienceMode = 'all' | 'tenants' | 'plans';

/** Elegir tenants buscando por id o nombre. */
function TenantPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const results = useQuery({
    queryKey: ['tenants', 'picker', debounced],
    queryFn: () =>
      get<Page<Tenant>>(
        `/tenants?perPage=8${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });
  const options = (results.data?.items ?? []).filter((t) => !selected.includes(t.id));
  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded-full bg-subtle px-2.5 py-1 font-mono text-xs ring-1 ring-line"
            >
              {id}
              <button
                type="button"
                aria-label={`Quitar ${id}`}
                onClick={() => onChange(selected.filter((x) => x !== id))}
                className="text-muted hover:text-fg"
              >
                <IconX width={12} height={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <Input
          aria-label="Buscar tenants"
          placeholder="Buscar por id o nombre"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>
      {options.length > 0 && (
        <ul className="max-h-40 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {options.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onChange([...selected, t.id])}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-subtle"
              >
                <span className="truncate">{t.name}</span>
                <span className="font-mono text-xs text-muted">{t.id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Compose({ onClose }: { onClose: () => void }) {
  const plans = usePlans();
  const client = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [level, setLevel] = useState<NotificationLevel>('info');
  const [mode, setMode] = useState<AudienceMode>('all');
  const [tenants, setTenants] = useState<string[]>([]);
  const [planIds, setPlanIds] = useState<string[]>([]);
  const [roles, setRoles] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const plansEnabled = plans.data?.enabled ?? false;

  const audience: NotificationAudience | null =
    mode === 'all'
      ? { type: 'all' }
      : mode === 'tenants'
        ? tenants.length > 0
          ? { type: 'tenants', tenants }
          : null
        : planIds.length > 0
          ? { type: 'plans', plans: planIds }
          : null;
  const audienceKey = JSON.stringify(audience);
  const [debouncedAudience, setDebouncedAudience] = useState(audienceKey);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedAudience(audienceKey), 300);
    return () => clearTimeout(t);
  }, [audienceKey]);
  const reach = useQuery({
    queryKey: ['notifications', 'reach', debouncedAudience],
    queryFn: () =>
      post<{ tenants: number }>('/notifications/reach', {
        audience: JSON.parse(debouncedAudience) as NotificationAudience,
      }),
    enabled: debouncedAudience !== 'null',
  });

  const link = linkUrl.trim()
    ? { url: linkUrl.trim(), label: linkLabel.trim() || 'Ver más' }
    : null;
  const roleList = roles
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  const send = useMutation({
    mutationFn: () =>
      post<PlatformNotification>('/notifications', {
        title: title.trim(),
        body: body.trim(),
        level,
        audience,
        roles: roleList.length > 0 ? roleList : null,
        link: link
          ? { url: link.url, ...(linkLabel.trim() ? { label: linkLabel.trim() } : {}) }
          : null,
        startsAt: localToIso(startsAt) ?? null,
        expiresAt: localToIso(expiresAt) ?? null,
      }),
    onSuccess: () => {
      toast('Aviso enviado');
      void client.invalidateQueries({ queryKey: ['notifications'] });
      onClose();
    },
  });
  const valid = title.trim() !== '' && audience !== null;

  return (
    <Modal
      open
      title="Nuevo aviso"
      description="Lo ven los usuarios de los tenants dentro de su app (y por push si hay canales)."
      onClose={onClose}
      size="lg"
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) send.mutate();
        }}
      >
        <ErrorBox error={send.error} />
        <Field label="Título">
          {(id) => (
            <Input
              id={id}
              value={title}
              maxLength={150}
              required
              placeholder="Mantenimiento programado el sábado"
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
        </Field>
        <Field label="Mensaje">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              maxLength={5000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          )}
        </Field>
        <div>
          <p className="mb-1.5 text-sm font-medium">Nivel</p>
          <div role="radiogroup" aria-label="Nivel" className="flex flex-wrap gap-2">
            {(Object.keys(LEVELS) as NotificationLevel[]).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={level === value}
                onClick={() => setLevel(value)}
                className={cx(
                  'rounded-full transition-opacity',
                  level === value
                    ? 'ring-2 ring-brand ring-offset-1'
                    : 'opacity-60 hover:opacity-100',
                )}
              >
                <Badge tone={LEVELS[value].tone} dot>
                  {LEVELS[value].label}
                </Badge>
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Para</p>
          <div role="radiogroup" aria-label="Audiencia" className="flex flex-wrap gap-1">
            {(
              [
                ['all', 'Todos los tenants'],
                ['tenants', 'Tenants específicos'],
                ...(plansEnabled ? [['plans', 'Por plan']] : []),
              ] as [AudienceMode, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                onClick={() => setMode(value)}
                className={cx(
                  'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  mode === value
                    ? 'bg-fg text-panel'
                    : 'text-muted ring-1 ring-inset ring-line hover:bg-subtle hover:text-fg',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === 'tenants' && <TenantPicker selected={tenants} onChange={setTenants} />}
          {mode === 'plans' && (
            <div className="flex flex-wrap gap-3">
              {plans.data?.plans.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={planIds.includes(p.id)}
                    onChange={(e) =>
                      setPlanIds(
                        e.target.checked ? [...planIds, p.id] : planIds.filter((x) => x !== p.id),
                      )
                    }
                  />
                  {p.label}
                </label>
              ))}
            </div>
          )}
          <p data-testid="notification-reach" className="text-xs text-muted">
            {audience === null
              ? mode === 'tenants'
                ? 'Elige al menos un tenant.'
                : 'Elige al menos un plan.'
              : reach.data
                ? `Llegará a ${reach.data.tenants} tenant${reach.data.tenants === 1 ? '' : 's'} activo${reach.data.tenants === 1 ? '' : 's'}.`
                : 'Calculando alcance…'}
          </p>
        </div>
        <details className="rounded-lg border border-line px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium">Más opciones</summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Roles" hint="Solo para estos roles de la app, separados por coma.">
              {(id) => (
                <Input
                  id={id}
                  value={roles}
                  placeholder="ADMIN, CONTABILIDAD"
                  onChange={(e) => setRoles(e.target.value)}
                />
              )}
            </Field>
            <div />
            <Field label="Enlace" hint="https://… o una ruta de la app (/novedades).">
              {(id) => (
                <Input id={id} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} />
              )}
            </Field>
            <Field label="Texto del enlace">
              {(id) => (
                <Input
                  id={id}
                  value={linkLabel}
                  maxLength={60}
                  placeholder="Ver más"
                  onChange={(e) => setLinkLabel(e.target.value)}
                />
              )}
            </Field>
            <Field label="Mostrar desde" hint="Vacío: desde que se envía.">
              {(id) => (
                <Input
                  id={id}
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                />
              )}
            </Field>
            <Field label="Mostrar hasta" hint="Vacío: sin vencimiento.">
              {(id) => (
                <Input
                  id={id}
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              )}
            </Field>
          </div>
        </details>
        <div>
          <p className="mb-1.5 text-sm font-medium">Vista previa</p>
          <NotificationPreview level={level} title={title} body={body} link={link} />
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            type="submit"
            variant="primary"
            icon={<IconSend />}
            disabled={!valid}
            busy={send.isPending}
          >
            Enviar aviso
          </Button>
        </div>
      </form>
    </Modal>
  );
}
