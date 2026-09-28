import type { Kysely } from 'kysely';
import type { DatabaseDriver, DialectKind } from '../drivers/driver.js';
import type { CentralTables } from '../schema/central-tables.js';

/** Base central con prefijo aplicado y lo necesario para escribir SQL portable. */
export interface CentralDb {
  readonly db: Kysely<CentralTables>;
  readonly kind: DialectKind;
  readonly driver: DatabaseDriver;
}

export function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

export function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

export function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

export function toDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

/** Escapa `%`, `_` y `\` para usar un texto dentro de LIKE. */
export function likeContains(value: string): string {
  return `%${value.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
