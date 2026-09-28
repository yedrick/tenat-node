import { InvalidDatabaseConfigError } from './errors.js';

export interface ConnectionOptions {
  host: string;
  port: number;
  user: string;
  password?: string | undefined;
  database?: string | undefined;
  /** Opciones SSL del driver nativo (mysql2 / pg). */
  ssl?: unknown;
  /** Modo schema (PostgreSQL): schema del tenant dentro de `database`. */
  schema?: string | undefined;
}

export interface Credentials {
  user: string;
  password?: string | undefined;
}

/** 'mysql://user:pass@host:3306/db' → opciones de conexión. */
export function parseConnectionUrl(url: string, defaultPort: number): ConnectionOptions {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidDatabaseConfigError('Invalid database URL');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : defaultPort,
    user: decodeURIComponent(parsed.username),
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database: database || undefined,
  };
}
