import type { ReactNode } from 'react';
import { useAuth } from '../auth';
import { Link, usePath } from '../router';
import { Badge, cx } from './ui';

const NAV: { to: string; label: string; permission: string }[] = [
  { to: '/', label: 'Dashboard', permission: 'metrics:read' },
  { to: '/tenants', label: 'Tenants', permission: 'tenants:read' },
  { to: '/webhooks', label: 'Webhooks', permission: 'webhooks:read' },
  { to: '/events', label: 'Eventos', permission: 'events:read' },
  { to: '/users', label: 'Usuarios', permission: 'users:manage' },
  { to: '/audit', label: 'Auditoría', permission: 'audit:read' },
];

export function Layout({ children }: { children: ReactNode }) {
  const { session, can, logout } = useAuth();
  const path = usePath();
  const active = (to: string) => (to === '/' ? path === '/' : path.startsWith(to));
  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="border-b border-line bg-panel md:w-56 md:border-b-0 md:border-r">
        <div className="px-4 py-4 text-sm font-semibold">tenancy · panel</div>
        <nav aria-label="Principal" className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col">
          {NAV.filter((item) => can(item.permission)).map((item) => (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active(item.to) ? 'page' : undefined}
              className={cx(
                'whitespace-nowrap rounded-md px-3 py-1.5 text-sm',
                active(item.to)
                  ? 'bg-brand/10 font-medium text-brand'
                  : 'text-muted hover:bg-surface hover:text-fg',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 border-b border-line bg-panel px-4 py-2 text-sm">
          <Link to="/account" className="text-muted hover:text-fg">
            {session?.user.name} <Badge tone="skipped">{session?.user.role}</Badge>
          </Link>
          <button onClick={() => void logout()} className="text-muted hover:text-fg">
            Salir
          </button>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
