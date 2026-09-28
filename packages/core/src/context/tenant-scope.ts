import { AsyncResource } from 'node:async_hooks';
import type { Tenant } from '../domain/index.js';
import type { BootstrapperRegistry } from './bootstrapper-registry.js';
import { createFrame, type ContextFrame, type TenancyContext } from './tenancy-context.js';

/**
 * Un contexto abierto para un tenant (o el central) que se puede atravesar varias veces
 * y se cierra una sola vez. Lo usan los adaptadores HTTP para cubrir todo el ciclo de una petición.
 */
export class TenantScope {
  readonly frame: ContextFrame;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly context: TenancyContext,
    private readonly registry: BootstrapperRegistry,
    tenant: Tenant | null,
    private readonly onClose: (scope: TenantScope) => Promise<void> = async () => {},
  ) {
    this.frame = createFrame(tenant);
  }

  get tenant(): Tenant | null {
    return this.frame.tenant;
  }

  get closed(): boolean {
    return this.closing !== undefined;
  }

  run<T>(fn: () => T): T {
    return this.context.run(this.frame, fn);
  }

  /**
   * Crea un `AsyncResource` ligado a este contexto. Sirve para restaurarlo en callbacks que
   * pierden el contexto (por ejemplo, después de leer el body de la petición).
   */
  bind(): AsyncResource {
    return this.run(() => new AsyncResource('tenancy.scope'));
  }

  /** Libera los recursos del contexto. Es idempotente. */
  close(): Promise<void> {
    this.closing ??= this.registry.revert(this.frame).then(() => this.onClose(this));
    return this.closing;
  }
}
