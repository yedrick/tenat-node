import type {
  Clock,
  ErrorTracker,
  IdGenerator,
  Logger,
  OperationSample,
  RequestSample,
  Telemetry,
  TrackedError,
} from '../ports/index.js';
import { errorCode, errorMessage, errorName, errorStack, errorTenantId } from './error-details.js';

export interface ObserverDeps {
  logger: Logger;
  tracker: ErrorTracker;
  ids: IdGenerator;
  clock: Clock;
  currentTenantId: () => string | null;
  telemetry?: readonly Telemetry[];
}

export interface ReportContext {
  /** Tenant afectado; por defecto el del contexto actual. */
  tenantId?: string | null | undefined;
  [key: string]: unknown;
}

/**
 * Punto único de observabilidad del núcleo. Todos los logs usan los mismos campos:
 *
 * | campo        | contenido                                        |
 * |--------------|--------------------------------------------------|
 * | `tenantId`   | id del tenant o `null` (central)                 |
 * | `operation`  | 'tenants.create', 'http.request', ...            |
 * | `outcome`    | 'success' o 'error'                              |
 * | `durationMs` | duración de la operación                          |
 * | `code`       | código estable del error (`TENANCY_*`)           |
 * | `errorId`    | id del error en el `ErrorTracker`                |
 * | `err`        | el error (con stack)                              |
 */
export class Observer {
  private readonly telemetry: readonly Telemetry[];
  private readonly spans: readonly Telemetry[];

  constructor(private readonly deps: ObserverDeps) {
    this.telemetry = deps.telemetry ?? [];
    this.spans = this.telemetry.filter((t) => t.span);
  }

  /** Avisa a cada telemetría. Un fallo de la telemetría nunca rompe la operación. */
  private emit(fn: (t: Telemetry) => void): void {
    for (const t of this.telemetry) {
      try {
        fn(t);
      } catch {
        // Ignorado a propósito: medir no puede tumbar la app.
      }
    }
  }

  private extraFields(): Record<string, unknown> {
    let fields: Record<string, unknown> = {};
    this.emit((t) => {
      const extra = t.logFields?.();
      if (extra) fields = { ...fields, ...extra };
    });
    return fields;
  }

  /** Lo usan los adaptadores al terminar cada petición. */
  recordRequest(sample: RequestSample): void {
    this.emit((t) => t.recordRequest?.(sample));
  }

  tenantResolved(tenantId: string | null): void {
    this.emit((t) => t.tenantResolved?.(tenantId));
  }

  /** Campos de correlación (`traceId`...) para logs escritos fuera del observer. */
  correlation(): Record<string, unknown> {
    return this.telemetry.length === 0 ? {} : this.extraFields();
  }

  get logger(): Logger {
    return this.deps.logger;
  }

  /**
   * Registra un error: lo escribe en el log (nivel `error`, o `warn` si `expected`)
   * y lo guarda en el tracker del tenant. Devuelve el registro.
   */
  reportError(
    operation: string,
    error: unknown,
    context: ReportContext = {},
    expected = false,
  ): TrackedError {
    const { tenantId: explicitTenant, ...rest } = context;
    // Prioridad: el tenant indicado, luego el tenant del que habla el error, luego el del contexto.
    const tenantId =
      explicitTenant ??
      errorTenantId(error) ??
      (explicitTenant === null ? null : this.deps.currentTenantId());
    const tracked: TrackedError = Object.freeze({
      id: this.deps.ids.generate(),
      tenantId,
      operation,
      code: errorCode(error),
      name: errorName(error),
      message: errorMessage(error),
      stack: errorStack(error),
      time: this.deps.clock.now(),
      context: Object.freeze(rest),
    });
    this.deps.tracker.record(tracked);
    this.emit((t) => t.recordError?.(tracked));

    const fields = {
      tenantId,
      operation,
      outcome: 'error',
      code: tracked.code,
      errorId: tracked.id,
      ...this.correlation(),
      ...rest,
      err: error,
    };
    if (expected) this.deps.logger.warn(fields, `${operation} failed: ${tracked.message}`);
    else this.deps.logger.error(fields, `${operation} failed: ${tracked.message}`);
    return tracked;
  }

  /**
   * Ejecuta una operación y la deja registrada: `info` al terminar bien, error al fallar.
   * El error se vuelve a lanzar sin cambios.
   */
  async trace<T>(
    operation: string,
    context: ReportContext,
    fn: () => Promise<T>,
    options: { isExpected?: (error: unknown) => boolean; successLevel?: 'info' | 'debug' } = {},
  ): Promise<T> {
    const { tenantId: explicitTenant, ...rest } = context;
    const tenantId = explicitTenant !== undefined ? explicitTenant : this.deps.currentTenantId();
    const run = async (): Promise<T> => {
      const started = performance.now();
      try {
        const result = await fn();
        const durationMs = round(performance.now() - started);
        this.deps.logger[options.successLevel ?? 'info'](
          { tenantId, operation, outcome: 'success', durationMs, ...this.correlation(), ...rest },
          `${operation} succeeded`,
        );
        this.sample({ operation, tenantId, outcome: 'success', durationMs });
        return result;
      } catch (error) {
        const durationMs = round(performance.now() - started);
        const tracked = this.reportError(
          operation,
          error,
          { ...context, durationMs },
          options.isExpected?.(error) ?? false,
        );
        this.sample({ operation, tenantId, outcome: 'error', durationMs, code: tracked.code });
        throw error;
      }
    };
    if (this.spans.length === 0) return run();
    // Cada telemetría con spans envuelve a la siguiente; la operación corre una sola vez.
    const attributes = spanAttributes(tenantId, operation, rest);
    return this.spans.reduceRight<() => Promise<T>>(
      (next, t) => () => t.span!(operation, attributes, next),
      run,
    )();
  }

  private sample(sample: OperationSample): void {
    this.emit((t) => t.recordOperation?.(sample));
  }
}

function spanAttributes(
  tenantId: string | null,
  operation: string,
  context: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {
    'tenancy.operation': operation,
    ...(tenantId ? { 'tenant.id': tenantId } : {}),
  };
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      attributes[`tenancy.${key}`] = value;
  }
  return attributes;
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
