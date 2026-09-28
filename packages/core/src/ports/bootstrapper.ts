import type { Tenant } from '../domain/index.js';

/**
 * Entrega un recurso aislado para el tenant del contexto (conexión, caché, disco...).
 * No modifica estado global: el recurso se crea la primera vez que se pide dentro
 * de un contexto y se libera con `revert` al salir de él.
 */
export interface Bootstrapper<TResource = unknown> {
  readonly name: string;
  /** `tenant` es `null` en el contexto central. */
  bootstrap(tenant: Tenant | null): TResource;
  /**
   * Trabajo asíncrono previo, al abrir cada contexto (por ejemplo, cargar los datos del servidor
   * de base de datos). Debe ser rápido: se llama en cada petición.
   */
  prepare?(tenant: Tenant | null): Promise<void>;
  revert?(resource: TResource, tenant: Tenant | null): void | Promise<void>;
}
