import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { ApiError, get, onUnauthorized, post, setCsrfToken } from './api';

export interface AdminUser {
  id: number;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'support';
  isActive: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface Session {
  user: AdminUser;
  permissions: string[];
  csrfToken: string | null;
}

interface AuthState {
  session: Session | null;
  loading: boolean;
  login(input: { email: string; password: string; code?: string }): Promise<void>;
  logout(): Promise<void>;
  /** La UI oculta lo que el rol no puede hacer; el servidor lo verifica igual. */
  can(permission: string): boolean;
  refresh(): Promise<unknown>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const session = await get<Session>('/auth/me');
        setCsrfToken(session.csrfToken);
        return session;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  /** Descarta los datos de la sesión anterior (tenants, métricas...) sin tocar la consulta de la sesión. */
  const forgetOtherQueries = () =>
    client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });

  useEffect(
    () =>
      onUnauthorized(() => {
        setCsrfToken(null);
        client.setQueryData(['me'], null);
      }),
    [client],
  );

  const state: AuthState = {
    session: me.data ?? null,
    loading: me.isLoading,
    async login(input) {
      const session = await post<Session>('/auth/login', { ...input, mode: 'cookie' });
      setCsrfToken(session.csrfToken);
      // No usar client.clear(): dejaría a quien observa ['me'] enganchado a una consulta borrada.
      forgetOtherQueries();
      client.setQueryData(['me'], session);
    },
    async logout() {
      await post('/auth/logout').catch(() => undefined);
      setCsrfToken(null);
      forgetOtherQueries();
      client.setQueryData(['me'], null);
    },
    can: (permission) => me.data?.permissions.includes(permission) ?? false,
    refresh: () => me.refetch(),
  };
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside AuthProvider');
  return value;
}
