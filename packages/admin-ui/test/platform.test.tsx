// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../src/api';
import { AuthProvider } from '../src/auth';
import { formatMoney, isOverdue, localToIso } from '../src/billing';
import { ToastProvider } from '../src/components/ui';
import { Billing } from '../src/pages/Billing';
import { Notifications, audienceSummary, validity } from '../src/pages/Notifications';
import { TenantBilling } from '../src/pages/TenantBilling';
import type {
  Invoice,
  InvoicesPage,
  NotificationsPage,
  PlansResponse,
  TenantBilling as TenantBillingData,
} from '../src/types';

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setCsrfToken(null);
});

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AuthProvider>{children}</AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

const session = (permissions: string[]) => ({
  user: { id: 1, email: 'a@x', name: 'A', role: 'admin' },
  permissions,
  csrfToken: 'tok',
});

const PLANS: PlansResponse = {
  enabled: true,
  defaultPlan: 'basico',
  features: [],
  plans: [
    {
      id: 'basico',
      label: 'Básico',
      description: null,
      price: { currency: 'BOB', monthly: 150 },
      features: [],
      limits: {},
      highlight: false,
      public: true,
      tenants: 2,
    },
    {
      id: 'pro',
      label: 'Profesional',
      description: null,
      price: null,
      features: [],
      limits: {},
      highlight: false,
      public: true,
      tenants: 1,
    },
  ],
  withoutPlan: 0,
  unknown: [],
};

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: 'INV1',
  tenantId: 'clinica-a',
  description: 'Básico · octubre',
  currency: 'BOB',
  amountCents: 15000,
  paidCents: 0,
  status: 'open',
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  dueAt: '2099-01-01T00:00:00.000Z',
  paidAt: null,
  provider: null,
  providerRef: null,
  checkoutUrl: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const bodyOf = (init: RequestInit | undefined) =>
  JSON.parse(String(init?.body)) as Record<string, unknown>;

describe('platform helpers', () => {
  it('formats money from cents and dates', () => {
    expect(formatMoney(15050, 'BOB')).toMatch(/150,50/);
    expect(formatMoney(100, 'XX')).toBe('1,00 XX');
    expect(isOverdue(invoice({ dueAt: '2000-01-01T00:00:00Z' }))).toBe(true);
    expect(isOverdue(invoice({ dueAt: '2000-01-01T00:00:00Z', status: 'paid' }))).toBe(false);
    expect(localToIso('')).toBeUndefined();
    expect(localToIso('2026-11-01T10:30')).toBe(new Date('2026-11-01T10:30').toISOString());
  });

  it('summarizes audiences and validity', () => {
    expect(audienceSummary({ type: 'all' }, PLANS)).toBe('Todos los tenants');
    expect(audienceSummary({ type: 'tenants', tenants: ['a', 'b', 'c', 'd'] }, PLANS)).toBe(
      '4 tenants: a, b, c…',
    );
    expect(audienceSummary({ type: 'plans', plans: ['pro'] }, PLANS)).toBe('Plan Profesional');
    expect(validity({ startsAt: '2099-01-01T00:00:00Z', expiresAt: null }).label).toBe(
      'Programado',
    );
    expect(validity({ startsAt: null, expiresAt: '2000-01-01T00:00:00Z' }).label).toBe('Vencido');
    expect(validity({ startsAt: null, expiresAt: null }).label).toBe('Vigente');
  });
});

describe('notifications page', () => {
  const LIST: NotificationsPage = {
    items: [
      {
        id: 'N1',
        title: 'Mantenimiento',
        body: 'Sábado de 2 a 4',
        level: 'warning',
        audience: { type: 'plans', plans: ['basico'] },
        roles: ['ADMIN'],
        link: null,
        startsAt: null,
        expiresAt: null,
        createdBy: 'ana@tuapp.com',
        createdAt: new Date().toISOString(),
        reads: { tenants: 2, users: 5 },
      },
    ],
    total: 1,
    page: 1,
    perPage: 20,
    channels: ['firebase'],
  };

  it('lists notifications, previews and sends a new one with live reach', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/auth/me')) return json(200, session(['tenants:read', 'notifications:send']));
      if (u.endsWith('/plans')) return json(200, PLANS);
      if (u.endsWith('/notifications/reach')) {
        const audience = bodyOf(init).audience as { type: string };
        return json(200, { tenants: audience.type === 'all' ? 3 : 2 });
      }
      if (u.includes('/notifications') && init?.method === 'POST')
        return json(201, { ...LIST.items[0], id: 'N2' });
      if (u.includes('/notifications/N1/deliver')) return json(200, []);
      return json(200, LIST);
    });
    const user = userEvent.setup();
    render(wrap(<Notifications />));
    // La sesión carga primero y descarta las demás consultas: se espera a que esté.
    await screen.findByRole('button', { name: 'Nuevo aviso' });
    await waitFor(() => expect(screen.getByText('Mantenimiento')).toBeInTheDocument());
    expect(screen.getByText('Push: firebase')).toBeInTheDocument();
    expect(screen.getByText('Plan Básico')).toBeInTheDocument();
    expect(screen.getByText('Roles: ADMIN')).toBeInTheDocument();
    expect(screen.getByText('2 tenants · 5 usuarios')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reenviar push' })).toBeInTheDocument();

    // Retirar pide confirmación dentro de la página.
    await user.click(screen.getByRole('button', { name: 'Retirar' }));
    expect(screen.getByRole('alert')).toHaveTextContent('¿Retirar de todos los tenants?');
    await user.click(screen.getByRole('button', { name: 'No' }));

    await user.click(screen.getByRole('button', { name: 'Nuevo aviso' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo aviso' });
    await user.type(within(dialog).getByLabelText('Título'), 'Nueva versión');
    await user.type(within(dialog).getByLabelText('Mensaje'), 'Ahora con reportes');
    await user.click(within(dialog).getByRole('radio', { name: 'Urgente' }));
    expect(within(dialog).getByTestId('notification-preview')).toHaveTextContent('Nueva versión');
    await waitFor(() =>
      expect(within(dialog).getByTestId('notification-reach')).toHaveTextContent(
        'Llegará a 3 tenants activos.',
      ),
    );
    await user.click(within(dialog).getByRole('radio', { name: 'Por plan' }));
    expect(within(dialog).getByTestId('notification-reach')).toHaveTextContent(
      'Elige al menos un plan.',
    );
    expect(within(dialog).getByRole('button', { name: 'Enviar aviso' })).toBeDisabled();
    await user.click(within(dialog).getByLabelText('Profesional'));
    await waitFor(() =>
      expect(within(dialog).getByTestId('notification-reach')).toHaveTextContent('Llegará a 2'),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Enviar aviso' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([u, init]) => String(u).endsWith('/notifications') && init?.method === 'POST',
        ),
      ).toBe(true),
    );
    const sent = fetch.mock.calls.find(
      ([u, init]) => String(u).endsWith('/notifications') && init?.method === 'POST',
    )!;
    expect(bodyOf(sent[1])).toEqual({
      title: 'Nueva versión',
      body: 'Ahora con reportes',
      level: 'critical',
      audience: { type: 'plans', plans: ['pro'] },
      roles: null,
      link: null,
      startsAt: null,
      expiresAt: null,
    });
  });
});

describe('billing pages', () => {
  const PAGE: InvoicesPage = {
    items: [invoice(), invoice({ id: 'INV2', tenantId: 'clinica-b', paidCents: 5000 })],
    total: 2,
    page: 1,
    perPage: 20,
    summary: { open: 2, overdue: 1, pastDueSubscriptions: 1 },
    providers: ['manual', 'qr'],
  };

  it('lists invoices, records a payment, voids and charges online', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/auth/me')) return json(200, session(['billing:read', 'billing:write']));
      if (u.endsWith('/payments'))
        return json(201, { invoice: invoice({ status: 'paid' }), payment: {} });
      if (u.endsWith('/void')) return json(200, invoice({ status: 'void' }));
      if (u.endsWith('/checkout')) return json(200, { providerRef: 'qr_INV1', qr: 'QR-TEXTO' });
      if (u.endsWith('/billing/run'))
        return json(200, { invoiced: ['x'], pastDue: [], suspended: [] });
      return json(200, PAGE);
    });
    const user = userEvent.setup();
    render(wrap(<Billing />));
    await screen.findByRole('button', { name: 'Correr ciclo de cobro' });
    await waitFor(() => expect(screen.getByText('clinica-a')).toBeInTheDocument());
    expect(
      screen.getByText('Suscripciones en mora').parentElement?.parentElement,
    ).toHaveTextContent('1');
    expect(screen.getByText(/Abierta \(parcial\)/)).toBeInTheDocument();
    expect(screen.getByText(/pasarelas:\s*qr/)).toBeInTheDocument();

    // Pago manual.
    await user.click(screen.getAllByRole('button', { name: 'Registrar pago' })[0]!);
    const pay = await screen.findByRole('dialog', { name: 'Registrar pago' });
    expect(within(pay).getByLabelText('Monto (BOB)')).toHaveValue(150);
    await user.selectOptions(within(pay).getByLabelText('Método'), 'qr');
    await user.type(within(pay).getByLabelText('Referencia'), 'BNB-1');
    await user.click(within(pay).getByRole('button', { name: 'Registrar pago' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([u]) => String(u).endsWith('/billing/invoices/INV1/payments')),
      ).toBe(true),
    );
    const payment = fetch.mock.calls.find(([u]) => String(u).endsWith('/payments'))!;
    expect(bodyOf(payment[1])).toMatchObject({ amount: 150, method: 'qr', reference: 'BNB-1' });

    // Anular: solo la que no tiene pagos, con confirmación.
    expect(screen.getAllByRole('button', { name: 'Anular' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Anular' }));
    await user.click(screen.getByRole('button', { name: 'Sí, anular' }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/INV1/void'))).toBe(true),
    );

    // Cobro en línea: muestra el QR.
    await user.click(screen.getAllByRole('button', { name: 'Cobrar en línea' })[0]!);
    const checkout = await screen.findByRole('dialog', { name: 'Cobrar en línea' });
    await user.click(within(checkout).getByRole('button', { name: 'Generar cobro' }));
    expect(await within(checkout).findByText('QR-TEXTO')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Correr ciclo de cobro' }));
    expect(await screen.findByText(/1 facturas nuevas \(x\)/)).toBeInTheDocument();
  });

  it('creates a subscription and a one-off invoice for a tenant', async () => {
    let data: TenantBillingData = {
      subscription: null,
      invoices: [],
      payments: [],
      providers: ['manual'],
    };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/auth/me')) return json(200, session(['billing:read', 'billing:write']));
      if (u.endsWith('/plans')) return json(200, PLANS);
      if (u.endsWith('/billing/subscription') && init?.method === 'PUT') {
        data = {
          ...data,
          subscription: {
            tenantId: 'clinica-a',
            plan: 'basico',
            period: 'monthly',
            status: 'active',
            currency: 'BOB',
            amountCents: 15000,
            currentPeriodStart: '2026-10-01T00:00:00.000Z',
            currentPeriodEnd: '2026-11-01T00:00:00.000Z',
            provider: 'manual',
            providerRef: null,
            canceledAt: null,
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
          invoices: [invoice()],
        };
        return json(200, data.subscription);
      }
      if (u.endsWith('/billing/invoices') && init?.method === 'POST') return json(201, invoice());
      return json(200, data);
    });
    const user = userEvent.setup();
    render(wrap(<TenantBilling tenantId="clinica-a" plan="basico" />));
    await user.click(await screen.findByRole('button', { name: 'Crear suscripción' }));
    const form = await screen.findByRole('dialog', { name: 'Nueva suscripción' });
    expect(within(form).getByText(/Vacío = precio del plan \(150 BOB\)/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Días de prueba'), '0');
    await user.click(within(form).getByRole('button', { name: 'Crear suscripción' }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true),
    );
    expect(bodyOf(fetch.mock.calls.find(([, init]) => init?.method === 'PUT')![1])).toEqual({
      period: 'monthly',
      trialDays: 0,
      provider: 'manual',
    });
    expect(await screen.findByText('Al día')).toBeInTheDocument();
    expect(screen.getByText('Básico · octubre')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Nueva factura' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nueva factura' });
    await user.click(within(dialog).getByRole('radio', { name: /Cobro suelto/ }));
    await user.type(within(dialog).getByLabelText('Concepto'), 'Capacitación');
    await user.type(within(dialog).getByLabelText('Monto (BOB)'), '80');
    await user.click(within(dialog).getByRole('button', { name: 'Emitir factura' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([u, init]) => String(u).endsWith('/billing/invoices') && init?.method === 'POST',
        ),
      ).toBe(true),
    );
    const created = fetch.mock.calls.find(
      ([u, init]) => String(u).endsWith('/billing/invoices') && init?.method === 'POST',
    )!;
    expect(bodyOf(created[1])).toEqual({ description: 'Capacitación', amount: 80 });

    await user.click(screen.getByRole('button', { name: 'Cancelar suscripción' }));
    expect(screen.getByRole('alert')).toHaveTextContent('¿Cancelar la suscripción?');
  });
});
