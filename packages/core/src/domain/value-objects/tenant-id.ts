import { InvalidTenantIdError } from '../errors/errors.js';

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,39}$/;

/**
 * Identificador de un tenant ('bolivar', 'tigre').
 *
 * Se valida con lista blanca porque termina en nombres de base de datos,
 * subdominios y prefijos de caché: si el objeto existe, es seguro usarlo.
 */
export class TenantId {
  private constructor(readonly value: string) {}

  static create(value: string): TenantId {
    if (!TenantId.isValid(value)) throw new InvalidTenantIdError(value);
    return new TenantId(value);
  }

  /** Como `create`, pero devuelve `undefined` en lugar de lanzar. */
  static tryCreate(value: string | null | undefined): TenantId | undefined {
    return typeof value === 'string' && TenantId.isValid(value) ? new TenantId(value) : undefined;
  }

  static isValid(value: string): boolean {
    return TENANT_ID_PATTERN.test(value);
  }

  equals(other: TenantId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}
