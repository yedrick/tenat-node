# Introducción

tenancy-node es un conjunto de paquetes para construir aplicaciones multi-tenant en Node.js: una sola aplicación que atiende a muchos clientes (tenants), cada uno con sus propios datos, dominio, caché, archivos y tema. Está inspirado en [stancl/tenancy](https://tenancyforlaravel.com) y es independiente del framework: funciona con Fastify, Express o `node:http`.

## El problema

Cuando una app sirve a varios clientes, cada petición tiene que responder varias preguntas antes de tocar un dato:

- **¿De quién es esta petición?** `clubbolivar.com`, `tigre.tuapp.com` o `tuapp.com` (la app central).
- **¿Dónde están sus datos?** Su base, su prefijo de caché, su carpeta de archivos.
- **¿Cómo creo un cliente nuevo?** Crear la base, correr las migraciones, cargar datos iniciales, y saber qué pasó si algo falla a la mitad.
- **¿Cómo corro algo en todos?** Migrar 500 bases, limpiar la caché de cada uno, sin saturar el servidor.
- **¿Qué tenant falló?** "Algo falló" no sirve con cientos de clientes.

tenancy-node responde esas preguntas en un solo lugar y deja tu código de negocio sin parámetros `tenantId` por todas partes.

```ts
import { createTenancy } from '@tenancy-node/core';

const tenancy = createTenancy({ centralDomains: ['tuapp.com'] });
await tenancy.tenants.create({ id: 'bolivar', domain: 'bolivar.tuapp.com' });

async function totalPedidos() {
  // Ningún parámetro "tenant": el contexto lo sabe.
  return { tenant: tenancy.currentId(), total: await tenancy.cache().get<number>('pedidos') };
}

await tenancy.run('bolivar', totalPedidos); // { tenant: 'bolivar', ... }
```

## Ideas principales

### Arquitectura hexagonal

`@tenancy-node/core` tiene el dominio (tenants, dominios, tema, eventos, errores), los casos de uso y los **puertos**: interfaces como `TenantRepository`, `DomainRepository`, `CacheStore`, `StorageDriver`, `QueueDriver`, `EventTransport` o `Logger`. El núcleo solo depende de `valibot`.

Cada motor concreto es un **adaptador** en su propio paquete: MySQL, Redis, S3, BullMQ, RabbitMQ... Agregar uno es implementar un puerto, sin tocar el núcleo. Las reglas de capas se verifican en el CI con `dependency-cruiser`, y cada puerto tiene una suite de contrato en `@tenancy-node/testing`. Detalles en el [ADR 0001](/adr/0001-arquitectura-hexagonal).

### Contexto del tenant con `AsyncLocalStorage`

El tenant actual vive en un `AsyncLocalStorage` de `node:async_hooks`, nunca en una variable global. El adaptador HTTP abre el contexto al recibir la petición y todo el código asíncrono que corre dentro lo hereda: `tenancy.current()`, `tenancy.db()` o `tenancy.cache()` funcionan en cualquier función, sin pasar el tenant como parámetro. Dos peticiones concurrentes de tenants distintos no se mezclan.

Fuera de HTTP (scripts, jobs, tests) abres el contexto tú con `tenancy.run('bolivar', fn)`. Ver [Conceptos](/guia/conceptos) y el [ADR 0003](/adr/0003-async-local-storage).

::: warning Límite conocido
Las librerías que guardan callbacks en colas propias pueden perder el contexto. Si ves `tenancy.current()` vacío dentro de un callback, envuélvelo en `tenancy.run()`.
:::

### Una base (o un schema) por tenant

Con `@tenancy-node/db` cada tenant tiene su propia base: `tenant_bolivar`, `tenant_tigre`. Crear un tenant crea la base, su usuario (opcional), corre las migraciones y el seed. Hay drivers para MySQL/MariaDB, PostgreSQL, SQLite (un archivo por tenant) y SQL Server.

En PostgreSQL también puedes usar **un schema por tenant** dentro de una sola base (`isolation: 'schema'`), útil en hostings que no permiten `CREATE DATABASE`. Las credenciales pueden ser compartidas o propias de cada tenant, con la contraseña cifrada con AES-256-GCM.

El paquete no filtra filas por una columna `tenant_id` en tablas compartidas: el aislamiento es siempre por base o por schema. Ver [Base de datos](/guia/base-de-datos) y los ADR [0006](/adr/0006-base-de-datos) y [0012](/adr/0012-mas-motores).

### Observabilidad por tenant

Cada operación (`tenants.create`, `http.request`, `tenancy.runForEach.item`...) deja una línea de log JSON con `tenantId`, `operation`, `outcome` y `durationMs`; si falla, también `code`, `errorId` y el error con stack. Los errores se guardan además por tenant, en memoria:

```ts
tenancy.observability.errors({ tenantId: 'bolivar' }); // errores recientes de bolivar
tenancy.observability.summary(); // totales por tenant y por código
```

Ver [Observabilidad](/guia/observabilidad) y el [ADR 0005](/adr/0005-observabilidad).

## Mapa de paquetes

Todos se publican bajo `@tenancy-node/`. Solo necesitas `core` y el adaptador de tu framework para empezar.

**Núcleo**

| Paquete   | Qué hace                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------- |
| `core`    | Dominio, puertos, contexto, resolvers, eventos, caché, archivos, colas, tema y el facade `tenancy` |
| `testing` | Suites de contrato para puertos, fakes (`FakeClock`, `MemoryLogger`) y `createTestTenancy()`       |
| `cli`     | `npx tenancy`: `init`, `install`, `create`, `migrate`, `run`, `move`, `worker`...                  |

**Frameworks**

| Paquete           | Qué hace                                                 |
| ----------------- | -------------------------------------------------------- |
| `adapter-fastify` | Plugin de Fastify 5                                      |
| `adapter-express` | Middleware y manejador de errores para Express 4 y 5     |
| `adapter-node`    | `withTenancy()` para `node:http` sin framework            |

**Base de datos y ORMs**

| Paquete                                                                     | Qué hace                                                                      |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `db`                                                                        | Plugin de base de datos: repositorios Kysely, pools, aprovisionamiento, migraciones, servidores, cifrado y `move` |
| `db-mysql`, `db-postgres`, `db-sqlite`, `db-mssql`                          | Drivers de MySQL/MariaDB, PostgreSQL (base o schema), SQLite y SQL Server     |
| `orm-knex`, `orm-drizzle`, `orm-prisma`, `orm-typeorm`, `orm-sequelize`, `orm-mikro-orm` | Una instancia del ORM por tenant y su migrador                   |

**Caché, archivos y colas**

| Paquete                          | Qué hace                                                       |
| -------------------------------- | -------------------------------------------------------------- |
| `cache-redis`, `cache-memcached` | Caché por tenant en Redis/Valkey o Memcached; `redisInvalidation()` entre instancias |
| `storage-s3`                     | Archivos en S3 y compatibles (R2, Spaces, MinIO...)            |
| `queue-bullmq`                   | Colas con BullMQ                                               |

**Eventos**

| Paquete                                                                  | Qué hace                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `outbox`                                                                 | Outbox transaccional con relay `SKIP LOCKED` y dead-letter  |
| `transport-webhook`                                                      | Webhooks firmados con HMAC, reintentos y protección SSRF    |
| `transport-rabbitmq`, `transport-redis-streams`, `transport-kafka`, `transport-nats` | Transportes de eventos (CloudEvents) y sus consumidores |

**Telemetría y administración**

| Paquete                 | Qué hace                                                            |
| ----------------------- | ------------------------------------------------------------------- |
| `otel`, `prometheus`    | Trazas y métricas con `tenant.id`                                   |
| `admin-api`, `admin-ui` | API REST del panel de administración y su interfaz (React)          |

## Siguientes pasos

- [Primeros pasos](/guia/empezar): instala, crea tu primer tenant y pruébalo por subdominio.
- [Conceptos](/guia/conceptos): tenants, estados, contexto, resolvers, bootstrappers y plugins.
- [Frameworks](/guia/frameworks): Fastify, Express y `node:http` en detalle.
- [Base de datos](/guia/base-de-datos): una base por tenant, migraciones y servidores.
- [CLI](/guia/cli): todos los comandos de `npx tenancy`.
- [Referencia de la API](/referencia/api/@tenancy-node/core/): tipos y firmas generados del código.
