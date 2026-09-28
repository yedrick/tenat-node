import type { Kysely } from 'kysely';
import type { ConnectionOptions } from '../connection.js';
import type { AnyDB, AnyKysely } from '../kysely-any.js';

export type DialectKind = 'mysql' | 'postgres' | 'sqlite' | 'mssql';

export interface PoolOptions {
  max: number;
  /** Errores de conexiones inactivas (sin manejador, un pool de `pg` tumba el proceso). */
  onError?: (error: Error) => void;
  /** Modo schema con credenciales propias: `search_path` de cada conexión. */
  schema?: string;
}

/** Una conexión abierta: la instancia Kysely y el pool nativo que usa. */
export interface OpenedConnection {
  readonly db: Kysely<AnyDB>;
  /** Pool nativo (mysql2 `Pool` o pg `Pool`) para quien necesite control total. */
  readonly native: unknown;
  destroy(): Promise<void>;
}

/**
 * Driver de un motor (Strategy). Todo lo que depende del motor pasa por aquí:
 * crear y borrar bases y usuarios, candados y detección de errores.
 * Los identificadores que recibe ya vienen validados por el paquete.
 */
export interface DatabaseDriver {
  readonly name: 'mysql' | 'mariadb' | 'postgres' | 'sqlite' | 'mssql';
  readonly kind: DialectKind;
  readonly defaultPort: number;
  /** Largo máximo de un nombre de base (64 en MySQL, 63 en PostgreSQL). */
  readonly maxIdentifierLength: number;
  /** Largo máximo de un usuario (32 en MySQL, 63 en PostgreSQL). */
  readonly maxUserLength: number;
  /** Base a la que se conecta el usuario administrador (PostgreSQL necesita una). */
  readonly adminDatabase: string | undefined;

  /**
   * Abre un pool. `onError` recibe los errores de conexiones inactivas (por ejemplo, si la base
   * se reinicia): sin ese manejador, un pool de `pg` tumba el proceso.
   */
  connect(options: ConnectionOptions, pool: PoolOptions): OpenedConnection;

  /** El motor admite aislar tenants por schema dentro de una base (PostgreSQL). */
  readonly supportsSchemas: boolean;
  /**
   * Instancia Kysely sobre un pool existente que fija el `search_path` del schema en cada
   * conexión que toma. No abre conexiones propias: cerrarla no cierra el pool.
   */
  scope?(base: OpenedConnection, schema: string): OpenedConnection;
  schemaExists?(admin: AnyKysely, schema: string): Promise<boolean>;
  /** Idempotente. */
  createSchema?(admin: AnyKysely, schema: string): Promise<void>;
  /** Idempotente; borra también las tablas del schema. */
  dropSchema?(admin: AnyKysely, schema: string): Promise<void>;
  /** Crea (o actualiza) un rol con login, sin darle ninguna base. */
  createRole?(admin: AnyKysely, username: string, password: string): Promise<void>;
  /** Da al usuario del tenant acceso solo a su schema dentro de `database`. */
  grantSchema?(admin: AnyKysely, username: string, schema: string, database: string): Promise<void>;

  databaseExists(admin: AnyKysely, name: string): Promise<boolean>;
  /** Idempotente: si ya existe no hace nada. */
  createDatabase(admin: AnyKysely, name: string): Promise<void>;
  /** Idempotente. */
  dropDatabase(admin: AnyKysely, name: string): Promise<void>;
  /** Crea el usuario (si no existe) y le da acceso solo a `database`. */
  createUser(admin: AnyKysely, username: string, password: string, database: string): Promise<void>;
  dropUser(admin: AnyKysely, username: string): Promise<void>;

  /** Ejecuta `fn` con un candado exclusivo entre procesos (GET_LOCK / pg_advisory_lock). */
  withLock<T>(db: AnyKysely, key: string, timeoutMs: number, fn: () => Promise<T>): Promise<T>;

  isUniqueViolation(error: unknown): boolean;
  /** Errores que se resuelven reintentando la transacción (deadlock, espera de lock, serialización). */
  isTransientError(error: unknown): boolean;
}
