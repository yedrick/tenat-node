import { TenancyError } from '../domain/index.js';

/** Código estable de un error: el `code` del paquete o el nombre de la clase. */
export function errorCode(error: unknown): string {
  if (error instanceof TenancyError) return error.code;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : error.name;
  }
  return 'UNKNOWN_ERROR';
}

/** Tenant al que se refiere un error del paquete (por ejemplo, el tenant suspendido). */
export function errorTenantId(error: unknown): string | undefined {
  if (!(error instanceof TenancyError)) return undefined;
  const id = error.details.tenantId;
  return typeof id === 'string' ? id : undefined;
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}
