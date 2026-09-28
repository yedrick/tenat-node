import type { TrackedError } from './error-tracker.js';

/** Una operación terminada (`tenants.create`, `provisioning.step`, `outbox.relay`...). */
export interface OperationSample {
  readonly operation: string;
  readonly tenantId: string | null;
  readonly outcome: 'success' | 'error';
  readonly durationMs: number;
  /** Código estable del error (`TENANCY_*`) si falló. */
  readonly code?: string;
}

/** Una petición HTTP terminada, informada por los adaptadores. */
export interface RequestSample {
  readonly tenantId: string | null;
  readonly method: string;
  /** Plantilla de la ruta (`/pedidos/:id`), nunca la ruta real: evita miles de series. */
  readonly route: string | undefined;
  readonly statusCode: number;
  readonly durationMs: number;
}

export type SpanAttributes = Record<string, string | number | boolean>;

/**
 * Enchufe para trazas y métricas (OpenTelemetry, Prometheus...). Todo es opcional:
 * cada implementación usa lo que le sirve. Nunca debe lanzar; si lo hace, se ignora.
 */
export interface Telemetry {
  readonly name: string;
  /** Envuelve una operación en un span activo (las operaciones internas quedan como hijas). */
  span?<T>(operation: string, attributes: SpanAttributes, fn: () => Promise<T>): Promise<T>;
  /** Se identificó el tenant de la petición en curso. */
  tenantResolved?(tenantId: string | null): void;
  recordOperation?(sample: OperationSample): void;
  recordRequest?(sample: RequestSample): void;
  recordError?(error: TrackedError): void;
  /** Campos que se agregan a los logs del observer (por ejemplo `traceId` y `spanId`). */
  logFields?(): Record<string, unknown> | undefined;
}
