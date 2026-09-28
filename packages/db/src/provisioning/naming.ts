import { createHash, randomBytes } from 'node:crypto';
import { InvalidDatabaseConfigError } from '../errors.js';

const IDENTIFIER = /^[a-z0-9_]+$/;

export interface NamingOptions {
  /** Prefijo de las bases de los tenants ('tenant_'). */
  prefix: string;
  suffix: string;
  /** Prefijo de las tablas del paquete ('tenancy_'). */
  tablePrefix: string;
}

/** 'bolivar' → 'tenant_bolivar'. Los guiones pasan a guion bajo. */
export function databaseNameFor(
  tenantId: string,
  options: NamingOptions,
  maxLength: number,
): string {
  const name = `${options.prefix}${tenantId.replace(/-/g, '_')}${options.suffix}`;
  if (!IDENTIFIER.test(name)) {
    throw new InvalidDatabaseConfigError(
      `Database name "${name}" must use only a-z, 0-9 and "_" (check prefix/suffix)`,
    );
  }
  if (name.length > maxLength) {
    throw new InvalidDatabaseConfigError(
      `Database name "${name}" is longer than ${maxLength} characters`,
    );
  }
  return name;
}

/** Usuario de base del tenant; si no cabe en el límite del motor, se recorta y se agrega un hash. */
export function usernameFor(tenantId: string, prefix: string, maxLength: number): string {
  const full = `${prefix}${tenantId.replace(/-/g, '_')}`;
  if (full.length <= maxLength) return full;
  const hash = createHash('sha256').update(tenantId).digest('hex').slice(0, 8);
  return `${full.slice(0, maxLength - 9)}_${hash}`;
}

/**
 * Contraseña aleatoria de 32 caracteres (base64url: segura dentro de un literal SQL), con al menos
 * una mayúscula, una minúscula y un dígito (la política de contraseñas de SQL Server lo exige).
 */
export function generatePassword(): string {
  for (;;) {
    const candidate = randomBytes(24).toString('base64url');
    if (/[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && /\d/.test(candidate)) return candidate;
  }
}

export function assertSafeIdentifier(value: string): string {
  if (!IDENTIFIER.test(value))
    throw new InvalidDatabaseConfigError(`Unsafe SQL identifier "${value}"`);
  return value;
}

export function assertSafePassword(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new InvalidDatabaseConfigError('Unsafe generated password');
  return value;
}
