import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { get, post } from '../api';
import { useAuth } from '../auth';
import { ImpersonationLink, useEnterAs } from '../components/EnterTenant';
import { IconKey, IconLogin, IconPlus, IconSearch, IconUsers } from '../components/icons';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CopyButton,
  DataTable,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Modal,
  RelativeTime,
  Select,
  useToast,
} from '../components/ui';
import type { Page, TenantUser } from '../types';

/** Contraseña inicial aleatoria: mayúscula, minúscula, número y símbolo (pasa las reglas típicas). */
export function generatePassword(length = 16): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*?-_'];
  const all = sets.join('');
  const random = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0]! % n;
  const chars = sets.map((set) => set[random(set.length)]!);
  while (chars.length < length) chars.push(all[random(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

export function TenantUsers({
  tenantId,
  tenantActive,
}: {
  tenantId: string;
  tenantActive: boolean;
}) {
  const { session, can } = useAuth();
  const config = session?.config?.tenantUsers;
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { enter, pending, error: enterError, link } = useEnterAs(tenantId);
  useEffect(() => {
    const timer = setTimeout(() => (setDebounced(search.trim()), setPage(1)), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const users = useQuery({
    queryKey: ['tenant-users', tenantId, debounced, page],
    queryFn: () =>
      get<Page<TenantUser>>(
        `/tenants/${encodeURIComponent(tenantId)}/users?page=${page}&perPage=20${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}`,
      ),
    enabled: Boolean(config),
    placeholderData: keepPreviousData,
  });

  if (!config)
    return (
      <Card>
        <EmptyState icon={<IconUsers />}>
          Esta app no conectó sus usuarios con el panel. Para verlos y crearlos aquí, configura{' '}
          <code className="rounded bg-subtle px-1 font-mono text-xs">tenantUsers</code> en{' '}
          <code className="rounded bg-subtle px-1 font-mono text-xs">createAdminApi</code>.
        </EmptyState>
      </Card>
    );

  const data = users.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;
  const roleLabel = (role: string | null) =>
    config.roles.find((r) => r.value === role)?.label ?? role;
  const canEnter = can('impersonate') && tenantActive;

  return (
    <div className="space-y-4">
      <ErrorBox error={enterError} />
      {link && <ImpersonationLink link={link} />}
      <Card
        title="Usuarios de la app"
        description={
          data ? `${data.total} ${data.total === 1 ? 'usuario' : 'usuarios'}` : undefined
        }
        flush
        actions={
          <>
            <div className="relative">
              <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <Input
                aria-label="Buscar usuario"
                placeholder="Buscar"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 w-48 pl-8 text-xs"
              />
            </div>
            {config.canCreate && can('tenants:write') && (
              <Button
                size="sm"
                variant="primary"
                icon={<IconPlus />}
                disabled={!tenantActive}
                onClick={() => setCreating(true)}
              >
                Nuevo usuario
              </Button>
            )}
          </>
        }
      >
        <div className="px-5 pt-3">
          <ErrorBox error={users.error} />
        </div>
        <DataTable
          data={data?.items ?? []}
          empty={users.isLoading ? 'Cargando…' : 'Sin usuarios'}
          emptyIcon={<IconUsers />}
          columns={[
            {
              header: 'Usuario',
              cell: ({ row }) => (
                <div className="flex items-center gap-3">
                  <Avatar name={row.original.name} size="sm" />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{row.original.name}</p>
                    <p className="truncate text-xs text-muted">
                      {row.original.email ?? row.original.id}
                    </p>
                  </div>
                </div>
              ),
            },
            {
              header: 'Rol',
              cell: ({ row }) =>
                row.original.role ? (
                  <Badge tone="neutral">{roleLabel(row.original.role)}</Badge>
                ) : (
                  '—'
                ),
            },
            {
              header: 'Estado',
              cell: ({ row }) =>
                row.original.active ? (
                  <Badge tone="ok" dot>
                    Activo
                  </Badge>
                ) : (
                  <Badge tone="neutral" dot>
                    Inactivo
                  </Badge>
                ),
            },
            {
              header: 'Último acceso',
              cell: ({ row }) => <RelativeTime value={row.original.lastLoginAt} />,
            },
            {
              header: '',
              id: 'actions',
              cell: ({ row }) =>
                canEnter && (
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      icon={<IconLogin />}
                      disabled={
                        !row.original.active || (pending !== null && pending !== row.original.id)
                      }
                      busy={pending === row.original.id}
                      aria-label={`Entrar como ${row.original.name}`}
                      onClick={() => void enter(row.original.id, row.original.name)}
                    >
                      Entrar como
                    </Button>
                  </div>
                ),
            },
          ]}
        />
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3 text-sm">
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Anterior
            </Button>
            <span className="text-muted">
              Página {page} de {pages}
            </span>
            <Button size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Siguiente
            </Button>
          </div>
        )}
      </Card>
      <NewTenantUser
        tenantId={tenantId}
        roles={config.roles}
        open={creating}
        onClose={() => setCreating(false)}
      />
    </div>
  );
}

function NewTenantUser({
  tenantId,
  roles,
  open,
  onClose,
}: {
  tenantId: string;
  roles: { value: string; label: string }[];
  open: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const empty = { name: '', email: '', role: roles[0]?.value ?? '', password: '' };
  const [form, setForm] = useState(empty);
  const [created, setCreated] = useState<{ user: TenantUser; password: string } | null>(null);
  const create = useMutation({
    mutationFn: () =>
      post<TenantUser>(`/tenants/${encodeURIComponent(tenantId)}/users`, {
        name: form.name,
        email: form.email,
        ...(form.role ? { role: form.role } : {}),
        ...(form.password ? { password: form.password } : {}),
      }),
    onSuccess: (user) => {
      toast(`Usuario ${user.name} creado`);
      void client.invalidateQueries({ queryKey: ['tenant-users', tenantId] });
      if (form.password) setCreated({ user, password: form.password });
      else close();
    },
  });
  const close = () => (setForm(empty), setCreated(null), create.reset(), onClose());
  const submit = (event: FormEvent) => (event.preventDefault(), create.mutate());

  return (
    <Modal
      title="Nuevo usuario"
      description="Se crea en la base de este tenant, con las reglas de la app."
      open={open}
      onClose={close}
    >
      {created ? (
        <div className="space-y-4 text-sm">
          <p>
            <strong>{created.user.name}</strong> ya puede entrar con su email y esta contraseña.
            Cópiala ahora: no se vuelve a mostrar.
          </p>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-subtle px-3 py-2">
            <code className="break-all font-mono text-sm" data-testid="initial-password">
              {created.password}
            </code>
            <CopyButton text={created.password} />
          </div>
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>
              Listo
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <ErrorBox error={create.error} />
          <Field label="Nombre completo">
            {(id) => (
              <Input
                id={id}
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Email">
            {(id) => (
              <Input
                id={id}
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            )}
          </Field>
          {roles.length > 0 && (
            <Field label="Rol">
              {(id) => (
                <Select
                  id={id}
                  options={roles.map((r) => [r.value, r.label] as [string, string])}
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                />
              )}
            </Field>
          )}
          <Field
            label="Contraseña inicial"
            hint="Opcional. Si la dejas vacía, la app decide (por ejemplo, la cuenta queda por activar)."
          >
            {(id) => (
              <div className="flex gap-2">
                <Input
                  id={id}
                  type="text"
                  autoComplete="new-password"
                  minLength={8}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className="font-mono"
                />
                <Button
                  icon={<IconKey />}
                  onClick={() => setForm({ ...form, password: generatePassword() })}
                >
                  Generar
                </Button>
              </div>
            )}
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button onClick={close}>Cancelar</Button>
            <Button type="submit" variant="primary" busy={create.isPending}>
              Crear usuario
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
