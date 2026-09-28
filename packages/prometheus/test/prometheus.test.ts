import { createTenancy, NoopLogger } from '@tenancy-node/core';
import { prometheus } from '@tenancy-node/prometheus';
import { describe, expect, it } from 'vitest';

describe('Prometheus metrics', () => {
  it('exposes operation, request and error metrics without tenant labels by default', async () => {
    const metrics = prometheus();
    const tenancy = createTenancy({ logger: new NoopLogger(), telemetry: metrics });
    await tenancy.tenants.create({ id: 'bolivar' });
    await expect(tenancy.tenants.create({ id: 'bolivar' })).rejects.toThrow();
    tenancy.logRequest({ tenantId: 'bolivar', method: 'GET', path: '/pedidos/1', route: '/pedidos/:id', statusCode: 200, durationMs: 12 });
    tenancy.logRequest({ tenantId: 'bolivar', method: 'GET', path: '/nada/9', statusCode: 404, durationMs: 1 });
    const text = await metrics.metrics();
    expect(text).toContain('tenancy_operation_duration_seconds_count{operation="tenants.create",outcome="success"} 1');
    expect(text).toContain('tenancy_operation_duration_seconds_count{operation="tenants.create",outcome="error"} 1');
    expect(text).toContain('tenancy_errors_total{operation="tenants.create",code="TENANCY_TENANT_ALREADY_EXISTS"} 1');
    expect(text).toContain('tenancy_http_request_duration_seconds_count{method="GET",route="/pedidos/:id",status_class="2xx"} 1');
    expect(text).toContain('route="unmatched",status_class="4xx"');
    expect(text).not.toContain('tenant=');
    expect(text).not.toContain('/nada/9');
    expect(metrics.contentType).toContain('text/plain');
    await tenancy.close();
  });

  it('caps tenant labels to protect Prometheus', async () => {
    const metrics = prometheus({ perTenant: { maxTenants: 2 }, prefix: 'app_' });
    for (const tenantId of ['aa', 'bb', 'cc', 'aa', null]) {
      metrics.recordOperation!({ operation: 'x', tenantId, outcome: 'success', durationMs: 1 });
    }
    const text = await metrics.metrics();
    expect(text).toContain('app_operation_duration_seconds_count{operation="x",outcome="success",tenant="aa"} 2');
    expect(text).toContain('tenant="bb"} 1');
    expect(text).toContain('tenant="other"} 1');
    expect(text).toContain('tenant="central"} 1');
    expect(text).not.toContain('tenant="cc"');
  });

  it('labels only allowed tenants and can include process metrics', async () => {
    const metrics = prometheus({ perTenant: { allow: (id) => id.startsWith('vip') }, defaultMetrics: true });
    metrics.recordError!({ id: '1', tenantId: 'vip1', operation: 'op', code: 'E', name: 'Error', message: 'm', time: new Date(), context: {}, stack: undefined } as never);
    metrics.recordError!({ id: '2', tenantId: 'normal', operation: 'op', code: 'E', name: 'Error', message: 'm', time: new Date(), context: {}, stack: undefined } as never);
    const listed = prometheus({ perTenant: { allow: ['a1'] } });
    listed.recordRequest!({ tenantId: 'a1', method: 'POST', route: '/r', statusCode: 503, durationMs: 5 });
    const text = await metrics.metrics();
    expect(text).toContain('tenancy_errors_total{operation="op",code="E",tenant="vip1"} 1');
    expect(text).toContain('tenancy_errors_total{operation="op",code="E",tenant="other"} 1');
    expect(text).toContain('tenancy_process_cpu_seconds_total');
    expect(await listed.metrics()).toContain('status_class="5xx",tenant="a1"} 1');
  });
});
