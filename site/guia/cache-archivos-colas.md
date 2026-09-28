# Caché, archivos y colas

Los tres recursos siguen el mismo patrón ([ADR 0008](/adr/0008-recursos-por-tenant)): un driver crudo que no sabe nada de tenants (`CacheStore`, `StorageDriver`, `QueueDriver`) y un envoltorio que aísla por tenant. Tú usas siempre el envoltorio: `tenancy.cache()`, `tenancy.storage()` y `tenancy.jobs`.

| Recurso  | Aislamiento                              | Por defecto                   | En producción                                                   |
| -------- | ---------------------------------------- | ----------------------------- | --------------------------------------------------------------- |
| Caché    | Prefijo `tenant:{id}:` (central: `central:`) | `MemoryCacheStore`            | `redis()` o `memcached()`                                       |
| Archivos | Prefijo `{id}/` (central: `central/`)        | `LocalStorage` en `./storage` | `s3()`                                                          |
| Colas    | `tenantId` dentro de cada trabajo        | `MemoryQueue`                 | `bullmq()`                                                      |

## Caché

`tenancy.cache()` devuelve una `TenantCache` para el contexto actual. Dentro de un tenant, todas las llaves llevan su prefijo; fuera de uno, el prefijo `central:`.

```ts
await tenancy.run('bolivar', async () => {
  const cache = tenancy.cache(); // llaves con prefijo tenant:bolivar:

  await cache.set('config', { moneda: 'BOB' }, 300); // TTL en segundos
  const config = await cache.get<{ moneda: string }>('config'); // o undefined
  await cache.delete('config');

  // Devuelve lo guardado o ejecuta la función y guarda el resultado 60 s
  const productos = await cache.remember('productos', 60, cargarProductos);

  await cache.flush(); // borra toda la caché de bolivar
});

// Fuera de un tenant, la caché usa el prefijo central:
await tenancy.cache().set('planes', ['free', 'pro']);
```

| Método                            | Qué hace                                                                    |
| --------------------------------- | --------------------------------------------------------------------------- |
| `get<T>(key)`                     | Valor guardado o `undefined`                                                |
| `set(key, value, ttlSeconds?)`    | Guarda. Sin TTL (o `0`), no vence. `set(key, undefined)` borra la llave      |
| `delete(key)`                     | Borra una llave                                                             |
| `remember(key, ttlSeconds, fn)`   | Lee o calcula y guarda                                                      |
| `flush()`                         | Borra todas las llaves del tenant. En el contexto central lanza `TenantNotIdentifiedError` |
| `prefix`, `tenantId`              | Prefijo en uso y tenant (`null` = central)                                  |

Cuando se borra un tenant (`tenant.deleted`), su caché se vacía sola.

::: warning Límites de `remember`
`remember` no tiene bloqueo: si dos peticiones fallan la lectura a la vez, las dos ejecutan la función. Y como un valor `undefined` se trata como "no guardado", una función que devuelve `undefined` se ejecuta siempre. Devuelve `null` si quieres guardar "no hay nada".
:::

### Stores

```ts
import { createTenancy, MemoryCacheStore } from '@tenancy-node/core';
import { redis, redisInvalidation } from '@tenancy-node/cache-redis';
import { memcached } from '@tenancy-node/cache-memcached';

// Por defecto: memoria del proceso (LRU de 10 000 llaves)
createTenancy({ cache: new MemoryCacheStore({ maxEntries: 50_000 }) });

// Redis o Valkey
createTenancy({
  cache: redis({ url: process.env.REDIS_URL, keyPrefix: 'miapp:' }),
  invalidation: redisInvalidation({ url: process.env.REDIS_URL }), // caché de búsqueda entre réplicas
});

// Memcached
createTenancy({
  cache: memcached({ servers: process.env.MEMCACHED_SERVERS, versionCacheMs: 1000 }),
});
```

**`MemoryCacheStore`** guarda los valores por referencia (si modificas el objeto que te devuelve `get`, cambias el guardado) y solo vive en el proceso: cada réplica tiene la suya. Úsalo en desarrollo y tests.

**`redis()`** guarda los valores como JSON: las fechas vuelven como texto y las clases como objetos planos. `flush()` recorre las llaves con `SCAN` y las borra con `UNLINK`, sin bloquear el servidor.

| Opción de `redis()` | Por defecto              | Qué hace                                             |
| ------------------- | ------------------------ | ---------------------------------------------------- |
| `url`               | `redis://127.0.0.1:6379` | Se ignora si pasas `client`                          |
| `client`            | —                        | Tu cliente ioredis. No se cierra en `tenancy.close()` |
| `redisOptions`      | —                        | Opciones de ioredis                                  |
| `keyPrefix`         | `tenancy:`               | Prefijo global. Usa uno por app si comparten Redis   |
| `scanCount`         | `500`                    | Llaves por iteración de `SCAN` al vaciar un tenant   |

**`memcached()`** también guarda JSON. Memcached no puede borrar por prefijo, así que cada tenant tiene un número de versión dentro de sus llaves (`tenancy:bolivar:v3:productos`). `flush()` incrementa la versión: lo anterior queda inalcanzable y vence solo por su TTL o por la memoria de Memcached ([ADR 0013](/adr/0013-mensajeria-y-cache-distribuida)).

| Opción de `memcached()` | Por defecto       | Qué hace                                                                  |
| ----------------------- | ----------------- | ------------------------------------------------------------------------- |
| `servers`               | `127.0.0.1:11211` | `host:puerto` separados por coma                                          |
| `username`, `password`  | —                 | Autenticación SASL                                                        |
| `keyPrefix`             | `tenancy:`        | Prefijo global                                                            |
| `versionCacheMs`        | `1000`            | Cuánto recuerda el proceso la versión de un tenant                        |

Dos consecuencias de las versiones:

- Tras un `flush()` en otra réplica, esta sigue leyendo la versión anterior hasta `versionCacheMs`.
- Las llaves de más de 200 bytes, o con espacios o caracteres de control, se guardan como hash SHA-1 (`tenancy:h:<hash>`). Funcionan igual; solo no las reconoces a simple vista.

### Caché de búsqueda de tenants

Aparte de `tenancy.cache()`, el núcleo guarda en memoria los tenants y dominios que busca en cada petición (LRU con TTL, también las búsquedas que no encuentran nada). Se configura con `lookupCache`:

```ts
createTenancy({ lookupCache: { max: 10_000, ttlMs: 60_000 } }); // valores por defecto
createTenancy({ lookupCache: false }); // cada petición consulta el repositorio
```

Los cambios hechos con `tenancy.tenants` y `tenancy.domains` la invalidan en la instancia que los hizo. Con varias réplicas, las demás esperan hasta el TTL salvo que configures `invalidation: redisInvalidation(...)`. Cómo montarlo en [Producción](/guia/produccion).

## Archivos

`tenancy.storage()` devuelve un `TenantStorage`: cada ruta que pasas es relativa a la carpeta del tenant.

```ts
await tenancy.run('bolivar', async () => {
  const storage = tenancy.storage(); // prefijo bolivar/

  await storage.put('logos/logo.png', png, { contentType: 'image/png' });
  await storage.put('notas/bienvenida.txt', 'Hola');

  await storage.get('logos/logo.png'); // Uint8Array | undefined
  await storage.getText('notas/bienvenida.txt'); // 'Hola'
  await storage.exists('logos/logo.png'); // true
  await storage.list('logos'); // [{ path: 'logos/logo.png', size, lastModified }]
  await storage.url('logos/logo.png'); // '/tenancy/assets/logos/logo.png' con el driver local
  storage.key('logos/logo.png'); // 'bolivar/logos/logo.png' (llave real en el driver)

  await storage.delete('notas/bienvenida.txt');
  await storage.deleteAll(); // todo lo de bolivar
});
```

`put` acepta `Uint8Array` o `string` y lee todo en memoria: no hay streams. Para archivos grandes, sube directo a S3 con tu propio cliente usando `storage.key(ruta)` como llave.

Cuando se borra un tenant (`tenant.deleted`), también se borran sus archivos (todo lo que está bajo `{id}/`), igual que su caché. Pasa en segundo plano: `tenancy.tenants.delete()` no espera al driver y, si el borrado falla, el tenant queda borrado igual y el error queda en el log como `storage.delete_tenant`, con su `tenantId`. Un tenant con id `central` compartiría la carpeta `central/` del contexto central: en ese caso no se borra nada.

### Rutas seguras

Toda ruta pasa por `normalizeStoragePath`, que rechaza con `InvalidStoragePathError` (`TENANCY_INVALID_STORAGE_PATH`):

- `..` en cualquier parte (`a/../../b`)
- rutas absolutas (`/etc/passwd`)
- `\` y bytes nulos
- rutas vacías, `.` o de más de 1024 caracteres

Las barras repetidas y los `.` intermedios se limpian (`a//./b` → `a/b`). Además, `LocalStorage` verifica que la ruta final quede dentro de su raíz aunque la llave llegue manipulada por otro camino.

### Local y memoria

```ts
import { createTenancy, LocalStorage, MemoryStorage } from '@tenancy-node/core';

// Disco local (por defecto en ./storage). Sirve los archivos con la ruta opcional /tenancy/assets/*
createTenancy({
  storage: new LocalStorage({ root: '/var/lib/miapp/storage' }),
  http: { assets: true },
});

// Memoria (tests)
createTenancy({ storage: new MemoryStorage() });
```

Con `LocalStorage` y `MemoryStorage`, `url()` devuelve `/tenancy/assets/<ruta>` (se puede cambiar con la opción `url` de `LocalStorage`). Esa URL solo responde si activas `http: { assets: true }`: el adaptador sirve el archivo del tenant del host con su `content-type`, `ETag` y `x-content-type-options: nosniff`. Los archivos locales viven en el disco de una sola máquina: con varias réplicas, usa S3.

### S3 y compatibles

`@tenancy-node/storage-s3` funciona con AWS S3 y servicios compatibles (MinIO, R2, DigitalOcean Spaces, SeaweedFS).

```ts
import { createTenancy } from '@tenancy-node/core';
import { s3 } from '@tenancy-node/storage-s3';

// URLs públicas: bucket público o CDN
createTenancy({
  storage: s3({ bucket: 'mi-app', region: 'us-east-1', publicUrl: 'https://cdn.tuapp.com' }),
});

// URLs firmadas (sin publicUrl) contra un servicio compatible
createTenancy({
  storage: s3({
    bucket: 'mi-app',
    endpoint: 'http://localhost:8333',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_KEY!,
      secretAccessKey: process.env.S3_SECRET!,
    },
    keyPrefix: 'uploads/',
    signedUrlExpiresInSeconds: 900,
  }),
});
```

| Opción                      | Por defecto | Qué hace                                                               |
| --------------------------- | ----------- | ---------------------------------------------------------------------- |
| `bucket`                    | obligatorio |                                                                        |
| `region`                    | `us-east-1` |                                                                        |
| `endpoint`                  | —           | URL del servicio compatible                                            |
| `forcePathStyle`            | —           | `true` para la mayoría de los servicios que no son AWS                 |
| `credentials`               | —           | Si falta, el SDK usa su cadena normal (variables de entorno, rol IAM)  |
| `keyPrefix`                 | `''`        | Prefijo dentro del bucket: `uploads/bolivar/logo.png`                  |
| `publicUrl`                 | —           | Base de las URLs públicas. Si falta, `url()` firma                     |
| `signedUrlExpiresInSeconds` | `3600`      | Vigencia de las URLs firmadas                                          |
| `client`, `clientConfig`    | —           | Tu `S3Client` (no se cierra al terminar) o su configuración            |

Con `publicUrl`, `url()` arma `publicUrl + llave` sin consultar S3 y sin comprobar que el archivo exista. Sin `publicUrl`, firma un `GetObject`; puedes cambiar la vigencia por llamada:

```ts
await tenancy.run('bolivar', async () => {
  // URL firmada de 5 minutos (con S3 sin publicUrl)
  const url = await tenancy.storage().url('facturas/2026-09.pdf', { expiresInSeconds: 300 });
});
```

`/tenancy/assets/*` no sirve archivos de S3 (responde 404): las URLs apuntan directo al bucket o al CDN. Si una ruta ya es una URL absoluta (`https://...`), `url()` la devuelve igual; eso permite guardar en el tema un logo alojado afuera.

## Colas

### Definir y encolar trabajos

```ts
import { createTenancy } from '@tenancy-node/core';
import { bullmq } from '@tenancy-node/queue-bullmq';

const tenancy = createTenancy({
  queue: bullmq({ url: process.env.REDIS_URL, queueName: 'miapp' }),
});

// En la app y en el worker: el mismo registro
tenancy.jobs.define<{ pedidoId: number }>(
  'factura',
  async (data, { tenant, job }) => {
    // corre en el contexto del tenant: tenancy.cache(), tenancy.storage()... ya son de él
    console.log(tenant?.id.value, data.pedidoId, `intento ${job.attempt}/${job.maxAttempts}`);
  },
  { attempts: 5, backoff: { type: 'exponential', delayMs: 2000 } }, // opciones por defecto
);

// En la petición: se encola con el tenant del contexto
await tenancy.run('bolivar', async () => {
  const id = await tenancy.jobs.dispatch('factura', { pedidoId: 123 });
  await tenancy.jobs.dispatch('factura', { pedidoId: 124 }, { delayMs: 60_000 });
});

// En el proceso worker
const worker = await tenancy.worker({ concurrency: 10 });
await worker.close();
```

- `dispatch` toma el tenant del contexto. Fuera de un tenant, el trabajo es central (`tenant: null`).
- `dispatch` de un nombre que no está definido lanza `InvalidConfigError`, igual que definirlo dos veces.
- Los datos se serializan como JSON: pasa ids, no instancias ni fechas.
- En el worker, el tenant se vuelve a leer del repositorio. Si ya no existe, el intento falla.

| Opción de trabajo (`JobOptions`) | Por defecto | Qué hace                                                        |
| -------------------------------- | ----------- | --------------------------------------------------------------- |
| `attempts`                       | `1`         | Intentos en total. Por defecto **no hay reintentos**            |
| `backoff`                        | sin espera  | `{ type: 'fixed' \| 'exponential', delayMs }`. Exponencial: `delayMs · 2^(intento−1)` |
| `delayMs`                        | `0`         | Espera antes del primer intento                                 |

Cada intento queda en el log con `operation: queue.job`, el `tenantId`, `job`, `jobId` y `attempt`. Un intento fallido con reintentos pendientes es `warn`; el último es `error` y queda en `tenancy.observability.errors()` bajo el tenant.

### Drivers

**`MemoryQueue`** (por defecto) vive en el proceso: se pierde al reiniciar y solo la procesa un `tenancy.worker()` del mismo proceso. Sirve para desarrollo y tests (`queue.drain()` espera a que termine todo). El `close()` del worker deja de tomar trabajos y espera a los que están en curso.

**`bullmq()`** usa Redis o Valkey: trabajos persistentes, reintentos y varios workers en distintos procesos. Todos los tenants comparten una cola; cada trabajo lleva su `tenantId`. Un tenant con muchos trabajos puede retrasar a los demás: no hay colas separadas por tenant.

| Opción de `bullmq()` | Por defecto              | Qué hace                                         |
| -------------------- | ------------------------ | ------------------------------------------------ |
| `url`                | `redis://127.0.0.1:6379` |                                                  |
| `redisOptions`       | —                        | Opciones de ioredis (`maxRetriesPerRequest` ya es `null`) |
| `queueName`          | `tenancy`                | Nombre de la cola                                |
| `prefix`             | `bull`                   | Prefijo de las llaves de BullMQ                  |
| `keepCompleted`      | `1000`                   | Trabajos terminados que se conservan             |
| `keepFailed`         | `5000`                   | Trabajos fallidos que se conservan (dead-letter) |

`BullmqQueue` también tiene `counts()`, con la cantidad de trabajos por estado (`waiting`, `active`, `delayed`, `failed`, `completed`).

### `npx tenancy worker`

El CLI arranca un worker con la configuración de `tenancy.config` y lo detiene con SIGINT/SIGTERM, esperando los trabajos en curso ([CLI](/guia/cli)). Los trabajos se registran en un archivo aparte:

```ts
import type { Tenancy } from '@tenancy-node/core';

// src/jobs.ts
export default (tenancy: Tenancy) => {
  tenancy.jobs.define('factura', async (data) => {
    // ...
  });
};
```

```bash
npx tenancy worker --entry=src/jobs.ts --concurrency=5
```

La app que encola también necesita esas definiciones: importa el mismo archivo en los dos lados. Si el worker recibe un trabajo que no conoce, lo registra como error y el trabajo falla.

### Listeners en modo `queue`

Un listener de eventos con `mode: 'queue'` se convierte en un trabajo interno `event:<nombre>`: la operación solo espera a que quede encolado y el worker lo ejecuta con reintentos.

```ts
tenancy.events.on('tenant.created', enviarBienvenida, {
  mode: 'queue',
  name: 'bienvenida', // trabajo interno event:bienvenida
  retries: 5, // 6 intentos en total
  backoff: 'exponential', // desde 1 s
});
```

| Opción    | Por defecto              | Qué hace                                                     |
| --------- | ------------------------ | ------------------------------------------------------------ |
| `name`    | `<patrón>#<n>`           | Identifica al listener entre la app y el worker              |
| `retries` | `3`                      | Reintentos después del primer intento                        |
| `backoff` | `'exponential'` desde 1 s | `'fixed'` (1 s), `'exponential'` o un `JobBackoff` propio   |

::: tip Pon siempre `name`
Sin `name`, el nombre sale del orden de registro (`tenant.created#1`, `tenant.created#2`). Si la app y el worker registran los listeners en otro orden, cada uno ejecuta el handler equivocado.
:::

El listener tiene que registrarse en la app (para encolar) y en el worker (para ejecutar). Recibe el mismo sobre que un listener normal, con `time` convertido de vuelta a `Date`. Más sobre eventos en [Eventos](/guia/eventos).

Referencia: [`@tenancy-node/core`](/referencia/api/@tenancy-node/core/), [`cache-redis`](/referencia/api/@tenancy-node/cache-redis/), [`cache-memcached`](/referencia/api/@tenancy-node/cache-memcached/), [`storage-s3`](/referencia/api/@tenancy-node/storage-s3/), [`queue-bullmq`](/referencia/api/@tenancy-node/queue-bullmq/).
