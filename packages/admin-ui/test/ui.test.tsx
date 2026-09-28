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
import { themeVariables } from '../src/pages/ThemeEditor';
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
});
