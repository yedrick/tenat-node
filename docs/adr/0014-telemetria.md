# ADR 0014 — OpenTelemetry y Prometheus

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Decisiones

1. **Puerto `Telemetry` en el núcleo**, con todo opcional: `span()` envuelve cada `observer.trace` (las operaciones internas quedan como hijas), y `recordOperation`, `recordRequest` y `recordError` reciben muestras ya medidas. `logFields()` agrega campos a los logs del observer. El núcleo no depende de OpenTelemetry ni de prom-client.
2. **Correlación log ↔ traza ↔ error.** Con `@tenancy-node/otel`, cada log de operación y cada log de error llevan `traceId` y `spanId`. El span registra la excepción y un evento `tenancy.error` con el `errorId` del registro de errores: de una traza se llega al error del tenant, y del log a la traza.
3. **`tenant.id` va siempre en las trazas**, en el span de cada operación y en el span HTTP activo (el de `instrumentation-http`) cuando se identifica el tenant.
4. **En las métricas, el tenant es opcional (`perTenant`).** Cada tenant multiplica las series y miles de tenants tumban a Prometheus. Con `perTenant: true` hay un tope (`maxTenants`, 100) y el resto va como `other`. También se puede dar una lista o una función de tenants permitidos. Las rutas HTTP usan la **plantilla** (`/pedidos/:id`), nunca la ruta real; sin plantilla van como `unmatched`.
5. **La telemetría nunca rompe la app:** un error dentro de una implementación se ignora.
6. **`@tenancy-node/otel` solo usa `@opentelemetry/api`.** El SDK y el exportador los configura la app. Sin SDK, la API es no-op y no cuesta nada.

## Métricas

| Prometheus                              | OpenTelemetry                  | Etiquetas                                            |
| --------------------------------------- | ------------------------------ | ---------------------------------------------------- |
| `tenancy_operation_duration_seconds`    | `tenancy.operation.duration`   | operación, resultado (+ tenant)                      |
| `tenancy_http_request_duration_seconds` | `tenancy.http.server.duration` | método, ruta (plantilla), clase de estado (+ tenant) |
| `tenancy_errors_total`                  | `tenancy.errors`               | operación, código `TENANCY_*` (+ tenant)             |
