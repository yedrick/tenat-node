import { InvalidConfigError, type Tenant } from '../domain/index.js';
import type { Bootstrapper, Logger } from '../ports/index.js';
import type { ContextFrame } from './tenancy-context.js';

/** Crea los recursos de un frame con carga perezosa y los libera al cerrarlo. */
export class BootstrapperRegistry {
  private readonly bootstrappers = new Map<string, Bootstrapper>();

  constructor(
    bootstrappers: readonly Bootstrapper[],
    private readonly logger: Logger,
  ) {
    for (const bootstrapper of bootstrappers) {
      if (this.bootstrappers.has(bootstrapper.name)) {
        throw new InvalidConfigError(`Duplicate bootstrapper "${bootstrapper.name}"`);
      }
      this.bootstrappers.set(bootstrapper.name, bootstrapper);
    }
  }

  has(name: string): boolean {
    return this.bootstrappers.has(name);
  }

  /** Ejecuta los `prepare` de los bootstrappers (antes de abrir un contexto). */
  async prepare(tenant: Tenant | null): Promise<void> {
    for (const bootstrapper of this.bootstrappers.values()) {
      if (bootstrapper.prepare) await bootstrapper.prepare(tenant);
    }
  }

  resource<T>(frame: ContextFrame, name: string): T {
    if (frame.resources.has(name)) return frame.resources.get(name) as T;
    const bootstrapper = this.bootstrappers.get(name);
    if (!bootstrapper)
      throw new InvalidConfigError(`No bootstrapper registered for resource "${name}"`);
    const resource = bootstrapper.bootstrap(frame.tenant);
    frame.resources.set(name, resource);
    return resource as T;
  }

  /** Revierte los recursos creados en el frame, en orden inverso. Nunca lanza. */
  async revert(frame: ContextFrame): Promise<void> {
    const created = [...frame.resources.entries()].reverse();
    frame.resources.clear();
    for (const [name, resource] of created) {
      const bootstrapper = this.bootstrappers.get(name);
      if (!bootstrapper?.revert) continue;
      try {
        await bootstrapper.revert(resource, frame.tenant);
      } catch (error) {
        this.logger.error(
          { err: error, bootstrapper: name, tenantId: frame.tenant?.id.value ?? null },
          'Bootstrapper revert failed',
        );
      }
    }
  }
}
