// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, onUnauthorized, setCsrfToken } from '../src/api';
import { AuthProvider } from '../src/auth';
import { ToastProvider } from '../src/components/ui';
import { Login } from '../src/pages/Login';
import { NewTenant } from '../src/pages/NewTenant';
import { ThemeEditor, themeVariables } from '../src/pages/ThemeEditor';
import { Tenants } from '../src/pages/Tenants';
import { matchPath } from '../src/router';

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

describe('api client', () => {
  it('sends the CSRF token only on requests that change something', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json(200, { ok: true }));
    setCsrfToken('tok123');
    await api('GET', '/tenants');
    await api('POST', '/tenants', { id: 'x' });
    const [getCall, postCall] = fetch.mock.calls;
    expect((getCall![1]!.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
    expect((postCall![1]!.headers as Record<string, string>)['x-csrf-token']).toBe('tok123');
    expect(postCall![1]!.credentials).toBe('same-origin');
    expect(postCall![0]).toBe('/admin/api/tenants');
  });

  it('turns API errors into ApiError and reports expired sessions', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      json(401, { error: { code: 'ADMIN_UNAUTHENTICATED', message: 'Login required' } }),
    );
    const expired = vi.fn();
    const off = onUnauthorized(expired);
    const error = await api('GET', '/tenants').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'ADMIN_UNAUTHENTICATED' });
    expect(expired).toHaveBeenCalledOnce();
    await api('POST', '/auth/login', {}).catch(() => undefined);
    expect(expired).toHaveBeenCalledOnce();
    off();
  });

  it('matches routes and builds theme variables like theme.css', () => {
    expect(matchPath('/tenants/:id', '/tenants/club%20a')).toEqual({ id: 'club a' });
    expect(matchPath('/tenants/:id', '/tenants')).toBeNull();
    expect(
      themeVariables({ primary: '#E4002B', secondary: 'nope', font: 'Inter', radius: 'lg' }),
    ).toEqual({
      '--color-primary': '#E4002B',
      '--font-main': "'Inter', system-ui, sans-serif",
      '--radius': '1rem',
    });
  });
});

describe('pages', () => {
  it('asks for the 2FA code when the account needs it', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/auth/me'))
        return json(401, { error: { code: 'ADMIN_UNAUTHENTICATED', message: 'x' } });
      const body = JSON.parse(String(init?.body)) as { code?: string };
      if (!body.code)
        return json(401, {
          error: { code: 'ADMIN_2FA_REQUIRED', message: 'Two-factor code required' },
        });
      return json(401, {
        error: { code: 'ADMIN_INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
    });
    render(wrap(<Login />));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'a@b.com');
    await user.type(screen.getByLabelText('Contraseña'), 'secreto-largo-123');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    const code = await screen.findByLabelText('Código de verificación');
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ADMIN_INVALID_CREDENTIALS');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('shows the lockout message after too many attempts', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/auth/me')
        ? json(401, { error: { code: 'X', message: 'x' } })
        : json(429, { error: { code: 'ADMIN_TOO_MANY_ATTEMPTS', message: 'Too many' } }),
    );
    render(wrap(<Login />));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'a@b.com');
    await user.type(screen.getByLabelText('Contraseña'), 'x');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Demasiados intentos');
  });

  it('hides actions the role cannot use', async () => {
    const session = (permissions: string[]) => ({
      user: { id: 1, email: 's@x', name: 'S', role: 'support' },
      permissions,
      csrfToken: 'c',
    });
    for (const [permissions, visible] of [
      [['tenants:read'], false],
      [['tenants:read', 'tenants:write'], true],
    ] as const) {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
        String(url).endsWith('/auth/me')
          ? json(200, session([...permissions]))
          : json(200, { items: [], total: 0, page: 1, perPage: 20 }),
      );
      render(wrap(<Tenants />));
      await waitFor(() => expect(screen.getByText('No hay tenants')).toBeTruthy());
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Nuevo tenant' }) !== null).toBe(visible),
      );
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('starts the theme editor from the app defaults and uploads the logo', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/theme/logo'))
        return json(200, {
          theme: { primary: '#0F172A', secondary: '#64748B', logo: 'theme/logo-abc.png' },
          logoUrl: '//sucre.dental.bo/tenancy/assets/theme/logo-abc.png',
        });
      if (init?.method === 'PUT') return json(200, {});
      return json(200, {
        user: { id: 1, email: 'o@x', name: 'O', role: 'owner' },
        permissions: ['tenants:write'],
        csrfToken: 'tok',
      });
    });
    render(
      wrap(
        <ThemeEditor
          tenantId="sucre"
          effectiveTheme={{ primary: '#0F172A', secondary: '#64748B' }}
          defaultTheme={{ primary: '#0F172A', secondary: '#64748B' }}
          logoUrl={null}
          previewDomain="sucre.dental.bo"
          canEdit
        />,
      ),
    );
    // El color por defecto de la app, no el azul del paquete; y el dominio real del tenant.
    expect(screen.getByDisplayValue('#0F172A')).toBeTruthy();
    expect(screen.queryByDisplayValue('#2563EB')).toBeNull();
    expect(screen.getByTestId('theme-preview').textContent).toContain('sucre.dental.bo');
    expect(screen.getByTestId('theme-preview').textContent).not.toContain('tuapp.com');

    await waitFor(() =>
      expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/auth/me'))).toBe(true),
    );
    const image = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', {
      type: 'image/png',
    });
    await userEvent.upload(screen.getByTestId('logo-file'), image);
    await waitFor(() => expect(screen.getByTestId('preview-logo')).toBeTruthy());
    expect(screen.getByTestId('preview-logo').getAttribute('src')).toBe(
      '//sucre.dental.bo/tenancy/assets/theme/logo-abc.png',
    );
    const call = fetch.mock.calls.find(([url]) => String(url).endsWith('/theme/logo'))!;
    expect(call[1]!.method).toBe('PUT');
    expect(call[1]!.body).toBe(image);
    const headers = call[1]!.headers as Record<string, string>;
    expect([headers['content-type'], headers['x-csrf-token']]).toEqual(['image/png', 'tok']);
    expect(screen.getByDisplayValue('theme/logo-abc.png')).toBeTruthy();

    // Vaciar un campo lo borra del tema (null); si se omitiera, el servidor lo dejaría igual.
    await userEvent.clear(screen.getByDisplayValue('theme/logo-abc.png'));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar tema' }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/tenants/sucre/theme'))).toBe(
        true,
      ),
    );
    const save = fetch.mock.calls.find(([url]) => String(url).endsWith('/tenants/sucre/theme'))!;
    expect(JSON.parse(String(save[1]!.body))).toEqual({
      primary: '#0F172A',
      secondary: '#64748B',
      logo: null,
    });
  });

  it('asks for the fields the app declares when creating a tenant', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/me'))
        return json(200, {
          user: { id: 1, email: 'o@x', name: 'O', role: 'owner' },
          permissions: ['tenants:write'],
          csrfToken: 'c',
          config: {
            centralDomains: ['dental.bo'],
            tenantFields: [
              {
                key: 'adminEmail',
                label: 'Email del administrador',
                type: 'email',
                required: true,
              },
            ],
          },
        });
      if (String(url).endsWith('/tenants'))
        return json(202, { id: 'sucre', progress: '/admin/api/tenants/sucre/progress' });
      return json(404, { error: { code: 'ADMIN_NOT_FOUND', message: 'x' } });
    });
    class FakeEventSource {
      addEventListener() {}
      close() {}
      onerror = null;
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    render(wrap(<NewTenant open onClose={() => undefined} />));
    const email = await screen.findByLabelText('Email del administrador');
    expect(screen.getByPlaceholderText('bolivar.dental.bo')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Id'), 'sucre');
    await userEvent.type(email, 'jefe@sucre.bo');
    await userEvent.click(screen.getByRole('button', { name: 'Agregar dato' }));
    await userEvent.type(screen.getByLabelText('Llave 1'), 'telefono');
    await userEvent.type(screen.getByLabelText('Valor 1'), '4-123');
    await userEvent.click(screen.getByRole('button', { name: 'Crear' }));
    await waitFor(() => expect(screen.getByText('Creando sucre')).toBeTruthy());
    const create = fetch.mock.calls.find(
      ([url, init]) => String(url).endsWith('/tenants') && init?.method === 'POST',
    )!;
    expect(JSON.parse(String(create[1]!.body))).toEqual({
      id: 'sucre',
      data: { telefono: '4-123', adminEmail: 'jefe@sucre.bo' },
    });
    vi.unstubAllGlobals();
  });
});
