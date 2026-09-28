import type { Tenant } from '../domain/index.js';

/** Crea y elimina bases de datos (o schemas) en un motor concreto. Se implementa en los drivers. */
export interface DatabaseManager {
  readonly driver: string;
  createDatabase(name: string): Promise<void>;
  deleteDatabase(name: string): Promise<void>;
  databaseExists(name: string): Promise<boolean>;
}

/** Entrega la configuración de conexión de un tenant o de la base central. */
export interface ConnectionProvider<TConnectionConfig = unknown> {
  forTenant(tenant: Tenant): TConnectionConfig;
  central(): TConnectionConfig;
}
