import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, post } from '../api';
import { useAuth } from '../auth';
import type { Page, TenantUser } from '../types';
import { IconExternal, IconLogin, IconSearch } from './icons';
import {
  Avatar,
  Badge,
  Button,
  CopyButton,
  ErrorBox,
  Field,
  Input,
  Modal,
  Spinner,
  formatDate,
  useToast,
} from './ui';

interface Link {
  url: string | null;
  token: string;
  expiresAt: string;
}

/**
 * Entra a la app del tenant como uno de sus usuarios. La pestaña se abre en el mismo clic (si se
 * abriera después de esperar a la API, el navegador la bloquearía) y luego se le pone la URL.
 */
export function useEnterAs(tenantId: string) {
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [link, setLink] = useState<Link | null>(null);
  /** `true` si la sesión se abrió en otra pestaña; si no, queda `link` o `error` para mostrar. */
  const enter = async (user: string, label = user): Promise<boolean> => {
    setError(null);
    setLink(null);
    setPending(user);
    const tab = window.open('', '_blank');
    try {
      const result = await post<Link>(`/tenants/${encodeURIComponent(tenantId)}/impersonate`, {
        user,
      });
      if (result.url && tab) {
        tab.opener = null;
        tab.location.href = result.url;
        toast(`Entrando a ${tenantId} como ${label}`);
        return true;
      }
      tab?.close();
      setLink(result);
      return false;
    } catch (e) {
      tab?.close();
      setError(e);
      return false;
    } finally {
      setPending(null);
    }
  };
  return { enter, pending, error, link, reset: () => (setError(null), setLink(null)) };
}

/** El enlace de un solo uso, cuando no se pudo abrir solo (sin URL o pestaña bloqueada). */
export function ImpersonationLink({ link }: { link: Link }) {
  return (
    <div className="space-y-3 rounded-lg border border-line bg-subtle p-4 text-sm">
      <p>
        Enlace de un solo uso, válido hasta <strong>{formatDate(link.expiresAt)}</strong>:
      </p>
      {link.url ? (
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 break-all font-mono text-xs text-brand underline"
        >
          {link.url} <IconExternal />
        </a>
      ) : (
        <p className="break-all font-mono text-xs">{link.token}</p>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted">La acción queda en la auditoría.</p>
        <CopyButton text={link.url ?? link.token} />
      </div>
    </div>
  );
}

/** Diálogo "Entrar": busca un usuario del tenant (o se escribe) y abre su sesión. */
export function EnterTenant({
  tenant,
  open,
  onClose,
}: {
  tenant: { id: string; name: string };
  open: boolean;
  onClose: () => void;
}) {
  const { session } = useAuth();
  const listable = Boolean(session?.config?.tenantUsers);
  const { enter, pending, error, link, reset } = useEnterAs(tenant.id);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [manual, setManual] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const users = useQuery({
    queryKey: ['tenant-users', tenant.id, 'enter', debounced],
    queryFn: () =>
      get<Page<TenantUser>>(
        `/tenants/${encodeURIComponent(tenant.id)}/users?perPage=8${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}`,
      ),
    enabled: open && listable,
    placeholderData: keepPreviousData,
  });
  const close = () => (reset(), setSearch(''), setManual(''), onClose());
  const go = async (user: string, label?: string) => {
    if (await enter(user, label)) close();
  };
  const roleLabel = (role: string) =>
    session?.config?.tenantUsers?.roles.find((r) => r.value === role)?.label ?? role;

  return (
    <Modal
      title={`Entrar a ${tenant.name}`}
      description="Abre la app del tenant en otra pestaña con la sesión del usuario que elijas."
      open={open}
      onClose={close}
    >
      <div className="space-y-4">
        <ErrorBox error={error ?? users.error} />
        {link ? (
          <ImpersonationLink link={link} />
        ) : listable ? (
          <>
            <div className="relative">
              <IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <Input
                aria-label="Buscar usuario"
                placeholder="Buscar por nombre o email"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {users.isLoading && (
                <li className="flex justify-center p-6">
                  <Spinner />
                </li>
              )}
              {users.data?.items.length === 0 && (
                <li className="p-6 text-center text-sm text-muted">Sin usuarios que coincidan</li>
              )}
              {users.data?.items.map((u) => (
                <li key={u.id} className="flex items-center gap-3 px-3 py-2.5">
                  <Avatar name={u.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{u.name}</p>
                    <p className="truncate text-xs text-muted">{u.email ?? u.id}</p>
                  </div>
                  {u.role && <Badge tone="neutral">{roleLabel(u.role)}</Badge>}
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<IconLogin />}
                    disabled={!u.active || (pending !== null && pending !== u.id)}
                    busy={pending === u.id}
                    aria-label={`Entrar como ${u.name}`}
                    onClick={() => void go(u.id, u.name)}
                  >
                    Entrar
                  </Button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => (e.preventDefault(), void go(manual.trim()))}
          >
            <Field
              label="Usuario (id o email en la app del tenant)"
              hint="Para elegirlo de una lista, la app puede configurar tenantUsers en createAdminApi."
            >
              {(id) => <Input id={id} value={manual} onChange={(e) => setManual(e.target.value)} />}
            </Field>
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="primary"
                icon={<IconLogin />}
                disabled={!manual.trim()}
                busy={pending !== null}
              >
                Generar enlace y entrar
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
