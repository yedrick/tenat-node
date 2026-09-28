/**
 * Base de todos los errores del paquete. Cada error tiene un `code` estable
 * (por ejemplo `TENANCY_TENANT_NOT_FOUND`) que se puede usar en lugar del mensaje.
 *
 * Los errores de dominio no incluyen detalles de infraestructura; esos van al log.
 */
export class TenancyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}
