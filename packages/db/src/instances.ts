import type { Logger } from '@tenancy-node/core';

export interface TenantInstancesOptions<T> {
  /** Nombre para los logs ('knex', 'prisma'...). */
  name: string;
  /** Instancias vivas como máximo. */
  max: number;
  destroy(instance: T): Promise<void>;
  /** Espera antes de cerrar una instancia descartada, para no cortar consultas en curso. Por defecto 30 s. */
  graceMs?: number;
  logger: Logger;
}

/**
 * Una instancia por conexión de tenant (cliente de ORM), con carga perezosa y LRU.
 * Las instancias descartadas se cierran después de un tiempo de gracia.
 */
export class TenantInstances<T> {
  private readonly instances = new Map<string, T>();
  /** Instancias descartadas que esperan su tiempo de gracia para cerrarse. */
  private readonly retiring = new Map<NodeJS.Timeout, [string, T]>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: TenantInstancesOptions<T>) {}

  get size(): number {
    return this.instances.size;
  }

  /** Instancia de `key`; si no existe, la crea con `create`. */
  get(key: string, create: () => T): T {
    const existing = this.instances.get(key);
    if (existing !== undefined) {
      this.instances.delete(key);
      this.instances.set(key, existing);
      return existing;
    }
    const created = create();
    this.instances.set(key, created);
    this.options.logger.debug(
      { operation: `${this.options.name}.open`, instance: key },
      `Opened ${this.options.name} instance`,
    );
    while (this.instances.size > this.options.max) {
      const [oldestKey, oldest] = this.instances.entries().next().value as [string, T];
      this.instances.delete(oldestKey);
      this.retire(oldestKey, oldest, 'evicted');
    }
    return created;
  }

  /**
   * Cierra las instancias cuya llave cumple la condición. Por defecto en el acto (al borrar un
   * tenant su base ya no existe); con `graceful`, tras el tiempo de gracia (al mover un tenant,
   * la base de origen sigue viva y puede haber consultas en curso).
   */
  evictWhere(predicate: (key: string) => boolean, options: { graceful?: boolean } = {}): void {
    for (const [key, instance] of [...this.instances]) {
      if (!predicate(key)) continue;
      this.instances.delete(key);
      this.retire(key, instance, 'invalidated', options.graceful ? undefined : 0);
    }
  }

  async closeAll(): Promise<void> {
    // También se cierran las que estaban esperando su tiempo de gracia.
    const all = [...this.instances, ...this.retiring.values()];
    for (const timer of this.retiring.keys()) clearTimeout(timer);
    this.retiring.clear();
    this.instances.clear();
    await Promise.all([
      ...this.pending,
      ...all.map(([key, i]) => this.destroy(key, i, 'shutdown')),
    ]);
  }

  private retire(
    key: string,
    instance: T,
    reason: string,
    delay = this.options.graceMs ?? 30_000,
  ): void {
    if (delay <= 0) {
      void this.destroy(key, instance, reason);
      return;
    }
    const timer = setTimeout(() => {
      this.retiring.delete(timer);
      void this.destroy(key, instance, reason);
    }, delay);
    timer.unref();
    this.retiring.set(timer, [key, instance]);
  }

  private destroy(key: string, instance: T, reason: string): Promise<void> {
    const task = this.options
      .destroy(instance)
      .then(() =>
        this.options.logger.debug(
          { operation: `${this.options.name}.close`, instance: key, reason },
          `Closed ${this.options.name} instance`,
        ),
      )
      .catch((error: unknown) =>
        this.options.logger.error(
          { operation: `${this.options.name}.close`, outcome: 'error', instance: key, err: error },
          `Failed to close ${this.options.name} instance`,
        ),
      );
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return task;
  }
}
