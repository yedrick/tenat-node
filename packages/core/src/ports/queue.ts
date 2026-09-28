export interface JobBackoff {
  type: 'fixed' | 'exponential';
  /** Espera base en ms. */
  delayMs: number;
}

export interface JobOptions {
  /** Intentos en total (1 = sin reintentos). */
  attempts?: number;
  backoff?: JobBackoff;
  /** Esperar antes del primer intento. */
  delayMs?: number;
}

export interface NewJob {
  name: string;
  /** `null` = trabajo del contexto central. */
  tenantId: string | null;
  data: unknown;
  options: JobOptions;
}

export interface QueuedJob {
  readonly id: string;
  readonly name: string;
  readonly tenantId: string | null;
  readonly data: unknown;
  /** Intento actual, empezando en 1. */
  readonly attempt: number;
  readonly maxAttempts: number;
}

export type JobProcessor = (job: QueuedJob) => Promise<void>;

export interface QueueWorker {
  close(): Promise<void>;
}

/**
 * Cola de trabajos (memoria, BullMQ...). El driver se encarga de persistir,
 * reintentar con espera y repartir entre workers.
 */
export interface QueueDriver {
  readonly name: string;
  enqueue(job: NewJob): Promise<string>;
  /** Empieza a procesar. Si `processor` lanza, el driver reintenta según las opciones del trabajo. */
  process(processor: JobProcessor, options: { concurrency: number }): Promise<QueueWorker>;
  ping?(): Promise<void>;
  close(): Promise<void>;
}
