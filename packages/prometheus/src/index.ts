import type { OperationSample, RequestSample, Telemetry, TrackedError } from '@tenancy-node/core';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface PrometheusOptions {
  /** Registro de prom-client. Por defecto uno nuevo (no el global). */
  registry?: Registry;
  /** Prefijo de las métricas. Por defecto `tenancy_`. */
  prefix?: string;
  /**
   * Etiqueta `tenant` en las métricas. Cada tenant multiplica las series: con miles de
   * tenants eso tumba a Prometheus. Por defecto `false`.
   * - `true`: hasta `maxTenants` (por defecto 100) tenants; los demás van como `other`.
   * - una lista o función: solo esos tenants (por ejemplo tus clientes grandes).
   */
  perTenant?: boolean | { allow?: readonly string[] | ((tenantId: string) => boolean); maxTenants?: number };
  /** Métricas del proceso (CPU, memoria, event loop). Por defecto `false`. */
  defaultMetrics?: boolean;
  /** Límites de los histogramas en segundos. */
  buckets?: number[];
}

export interface PrometheusTelemetry extends Telemetry {
  readonly registry: Registry;
  /** Texto para `GET /metrics`. */
  metrics(): Promise<string>;
  readonly contentType: string;
}

const statusClass = (code: number) => `${Math.floor(code / 100)}xx`;

/**
 * Métricas para Prometheus: operaciones, peticiones HTTP y errores por código.
 *
 * ```ts
 * const metrics = prometheus();
 * createTenancy({ telemetry: metrics });
 * app.get('/metrics', async (_, res) => res.type(metrics.contentType).send(await metrics.metrics()));
 * ```
 */
export function prometheus(options: PrometheusOptions = {}): PrometheusTelemetry {
  const registry = options.registry ?? new Registry();
  const prefix = options.prefix ?? 'tenancy_';
  const buckets = options.buckets ?? [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
  if (options.defaultMetrics) collectDefaultMetrics({ register: registry, prefix });

  const perTenant = options.perTenant ?? false;
  const tenantLabels = perTenant ? ['tenant'] : [];
  const allow = typeof perTenant === 'object' ? perTenant.allow : undefined;
  const maxTenants = typeof perTenant === 'object' ? (perTenant.maxTenants ?? 100) : 100;
  const seen = new Set<string>();
  const tenantLabel = (tenantId: string | null): Record<string, string> => {
    if (!perTenant) return {};
    if (tenantId === null) return { tenant: 'central' };
    const allowed = allow === undefined ? true : typeof allow === 'function' ? allow(tenantId) : allow.includes(tenantId);
    if (!allowed) return { tenant: 'other' };
    if (!seen.has(tenantId)) {
      if (allow === undefined && seen.size >= maxTenants) return { tenant: 'other' };
      seen.add(tenantId);
    }
    return { tenant: tenantId };
  };

  const operations = new Histogram({
    name: `${prefix}operation_duration_seconds`,
    help: 'Duration of tenancy operations (tenants.create, provisioning.step, outbox.relay...)',
    labelNames: ['operation', 'outcome', ...tenantLabels],
    buckets,
    registers: [registry],
  });
  const requests = new Histogram({
    name: `${prefix}http_request_duration_seconds`,
    help: 'Duration of HTTP requests handled with a tenant context',
    labelNames: ['method', 'route', 'status_class', ...tenantLabels],
    buckets,
    registers: [registry],
  });
  const errors = new Counter({
    name: `${prefix}errors_total`,
    help: 'Errors by operation and stable code (TENANCY_*); details in the logs by errorId',
    labelNames: ['operation', 'code', ...tenantLabels],
    registers: [registry],
  });

  return {
    name: 'prometheus',
    registry,
    contentType: registry.contentType,
    metrics: () => registry.metrics(),
    recordOperation(sample: OperationSample) {
      operations.observe(
        { operation: sample.operation, outcome: sample.outcome, ...tenantLabel(sample.tenantId) },
        sample.durationMs / 1000,
      );
    },
    recordRequest(sample: RequestSample) {
      requests.observe(
        {
          method: sample.method,
          // Sin plantilla no se usa la ruta real: cada id sería una serie nueva.
          route: sample.route ?? 'unmatched',
          status_class: statusClass(sample.statusCode),
          ...tenantLabel(sample.tenantId),
        },
        sample.durationMs / 1000,
      );
    },
    recordError(error: TrackedError) {
      errors.inc({ operation: error.operation, code: error.code, ...tenantLabel(error.tenantId) });
    },
  };
}
