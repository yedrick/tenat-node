# Producción

Esta guía junta lo que cambia cuando pasas de un proceso en tu máquina a varias réplicas detrás de un balanceador.

## Varias réplicas y la caché de búsqueda

Cada petición resuelve dominio → tenant. Para no ir a la base central cada vez, cada proceso guarda esa búsqueda en una caché LRU en memoria (`lookupCache`), para tenants y para dominios. También guarda las ausencias: un host desconocido no consulta la base en cada petición.

| Opción              | Por defecto | Qué hace                              |
| ------------------- | ----------- | ------------------------------------- |
| `lookupCache.max`   | `10000`     | Entradas máximas por caché            |
| `lookupCache.ttlMs` | `60000`     | Vida de cada entrada                  |
| `lookupCache: false` | —          | Desactiva la caché (cada petición consulta la base) |

Dentro de un proceso, `tenancy.tenants.*` y `tenancy.domains.*` borran la entrada al escribir. El problema son **las otras réplicas**: sin nada más, ven el cambio recién cuando vence el TTL. Suspendes un tenant y durante hasta 60 s otra réplica lo sigue atendiendo.

### Invalidación entre instancias

Con `invalidation`, cada cambio de tenant o dominio se avisa a las demás réplicas y borran su caché en el acto. `redisInvalidation()` de `@tenancy-node/cache-redis` lo hace con Redis pub/sub:

```ts
import { createTenancy } from '@tenancy-node/core';
import { redis, redisInvalidation } from '@tenancy-node/cache-redis';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';

export const tenancy = createTenancy({
  centralDomains: ['tuapp.com'],
  // Caché de búsqueda dominio → tenant en cada réplica (por defecto 10 000 entradas, 60 s)
  lookupCache: { max: 20_000, ttlMs: 30_000 },
  // Cada cambio de tenant o dominio borra esa caché en las demás réplicas
  invalidation: redisInvalidation({ url: process.env.REDIS_URL!, channel: 'miapp:invalidation' }),
  cache: redis({ url: process.env.REDIS_URL! }),
  plugins: [
    database({
      driver: postgres(),
      central: { url: process.env.DATABASE_URL!, pool: { max: 10 } },
      encryptionKey: process.env.TENANCY_KEY,
      pool: { max: 5, maxOpenPools: 100, idleTimeoutMs: 60_000 },
    }),
  ],
});
```

| Opción de `redisInvalidation` | Por defecto              | Qué hace                                                        |
| ----------------------------- | ------------------------ | --------------------------------------------------------------- |
| `url`                         | `redis://127.0.0.1:6379` | Se ignora si pasas `client`                                     |
| `client`                      | —                        | Tu cliente ioredis para publicar (no se cierra); la suscripción usa un `duplicate()` |
| `redisOptions`                | —                        | Opciones de ioredis                                             |
| `channel`                     | `tenancy:invalidation`   | Usa uno por app si varias comparten el mismo Redis              |
| `onError`                     | —                        | Mensajes que no se pudieron leer                                |

Cómo se comporta:

- Los cambios de una misma operación viajan en un solo mensaje. Cada réplica ignora los suyos.
- La entrega es "a lo sumo una vez", como Redis pub/sub. Si un mensaje se pierde, el TTL sigue poniendo el límite. Por eso conviene un `ttlMs` corto aunque tengas invalidación.
- Si el bus falla, la escritura **no** falla: queda en el log (`cache.invalidation.publish`) y en el registro de errores.
- El bus aparece en `tenancy.health()` como `invalidation`.
- El tema no necesita mensaje: su clave de render incluye `updatedAt`.

Si cambias un tenant por fuera de `tenancy.tenants` (SQL directo, otro servicio), avisa tú:

```ts
// Cambiaste el tenant con SQL directo o desde otro servicio: avisa a todas las réplicas.
await tenancy
  .centralDb()
  .updateTable('tenancy_tenants')
  .set({ name: nuevoNombre, updated_at: new Date() })
  .where('id', '=', 'bolivar')
  .execute();
tenancy.tenants.invalidate('bolivar');
```

`tenancy.tenants.invalidate(id)` borra el tenant en esta réplica y, con bus, en las demás. Solo cubre la caché de tenants, no la de dominios. `tenancy move` lo usa al cambiar de servidor. Más en [ADR 0013](/adr/0013-mensajeria-y-cache-distribuida).

## Pools y límites de conexiones

Con una base por tenant, cada tenant activo abre su propio pool. Las cuentas importan: réplicas × pools abiertos × conexiones por pool no puede pasar el `max_connections` de tu servidor.

| Opción de `database()`   | Por defecto | Qué hace                                                            |
| ------------------------ | ----------- | ------------------------------------------------------------------- |
| `central.pool.max`       | `10`        | Conexiones del pool de la base central                              |
| `pool.max`               | `5`         | Conexiones de cada pool de tenant                                   |
| `pool.maxOpenPools`      | `100`       | Pools abiertos a la vez **por servidor**; al pasarse se cierra el menos usado (LRU) |
| `pool.idleTimeoutMs`     | `60000`     | Cierra los pools sin uso después de este tiempo (`0` = nunca)       |

Los pools se abren con la primera consulta y nunca se cierra uno que está en uso. Con los valores por defecto, una réplica puede abrir hasta 100 × 5 = 500 conexiones por servidor, más 10 de la central. Con 4 réplicas, 2 040. Ajusta `maxOpenPools` y `pool.max` a tu servidor, o reparte tenants en varios servidores (`tenancy servers:add`).

Cuando se alcanza el límite queda un log `db.pool.limit` en `warn`. Para ver el estado:

```ts
const { servers, pools } = tenancy.database.pools();
// servers: { default: { open: 37, inUse: 4, maxOpenPools: 100 } }
// pools: [{ key, serverId, refs, idleMs, ageMs }, ...]
console.log(servers, pools.length);
```

El panel muestra lo mismo en el Dashboard (`GET /admin/api/metrics`).

### ORMs

Los ORMs que abren sus propias conexiones guardan una instancia por tenant en otro LRU. Suma esas conexiones a la cuenta:

```ts
knexIntegration({ maxInstances: 50, pool: { min: 0, max: 5 } }); // hasta 50 × 5 conexiones
prismaIntegration({ client: PrismaClient, maxClients: 10 }); // PrismaClient es pesado: pocos
```

| Integración                                    | Límite de instancias   | Por defecto |
| ---------------------------------------------- | ---------------------- | ----------- |
| `knexIntegration`, `typeormIntegration`, `sequelizeIntegration`, `mikroOrmIntegration` | `maxInstances` | `50` |
| `prismaIntegration`                            | `maxClients` (y `graceMs`, 30 s antes de desconectar) | `10` |
| `drizzleIntegration`                           | no abre conexiones: usa el pool de `tenancy.db()` | —  |

Al borrar un tenant, su instancia se cierra. Detalles en [ORMs](/guia/orm).

## Llave de cifrado

`encryptionKey` (variable `TENANCY_KEY`) cifra con AES-256-GCM lo que la base central guarda como secreto:

- contraseñas de los usuarios de cada tenant (`credentials: 'per-tenant'`, donde la llave es obligatoria),
- contraseñas de administrador de los servidores (`servers:add`),
- secretos de firma de los webhooks,
- secretos 2FA del panel.

Genera la llave con `npx tenancy key:generate` (formato `base64:...`, 32 bytes; también acepta 64 caracteres hex). Guárdala en tu gestor de secretos, nunca en el repositorio. **Si la pierdes, esos secretos no se recuperan.**

### Rotación

Cada valor cifrado lleva el id de la llave con la que se cifró, así una llave nueva convive con las anteriores:

```ts
database({
  driver: postgres(),
  central: { url: process.env.DATABASE_URL! },
  encryptionKey: process.env.TENANCY_KEY, // la llave nueva: cifra todo lo que se escribe
  previousKeys: process.env.TENANCY_PREVIOUS_KEYS?.split(',') ?? [], // solo para leer lo viejo
});
```

`TENANCY_PREVIOUS_KEYS` es un nombre de ejemplo: el paquete no lee esa variable, lee lo que pases en `previousKeys`.

1. Genera una llave nueva. Ponla en `encryptionKey` y mueve la actual a `previousKeys`. Despliega en **todos** los procesos (app, workers, relay, panel).
2. Corre `npx tenancy key:rotate` (o `tenancy.database.rotateKey()`). Vuelve a cifrar con la llave actual los valores que usan otra y responde cuántos cambió. Es idempotente: si se corta, vuelve a correrlo.
3. Cuando todos los procesos usen la llave nueva y `key:rotate` responda 0, quita la vieja de `previousKeys`.

Si un proceso no tiene la llave con la que se cifró un valor, falla con `DecryptionError` (`no key with id ...`).

## Workers y relays en procesos aparte

Los trabajos, la outbox y los webhooks no deberían correr en el mismo proceso que atiende HTTP: un pico de trabajos no debe frenar las peticiones, y cada cosa escala por separado.

| Proceso        | Comando                                   | Desde código                                   |
| -------------- | ----------------------------------------- | ---------------------------------------------- |
| Worker de cola | `npx tenancy worker --entry=src/jobs.ts`  | `await tenancy.worker({ concurrency })`        |
| Relay          | `npx tenancy outbox:relay`                | `tenancy.outbox.startRelay()` y, con webhooks, `tenancy.webhooks.startDispatcher()` |
| Panel          | `npx tenancy admin:serve`                 | `serveAdmin(tenancy, options)`                 |

Los comandos del CLI se detienen con SIGINT/SIGTERM y esperan lo que está en curso. Si prefieres tu propio proceso:

```ts
// worker.ts: proceso aparte, sin servidor HTTP
tenancy.jobs.define('factura', async (data) => enviarFactura(data)); // igual que en la app

const worker = await tenancy.worker({ concurrency: 5 });
const relay = tenancy.outbox.startRelay();
const dispatcher = tenancy.webhooks.startDispatcher();

const detener = async () => {
  await worker.close(); // espera los trabajos en curso
  await relay.stop();
  await dispatcher.stop();
  await tenancy.close();
  process.exit(0);
};
process.once('SIGTERM', detener);
process.once('SIGINT', detener);
```

::: warning La cola por defecto es en memoria
Sin `queue: bullmq(...)`, la cola vive en el proceso que encola: un worker en otro proceso no ve esos trabajos y todo se pierde al reiniciar. En producción usa `@tenancy-node/queue-bullmq`. Los trabajos se definen igual (`jobs.define`) en la app y en el worker.
:::

Puedes correr varios relays a la vez: se reparten los lotes con `SKIP LOCKED` y un lote reservado por un relay que muere se retoma después de `lockMs` (60 s por defecto). La entrega es "al menos una vez": los consumidores deduplican con el `id` del CloudEvent. Más en [Eventos](/guia/eventos).

## El panel en su propio proceso

Levanta el panel aparte, en su propio puerto, y no lo expongas a internet:

```bash
TENANCY_ADMIN_SECRET=... TENANCY_KEY=... npx tenancy admin:serve --port=4000 --ui
```

- Por defecto escucha en `127.0.0.1`. Entra por VPN o túnel SSH (`ssh -L 4000:127.0.0.1:4000 servidor`).
- Si lo pones detrás de un proxy con HTTPS, deja las cookies `Secure` (no uses `--insecure-cookies`) y agrega el host del proxy a `allowedHosts` si no es un dominio central.
- Con varias réplicas del panel, el límite de intentos de login es por réplica.

Ver [Panel de administración](/guia/panel).

## Seguridad

- **SSRF en webhooks.** Solo `http`/`https`, sin credenciales en la URL, y ningún destino que resuelva a una IP interna (loopback, redes privadas, `169.254.0.0/16` de la metadata de nubes, CGNAT, multicast). Se valida al registrar o cambiar un endpoint y otra vez antes de cada entrega, y no se siguen redirecciones. `allowPrivateNetworks: true` desactiva todo esto: solo para desarrollo y tests. La validación resuelve el DNS antes de cada envío; si necesitas protección contra DNS rebinding, agrega un proxy de salida.
- **Secretos.** El paquete no escribe la llave ni las contraseñas en sus logs, y la auditoría del panel nunca guarda contraseñas ni tokens. Lo que tú pongas en `observability.report(..., context)` sí va al log: no pases secretos ahí. Las sesiones y los tokens de impersonación se guardan como SHA-256. El secreto de un webhook se muestra una sola vez, al crearlo. `servers:add` y `admin:user` leen las contraseñas de variables de entorno para que no queden en el historial.
- **Errores hacia afuera.** Los 5xx del panel responden `ADMIN_INTERNAL_ERROR` sin detalles; el detalle queda en el log.
- **CSRF.** Con cookie, el panel exige `X-CSRF-Token` en todo lo que no sea `GET`. Las cookies son `HttpOnly; SameSite=Strict; Secure`.
- **CSP.** La API responde con `default-src 'none'; frame-ancestors 'none'` y la UI con una CSP sin inline ni orígenes externos.
- **Métricas.** Expón `/metrics` en un puerto interno. Las etiquetas por tenant pueden revelar quiénes son tus clientes.
- **Health.** `/tenancy/health` responde en cualquier host y muestra los mensajes de error de cada chequeo. Si no quieres exponerlos, filtra la ruta en tu proxy.

## Apagado ordenado

`tenancy.close()` libera todo lo que abrió la instancia, en este orden: workers de la cola, listeners `async` pendientes, invalidaciones en vuelo y el bus, recursos del contexto raíz, plugins (pools de base de datos, instancias de ORM), la cola, los transportes, la caché y el almacenamiento. No cierra tu servidor HTTP: ciérralo tú primero.

```ts
import { createServer } from 'node:http';
import { withTenancy } from '@tenancy-node/adapter-node';

const server = createServer(withTenancy(tenancy, (req, res) => {
  res.end(`hola ${req.tenant?.id.value ?? 'central'}`);
}));
server.listen(3000);

process.once('SIGTERM', () => {
  // 1. deja de aceptar conexiones; 2. espera las peticiones en curso; 3. libera recursos
  server.close(async () => {
    await tenancy.close(); // listeners async, invalidaciones pendientes, pools, cola, transportes
    process.exit(0);
  });
});
```

En Fastify, `await app.close()` y luego `await tenancy.close()`.

## Checklist

- [ ] `logger: pino()` y los logs en un sistema donde puedas filtrar por `tenantId` ([Observabilidad](/guia/observabilidad)).
- [ ] `TENANCY_KEY` en un gestor de secretos, con copia de respaldo. La misma en todos los procesos.
- [ ] `invalidation: redisInvalidation(...)` si tienes más de una réplica, y un `lookupCache.ttlMs` que toleres como peor caso.
- [ ] Caché compartida (`redis()` o `memcached()`) en vez de la de memoria.
- [ ] `queue: bullmq(...)` y el worker en su propio proceso.
- [ ] `outbox:relay` en su propio proceso si usas outbox o webhooks.
- [ ] Cuentas de conexiones hechas: réplicas × `maxOpenPools` × `pool.max` (+ ORMs) por debajo del límite del servidor.
- [ ] Panel en su propio proceso, en `127.0.0.1` o red privada, con HTTPS si pasa por un proxy.
- [ ] `TENANCY_ADMIN_SECRET` de 32 caracteres o más; 2FA activada para los `owner`.
- [ ] `allowPrivateNetworks` apagado en webhooks.
- [ ] `http: { health: true }` conectado al balanceador.
- [ ] `/metrics` solo en la red interna, sin `perTenant` o con un tope.
- [ ] `tenancy.close()` en SIGTERM, después de cerrar el servidor HTTP.
- [ ] `tenancy migrate` en el despliegue, antes de levantar la versión nueva.
