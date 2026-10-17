import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { del, get, patch } from '../api';
import { useAuth } from '../auth';
import { IconInbox, IconPlus, IconSearch, IconTrash } from '../components/icons';
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
  Select,
  Textarea,
  cx,
  formatDate,
  useToast,
} from '../components/ui';
import { planLabel, usePlans } from '../plans';
import { Link } from '../router';
import type { Lead, LeadStatus, LeadsPage } from '../types';
import { NewTenant, type NewTenantInitial } from './NewTenant';

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'Nueva',
  contacted: 'Contactada',
  converted: 'Convertida',
  discarded: 'Descartada',
};
const STATUS_TONES: Record<LeadStatus, string> = {
  new: 'info',
  contacted: 'warn',
  converted: 'ok',
  discarded: 'neutral',
};
const STATUSES = Object.keys(LEAD_STATUS_LABELS) as LeadStatus[];

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  return (
    <Badge tone={STATUS_TONES[status]} dot>
      {LEAD_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/** Id de tenant sugerido a partir del nombre de la clínica: `Dental Sur` → `dental-sur`. */
export function suggestTenantId(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Lo que el formulario "Nuevo tenant" recibe de una solicitud. */
export function tenantFromLead(lead: Lead): NewTenantInitial {
  const data: Record<string, string> = {};
  if (lead.email) data.email = lead.email;
  if (lead.phone) data.telefono = lead.phone;
  if (lead.city) data.ciudad = lead.city;
  if (lead.company) data.contacto = lead.name;
  const name = lead.company ?? lead.name;
  return {
    id: suggestTenantId(name),
    name,
    plan: lead.plan ?? '',
    data,
    email: lead.email,
    phone: lead.phone,
  };
}

/** Solicitudes de la web comercial ("Solicitar demo"). */
export function Leads() {
  const plans = usePlans();
  const [status, setStatus] = useState<LeadStatus | ''>('new');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  // La solicitud abierta se guarda entera: al convertirla sale de la lista filtrada ("Nuevas"),
  // y el detalle (con el progreso de creación del tenant) no debe desaparecer.
  const [open, setOpen] = useState<Lead | null>(null);
  useEffect(() => {
    const t = setTimeout(() => (setDebounced(search.trim()), setPage(1)), 250);
    return () => clearTimeout(t);
  }, [search]);

  const params = new URLSearchParams({
    page: String(page),
    perPage: '20',
    ...(status ? { status } : {}),
    ...(debounced ? { search: debounced } : {}),
  });
  const leads = useQuery({
    queryKey: ['leads', params.toString()],
    queryFn: () => get<LeadsPage>(`/leads?${params}`),
    placeholderData: keepPreviousData,
  });
  const data = leads.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;
  const counts = data?.counts;
  const all = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : undefined;

  return (
    <>
      <PageHeader
        title="Solicitudes"
        subtitle="Pedidos de demo que llegan desde la web comercial"
      />
      <ErrorBox error={leads.error} />
      <Card flush>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
          <div className="relative w-full max-w-xs">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input
              aria-label="Buscar solicitud"
              placeholder="Nombre, clínica, email o ciudad"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div role="radiogroup" aria-label="Estado" className="flex flex-wrap gap-1">
            {([['', 'Todas'], ...STATUSES.map((s) => [s, LEAD_STATUS_LABELS[s]])] as const).map(
              ([value, label]) => {
                const n = value === '' ? all : counts?.[value as LeadStatus];
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={status === value}
                    onClick={() => (setStatus(value as LeadStatus | ''), setPage(1))}
                    className={cx(
                      'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                      status === value
                        ? 'bg-fg text-panel'
                        : 'text-muted ring-1 ring-inset ring-line hover:bg-subtle hover:text-fg',
                    )}
                  >
                    {label}
                    {n !== undefined && <span className="ml-1.5 tabular-nums opacity-70">{n}</span>}
                  </button>
                );
              },
            )}
          </div>
        </div>
        <DataTable
          data={data?.items ?? []}
          empty={leads.isLoading ? 'Cargando…' : 'No hay solicitudes'}
          emptyIcon={<IconInbox />}
          onRowClick={(lead) => setOpen(lead)}
          columns={[
            {
              header: 'Solicitud',
              cell: ({ row }) => (
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {row.original.company ?? row.original.name}
                  </p>
                  {row.original.company && (
                    <p className="truncate text-xs text-muted">{row.original.name}</p>
                  )}
                </div>
              ),
            },
            {
              header: 'Contacto',
              cell: ({ row }) => (
                <div className="text-xs">
                  {row.original.email && <p>{row.original.email}</p>}
                  {row.original.phone && <p className="text-muted">{row.original.phone}</p>}
                </div>
              ),
            },
            {
              header: 'Ciudad',
              cell: ({ row }) => row.original.city ?? <span className="text-muted">—</span>,
            },
            {
              header: 'Plan',
              cell: ({ row }) =>
                row.original.plan ? (
                  <Badge tone="info">{planLabel(plans.data, row.original.plan)}</Badge>
                ) : (
                  <span className="text-muted">—</span>
                ),
            },
            {
              header: 'Estado',
              cell: ({ row }) => <LeadStatusBadge status={row.original.status} />,
            },
            {
              header: 'Recibida',
              cell: ({ row }) => (
                <span className="text-muted">
                  <RelativeTime value={row.original.createdAt} />
                </span>
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
      {open && (
        <LeadDetail key={open.id} lead={open} onChange={setOpen} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="break-words text-sm">{children ?? <span className="text-muted">—</span>}</dd>
    </div>
  );
}

function LeadDetail({
  lead,
  onChange,
  onClose,
}: {
  lead: Lead;
  onChange: (lead: Lead) => void;
  onClose: () => void;
}) {
  const { can } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const plans = usePlans();
  const [status, setStatus] = useState<LeadStatus>(lead.status);
  const [notes, setNotes] = useState(lead.notes ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [creating, setCreating] = useState(false);
  const canWrite = can('leads:write');
  const refresh = () => client.invalidateQueries({ queryKey: ['leads'] });

  const save = useMutation({
    mutationFn: () =>
      patch<Lead>(`/leads/${lead.id}`, { status, notes: notes.trim() === '' ? null : notes }),
    onSuccess: (updated) => (toast('Solicitud guardada'), onChange(updated), refresh()),
  });
  const remove = useMutation({
    mutationFn: () => del(`/leads/${lead.id}`),
    onSuccess: () => (toast('Solicitud borrada'), refresh(), onClose()),
  });
  const changed = status !== lead.status || notes !== (lead.notes ?? '');

  return (
    <>
      <Modal
        title={lead.company ?? lead.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <LeadStatusBadge status={lead.status} /> Recibida {formatDate(lead.createdAt)}
          </span>
        }
        open={!creating}
        onClose={onClose}
        size="lg"
      >
        <div className="space-y-5">
          <ErrorBox error={save.error ?? remove.error} />
          <dl className="grid gap-4 sm:grid-cols-2">
            <Info label="Nombre">{lead.name}</Info>
            <Info label="Clínica / empresa">{lead.company}</Info>
            <Info label="Email">
              {lead.email && (
                <a href={`mailto:${lead.email}`} className="text-brand hover:underline">
                  {lead.email}
                </a>
              )}
            </Info>
            <Info label="Teléfono / WhatsApp">{lead.phone}</Info>
            <Info label="Ciudad">{lead.city}</Info>
            <Info label="Plan de interés">{planLabel(plans.data, lead.plan)}</Info>
            <Info label="Consentimiento">
              {lead.consentAt ? `Aceptado el ${formatDate(lead.consentAt)}` : 'No'}
            </Info>
            <Info label="IP">
              {lead.ip && <span className="font-mono text-xs">{lead.ip}</span>}
            </Info>
            {lead.tenantId && (
              <Info label="Tenant creado">
                <Link
                  to={`/tenants/${lead.tenantId}`}
                  className="font-mono text-brand hover:underline"
                >
                  {lead.tenantId}
                </Link>
              </Info>
            )}
            {Object.entries(lead.data).map(([key, value]) => (
              <Info key={key} label={key}>
                {value}
              </Info>
            ))}
          </dl>
          {lead.message && (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Mensaje</p>
              <p className="whitespace-pre-wrap rounded-lg bg-subtle p-3 text-sm">{lead.message}</p>
            </div>
          )}
          <fieldset disabled={!canWrite} className="grid gap-3 sm:grid-cols-[12rem_1fr]">
            <Field label="Estado">
              {(id) => (
                <Select
                  id={id}
                  value={status}
                  onChange={(e) => setStatus(e.target.value as LeadStatus)}
                  options={STATUSES.map((s) => [s, LEAD_STATUS_LABELS[s]] as [string, string])}
                />
              )}
            </Field>
            <Field label="Notas internas">
              {(id) => (
                <Textarea
                  id={id}
                  rows={3}
                  value={notes}
                  placeholder="Llamada el lunes, quiere el plan anual…"
                  onChange={(e) => setNotes(e.target.value)}
                />
              )}
            </Field>
          </fieldset>
          {confirmDelete ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm"
            >
              <span>¿Borrar esta solicitud? No se puede deshacer.</span>
              <span className="flex gap-2">
                <Button size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancelar
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  busy={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  Sí, borrar
                </Button>
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap justify-between gap-2">
              <div>
                {canWrite && (
                  <Button
                    variant="ghost"
                    icon={<IconTrash />}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Borrar (spam)
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {can('tenants:write') && canWrite && lead.status !== 'converted' && (
                  <Button icon={<IconPlus />} onClick={() => setCreating(true)}>
                    Crear tenant
                  </Button>
                )}
                {canWrite && (
                  <Button
                    variant="primary"
                    disabled={!changed}
                    busy={save.isPending}
                    onClick={() => save.mutate()}
                  >
                    Guardar
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </Modal>
      <NewTenant
        open={creating}
        initial={tenantFromLead(lead)}
        leadId={lead.id}
        onConverted={onChange}
        onClose={() => setCreating(false)}
      />
    </>
  );
}
