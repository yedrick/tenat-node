import type { Domain, DomainName, TenantId } from '../domain/index.js';

export interface NewDomain {
  domain: DomainName;
  tenantId: TenantId;
  isPrimary: boolean;
  now: Date;
}

export interface DomainReader {
  findByName(domain: DomainName): Promise<Domain | undefined>;
  /** Dominios del tenant; el principal primero y luego por antigüedad. */
  listByTenant(tenantId: TenantId): Promise<Domain[]>;
}

export interface DomainWriter {
  /** Crea el dominio y le asigna un `id`. Lanza `DomainAlreadyTakenError` si el nombre ya existe. */
  create(input: NewDomain): Promise<Domain>;
  /** Marca `domain` como principal y desmarca los demás del mismo tenant (atómico). */
  setPrimary(tenantId: TenantId, domain: DomainName, now: Date): Promise<void>;
  delete(domain: DomainName): Promise<void>;
  deleteByTenant(tenantId: TenantId): Promise<void>;
}

export interface DomainRepository extends DomainReader, DomainWriter {}
