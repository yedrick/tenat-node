import { AsyncLocalStorage } from 'node:async_hooks';
import type { Tenant } from '../domain/index.js';

/** Lo que vive dentro de un contexto: el tenant (o `null` = central) y sus recursos ya creados. */
export interface ContextFrame {
  readonly tenant: Tenant | null;
  readonly resources: Map<string, unknown>;
}

export function createFrame(tenant: Tenant | null): ContextFrame {
  return { tenant, resources: new Map() };
}

/**
 * Contexto por petición basado en `AsyncLocalStorage`. Nunca se usa una variable
 * global para el tenant actual: cada `run` tiene su propio frame.
 */
export class TenancyContext {
  private readonly storage = new AsyncLocalStorage<ContextFrame>();

  run<T>(frame: ContextFrame, fn: () => T): T {
    return this.storage.run(frame, fn);
  }

  frame(): ContextFrame | undefined {
    return this.storage.getStore();
  }

  current(): Tenant | undefined {
    return this.storage.getStore()?.tenant ?? undefined;
  }
}
