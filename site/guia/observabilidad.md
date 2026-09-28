# Observabilidad

Con muchos tenants, "algo falló" no alcanza. Necesitas saber en qué tenant, en qué operación y por qué. Por eso la observabilidad está en el núcleo, no en un plugin: todo lo que hace el paquete pasa por un mismo `Observer` que escribe logs con campos fijos, guarda los errores por tenant y avisa a la telemetría (trazas y métricas).

Decisiones en [ADR 0005](/adr/0005-observabilidad) y [ADR 0014](/adr/0014-telemetria).

## Logs con campos fijos

Cada línea que escribe el paquete usa los mismos nombres:

| Campo        | Contenido                                                                       |
| ------------ | ------------------------------------------------------------------------------- |
| `tenantId`   | Id del tenant o `null` (contexto central). Siempre presente                     |
| `operation`  | `tenants.create`, `http.request`, `queue.job`... (ver [la tabla](#operaciones)) |
| `outcome`    | `success` o `error`                                                             |
| `durationMs` | Duración de la operación o de la petición                                       |
| `code`       | Código estable del error: `TENANCY_*`, el `code` del error (`ECONNREFUSED`) o el nombre de la clase |
| `errorId`    | Id del error en el registro de errores (para cruzar el log con el panel)        |
| `err`        | El error completo, con stack                                                    |

Las peticiones HTTP agregan `requestId`, `method`, `path`, `host`, `route` (la plantilla, por ejemplo `/pedidos/:id`) y `statusCode`. Con `@tenancy-node/otel` se agregan `traceId` y `spanId`. Los logs del paquete llevan además `component: 'tenancy'`.

Un error del paquete se asigna al tenant del que habla: si `TenantSuspendedError` trae `details.tenantId`, se registra bajo ese tenant aunque la petición nunca haya entrado a su contexto.

### Niveles

| Qué pasó                                          | Nivel   |
| ------------------------------------------------- | ------- |
| Escritura correcta (`tenants.create`, `domains.add`...) | `info`  |
| Lectura correcta (`tenants.find`, `tenants.list`, `domains.list`) | `debug` |
| Error del cliente (4xx: no encontrado, ya existe, datos inválidos) | `warn`  |
| Error del servidor (5xx) o inesperado              | `error` |
| Intento fallido con reintentos pendientes (trabajo, outbox, webhook, transporte) | `warn` |
| Último intento fallido (dead-letter)               | `error` |

Para las peticiones HTTP el nivel sale del código de respuesta: `>= 500` es `error`, `>= 400` es `warn` y el resto `info`.

### Usar pino

El logger por defecto es `ConsoleLogger` (JSON por consola, nivel `info`). En producción pasa `pino()`: la interfaz `Logger` es compatible.

```ts
import pino from 'pino';
import { createTenancy } from '@tenancy-node/core';

const tenancy = createTenancy({
  centralDomains: ['tuapp.com'],
  logger: pino({ level: 'info' }), // cualquier logger compatible con pino
});
```

Cualquier objeto con `debug`, `info`, `warn`, `error` y `child` sirve. Para ver las lecturas (`debug`) sube el nivel del logger que pases.

## `tenancy.observability`

```ts
// Tu log, con el tenantId del contexto agregado solo
tenancy.observability.logger.info({ pedidoId }, 'pedido confirmado');

// Registrar un error de tu aplicación (queda en el log y en el registro de errores)
try {
  await cobrar(pedidoId);
} catch (error) {
  const tracked = tenancy.observability.report('pagos.cobrar', error, { pedidoId });
  console.log(tracked.id); // el mismo valor que `errorId` en el log
}

tenancy.observability.errors({ tenantId: 'bolivar', limit: 20 }); // recientes de bolivar
tenancy.observability.errors({ tenantId: null }); // del contexto central
tenancy.observability.summary(); // [{ tenantId, total, byCode, lastErrorAt }], más errores primero
tenancy.observability.clear('bolivar'); // olvida los de bolivar
```

| Miembro                                | Qué hace                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `logger`                               | Logger que agrega `tenantId` del contexto a cada línea (si no lo pasas tú)               |
| `report(operation, error, context?)`   | Registra el error (nivel `error`) con el tenant actual o `context.tenantId`. Devuelve el `TrackedError` |
| `errors({ tenantId?, limit? })`        | Errores más nuevos primero. Sin `tenantId`, de todos; `null`, del central. `limit` por defecto 50 |
| `summary()`                            | Totales por tenant y por código                                                          |
| `clear(tenantId?)`                     | Borra los de un tenant, o todos                                                          |

Cada `TrackedError` trae `id`, `tenantId`, `operation`, `code`, `name`, `message`, `stack`, `time` y `context` (método, ruta, tipo de evento...).

El panel usa lo mismo: `GET /admin/api/errors?tenant=bolivar` y la pestaña Errores del tenant ([Panel](/guia/panel)).

## Registro de errores (`ErrorTracker`)

Por defecto es `MemoryErrorTracker`: un ring buffer por tenant en la memoria del proceso.

| Opción       | Por defecto | Qué hace                                                              |
| ------------ | ----------- | --------------------------------------------------------------------- |
| `perTenant`  | `100`       | Errores guardados por tenant (los más viejos se descartan)            |
| `maxTenants` | `10000`     | Tenants distintos que se siguen; se descarta el que lleva más tiempo sin errores |

Puedes pasar las opciones o tu propia implementación del puerto:

```ts
import { createTenancy, MemoryErrorTracker, type ErrorTracker, type TrackedError } from '@tenancy-node/core';

// Opciones del tracker en memoria
createTenancy({ errorTracker: { perTenant: 200, maxTenants: 5_000 } });

// O tu propia implementación del puerto: aquí se reenvía cada error a otro sistema
class ReenviarErrores implements ErrorTracker {
  private readonly local = new MemoryErrorTracker();
  constructor(private readonly enviar: (error: TrackedError) => void) {}
  record(error: TrackedError): void {
    this.local.record(error);
    this.enviar(error);
  }
  recent(options?: { tenantId?: string | null; limit?: number }): TrackedError[] {
    return this.local.recent(options);
  }
  summary() {
    return this.local.summary();
  }
  clear(tenantId?: string | null): void {
    this.local.clear(tenantId);
  }
}

createTenancy({ errorTracker: new ReenviarErrores((e) => console.error(e.id, e.code)) });
```

::: warning Es por proceso
Con varias réplicas, cada una tiene su propio registro en memoria: `errors()` y `summary()` solo muestran lo de ese proceso. Para una vista global usa los logs (todos llevan `errorId`) o un `ErrorTracker` propio que guarde en un lugar compartido. El paquete no trae uno persistente.
:::

## Health checks

`tenancy.health()` corre en paralelo un chequeo por cada pieza configurada que lo soporte: `database` (base central, con `@tenancy-node/db`), `cache`, `invalidation`, `queue`, `storage` y `transport:<nombre>`. Cada chequeo tiene 3 s como máximo.

```ts
const tenancy = createTenancy({
  centralDomains: ['tuapp.com'],
  http: { health: true }, // GET /tenancy/health en cualquier host
});

const report = await tenancy.health();
// { status: 'ok' | 'error', checks: { cache: { ok, durationMs, error? }, queue: {...}, ... } }
if (report.status === 'error') console.error(report.checks);
```

Con `http: { health: true }` los adaptadores responden `GET /tenancy/health` (o `<prefix>/health` si cambias `http.prefix`) en **cualquier host**, antes de identificar al tenant: sirve para el balanceador. Responde 200 si todo está bien y 503 si algo falla, con `Cache-Control: no-store`. Cada chequeo que falla se registra como error con `operation: 'health.check'`.

El panel tiene su propia ruta pública: `GET /admin/api/health`.

## Operaciones

Estos son los valores de `operation` que emite el paquete. Las marcadas como **traza** pasan por `observer.trace`: dejan log al terminar (bien o mal), abren un span y alimentan las métricas `operation_duration`. Las demás solo escriben logs o registran errores.

| `operation`                                                                                      | Paquete           | Tipo  | Notas                                                   |
| ------------------------------------------------------------------------------------------------ | ----------------- | ----- | ------------------------------------------------------- |
| `tenants.create`, `.update`, `.suspend`, `.activate`, `.maintenance`, `.delete`, `.retryProvisioning` | core          | traza | `info`; 4xx como `warn`                                 |
| `tenants.find`, `tenants.findOrFail`, `tenants.list`                                              | core              | traza | `debug`                                                 |
| `domains.add`, `domains.remove`, `domains.setPrimary`, `domains.list`                             | core              | traza | `domains.list` en `debug`                               |
| `theme.update`, `theme.reset`                                                                     | core              | traza |                                                         |
| `tenancy.runForEach`                                                                              | core              | traza | Todo el recorrido                                       |
| `tenancy.runForEach.item`                                                                         | core              | error | Un tenant que falló dentro del recorrido                |
| `tenancy.resolve`                                                                                 | core              | error | No se pudo identificar el tenant (`warn`), o está suspendido/en mantenimiento |
| `http.request`                                                                                    | core + adaptadores | log  | Una línea por petición; nivel según `statusCode`        |
| `events.listener`                                                                                 | core              | error | Un listener `async` que lanzó                           |
| `events.transport`                                                                                | core              | log   | Envío directo a un transporte (sin outbox), por intento |
| `queue.job`                                                                                       | core              | traza | Cada intento; `warn` si quedan reintentos               |
| `queue.dispatch`, `queue.worker`                                                                  | core, cli         | log   | Trabajo encolado (`debug`), worker iniciado             |
| `health.check`                                                                                    | core              | error | Un chequeo que falló                                    |
| `storage.delete_tenant`                                                                           | core              | error | No se pudieron borrar los archivos de un tenant borrado |
| `cache.invalidation.publish`, `.subscribe`, `.received`                                           | core              | log   | Bus de invalidación entre réplicas                      |
| `provisioning.step`                                                                               | db                | traza | Cada paso (`createDatabase`, `createUser`, `migrate`, `seed`) con `step`, `runId`, `attempt` |
| `database.install`, `database.migrate`, `database.rollback`, `database.seed`                      | db                | log   | Una línea por tenant                                    |
| `database.migrations.load`, `database.rotateKey`                                                  | db                | log   |                                                         |
| `database.move`, `database.move.step`                                                             | db                | traza | `tenancy move`                                          |
| `database.move.table`, `.cleanup`, `.restore`                                                     | db                | log   |                                                         |
| `db.pool.open`, `db.pool.close`, `db.pool.limit`, `db.pool.error`, `db.servers.load`              | db                | log   | Pools por tenant                                        |
| `knex.open`, `knex.close` (y el nombre de cada ORM)                                               | orm-*             | log   | Instancias del ORM por tenant                           |
| `outbox.relay`                                                                                    | outbox            | traza | Cada lote con al menos un evento, en `debug` (un sondeo vacío no deja span ni métrica); también el arranque del relay y sus errores |
| `outbox.deliver`, `outbox.dead_letter`                                                            | outbox            | log   | `deliver` en `warn` si hay reintento                    |
| `webhook.register`, `webhook.deliver`, `webhook.dead`, `webhook.circuit_open`, `webhook.dispatcher` | transport-webhook | log |                                                         |
| `admin.request`, `admin.serve`, `admin.impersonation_used`                                        | admin-api         | log   |                                                         |
| `cli.<comando>`, `cli.run`                                                                        | cli               | error | Errores de un comando                                   |

Los nombres que registras tú con `observability.report('pagos.cobrar', ...)` conviven con estos.

## Seguir los errores de un tenant

Todo lo de un tenant se filtra por `tenantId`. Con los logs en un archivo (o `tenancy --log-file`):

```bash
# todo lo de bolivar
jq -c 'select(.tenantId == "bolivar")' app.log

# solo sus errores, con lo mínimo para diagnosticar
jq -c 'select(.tenantId == "bolivar" and .outcome == "error")
       | {time, operation, code, errorId, msg}' app.log

# errores por código en todos los tenants
jq -r 'select(.outcome == "error") | "\(.tenantId)\t\(.code)"' app.log | sort | uniq -c | sort -rn
```

Con un `errorId` del panel encuentras la línea completa (con stack): `jq 'select(.errorId == "01J...")' app.log`. Si usas OpenTelemetry, esa línea trae el `traceId` para abrir la traza.

::: tip
En Loki, Datadog o ELK es la misma idea: indexa `tenantId`, `operation`, `code` y `outcome`. Con pino, `level` es un número (`40` = warn, `50` = error); con `ConsoleLogger`, un texto.
:::

## Telemetría

El núcleo no depende de OpenTelemetry ni de prom-client. Define un puerto, `Telemetry`, con todo opcional:

| Miembro                                | Cuándo se llama                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `name`                                 | Obligatorio                                                                     |
| `span(operation, attributes, fn)`      | Envuelve cada operación de tipo traza; las internas quedan como hijas            |
| `tenantResolved(tenantId)`             | Se identificó el tenant de la petición                                           |
| `recordOperation(sample)`              | Terminó una operación: `{ operation, tenantId, outcome, durationMs, code? }`     |
| `recordRequest(sample)`                | Terminó una petición: `{ tenantId, method, route, statusCode, durationMs }`      |
| `recordError(error)`                   | Se registró un `TrackedError`                                                    |
| `logFields()`                          | Campos extra para los logs del observer (por ejemplo `traceId`)                  |

Los atributos del span son `tenancy.operation`, `tenant.id` (si hay tenant) y `tenancy.<campo>` por cada dato simple del contexto. Si una telemetría lanza, el núcleo la ignora: medir nunca tumba la app. Puedes pasar una o varias (`telemetry: [a, b]`).

```ts
import { createTenancy, type Telemetry } from '@tenancy-node/core';

// Todo es opcional: implementa solo lo que te sirve. Si algo lanza, el núcleo lo ignora.
const lentas: Telemetry = {
  name: 'operaciones-lentas',
  recordOperation(sample) {
    if (sample.durationMs > 1_000)
      console.warn(`${sample.operation} tardó ${sample.durationMs} ms (tenant ${sample.tenantId})`);
  },
  recordError(error) {
    console.warn(`error ${error.code} en ${error.operation}: ${error.id}`);
  },
};

createTenancy({ telemetry: lentas });
```

### OpenTelemetry (`@tenancy-node/otel`)

`openTelemetry()` solo usa `@opentelemetry/api` (peer dependency). El SDK y el exportador los configuras tú al arrancar. Sin SDK, la API es no-op y no cuesta nada.

Qué hace:

- Un span `INTERNAL` por cada operación de tipo traza, con `tenant.id` y `tenancy.operation`. Si falla: estado `ERROR`, la excepción registrada, el atributo `tenancy.error_code` y un evento `tenancy.error` con el `tenancy.error_id` del registro de errores.
- `tenant.id` en el span HTTP activo (el de `@opentelemetry/instrumentation-http`) cuando se identifica el tenant (`central` si no hay).
- `traceId` y `spanId` en los logs de operaciones, errores y peticiones.
- Métricas (ver la [tabla](#metricas)).

| Opción          | Por defecto                          | Qué hace                                                          |
| --------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `tracer`        | `trace.getTracer('tenancy-node')`    | Tracer a usar                                                     |
| `meter`         | `metrics.getMeter('tenancy-node')`   | Meter a usar; `false` desactiva las métricas                      |
| `tenantMetrics` | `false`                              | `tenant.id` también en las métricas (en las trazas va siempre)    |
| `correlateLogs` | `true`                               | `traceId`/`spanId` en los logs                                    |

Un arranque con el SDK base, como en las pruebas del paquete (cambia los exportadores de consola por los tuyos, por ejemplo OTLP):

```ts
// telemetria.ts: se importa antes que cualquier otro módulo de la app
import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, BatchSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { createTenancy } from '@tenancy-node/core';
import { openTelemetry } from '@tenancy-node/otel';

// Sin un context manager, los spans no se anidan entre llamadas async.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new BatchSpanProcessor(new ConsoleSpanExporter())] }),
);
metrics.setGlobalMeterProvider(
  new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter(), exportIntervalMillis: 60_000 })],
  }),
);

export const tenancy = createTenancy({
  centralDomains: ['tuapp.com'],
  telemetry: openTelemetry(), // usa el tracer y el meter globales ('tenancy-node')
});
```

Si usas `@opentelemetry/sdk-node`, la regla es la misma: inicia el SDK antes de `createTenancy` y de cargar tu framework, así el span HTTP existe cuando el adaptador identifica al tenant.

Otras combinaciones:

```ts
openTelemetry({
  tenantMetrics: false, // tenant.id en las métricas (por defecto false; en las trazas va siempre)
  correlateLogs: true, // traceId y spanId en los logs (por defecto true)
  meter: false, // solo trazas, sin métricas
});
```

### Prometheus (`@tenancy-node/prometheus`)

`prometheus()` crea un registro de prom-client propio (no el global) y devuelve la telemetría con `metrics()`, `contentType` y `registry`.

```ts
import { createServer } from 'node:http';
import { createTenancy } from '@tenancy-node/core';
import { prometheus } from '@tenancy-node/prometheus';

const metrics = prometheus({
  perTenant: { maxTenants: 50 }, // etiqueta `tenant` para los primeros 50; el resto va como `other`
  defaultMetrics: true, // CPU, memoria y event loop del proceso
});
const tenancy = createTenancy({ centralDomains: ['tuapp.com'], telemetry: metrics });

// /metrics en un puerto interno, fuera del tráfico público
createServer(async (req, res) => {
  if (req.url !== '/metrics') return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': metrics.contentType }).end(await metrics.metrics());
}).listen(9464);
```

En Express o Fastify es lo mismo: una ruta que responde `await metrics.metrics()` con `metrics.contentType`. Con varios procesos, cada uno expone lo suyo y Prometheus los suma.

| Opción           | Por defecto        | Qué hace                                                        |
| ---------------- | ------------------ | --------------------------------------------------------------- |
| `registry`       | uno nuevo          | Registro de prom-client (pasa el tuyo para juntar métricas)     |
| `prefix`         | `tenancy_`         | Prefijo de los nombres                                          |
| `perTenant`      | `false`            | Etiqueta `tenant` (ver abajo)                                   |
| `defaultMetrics` | `false`            | Métricas del proceso con el mismo prefijo                       |
| `buckets`        | `0.005` a `30` s   | Límites de los histogramas, en segundos                         |

#### Cardinalidad: `perTenant`

Cada tenant multiplica las series. Con miles de tenants, Prometheus se cae. Por eso la etiqueta `tenant` está apagada por defecto.

```ts
prometheus({ perTenant: true }); // hasta 100 tenants con etiqueta propia
prometheus({ perTenant: { allow: ['bolivar', 'tigre'] } }); // solo estos; el resto `other`
prometheus({ perTenant: { allow: (id) => id.startsWith('vip-') } });
```

- `true` o `{ maxTenants }`: los primeros tenants que aparecen (100 por defecto) tienen etiqueta propia; los siguientes van como `other`.
- `{ allow }`: una lista o una función. Solo esos tenants; el resto `other`. Con `allow`, `maxTenants` no aplica.
- El contexto central va como `central`.

Las rutas HTTP usan la plantilla (`/pedidos/:id`), nunca la ruta real. Sin plantilla van como `unmatched`.

### Métricas

| Prometheus                              | OpenTelemetry                  | Etiquetas Prometheus                          | Atributos OpenTelemetry                                                                 |
| --------------------------------------- | ------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `tenancy_operation_duration_seconds`    | `tenancy.operation.duration` (ms) | `operation`, `outcome` (+ `tenant`)        | `tenancy.operation`, `tenancy.outcome` (+ `tenant.id`)                                  |
| `tenancy_http_request_duration_seconds` | `tenancy.http.server.duration` (ms) | `method`, `route`, `status_class` (+ `tenant`) | `http.request.method`, `http.response.status_code`, `http.route`, `tenancy.status_class` (+ `tenant.id`) |
| `tenancy_errors_total`                  | `tenancy.errors`               | `operation`, `code` (+ `tenant`)              | `tenancy.operation`, `tenancy.error_code` (+ `tenant.id`)                               |

`status_class` es `2xx`, `4xx`, `5xx`... Las métricas de operaciones solo cubren las operaciones de tipo traza de la [tabla](#operaciones); `tenancy_errors_total` cuenta todos los errores registrados.

## Límites

- El registro de errores y las métricas son por proceso.
- Sin OpenTelemetry no hay `traceId` en los logs. `requestId` sale del `request.id` de Fastify; en Express, solo si la petición trae el header `x-request-id`.
- `@tenancy-node/prometheus` no crea spans ni agrega campos a los logs.

Referencia: [`@tenancy-node/core`](/referencia/api/@tenancy-node/core/), [`@tenancy-node/otel`](/referencia/api/@tenancy-node/otel/), [`@tenancy-node/prometheus`](/referencia/api/@tenancy-node/prometheus/).
