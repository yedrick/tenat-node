import { useAuth } from './auth';
import { Layout } from './components/Layout';
import { EmptyState, Spinner } from './components/ui';
import { Account } from './pages/Account';
import { Audit } from './pages/Audit';
import { Billing } from './pages/Billing';
import { Dashboard } from './pages/Dashboard';
import { Events } from './pages/Events';
import { Leads } from './pages/Leads';
import { Login } from './pages/Login';
import { Notifications } from './pages/Notifications';
import { Plans } from './pages/Plans';
import { Platform } from './pages/Platform';
import { TenantDetail } from './pages/TenantDetail';
import { Tenants } from './pages/Tenants';
import { Users } from './pages/Users';
import { Webhooks } from './pages/Webhooks';
import { matchPath, usePath } from './router';

export function App() {
  const { session, loading, can } = useAuth();
  const path = usePath();
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!session) return <Login />;

  const tenant = matchPath('/tenants/:id', path);
  let page;
  if (path === '/') page = can('metrics:read') ? <Dashboard /> : <Tenants />;
  else if (path === '/tenants') page = <Tenants />;
  else if (tenant) page = <TenantDetail key={tenant.id} id={tenant.id!} />;
  else if (path === '/plans' && can('tenants:read')) page = <Plans />;
  else if (path === '/platform' && can('tenants:read')) page = <Platform />;
  else if (path === '/leads' && can('leads:read')) page = <Leads />;
  else if (path === '/notifications' && can('tenants:read')) page = <Notifications />;
  else if (path === '/billing' && can('billing:read')) page = <Billing />;
  else if (path === '/webhooks' && can('webhooks:read')) page = <Webhooks />;
  else if (path === '/events' && can('events:read')) page = <Events />;
  else if (path === '/users' && can('users:manage')) page = <Users />;
  else if (path === '/audit' && can('audit:read')) page = <Audit />;
  else if (path === '/account') page = <Account />;
  else page = <EmptyState>Página no encontrada</EmptyState>;
  return <Layout>{page}</Layout>;
}
