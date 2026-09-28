import type { OperationSample, RequestSample, Telemetry, TrackedError } from '@tenancy-node/core';
import {
  SpanKind,
  SpanStatusCode,
  metrics,
  trace,
  type Attributes,
  type Meter,
  type Tracer,
} from '@opentelemetry/api';

export interface OpenTelemetryOptions {
  /** Por defecto `trace.getTracer('tenancy-node')` (el proveedor global que registraste). */
  tracer?: Tracer;
  /** Por defecto `metrics.getMeter('tenancy-node')`. `false` desactiva las métricas. */
  meter?: Meter | false;
  /**
   * Agrega `tenant.id` a las métricas. Cada tenant crea series nuevas: actívalo solo si
   * tienes pocos tenants o tu backend lo soporta. Por defecto `false` (sí va en las trazas).
   */
  tenantMetrics?: boolean;
  /** Agrega `traceId`/`spanId` a los logs del observer para saltar del log a la traza. Por defecto `true`. */
  correlateLogs?: boolean;
}

const statusClass = (code: number) => `${Math.floor(code / 100)}xx`;

/**
 * Trazas y métricas con OpenTelemetry. Solo usa `@opentelemetry/api`: el SDK y el exportador
 * (OTLP, Jaeger...) los configuras tú al arrancar, como en cualquier app.
 *
 * - Un span por operación (`tenants.create`, `provisioning.step`, `outbox.relay`...) con `tenant.id`.
 * - `tenant.id` también en el span HTTP activo (el de `@opentelemetry/instrumentation-http`).
 * - Histogramas `tenancy.operation.duration` y `tenancy.http.server.duration`, contador `tenancy.errors`.
 */
export function openTelemetry(options: OpenTelemetryOptions = {}): Telemetry {
  const tracer = options.tracer ?? trace.getTracer('tenancy-node');
  const meter = options.meter === false ? undefined : (options.meter ?? metrics.getMeter('tenancy-node'));
  const withTenant = options.tenantMetrics ?? false;
  const operations = meter?.createHistogram('tenancy.operation.duration', {
    unit: 'ms',
    description: 'Duration of tenancy operations',
  });
  const requests = meter?.createHistogram('tenancy.http.server.duration', {
    unit: 'ms',
    description: 'Duration of HTTP requests handled with a tenant context',
  });
  const errors = meter?.createCounter('tenancy.errors', { description: 'Errors by operation and code' });
  const tenantAttr = (tenantId: string | null): Attributes =>
    withTenant ? { 'tenant.id': tenantId ?? 'central' } : {};

  return {
    name: 'opentelemetry',
    span(operation, attributes, fn) {
      return tracer.startActiveSpan(operation, { kind: SpanKind.INTERNAL, attributes }, async (span) => {
        try {
          return await fn();
        } catch (error) {
          span.recordException(error instanceof Error ? error : String(error));
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          const code = (error as { code?: unknown } | null)?.code;
          if (typeof code === 'string') span.setAttribute('tenancy.error_code', code);
          throw error;
        } finally {
          span.end();
        }
      });
    },
    tenantResolved(tenantId) {
      trace.getActiveSpan()?.setAttribute('tenant.id', tenantId ?? 'central');
    },
    recordOperation(sample: OperationSample) {
      operations?.record(sample.durationMs, {
        'tenancy.operation': sample.operation,
        'tenancy.outcome': sample.outcome,
        ...tenantAttr(sample.tenantId),
      });
    },
    recordRequest(sample: RequestSample) {
      requests?.record(sample.durationMs, {
        'http.request.method': sample.method,
        'http.response.status_code': sample.statusCode,
        'http.route': sample.route ?? '',
        'tenancy.status_class': statusClass(sample.statusCode),
        ...tenantAttr(sample.tenantId),
      });
    },
    recordError(error: TrackedError) {
      errors?.add(1, { 'tenancy.operation': error.operation, 'tenancy.error_code': error.code, ...tenantAttr(error.tenantId) });
      // El id del error permite buscarlo en el admin (`/errors`) desde la traza.
      trace.getActiveSpan()?.addEvent('tenancy.error', {
        'tenancy.error_id': error.id,
        'tenancy.error_code': error.code,
        'tenant.id': error.tenantId ?? 'central',
      });
    },
    logFields() {
      if (options.correlateLogs === false) return undefined;
      const span = trace.getActiveSpan()?.spanContext();
      return span && trace.isSpanContextValid(span) ? { traceId: span.traceId, spanId: span.spanId } : undefined;
    },
  };
}
