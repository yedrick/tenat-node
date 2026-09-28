import type { JobProcessor, NewJob, QueueDriver, QueueWorker } from '@tenancy-node/core';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';

export interface BullmqOptions {
  /** `redis://localhost:6379`. */
  url?: string | undefined;
  redisOptions?: RedisOptions;
  /** Nombre de la cola. Por defecto `tenancy`. */
  queueName?: string | undefined;
  /** Prefijo de las llaves de BullMQ. Por defecto `bull`. */
  prefix?: string | undefined;
  /** Trabajos terminados que se conservan (para inspección). Por defecto 1000. */
  keepCompleted?: number;
  /** Trabajos fallidos que se conservan (dead-letter). Por defecto 5000. */
  keepFailed?: number;
}

interface Payload {
  tenantId: string | null;
  data: unknown;
}

/**
 * Cola sobre BullMQ (Redis/Valkey): trabajos persistentes, reintentos con espera y
 * varios workers en distintos procesos. Cada trabajo lleva el `tenantId`.
 */
export class BullmqQueue implements QueueDriver {
  readonly name = 'bullmq';
  private readonly connection: Redis;
  private readonly queue: Queue<Payload>;
  private readonly queueName: string;
  private readonly workers = new Set<Worker<Payload>>();

  constructor(private readonly options: BullmqOptions = {}) {
    this.queueName = options.queueName ?? 'tenancy';
    this.connection = this.redis();
    this.queue = new Queue<Payload>(this.queueName, {
      connection: this.connection,
      ...(options.prefix ? { prefix: options.prefix } : {}),
    });
  }

  private redis(): Redis {
    // BullMQ exige maxRetriesPerRequest: null en las conexiones de los workers.
    return new Redis(this.options.url ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
      ...this.options.redisOptions,
    });
  }

  async enqueue(job: NewJob): Promise<string> {
    const added = await this.queue.add(
      job.name,
      { tenantId: job.tenantId, data: job.data },
      {
        attempts: Math.max(1, job.options.attempts ?? 1),
        ...(job.options.backoff
          ? { backoff: { type: job.options.backoff.type, delay: job.options.backoff.delayMs } }
          : {}),
        ...(job.options.delayMs ? { delay: job.options.delayMs } : {}),
        removeOnComplete: this.options.keepCompleted ?? 1000,
        removeOnFail: this.options.keepFailed ?? 5000,
      },
    );
    return String(added.id);
  }

  async process(processor: JobProcessor, options: { concurrency: number }): Promise<QueueWorker> {
    const connection = this.redis();
    const worker = new Worker<Payload>(
      this.queueName,
      async (job: Job<Payload>) => {
        await processor({
          id: String(job.id),
          name: job.name,
          tenantId: job.data.tenantId,
          data: job.data.data,
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts ?? 1,
        });
      },
      {
        connection,
        concurrency: options.concurrency,
        ...(this.options.prefix ? { prefix: this.options.prefix } : {}),
      },
    );
    this.workers.add(worker);
    await worker.waitUntilReady();
    return {
      close: async () => {
        this.workers.delete(worker);
        await worker.close();
        await connection.quit().catch(() => connection.disconnect());
      },
    };
  }

  async ping(): Promise<void> {
    await this.connection.ping();
  }

  /** Cantidad de trabajos por estado (para métricas y el panel). */
  counts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  }

  async close(): Promise<void> {
    for (const worker of [...this.workers]) await worker.close();
    await this.queue.close();
    await this.connection.quit().catch(() => this.connection.disconnect());
  }
}

/** `queue: bullmq({ url: process.env.REDIS_URL })` */
export function bullmq(options: BullmqOptions = {}): BullmqQueue {
  return new BullmqQueue(options);
}
