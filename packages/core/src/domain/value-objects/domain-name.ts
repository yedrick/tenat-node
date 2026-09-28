import { InvalidDomainError } from '../errors/errors.js';

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Nombre de dominio normalizado ('bolivar.tuapp.com').
 * Se guarda en minúsculas y sin punto final.
 */
export class DomainName {
  private constructor(readonly value: string) {}

  static create(value: string): DomainName {
    const normalized = DomainName.normalize(value);
    if (!DomainName.isValidNormalized(normalized)) throw new InvalidDomainError(value);
    return new DomainName(normalized);
  }

  static tryCreate(value: string | null | undefined): DomainName | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = DomainName.normalize(value);
    return DomainName.isValidNormalized(normalized) ? new DomainName(normalized) : undefined;
  }

  private static normalize(value: string): string {
    const trimmed = value.trim().toLowerCase();
    return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  }

  private static isValidNormalized(value: string): boolean {
    if (value.length === 0 || value.length > 253) return false;
    return value.split('.').every((label) => LABEL_PATTERN.test(label));
  }

  /** Primer label del dominio: 'bolivar' en 'bolivar.tuapp.com'. */
  get firstLabel(): string {
    return this.value.split('.', 1)[0] ?? this.value;
  }

  /** `true` si este dominio es exactamente `base` o un subdominio de `base`. */
  isWithin(base: DomainName): boolean {
    return this.value === base.value || this.value.endsWith(`.${base.value}`);
  }

  equals(other: DomainName): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}
