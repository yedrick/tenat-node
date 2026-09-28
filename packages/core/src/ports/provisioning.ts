import type { Tenant } from '../domain/index.js';

/** Crea y destruye los recursos físicos de un tenant (base, usuario, migraciones...). */
export interface ProvisioningPipeline {
  provision(tenant: Tenant): Promise<void>;
  deprovision(tenant: Tenant): Promise<void>;
}
