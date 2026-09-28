import type { InvalidationBus, InvalidationMessage } from '../../ports/index.js';

/**
 * Bus en memoria: conecta varias instancias de `tenancy` dentro de un mismo proceso
 * (tests, workers). Entre procesos usa `redisInvalidation()` de `@tenancy-node/cache-redis`.
 */
export class MemoryInvalidationBus implements InvalidationBus {
  private readonly handlers = new Set<(message: InvalidationMessage) => void>();

  async publish(message: InvalidationMessage): Promise<void> {
    // Asíncrono como un bus real: nadie recibe su propio mensaje en medio de la escritura.
    await Promise.resolve();
    for (const handler of this.handlers) handler(message);
  }

  async subscribe(handler: (message: InvalidationMessage) => void): Promise<void> {
    this.handlers.add(handler);
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}
