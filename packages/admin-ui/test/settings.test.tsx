// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, setCsrfToken } from '../src/api';
import { AuthProvider } from '../src/auth';
import { ToastProvider } from '../src/components/ui';
import {
  conflictMessage,
  planChanges,
  planFormFrom,
  planInputFrom,
  validatePlanForm,
} from '../src/pages/PlanForm';
import { Plans } from '../src/pages/Plans';
import {
  Platform,
  platformChanges,
  platformFormFrom,
  validatePlatform,
} from '../src/pages/Platform';
import type { PlanInfo, PlansResponse, PlatformInfo } from '../src/types';

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

const basico: PlanInfo = {
  id: 'basico',
  label: 'Básico',
  description: null,
  price: { currency: 'BOB', monthly: 150 },
  features: ['agenda'],
  limits: { usuarios: 3 },
  highlight: false,
  public: true,
  tenants: 2,
  source: 'config',
  customized: true,
  archived: false,
  updatedAt: '2026-10-18T10:00:00.000Z',
  updatedBy: 'ana@tuapp.com',
};
const premium: PlanInfo = {
  id: 'premium',
  label: 'Premium',
  description: 'Todo incluido',
  price: null,
  features: ['agenda', 'caja'],
  limits: { usuarios: null },
  highlight: true,
  public: true,
  tenants: 1,
  source: 'panel',
  customized: false,
  archived: false,
  updatedAt: null,
  updatedBy: null,
};
const viejo: PlanInfo = { ...premium, id: 'viejo', label: 'Viejo', archived: true, tenants: 0 };
const PLANS: PlansResponse = {
  enabled: true,
  defaultPlan: 'basico',
  features: [
    { id: 'agenda', label: 'Agenda', description: null },
    { id: 'caja', label: 'Caja', description: null },
  ],
  plans: [basico, premium, viejo],
  withoutPlan: 0,
  unknown: [],
};

describe('plan form helpers', () => {
  it('builds the body and sends only what changed', () => {
    const form = planFormFrom(basico, ['usuarios', 'sucursales']);
    expect(form).toMatchObject({
      currency: 'BOB',
      monthly: '150',
      yearly: '',
      features: ['agenda'],
    });
    expect(form.limits).toEqual({
      usuarios: { value: '3', unlimited: false },
      sucursales: { value: '', unlimited: false },
    });
    const same = planInputFrom(form, PLANS.features);
    expect(planChanges(basico, same)).toEqual({});
    const changed = planInputFrom(
      {
        ...form,
        monthly: '180,5',
        features: ['caja', 'agenda'],
        limits: { ...form.limits, sucursales: { value: '', unlimited: true } },
      },
      PLANS.features,
    );
    expect(planChanges(basico, changed)).toEqual({
      price: { currency: 'BOB', monthly: 180.5, yearly: null },
      features: ['agenda', 'caja'],
      limits: { usuarios: 3, sucursales: null },
    });
    expect(planInputFrom({ ...form, monthly: '', yearly: '' }, PLANS.features).price).toBeNull();
    expect(planInputFrom({ ...form, allFeatures: true }, PLANS.features).features).toBe('*');
  });

  it('validates the form and explains conflicts', () => {
    const form = planFormFrom(undefined, []);
    expect(validatePlanForm(form, true)).toEqual({
      id: expect.any(String),
      label: expect.any(String),
    });
    expect(
      validatePlanForm(
        {
          ...form,
          id: 'ok',
          label: 'Ok',
          monthly: '-1',
          currency: 'bs',
          limits: { u: { value: '1.5', unlimited: false } },
        },
        true,
      ),
    ).toEqual({
      monthly: expect.any(String),
      currency: expect.any(String),
      'limit.u': expect.any(String),
    });
    const conflict = (message: string) =>
      conflictMessage(new ApiError(409, 'TENANCY_PLAN_CONFLICT', message));
    expect(conflict('Plan "x": 3 tenant(s) use this plan')).toMatch(/lo usan 3 tenants/);
    expect(conflict('Plan "x": 1 tenant(s) use this plan')).toMatch(/lo usan 1 tenant\./);
    expect(conflict('Plan "x": is the default plan')).toMatch(/plan por defecto/);
    expect(conflict('Plan "x": already exists')).toMatch(/Ya existe/);
    expect(conflictMessage(new Error('x'))).toBeNull();
  });
});

describe('plans page (editable)', () => {
  it('edits a plan sending only the changed fields', async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/auth/me')) return json(200, session(['tenants:read', 'plans:write']));
      if (init?.method && init.method !== 'GET') {
        calls.push({
          method: init.method,
          url: u,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return json(200, { ...basico, label: 'Básico 2026' });
      }
      return json(200, PLANS);
    });
    const user = userEvent.setup();
    render(wrap(<Plans />));
    const card = await screen.findByRole('region', { name: 'Plan Básico' });
    expect(card).toHaveTextContent('Configuración');
    expect(card).toHaveTextContent('Modificado');
    expect(card).toHaveTextContent('Modificado por ana@tuapp.com');
    expect(screen.getByRole('region', { name: 'Plan Premium' })).toHaveTextContent(
      'Creado en el panel',
    );
    // Los archivados van aparte y no salen en la comparativa.
    expect(screen.queryByRole('region', { name: 'Plan Viejo' })).toBeNull();
    expect(screen.getByText('Archivados (1)')).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Editar' }));
    const form = await screen.findByRole('form', { name: 'Editar plan Básico' });
    const label = within(form).getByLabelText('Nombre');
    await user.clear(label);
    await user.type(label, 'Básico 2026');
    await user.type(within(form).getByLabelText('Anual'), '1500');
    await user.click(within(form).getByRole('checkbox', { name: 'Más elegido' }));
    await user.click(within(form).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: 'PATCH',
      url: '/admin/api/plans/basico',
      body: {
        label: 'Básico 2026',
        price: { currency: 'BOB', monthly: 150, yearly: 1500 },
        highlight: true,
      },
    });
  });

  it('creates a plan with a suggested id', async () => {
    const calls: { method: string; body: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/auth/me'))
        return json(200, session(['tenants:read', 'plans:write']));
      if (init?.method === 'POST') {
        calls.push({ method: 'POST', body: JSON.parse(String(init.body)) });
        return json(201, premium);
      }
      return json(200, PLANS);
    });
    const user = userEvent.setup();
    render(wrap(<Plans />));
    await user.click(await screen.findByRole('button', { name: 'Nuevo plan' }));
    const form = await screen.findByRole('form', { name: 'Nuevo plan' });
    await user.type(within(form).getByLabelText('Nombre'), 'Clínica Grande');
    expect(within(form).getByLabelText('Id')).toHaveValue('clinica-grande');
    await user.type(within(form).getByLabelText('Mensual'), '400');
    await user.click(within(form).getByRole('checkbox', { name: 'Caja' }));
    await user.type(within(form).getByLabelText('Nuevo límite'), 'sucursales');
    await user.click(within(form).getByRole('button', { name: 'Agregar' }));
    await user.type(within(form).getByLabelText('Límite de sucursales'), '2');
    await user.click(within(form).getByRole('button', { name: 'Crear plan' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({
      id: 'clinica-grande',
      label: 'Clínica Grande',
      description: null,
      price: { currency: 'BOB', monthly: 400, yearly: null },
      features: ['caja'],
      limits: { sucursales: 2 },
      public: true,
      highlight: false,
    });
  });

  it('confirms reset and shows a clear 409 when archiving', async () => {
    const deletes: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/auth/me')) return json(200, session(['tenants:read', 'plans:write']));
      if (init?.method === 'DELETE') {
        deletes.push(u);
        if (u.endsWith('/premium'))
          return json(409, {
            error: {
              code: 'TENANCY_PLAN_CONFLICT',
              message: 'Plan "premium": 1 tenant(s) use this plan',
            },
          });
        return json(200, { id: 'basico', result: 'reset' });
      }
      return json(200, PLANS);
    });
    const user = userEvent.setup();
    render(wrap(<Plans />));
    const card = await screen.findByRole('region', { name: 'Plan Básico' });
    await user.click(within(card).getByRole('button', { name: 'Restablecer a la configuración' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restablecer Básico' });
    expect(deletes).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Restablecer' }));
    await waitFor(() => expect(deletes).toEqual(['/admin/api/plans/basico']));

    const premiumCard = screen.getByRole('region', { name: 'Plan Premium' });
    expect(within(premiumCard).queryByRole('button', { name: /Restablecer/ })).toBeNull();
    await user.click(within(premiumCard).getByRole('button', { name: 'Archivar' }));
    const archive = await screen.findByRole('dialog', { name: 'Archivar Premium' });
    await user.click(within(archive).getByRole('button', { name: 'Archivar' }));
    expect(await within(archive).findByRole('alert')).toHaveTextContent('lo usan 1 tenant.');
  });

  it('is read-only without plans:write', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/auth/me') ? json(200, session(['tenants:read'])) : json(200, PLANS),
    );
    render(wrap(<Plans />));
    await screen.findByRole('region', { name: 'Plan Básico' });
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Nuevo plan' })).toBeNull();
  });
});

const PLATFORM: PlatformInfo = {
  name: 'IONIX',
  logo: 'platform/logo-abc.png',
  favicon: null,
  primary: '#0F766E',
  contact: { whatsapp: '59170000000', email: null },
  salesNotifyTo: ['jefe@ionix.bo'],
  logoUrl: '/tenancy/platform/assets/logo-abc.png',
  faviconUrl: null,
  updatedAt: '2026-10-18T10:00:00.000Z',
  updatedBy: 'ana@tuapp.com',
};

describe('platform page', () => {
  it('computes and validates changes', () => {
    const form = platformFormFrom(PLATFORM);
    expect(platformChanges(PLATFORM, form)).toEqual({});
    expect(
      platformChanges(PLATFORM, {
        ...form,
        name: '',
        primary: '#0f766e',
        whatsapp: '+591 7111 1111',
        email: 'v@ionix.bo',
        salesNotifyTo: [],
      }),
    ).toEqual({
      name: null,
      contact: { whatsapp: '59171111111', email: 'v@ionix.bo' },
      salesNotifyTo: [],
    });
    expect(validatePlatform({ ...form, primary: 'rojo', whatsapp: '123', email: 'x' })).toEqual({
      primary: expect.any(String),
      whatsapp: expect.any(String),
      email: expect.any(String),
    });
  });

  it('saves only the changed fields and uploads the logo', async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/auth/me')) return json(200, session(['tenants:read', 'platform:write']));
      if (init?.method === 'PATCH') {
        calls.push({ method: 'PATCH', url: u, body: JSON.parse(String(init.body)) });
        return json(200, {
          ...PLATFORM,
          name: 'IONIX Salud',
          contact: { whatsapp: '59170000000', email: 'ventas@ionix.bo' },
        });
      }
      if (init?.method === 'PUT') {
        calls.push({
          method: 'PUT',
          url: u,
          body: (init.headers as Record<string, string>)['content-type'],
        });
        return json(200, {
          ...PLATFORM,
          logo: 'platform/logo-new.png',
          logoUrl: '/tenancy/platform/assets/logo-new.png',
        });
      }
      return json(200, PLATFORM);
    });
    const user = userEvent.setup();
    render(wrap(<Platform />));
    const form = await screen.findByRole('form', { name: 'Marca de la plataforma' });
    expect(screen.getByText(/Actualizado por ana@tuapp.com/)).toBeInTheDocument();
    expect(
      within(screen.getByTestId('platform-preview')).getByText('+59170000000'),
    ).toBeInTheDocument();
    const name = within(form).getByLabelText('Nombre');
    await user.clear(name);
    await user.type(name, 'IONIX Salud');
    await user.type(within(form).getByLabelText('Email de contacto'), 'ventas@ionix.bo');
    await user.type(within(form).getByLabelText('Nuevo correo de ventas'), 'otro@ionix.bo{Enter}');
    await user.click(within(form).getByRole('button', { name: 'Quitar jefe@ionix.bo' }));
    expect(
      within(screen.getByTestId('platform-preview')).getByText('IONIX Salud'),
    ).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: 'PATCH',
      url: '/admin/api/platform',
      body: {
        name: 'IONIX Salud',
        contact: { email: 'ventas@ionix.bo' },
        salesNotifyTo: ['otro@ionix.bo'],
      },
    });

    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', {
      type: 'image/png',
    });
    await user.upload(screen.getByTestId('logo-file'), png);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ method: 'PUT', url: '/admin/api/platform/logo', body: 'image/png' });
    await waitFor(() =>
      expect(screen.getByAltText('Logo actual')).toHaveAttribute(
        'src',
        '/tenancy/platform/assets/logo-new.png',
      ),
    );
  });

  it('is read-only without platform:write', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/auth/me') ? json(200, session(['tenants:read'])) : json(200, PLATFORM),
    );
    render(wrap(<Platform />));
    const form = await screen.findByRole('form', { name: 'Marca de la plataforma' });
    expect(within(form).getByLabelText('Nombre')).toBeDisabled();
    expect(within(form).queryByRole('button', { name: 'Guardar' })).toBeNull();
  });
});
