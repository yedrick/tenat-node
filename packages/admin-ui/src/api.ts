/** Error de la Admin API con su código estable (ADMIN_*, TENANCY_*). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = '/admin/api';
let csrfToken: string | null = null;
const unauthorizedListeners = new Set<() => void>();

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Se llama cuando la API responde 401 (sesión vencida): la app vuelve al login. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  // Toda petición que cambia algo lleva el token CSRF de la sesión.
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const response = await fetch(BASE + path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => undefined)) as
    { error?: { code: string; message: string; details?: unknown } } | undefined;
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login')
      for (const listener of unauthorizedListeners) listener();
    const error = data?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'HTTP_ERROR',
      error?.message ?? response.statusText,
      error?.details,
    );
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body);
export const del = <T>(path: string, body?: unknown) => api<T>('DELETE', path, body);

export interface ProgressEvent {
  event: 'step' | 'status' | 'done';
  data: {
    step?: string;
    status: string;
    durationMs?: number | null;
    error?: string | null;
    attempt?: number;
  };
}

/** Sigue el progreso de un tenant (SSE). Devuelve la función para cortar. */
export function followProgress(
  tenantId: string,
  onEvent: (event: ProgressEvent) => void,
): () => void {
  const source = new EventSource(`${BASE}/tenants/${encodeURIComponent(tenantId)}/progress`, {
    withCredentials: true,
  });
  for (const name of ['step', 'status', 'done'] as const) {
    source.addEventListener(name, (e) => {
      onEvent({
        event: name,
        data: JSON.parse((e as MessageEvent<string>).data) as ProgressEvent['data'],
      });
      if (name === 'done') source.close();
    });
  }
  source.onerror = () => source.close();
  return () => source.close();
}
