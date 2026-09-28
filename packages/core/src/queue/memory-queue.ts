import type {
  JobOptions,
  JobProcessor,
  NewJob,
  QueueDriver,
  QueueWorker,
  QueuedJob,
} from '../ports/index.js';

interface Pending {
  id: string;
  job: NewJob;
  attempt: number;
  runAt: number;
}

export function backoffDelay(options: JobOptions, attempt: number): number {
  const backoff = options.backoff;
  if (!backoff) return 0;
  return backoff.type === 'exponential' ? backoff.delayMs * 2 ** (attempt - 1) : backoff.delayMs;
}

/**
 * Cola en memoria del proceso. Útil en desarrollo y tests: se pierde al reiniciar.
 * En producción usa `@tenancy-node/queue-bullmq`.
 */
export class MemoryQueue implements QueueDriver {
  readonly name = 'memory';
  private readonly pending: Pending[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private processor: JobProcessor | undefined;
  private concurrency = 1;
  private running = 0;
  private nextId = 1;
  private idleWaiters: (() => void)[] = [];
  /** Trabajos en curso: `close()` del worker espera a que terminen. */
  private readonly inFlight = new Set<Promise<void>>();

  async enqueue(job: NewJob): Promise<string> {
    const id = String(this.nextId++);
    // Se copia el dato como lo haría una cola real (serialización).
    const copy: NewJob = {
      ...job,
      data: job.data === undefined ? undefined : JSON.parse(JSON.stringify(job.data)),
    };
    this.schedule({ id, job: copy, attempt: 1, runAt: Date.now() + (job.options.delayMs ?? 0) });
    return id;
  }

  async process(processor: JobProcessor, options: { concurrency: number }): Promise<QueueWorker> {
    this.processor = processor;
    this.concurrency = Math.max(1, options.concurrency);
    this.pump();
    return {
      // Deja de tomar trabajos y espera a los que están en curso (cierre ordenado del worker).
      close: async () => {
        this.processor = undefined;
        await Promise.all(this.inFlight);
      },
    };
  }

  /** Espera a que no queden trabajos pendientes ni en curso (tests). */
  drain(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  get size(): number {
    return this.pending.length + this.running + this.timers.size;
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.processor = undefined;
    await Promise.all(this.inFlight);
  }

  private schedule(item: Pending): void {
    const wait = item.runAt - Date.now();
    if (wait <= 0) {
      this.pending.push(item);
      this.pump();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.pending.push(item);
      this.pump();
    }, wait);
    this.timers.add(timer);
  }

  private pump(): void {
    while (this.processor && this.running < this.concurrency && this.pending.length > 0) {
      const item = this.pending.shift()!;
      this.running++;
      const maxAttempts = Math.max(1, item.job.options.attempts ?? 1);
      const job: QueuedJob = {
        id: item.id,
        name: item.job.name,
        tenantId: item.job.tenantId,
        data: item.job.data,
        attempt: item.attempt,
        maxAttempts,
      };
      const processor = this.processor;
      const done = new Promise<void>((resolve) => {
        setImmediate(() => {
          processor(job)
            .catch(() => {
              if (item.attempt < maxAttempts) {
                this.schedule({
                  ...item,
                  attempt: item.attempt + 1,
                  runAt: Date.now() + backoffDelay(item.job.options, item.attempt),
                });
              }
            })
            .finally(() => {
              this.running--;
              this.inFlight.delete(done);
              resolve();
              this.pump();
              if (this.isIdle()) for (const waiter of this.idleWaiters.splice(0)) waiter();
            });
        });
      });
      this.inFlight.add(done);
    }
  }

  private isIdle(): boolean {
    return this.pending.length === 0 && this.running === 0 && this.timers.size === 0;
  }
}
