import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { context, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { createTenancy, NoopLogger, type Logger } from '@tenancy-node/core';
import { openTelemetry } from '@tenancy-node/otel';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const spans = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
const tracer = provider.getTracer('test');
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 });
const meterProvider = new MeterProvider({ readers: [reader] });

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});
afterAll(async () => {
  context.disable();
  await meterProvider.shutdown();
});
beforeEach(() => spans.reset());

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger: Logger = new NoopLogger();
  for (const level of ['debug', 'info', 'warn', 'error'] as const)
    (logger as unknown as Record<string, unknown>)[level] = (fields: Record<string, unknown>) => lines.push({ level, ...fields });
  return { logger, lines };
}

async function metricPoints(name: string) {
  await reader.forceFlush();
  const all = metricExporter.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics));
  return all
    .filter((m) => m.descriptor.name === name)
    .flatMap((m) => m.dataPoints as { attributes: Record<string, unknown> }[]);
}

describe('OpenTelemetry', () => {
  it('creates a span per operation with tenant.id, nested under the active span', async () => {
    const { logger, lines } = capture();
    const tenancy = createTenancy({ logger, telemetry: openTelemetry({ tracer, meter: meterProvider.getMeter('t') }) });
    await tracer.startActiveSpan('http GET', async (root) => {
      await tenancy.tenants.create({ id: 'bolivar' });
      root.end();
    });
    const finished = spans.getFinishedSpans();
    const create = finished.find((s) => s.name === 'tenants.create')!;
    const root = finished.find((s) => s.name === 'http GET')!;
    expect(create.attributes['tenant.id']).toBe('bolivar');
    expect(create.attributes['tenancy.operation']).toBe('tenants.create');
    expect(create.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    // El log de la operación trae traceId/spanId para saltar a la traza.
    const log = lines.find((l) => l.operation === 'tenants.create' && l.outcome === 'success')!;
    expect(log.traceId).toBe(create.spanContext().traceId);
    expect(log.spanId).toBe(create.spanContext().spanId);
    await tenancy.close();
  });

  it('marks failed operations, records the exception and counts errors by code', async () => {
    const { logger, lines } = capture();
    const tenancy = createTenancy({ logger, telemetry: openTelemetry({ tracer, meter: meterProvider.getMeter('t2'), tenantMetrics: true }) });
    await tenancy.tenants.create({ id: 'bolivar' });
    await expect(tenancy.tenants.create({ id: 'bolivar' })).rejects.toThrow();
    const failed = spans.getFinishedSpans().filter((s) => s.name === 'tenants.create')[1]!;
    expect(failed.status.code).toBe(2);
    expect(failed.attributes['tenancy.error_code']).toBe('TENANCY_TENANT_ALREADY_EXISTS');
    expect(failed.events.map((e) => e.name)).toEqual(expect.arrayContaining(['exception', 'tenancy.error']));
    const errorLog = lines.find((l) => l.outcome === 'error')!;
    expect(errorLog).toMatchObject({ tenantId: 'bolivar', code: 'TENANCY_TENANT_ALREADY_EXISTS', traceId: failed.spanContext().traceId });

    const errors = await metricPoints('tenancy.errors');
    expect(errors.some((p) => p.attributes['tenancy.error_code'] === 'TENANCY_TENANT_ALREADY_EXISTS' && p.attributes['tenant.id'] === 'bolivar')).toBe(true);
    const ops = await metricPoints('tenancy.operation.duration');
    expect(ops.some((p) => p.attributes['tenancy.outcome'] === 'error')).toBe(true);
    await tenancy.close();
  });

  it('tags the active HTTP span with the tenant and records request metrics without tenant labels', async () => {
    const tenancy = createTenancy({ logger: new NoopLogger(), telemetry: openTelemetry({ tracer, meter: meterProvider.getMeter('t3') }) });
    await tenancy.tenants.create({ id: 'tigre', domain: 'tigre.com' });
    await tracer.startActiveSpan('GET /pedidos/:id', async (span) => {
      const scope = await tenancy.openRequestScope({ host: 'tigre.com', path: '/pedidos/1', headers: {} });
      await scope.close();
      tenancy.logRequest({ tenantId: 'tigre', method: 'GET', path: '/pedidos/1', route: '/pedidos/:id', statusCode: 200, durationMs: 12 });
      span.end();
    });
    const http = spans.getFinishedSpans().find((s) => s.name === 'GET /pedidos/:id')!;
    expect(http.attributes['tenant.id']).toBe('tigre');
    const points = await metricPoints('tenancy.http.server.duration');
    expect(points[0]?.attributes).toMatchObject({ 'http.route': '/pedidos/:id', 'http.response.status_code': 200 });
    expect(points[0]?.attributes['tenant.id']).toBeUndefined();
    await tenancy.close();
  });

  it('works with the global no-op API and never breaks the app when telemetry throws', async () => {
    const tenancy = createTenancy({
      logger: new NoopLogger(),
      telemetry: [
        openTelemetry({ meter: false, correlateLogs: false }),
        { name: 'rota', recordOperation: () => { throw new Error('x'); }, logFields: () => { throw new Error('y'); } },
      ],
    });
    await tenancy.tenants.create({ id: 'bolivar' });
    expect(trace.getActiveSpan()).toBeUndefined();
    await tenancy.close();
  });
});
