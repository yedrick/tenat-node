# Frameworks

Los tres adaptadores hacen lo mismo en cada petición:

1. Arman un `RequestLike` con el header `Host`, la ruta sin query string y los headers.
2. Identifican al tenant con el resolver configurado (ver [Resolvers](/guia/conceptos#resolvers-como-se-identifica-el-tenant)).
3. Abren su contexto y ejecutan el resto de la petición dentro de él.
4. Al terminar la respuesta, escriben una línea de log y cierran el contexto (liberan conexiones y recursos).

Si el tenant no se puede identificar o no puede atender (suspendido, en mantenimiento), responden el error con su código HTTP sin llegar a tus rutas.

| Paquete                         | Framework          | Uso                                          |
| ------------------------------- | ------------------ | -------------------------------------------- |
| `@tenancy-node/adapter-fastify` | Fastify 5          | `app.register(tenancyPlugin, { tenancy })`   |
| `@tenancy-node/adapter-express` | Express 4 y 5      | `app.use(tenancyMiddleware(tenancy))`        |
| `@tenancy-node/adapter-node`    | `node:http`        | `createServer(withTenancy(tenancy, handler))` |

## Opciones comunes

| Opción           | Por defecto | Qué hace                                                                                         |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `onUnidentified` | `'error'`   | Host que no es central ni de ningún tenant: `'error'` responde 404, `'central'` lo atiende sin tenant |
| `trustProxy`     | `false`     | Tomar el host de `X-Forwarded-Host`. Ver [Detrás de un proxy](#detras-de-un-proxy)               |
| `skip`           | —           | Función que recibe la petición; si devuelve `true`, la petición no pasa por tenancy. Solo Fastify y Express |
| `logRequests`    | `true`      | Una línea de log por petición. Ver [Logs por petición](#logs-por-peticion)                       |
| `errorHandler`   | `true`      | Responder con su código los errores del paquete que lanzan tus rutas. Solo Fastify. Ver [Errores dentro de tus handlers](#errores-dentro-de-tus-handlers) |

## Fastify

```ts
import Fastify from 'fastify';
import { createTenancy } from '@tenancy-node/core';
import { tenancyPlugin } from '@tenancy-node/adapter-fastify';

const tenancy = createTenancy({ centralDomains: ['tuapp.com'] });

const app = Fastify();
await app.register(tenancyPlugin, {
  tenancy,
  onUnidentified: 'error', // por defecto: 404 si el host no es de nadie
  skip: (request) => request.url === '/ping', // no pasa por tenancy
});

app.get('/whoami', async (req) => ({
  tenant: req.tenant?.id.value ?? null, // null en el dominio central
  mismo: tenancy.currentId() ?? null, // lo mismo, desde cualquier función
}));
app.get('/ping', async () => 'pong');
```

El plugin usa `fastify-plugin`, así que sus hooks aplican a toda la app. Resuelve el tenant en `onRequest`, restaura el contexto en `preValidation` y `preHandler` (leer el body lo pierde) y cierra el contexto en `onResponse`. Una petición que el cliente corta se registra con código 499.

`request.tenant` es `Tenant | null`: `null` en el contexto central. Nota: `skip` recibe `request.url`, que incluye la query string.

### Errores dentro de tus handlers

Si un handler lanza un error del paquete (por ejemplo `tenancy.tenants.findOrFail()` con un id que no existe), el plugin lo responde con su código y el mismo cuerpo que Express y `node:http` (`404 { "error": { "code": "TENANCY_TENANT_NOT_FOUND", ... } }`). Los demás errores siguen al manejador por defecto de Fastify, sin cambios. En los dos casos el error queda registrado con su tenant y con el código que realmente se envió.

Tu propio `setErrorHandler` siempre manda: si lo registras (antes o después del plugin), el del plugin no se usa para esas rutas, así que ahí decides tú el código. Para responder como el paquete, usa `httpStatusFor` y `errorResponseBody`:

```ts
import Fastify from 'fastify';
import { createTenancy, errorResponseBody, httpStatusFor, isTenancyError } from '@tenancy-node/core';
import { tenancyPlugin } from '@tenancy-node/adapter-fastify';

const tenancy = createTenancy({ centralDomains: ['tuapp.com'] });
const app = Fastify();
await app.register(tenancyPlugin, { tenancy });

app.setErrorHandler((error, _request, reply) => {
  if (isTenancyError(error)) return reply.code(httpStatusFor(error)).send(errorResponseBody(error));
  // ...tu manejo del resto de errores
  return reply.code(500).send({ error: 'Algo falló' });
});
```

Con `errorHandler: false` el plugin no instala su manejador.


## Express

```ts
import express from 'express';
import { createTenancy } from '@tenancy-node/core';
import { tenancyErrorHandler, tenancyMiddleware } from '@tenancy-node/adapter-express';

const tenancy = createTenancy({ centralDomains: ['tuapp.com'] });
const app = express();

app.use(express.json()); // antes de tenancy: leer el body pierde el contexto
app.use(tenancyMiddleware(tenancy, { skip: (req) => req.path === '/ping' }));

app.get('/whoami', (req, res) => {
  res.json({ tenant: req.tenant?.id.value ?? null, mismo: tenancy.currentId() ?? null });
});
app.get('/pedidos/:id', async (req, res) => {
  await tenancy.tenants.findOrFail('ghost'); // TenantNotFoundError → 404
  res.json({});
});

app.use(tenancyErrorHandler(tenancy)); // después de las rutas
app.use(((err, _req, res, _next) => {
  res.status(500).json({ error: 'Algo falló' }); // errores que no son del paquete
}) as express.ErrorRequestHandler);

app.listen(3000);
```

El orden importa:

- **`tenancyMiddleware` va después de los body parsers** (`express.json()`, `express.urlencoded()`). Leer el body con eventos del stream pierde el contexto asíncrono.
- **`tenancyErrorHandler` va después de tus rutas.** Registra cada error con su tenant, responde los errores del paquete con su código y pasa los demás al siguiente manejador con `next(error)`. Si la respuesta ya empezó, también los pasa.

Puedes montar el middleware en la raíz (`app.use(...)`) o bajo una ruta (`app.use('/api', ...)`). Las [rutas HTTP opcionales](#rutas-http-opcionales) y el log usan siempre la ruta completa (`req.originalUrl` sin la query), no `req.path`, que es relativa al punto de montaje. Si lo montas en `/api`, configura `http.prefix: '/api/tenancy'`. Ojo: `skip` recibe la petición de Express tal cual, así que ahí `req.path` sigue siendo relativo.

`req.tenant` es `Tenant | null`, y `undefined` en las peticiones que salta `skip`. Express 5 pasa al manejador de errores lo que rechaza un handler `async`; en Express 4 tienes que llamar a `next(error)` tú.

## `node:http`

```ts
import { createServer } from 'node:http';
import { createTenancy } from '@tenancy-node/core';
import { withTenancy } from '@tenancy-node/adapter-node';

const tenancy = createTenancy({ centralDomains: ['tuapp.com'] });

const server = createServer(
  withTenancy(tenancy, async (req, res) => {
    // req.tenant: Tenant | null; los errores que lances salen con su código HTTP
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ tenant: req.tenant?.id.value ?? null }));
  }),
);
server.listen(3000);
```

`withTenancy(tenancy, handler, options)` envuelve tu handler: identifica el tenant, lo ejecuta en su contexto y cierra el contexto cuando se cierra la respuesta. Si el handler lanza, responde el error con su código y lo registra; si ya habías enviado headers, destruye la conexión. No tiene opción `skip`: decide tú dentro del handler.

El body lo lees tú. Los callbacks de eventos del stream (`req.on('data')`) pueden perder el contexto; léelo con `await`, por ejemplo con `for await (const chunk of req)`, dentro del handler.

## Logs por petición

Con `logRequests: true` (por defecto), cada petición deja una línea al terminar. Con el `ConsoleLogger` por defecto se ve así (con `pino`, el formato de `level` y `time` es el de pino):

```json
{"level":"info","time":"2026-09-28T15:04:05.000Z","component":"tenancy","operation":"http.request","outcome":"success","tenantId":"bolivar","requestId":"req-1","method":"GET","path":"/productos","host":"bolivar.tuapp.com","route":"/productos","statusCode":200,"durationMs":3.41,"msg":"GET /productos 200"}
```

- El nivel depende del código: `info` hasta 399, `warn` de 400 a 499, `error` desde 500.
- `tenantId` es `null` en el contexto central. Si la petición falló porque el tenant está suspendido o no existe, lleva el id del que habla el error (`closed`, `ghost`).
- `requestId`: en Fastify, `request.id`; en Express, el header `X-Request-Id` si viene; en `node:http` no se agrega.
- `route` (la plantilla, `/pedidos/:id`) se agrega en Fastify y, cuando se conoce, en Express. Se usa para métricas sin explosión de series.
- Con telemetría configurada, se agregan los campos de correlación (`traceId`).

Además, cada error de un handler queda en `tenancy.observability.errors({ tenantId })` con `operation: http.request`, el método, la ruta y el código. Ver [Observabilidad](/guia/observabilidad).

## Errores y códigos HTTP

Todos los errores del paquete extienden `TenancyError` y tienen un `code` estable. Los adaptadores usan `httpStatusFor(error)` para el código y `errorResponseBody(error)` para el cuerpo:

| Código                              | HTTP | Cuándo                                               |
| ----------------------------------- | ---- | ---------------------------------------------------- |
| `TENANCY_TENANT_NOT_FOUND`          | 404  | El id resuelto no existe o está eliminado            |
| `TENANCY_TENANT_NOT_IDENTIFIED`     | 404  | El host no es central ni de ningún tenant            |
| `TENANCY_DOMAIN_NOT_FOUND`          | 404  | El dominio no existe                                 |
| `TENANCY_TENANT_ALREADY_EXISTS`     | 409  | Ya hay un tenant con ese id                          |
| `TENANCY_DOMAIN_TAKEN`              | 409  | El dominio ya es de otro tenant                      |
| `TENANCY_INVALID_STATUS_TRANSITION` | 409  | Cambio de estado no permitido                        |
| `TENANCY_TENANT_SUSPENDED`          | 423  | El tenant está suspendido                            |
| `TENANCY_TENANT_IN_MAINTENANCE`     | 503  | El tenant está en mantenimiento                      |
| `TENANCY_TENANT_NOT_READY`          | 503  | El tenant está en `provisioning`, `failed` o `deleting` |
| `TENANCY_INVALID_TENANT_ID`         | 422  | Id con formato inválido                              |
| `TENANCY_INVALID_DOMAIN`            | 422  | Dominio con formato inválido                         |
| `TENANCY_INVALID_COLOR`             | 422  | Color del tema inválido                              |
| `TENANCY_INVALID_THEME`             | 422  | Campo del tema inválido                              |
| `TENANCY_INVALID_TENANT_DATA`       | 422  | `name`, `plan` o `data` inválidos                    |

Cualquier otro error, del paquete o no, es 500.

El cuerpo siempre tiene la misma forma:

```json
{ "error": { "code": "TENANCY_TENANT_SUSPENDED", "message": "Tenant \"closed\" is suspended" } }
```

Los errores 4xx y los 503 de la tabla muestran su mensaje (en mantenimiento, el mensaje que pasaste a `tenancy.tenants.maintenance()`). El resto de errores 5xx responden `{ "error": { "code": "TENANCY_INTERNAL_ERROR", "message": "Internal Server Error" } }` para no filtrar detalles; el error completo queda en el log.

## Rutas HTTP opcionales

El núcleo trae cuatro rutas listas, todas apagadas por defecto. Las activas en la configuración y los tres adaptadores las atienden solas, sin que registres nada en tu router:

```ts
import { createTenancy } from '@tenancy-node/core';

const tenancy = createTenancy({
  centralDomains: ['tuapp.com'],
  http: {
    me: true, // GET /tenancy/me
    theme: true, // GET /tenancy/theme.css
    assets: true, // GET /tenancy/assets/*
    health: true, // GET /tenancy/health
    prefix: '/_t', // en lugar de /tenancy
    cacheControl: 'public, max-age=60',
  },
  publicFields: ['name', 'plan', 'locale'], // 'locale' se lee de tenant.data
});
```

| Opción         | Por defecto             | Ruta y qué responde                                                                      |
| -------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `me`           | `false`                 | `GET {prefix}/me`: `id`, `theme` (con `logo` si hay) y los campos de `publicFields`      |
| `theme`        | `false`                 | `GET {prefix}/theme.css`: las variables CSS del tema del tenant                          |
| `assets`       | `false`                 | `GET {prefix}/assets/<ruta>`: un archivo del almacenamiento del tenant                    |
| `health`       | `false`                 | `GET {prefix}/health`: estado de la base central, caché, cola, almacenamiento y transportes. 200 o 503 |
| `prefix`       | `'/tenancy'`            | Debe empezar con `/` y usar solo letras, dígitos, `/`, `_` y `-`                         |
| `cacheControl` | `'public, max-age=300'` | `Cache-Control` de `me`, `theme.css` y `assets`                                          |

Algunos detalles:

- `publicFields` (por defecto `['name']`) acepta `name`, `plan`, `status` o llaves de `tenant.data`. Nada más sale en `/me`.
- `me`, `theme.css` y `assets` responden 404 en el contexto central. Llevan `ETag` y responden 304 con `If-None-Match`. También aceptan `HEAD`.
- `assets` solo sirve archivos con el driver de disco local (o el de memoria). Con S3 responde 404: usa las URLs del bucket. Una ruta que intenta salir de la carpeta del tenant, o con un escape `%` mal formado (`%E0%A4%A`), responde 400 con `TENANCY_INVALID_STORAGE_PATH`. En Fastify, el router rechaza antes ese escape mal formado con su propio 400 (`FST_ERR_BAD_URL`).
- `GET` y `HEAD {prefix}/health` responden en **cualquier** host, antes de identificar al tenant (salvo que `skip` la salte), y dejan su línea de log como cualquier petición. Cada chequeo tiene un límite de 3 segundos. No la expongas a internet si no quieres mostrar qué servicios usas.

Más sobre el tema en [Tema](/guia/tema) y sobre archivos en [Caché, archivos y colas](/guia/cache-archivos-colas).

## Detrás de un proxy

Por defecto el host sale del header `Host`. Si tu proxy (nginx, Traefik, un balanceador) lo reescribe y manda el original en `X-Forwarded-Host`, activa `trustProxy`:

```ts
import Fastify from 'fastify';
import { createTenancy } from '@tenancy-node/core';
import { tenancyPlugin } from '@tenancy-node/adapter-fastify';

const tenancy = createTenancy({ centralDomains: ['tuapp.com'] });
const app = Fastify();

// Solo si tu propio proxy (nginx, Traefik) reescribe el Host y pone X-Forwarded-Host
await app.register(tenancyPlugin, { tenancy, trustProxy: true, logRequests: true });
```

Con `trustProxy: true` se usa el primer valor de `X-Forwarded-Host`; si no viene, el `Host`. Esta opción es independiente del `trustProxy` de Fastify y del `trust proxy` de Express: tienes que activarla aquí.

::: warning
No actives `trustProxy` si la app recibe tráfico directo. Cualquier cliente podría mandar `X-Forwarded-Host: otro-tenant.tuapp.com` y entrar al contexto de otro tenant.
:::

## Saltar peticiones con `skip`

`skip` sirve para rutas que no tienen nada que ver con tenants: el health check de tu balanceador, métricas, webhooks entrantes con su propia autenticación. Una petición saltada no abre ningún contexto: `tenancy.current()` es `undefined`, no se escribe la línea de log de tenancy y los recursos que pidas usan el contexto central raíz.

Si lo que quieres es que un host desconocido no responda 404, no uses `skip`: usa `onUnidentified: 'central'`.

## Siguientes pasos

- [Observabilidad](/guia/observabilidad): logs, errores por tenant y telemetría.
- [Panel de administración](/guia/panel): montar la Admin API en Express o Fastify.
- Referencia: [adapter-fastify](/referencia/api/@tenancy-node/adapter-fastify/), [adapter-express](/referencia/api/@tenancy-node/adapter-express/), [adapter-node](/referencia/api/@tenancy-node/adapter-node/).
