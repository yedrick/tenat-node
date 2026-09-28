import { InvalidColorError } from '../errors/errors.js';

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Color hexadecimal ('#E4002B'). Validar aquí evita que un tema
 * inyecte CSS arbitrario en `theme.css`.
 */
export class HexColor {
  private constructor(readonly value: string) {}

  static create(value: string): HexColor {
    if (typeof value !== 'string' || !HEX_PATTERN.test(value.trim()))
      throw new InvalidColorError(String(value));
    return new HexColor(value.trim().toUpperCase());
  }

  equals(other: HexColor): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}
