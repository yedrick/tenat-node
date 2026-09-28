import type { ProvisioningPipeline } from '../../ports/index.js';

/** Aprovisionamiento vacío: el tenant queda activo al crearse. Los drivers de base lo reemplazan. */
export class NoopProvisioning implements ProvisioningPipeline {
  async provision(): Promise<void> {}
  async deprovision(): Promise<void> {}
}
