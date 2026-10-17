// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../src/api';
import { AuthProvider } from '../src/auth';
import { ToastProvider } from '../src/components/ui';
import { Leads, suggestTenantId, tenantFromLead } from '../src/pages/Leads';
import { PlanEditor } from '../src/pages/PlanEditor';
import { Plans } from '../src/pages/Plans';
import { ThemeEditor, themeVariables } from '../src/pages/ThemeEditor';
import { formatLimit, formatPrice } from '../src/plans';
import type { Lead, PlansResponse, TenantDetail } from '../src/types';

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setCsrfToken(null);
  document.head.querySelectorAll('link[data-font]').forEach((l) => l.remove());
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

const PLANS: PlansResponse = {
  enabled: true,
  defaultPlan: 'basico',
  features: [
    { id: 'agenda', label: 'Agenda', description: null },
    { id: 'caja', label: 'Caja', description: null },
    { id: 'reportes', label: 'Reportes', description: 'Reportes y PDF' },
  ],
  plans: [
    {
      id: 'basico',
      label: 'Básico',
      description: null,
      price: { currency: 'BOB', monthly: 150 },
      features: ['agenda', 'caja'],
      limits: { usuarios: 3 },
      highlight: false,
      public: true,
      tenants: 2,
    },
    {
      id: 'pro',
      label: 'Profesional',
      description: 'Para clínicas grandes',
      price: null,
      features: ['agenda', 'caja', 'reportes'],
      limits: { usuarios: null },
      highlight: true,
      public: false,
      tenants: 1,
    },
  ],
  withoutPlan: 0,
  unknown: [{ plan: 'viejo', tenants: 1 }],
};

const session = (permissions: string[]) => ({
  user: { id: 1, email: 'a@x', name: 'A', role: 'admin' },
  permissions,
  csrfToken: 'tok',
});

describe('plans helpers', () => {
  it('formats prices and limits', () => {
    expect(formatPrice(null)).toBe('A consultar');
    expect(formatPrice({ currency: 'BOB' })).toBe('A consultar');
    expect(formatPrice({ currency: 'BOB', monthly: 150, yearly: 1500 })).toMatch(
      /^150 BOB \/ mes · 1.?500 BOB \/ año$/,
    );
    expect(formatLimit(null)).toBe('sin límite');
    expect(formatLimit(undefined)).toBe('sin límite');
    expect(formatLimit(3)).toBe('3');
  });

  it('builds the new tenant from a lead', () => {
    expect(suggestTenantId('Clínica Dental Sur!')).toBe('clinica-dental-sur');
    const lead = {
      name: 'Ana',
      company: 'Dental Sur',
      email: 'ana@x.com',
      phone: '+591 7',
      city: 'La Paz',
      plan: 'pro',
    } as Lead;
    expect(tenantFromLead(lead)).toEqual({
      id: 'dental-sur',
      name: 'Dental Sur',
      plan: 'pro',
      data: { email: 'ana@x.com', telefono: '+591 7', ciudad: 'La Paz', contacto: 'Ana' },
      email: 'ana@x.com',
      phone: '+591 7',
    });
  });

  it('uses the font stack from theme.fonts in the preview variables', () => {
    expect(
      themeVariables({ font: 'Georgia' }, [
        {
          family: 'Georgia',
          label: 'Georgia',
          source: 'system',
          weights: [400],
          cssUrl: null,
          stack: "'Georgia', serif",
        },
      ]),
    ).toEqual({ '--font-main': "'Georgia', serif" });
  });
});

describe('plan pages', () => {
  it('shows plans with prices, comparison, badges and unknown plans', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/auth/me') ? json(200, session(['tenants:read'])) : json(200, PLANS),
    );
    render(wrap(<Plans />));
    const basico = await screen.findByRole('region', { name: 'Plan Básico' });
    expect(basico).toHaveTextContent('150 BOB / mes');
    expect(basico).toHaveTextContent('2 tenants');
    const pro = screen.getByRole('region', { name: 'Plan Profesional' });
    expect(pro).toHaveTextContent('A consultar');
    expect(pro).toHaveTextContent('Destacado');
    expect(pro).toHaveTextContent('Oculto en la web');
    expect(screen.getByRole('alert')).toHaveTextContent('viejo (1)');
    expect(screen.getByText('Límite: usuarios')).toBeTruthy();
    expect(screen.getByText('sin límite')).toBeTruthy();
  });

  it('edits the plan and loose modules of a tenant', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/auth/me')) return json(200, session(['tenants:write']));
      if (init?.method === 'PATCH') return json(200, {});
      return json(200, PLANS);
    });
    const detail = {
      tenant: {
        id: 'clinica',
        name: 'Clínica',
        plan: 'basico',
        features: { remove: ['caja'] },
      },
      plan: { enabled: true, knownPlan: true },
    } as unknown as TenantDetail;
    render(wrap(<PlanEditor detail={detail} canEdit />));
    const caja = await screen.findByRole('checkbox', { name: /Caja/ });
    expect(caja).not.toBeChecked();
    expect(screen.getByTestId('effective-features')).toHaveTextContent('Agenda');
    expect(screen.getByTestId('effective-features')).not.toHaveTextContent('Caja');
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: /Reportes/ }));
    await user.type(screen.getByLabelText('Límite propio de usuarios'), '5');
    await user.click(screen.getByRole('button', { name: 'Guardar plan' }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true),
    );
    const call = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(String(call[0])).toBe('/admin/api/tenants/clinica');
    expect(JSON.parse(String(call[1]!.body))).toEqual({
      plan: 'basico',
      features: { add: ['reportes'], remove: ['caja'], limits: { usuarios: 5 } },
    });

    // Al pasar a Profesional, "reportes" ya viene del plan: no es un módulo suelto.
    await user.selectOptions(screen.getByLabelText('Plan'), 'pro');
    await user.click(screen.getByRole('checkbox', { name: /Caja/ }));
    await user.click(screen.getByRole('checkbox', { name: 'sin límite' }));
    fetch.mockClear();
    await user.click(screen.getByRole('button', { name: 'Guardar plan' }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true),
    );
    const second = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(second[1]!.body))).toEqual({
      plan: 'pro',
      features: { limits: { usuarios: null } },
    });
  });

  it('lists leads, edits one and converts it into a tenant', async () => {
    const lead: Lead = {
      id: 7,
      name: 'Ana Pérez',
      company: 'Dental Sur',
      city: 'La Paz',
      phone: '+591 70000000',
      email: 'ana@example.com',
      plan: 'pro',
      message: 'Quiero una demo',
      data: { origen: 'google' },
      status: 'new',
      notes: null,
      tenantId: null,
      ip: '10.0.0.1',
      consentAt: '2026-10-01T10:00:00Z',
      createdAt: '2026-10-01T10:00:00Z',
      updatedAt: '2026-10-01T10:00:00Z',
    };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/auth/me'))
        return json(200, session(['leads:read', 'leads:write', 'tenants:write']));
      if (u.includes('/leads?'))
        return json(200, {
          items: [lead],
          total: 1,
          page: 1,
          perPage: 20,
          counts: { new: 1, contacted: 2, converted: 0, discarded: 0 },
        });
      if (u.endsWith('/leads/7') && init?.method === 'PATCH') return json(200, lead);
      if (u.endsWith('/leads/7') && init?.method === 'DELETE')
        return new Response(null, { status: 204 });
      if (u.endsWith('/tenants') && init?.method === 'POST')
        return json(202, { id: 'dental-sur', progress: '/x' });
      if (u.endsWith('/plans')) return json(200, PLANS);
      return json(404, { error: { code: 'ADMIN_NOT_FOUND', message: 'x' } });
    });
    class FakeEventSource {
      addEventListener() {}
      close() {}
      onerror = null;
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    render(wrap(<Leads />));
    const user = userEvent.setup();
    const filters = screen.getByRole('radiogroup', { name: 'Estado' });
    await waitFor(() =>
      expect(within(filters).getByRole('radio', { name: /Contactada 2/ })).toBeTruthy(),
    );
    expect(within(filters).getByRole('radio', { name: /Todas 3/ })).toBeTruthy();
    await user.click(await screen.findByText('Dental Sur'));
    const dialog = await screen.findByRole('dialog', { name: 'Dental Sur' });
    expect(dialog).toHaveTextContent('Quiero una demo');
    expect(dialog).toHaveTextContent('google');
    expect(dialog).toHaveTextContent('Profesional');

    await user.selectOptions(within(dialog).getByLabelText('Estado'), 'contacted');
    await user.type(within(dialog).getByLabelText('Notas internas'), 'Llamar el lunes');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true),
    );
    const saved = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(saved[1]!.body))).toEqual({
      status: 'contacted',
      notes: 'Llamar el lunes',
    });

    // Borrar pide confirmación dentro del panel.
    await user.click(within(dialog).getByRole('button', { name: 'Borrar (spam)' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('¿Borrar esta solicitud?');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

    // "Crear tenant": el formulario llega lleno y la solicitud queda convertida.
    fetch.mockClear();
    await user.click(within(dialog).getByRole('button', { name: 'Crear tenant' }));
    const form = await screen.findByRole('dialog', { name: 'Nuevo tenant' });
    expect(within(form).getByLabelText('Id')).toHaveValue('dental-sur');
    expect(within(form).getByLabelText('Nombre')).toHaveValue('Dental Sur');
    await waitFor(() => expect(within(form).getByLabelText('Plan')).toHaveValue('pro'));
    await user.click(within(form).getByRole('button', { name: 'Crear' }));
    await waitFor(() => expect(screen.getByText('Creando dental-sur')).toBeTruthy());
    const create = fetch.mock.calls.find(
      ([u, init]) => String(u).endsWith('/tenants') && init?.method === 'POST',
    )!;
    expect(JSON.parse(String(create[1]!.body))).toEqual({
      id: 'dental-sur',
      name: 'Dental Sur',
      plan: 'pro',
      data: {
        email: 'ana@example.com',
        telefono: '+591 70000000',
        ciudad: 'La Paz',
        contacto: 'Ana Pérez',
      },
    });
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([u, init]) => String(u).endsWith('/leads/7') && init?.method === 'PATCH',
        ),
      ).toBe(true),
    );
    const converted = fetch.mock.calls.find(
      ([u, init]) => String(u).endsWith('/leads/7') && init?.method === 'PATCH',
    )!;
    expect(JSON.parse(String(converted[1]!.body))).toEqual({
      status: 'converted',
      tenantId: 'dental-sur',
    });
  });

  it('picks fonts from the allowed list, previewed in their own font', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/auth/me')) return json(200, session(['tenants:write']));
      if (init?.method === 'PUT') return json(200, {});
      return json(404, {});
    });
    const fonts = [
      {
        family: 'Inter',
        label: 'Inter',
        source: 'google' as const,
        weights: [400, 700],
        cssUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap',
        stack: "'Inter', system-ui, sans-serif",
      },
      {
        family: 'Marca',
        label: 'Fuente de marca',
        source: 'url' as const,
        weights: [400],
        cssUrl: '/fonts/marca.css',
        stack: "'Marca', sans-serif",
      },
    ];
    render(
      wrap(
        <ThemeEditor
          tenantId="sucre"
          effectiveTheme={{ primary: '#0F172A', secondary: '#64748B' }}
          defaultTheme={{ primary: '#0F172A', secondary: '#64748B' }}
          logoUrl={null}
          previewDomain="sucre.dental.bo"
          canEdit
          fonts={fonts}
        />,
      ),
    );
    // Solo se carga el CSS de Google (el de otros orígenes lo bloquea la CSP del panel).
    const links = [...document.head.querySelectorAll<HTMLLinkElement>('link[data-font]')];
    expect(links.map((l) => l.dataset.font)).toEqual([fonts[0]!.cssUrl]);
    const group = screen.getByRole('radiogroup', { name: 'Tipografía' });
    const inter = within(group).getByRole('radio', { name: 'Inter' });
    expect(inter.style.fontFamily).toContain('Inter');
    expect(within(group).getByRole('radio', { name: 'Por defecto' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(inter);
    expect(inter).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('theme-preview').style.getPropertyValue('--font-main')).toBe(
      "'Inter', system-ui, sans-serif",
    );
    await userEvent.click(screen.getByRole('button', { name: 'Guardar tema' }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true),
    );
    const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]!.body))).toMatchObject({ font: 'Inter' });
  });
});
