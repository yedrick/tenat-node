import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../auth';
import { Link, navigate, usePath } from '../router';
import { useColorMode } from '../theme';
import {
  IconActivity,
  IconBell,
  IconBuilding,
  IconDashboard,
  IconInbox,
  IconLayers,
  IconLogout,
  IconMenu,
  IconMoon,
  IconSearch,
  IconShield,
  IconSun,
  IconUsers,
  IconWallet,
  IconWebhook,
  IconX,
  IconPalette,
} from './icons';
import { Avatar, cx } from './ui';

interface NavItem {
  to: string;
  label: string;
  permission: string;
  icon: ReactNode;
}

const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: 'Plataforma',
    items: [
      { to: '/', label: 'Dashboard', permission: 'metrics:read', icon: <IconDashboard /> },
      { to: '/tenants', label: 'Tenants', permission: 'tenants:read', icon: <IconBuilding /> },
      { to: '/plans', label: 'Planes', permission: 'tenants:read', icon: <IconLayers /> },
      { to: '/leads', label: 'Solicitudes', permission: 'leads:read', icon: <IconInbox /> },
      { to: '/notifications', label: 'Avisos', permission: 'tenants:read', icon: <IconBell /> },
      { to: '/billing', label: 'Cobros', permission: 'billing:read', icon: <IconWallet /> },
      { to: '/platform', label: 'Plataforma', permission: 'tenants:read', icon: <IconPalette /> },
    ],
  },
  {
    title: 'Integraciones',
    items: [
      { to: '/webhooks', label: 'Webhooks', permission: 'webhooks:read', icon: <IconWebhook /> },
      { to: '/events', label: 'Eventos', permission: 'events:read', icon: <IconActivity /> },
    ],
  },
  {
    title: 'Administración',
    items: [
      {
        to: '/users',
        label: 'Usuarios del panel',
        permission: 'users:manage',
        icon: <IconUsers />,
      },
      { to: '/audit', label: 'Auditoría', permission: 'audit:read', icon: <IconShield /> },
    ],
  },
];

const ROLE_LABELS: Record<string, string> = {
  owner: 'Dueño',
  admin: 'Administrador',
  support: 'Soporte',
};

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-5 py-5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-brand-fg shadow-sm">
        <IconBuilding width={18} height={18} />
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold">tenancy</p>
        <p className="text-xs text-muted">Panel de la plataforma</p>
      </div>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { session, can, logout } = useAuth();
  const path = usePath();
  const active = (to: string) => (to === '/' ? path === '/' : path.startsWith(to));
  return (
    <div className="flex h-full flex-col">
      <Brand />
      <nav aria-label="Principal" className="flex-1 space-y-6 overflow-y-auto px-3 pb-4">
        {NAV.map((group) => {
          const items = group.items.filter((item) => can(item.permission));
          if (items.length === 0) return null;
          return (
            <div key={group.title}>
              <p className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted/80">
                {group.title}
              </p>
              <div className="space-y-0.5">
                {items.map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={onNavigate}
                    aria-current={active(item.to) ? 'page' : undefined}
                    className={cx(
                      'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                      active(item.to)
                        ? 'bg-brand/10 font-medium text-brand'
                        : 'text-muted hover:bg-subtle hover:text-fg',
                    )}
                  >
                    {item.icon}
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </nav>
      {session && (
        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2.5 rounded-lg p-2">
            <Avatar name={session.user.name} size="sm" />
            <Link to="/account" onClick={onNavigate} className="min-w-0 flex-1 hover:text-brand">
              <p className="truncate text-sm font-medium">{session.user.name}</p>
              <p className="truncate text-xs text-muted">
                {ROLE_LABELS[session.user.role] ?? session.user.role}
              </p>
            </Link>
            <button
              type="button"
              onClick={() => void logout()}
              title="Cerrar sesión"
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-subtle hover:text-danger"
            >
              <IconLogout />
              Salir
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Buscador rápido: lleva a la lista de tenants filtrada. */
function QuickSearch() {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const search = value.trim();
    navigate(search ? `/tenants?search=${encodeURIComponent(search)}` : '/tenants');
    setValue('');
  };
  return (
    <form onSubmit={submit} role="search" className="relative w-full max-w-sm">
      <IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
      <input
        aria-label="Buscar tenant"
        placeholder="Buscar tenant por id o nombre…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-9 w-full rounded-lg border border-line bg-subtle pl-9 pr-3 text-sm outline-none transition placeholder:text-muted/70 focus:border-brand focus:bg-panel focus:ring-3 focus:ring-brand/15"
      />
    </form>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mode, toggleMode] = useColorMode();
  const path = usePath();
  useEffect(() => setOpen(false), [path]);

  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-line bg-panel lg:block">
        <Sidebar />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="presentation">
          <div className="absolute inset-0 bg-slate-950/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-line bg-panel shadow-[var(--shadow-pop)]">
            <button
              type="button"
              aria-label="Cerrar menú"
              onClick={() => setOpen(false)}
              className="absolute right-3 top-5 rounded-md p-1 text-muted hover:bg-subtle"
            >
              <IconX />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-panel/85 px-4 backdrop-blur md:px-6">
          <button
            type="button"
            aria-label="Abrir menú"
            onClick={() => setOpen(true)}
            className="rounded-md p-1.5 text-muted hover:bg-subtle lg:hidden"
          >
            <IconMenu width={20} height={20} />
          </button>
          <QuickSearch />
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={toggleMode}
              aria-label={mode === 'dark' ? 'Usar modo claro' : 'Usar modo oscuro'}
              title={mode === 'dark' ? 'Modo claro' : 'Modo oscuro'}
              className="rounded-lg p-2 text-muted hover:bg-subtle hover:text-fg"
            >
              {mode === 'dark' ? <IconSun /> : <IconMoon />}
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
