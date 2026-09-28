import type { Tenant, TenantId, TenantStatus } from '../domain/index.js';

export interface TenantListQuery {
  status?: TenantStatus | readonly TenantStatus[];
  /** Busca por coincidencia parcial en id o nombre (sin distinguir mayúsculas). */
  search?: string;
  /** Página, empezando en 1. */
  page?: number;
  perPage?: number;
  withDeleted?: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

/** Lectura de tenants. Los resultados se ordenan por `createdAt` y luego por `id`. */
export interface TenantReader {
  /** Devuelve el tenant, o `undefined` si no existe o está eliminado (salvo `withDeleted`). */
  findById(id: TenantId, options?: { withDeleted?: boolean }): Promise<Tenant | undefined>;
  /** `true` si el id está ocupado, incluso por un tenant eliminado. */
  exists(id: TenantId): Promise<boolean>;
  list(query?: TenantListQuery): Promise<Page<Tenant>>;
}

export interface TenantWriter {
  /** Inserta un tenant nuevo. Lanza `TenantAlreadyExistsError` si el id ya existe (aunque sea en paralelo). */
  insert(tenant: Tenant): Promise<void>;
  /** Guarda los cambios de un tenant existente. */
  save(tenant: Tenant): Promise<void>;
}

export interface TenantRepository extends TenantReader, TenantWriter {}
