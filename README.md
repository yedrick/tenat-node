# tenancy-node

Multi-tenancy para Node.js inspirado en [stancl/tenancy](https://tenancyforlaravel.com): arquitectura hexagonal, independiente del framework y con observabilidad por tenant desde el núcleo.

> Estado: **0.8.0, lista para publicar** · Documentación: https://yedrick.github.io/tenat-node/ · **Fases 0 a 8** (núcleo; bases MySQL/MariaDB, PostgreSQL —por base o por schema—, SQLite y SQL Server; CLI; caché, archivos, colas y rutas HTTP; ORMs; eventos; panel de administración; telemetría y `tenancy move`). Avance en [`docs/ROADMAP.md`](docs/ROADMAP.md), decisiones en `docs/adr/`.

## Paquetes

| Paquete                                                                                           | Qué hace                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `@tenancy-node/core`                                                                              | Dominio, casos de uso, puertos, contexto (`AsyncLocalStorage`), resolvers, EventBus, caché, tema, observabilidad y el facade `tenancy` |
| `@tenancy-node/testing`                                                                           | Suites de contrato para puertos, fakes (`FakeClock`, `MemoryLogger`) y `createTestTenancy()`                                           |
| `@tenancy-node/adapter-fastify`                                                                   | Plugin de Fastify 5                                                                                                                    |
| `@tenancy-node/adapter-express`                                                                   | Middleware de Express 4/5                                                                                                              |
| `@tenancy-node/adapter-node`                                                                      | `node:http` sin framework                                                                                                              |
| `@tenancy-node/db`                                                                                | Plugin de base de datos: repositorios Kysely, pools, aprovisionamiento, migraciones, servidores, cifrado y `move`                      |
| `@tenancy-node/db-mysql / db-postgres / db-sqlite / db-mssql`                                     | Drivers: MySQL/MariaDB, PostgreSQL (base o schema por tenant), SQLite y SQL Server                                                     |
| `@tenancy-node/cli`                                                                               | `npx tenancy` (ver [docs/cli.md](docs/cli.md))                                                                                         |
| `@tenancy-node/cache-redis / cache-memcached`                                                     | Caché por tenant en Redis/Valkey o Memcached; `redisInvalidation()` entre instancias                                                   |
| `@tenancy-node/storage-s3 / queue-bullmq`                                                         | Archivos en S3 y colas con BullMQ                                                                                                      |
| `@tenancy-node/orm-knex / orm-drizzle / orm-prisma / orm-typeorm / orm-sequelize / orm-mikro-orm` | Instancia de cada ORM por tenant (LRU) y sus migradores                                                                                |
| `@tenancy-node/outbox`                                                                            | Outbox transaccional con relay `SKIP LOCKED`                                                                                           |
| `@tenancy-node/transport-webhook / -rabbitmq / -redis-streams / -kafka / -nats`                   | Transportes de eventos (CloudEvents) y sus consumidores                                                                                |
| `@tenancy-node/otel / prometheus`                                                                 | Trazas y métricas con `tenant.id`                                                                                                      |
| `@tenancy-node/admin-api / admin-ui`                                                              | Panel de administración                                                                                                                |

## Uso rápido

```ts
import Fastify from 'fastify';
import { createTenancy } from '@tenancy-node/core';
import { tenancyPlugin } from '@tenancy-node/adapter-fastify';

const tenancy = createTenancy({ centralDomains: ['tuapp.com', 'localhost'] });
await tenancy.tenants.create({ id: 'bolivar', name: 'Club Bolívar', domain: 'clubbolivar.com' });

const app = Fastify();
await app.register(tenancyPlugin, { tenancy });
app.get('/whoami', async () => ({ tenant: tenancy.currentId() })); // bolivar.tuapp.com → "bolivar"
```

```ts
tenancy.current(); // Tenant | undefined
await tenancy.run('tigre', fn); // ejecutar en otro tenant
await tenancy.central(fn); // ejecutar en contexto central
await tenancy.runForEach(fn, { concurrency: 5 });
tenancy.cache().remember('k', 60, factory); // caché aislada por tenant
tenancy.theme().toCss(); // variables CSS del tenant
tenancy.events.on('tenant.created', listener, { mode: 'sync' | 'async' });
```

## CLI

```bash
npx tenancy init                          # detecta tu proyecto y genera la configuración
npx tenancy install                       # tablas tenancy_*
npx tenancy create bolivar --domain=bolivar.localhost
npx tenancy create --from=tenants.csv --concurrency=5
npx tenancy migrate --log-file=tenancy.log
npx tenancy run "node scripts/limpiar.js" # con DATABASE_URL de cada tenant
```

Referencia completa en [docs/cli.md](docs/cli.md).

## Base de datos (una base por tenant)

```ts
import { createTenancy } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { mysql } from '@tenancy-node/db-mysql'; // o postgres() de @tenancy-node/db-postgres

export const tenancy = createTenancy({
  centralDomains: ['tuapp.com'],
  plugins: [
    database({
      driver: mysql(),
      central: { url: process.env.DATABASE_URL! },
      encryptionKey: process.env.TENANCY_KEY, // generateEncryptionKey()
      credentials: 'per-tenant', // o 'shared'
      migrations: { tenant: './migrations/tenant' }, // .sql, módulos Kysely u objeto
      seed: async (db, tenant) => {
        /* datos iniciales */
      },
    }),
  ],
});

await tenancy.database.install(); // tablas tenancy_* (idempotente)
await tenancy.tenants.create({ id: 'bolivar', domain: 'bolivar.tuapp.com' }); // crea tenant_bolivar

await tenancy.run('bolivar', async () => {
  await tenancy.db().selectFrom('productos').selectAll().execute(); // Kysely
  await tenancy.sql`SELECT * FROM productos WHERE precio > ${50}`; // SQL parametrizado
  await tenancy.centralDb().selectFrom('planes').selectAll().execute();
});

await tenancy.database.migrate({ concurrency: 5 }); // todos los tenants
await tenancy.database.servers.add({ id: 'mysql-2', host: '10.0.0.5', maxTenants: 500 });
```

Ejemplo completo en `examples/fastify-mysql`. Detalles en [ADR 0006](docs/adr/0006-base-de-datos.md).

## Caché, archivos, colas y rutas HTTP

```ts
import { redis } from '@tenancy-node/cache-redis';
import { s3 } from '@tenancy-node/storage-s3';
import { bullmq } from '@tenancy-node/queue-bullmq';

const tenancy = createTenancy({
  cache: redis({ url: process.env.REDIS_URL }),
  storage: s3({ bucket: 'mi-app', publicUrl: 'https://cdn.tuapp.com' }),
  queue: bullmq({ url: process.env.REDIS_URL }),
  http: { me: true, theme: true, health: true }, // todo apagado por defecto
  publicFields: ['name', 'locale', 'features'],
});

await tenancy.cache().remember('productos', 60, cargarProductos); // tenant:{id}:productos
await tenancy.storage().put('logos/logo.png', archivo); // bucket/bolivar/logos/logo.png

tenancy.jobs.define('factura', async (data, { tenant }) => {
  /* corre en el contexto del tenant */
});
await tenancy.jobs.dispatch('factura', { pedidoId: 123 });
tenancy.events.on('tenant.created', enviarBienvenida, { mode: 'queue', retries: 5 });
// en otro proceso: npx tenancy worker --entry=src/jobs.ts
```

Con un ORM:

```ts
plugins: [database({...}), knexIntegration(), drizzleIntegration({ drizzle }), prismaIntegration({ client: PrismaClient })]
tenancy.knex()('clientes').select();
tenancy.drizzle(schema).select().from(productos);
tenancy.prisma().producto.findMany();
// npx tenancy schema --prisma --out=prisma/tenancy.prisma
```

## Eventos hacia otros servicios

```ts
import { outbox } from '@tenancy-node/outbox';
import { webhooks } from '@tenancy-node/transport-webhook';
import { rabbitmq } from '@tenancy-node/transport-rabbitmq';

const tenancy = createTenancy({
  events: { transports: [rabbitmq({ url: process.env.RABBIT_URL! })] },
  plugins: [database({...}), outbox(), webhooks()],
});

tenancy.events.forward('tenant.created', { transport: 'rabbitmq' });      // CloudEvents 1.0
tenancy.events.define('pedido.creado', v.object({ pedidoId: v.number() })); // validación Valibot
await tenancy.webhooks.register({ tenant: 'bolivar', name: 'ERP', url: 'https://erp.bolivar.bo/hook', events: ['pedido.*'] });
// en otro proceso: npx tenancy outbox:relay
```

El receptor verifica la firma con `verifyWebhook({ secret, body, header })`. Ejemplo completo con un microservicio independiente en `examples/microservicio-emails`.

## Panel de administración (API)

```bash
npx tenancy admin:user tu@email.com --role=owner   # muestra la contraseña generada una sola vez
TENANCY_ADMIN_SECRET=$(openssl rand -base64 48) npx tenancy admin:serve --port=4000 --ui   # panel en http://127.0.0.1:4000/admin/ (solo local: VPN o túnel SSH)
# documentación: http://127.0.0.1:4000/admin/api/openapi.json
```

La 2FA del panel y los webhooks guardan sus secretos cifrados: necesitan `encryptionKey` (`TENANCY_KEY`) en el plugin de base de datos. Sin ella, `POST /auth/2fa/setup` y `/auth/2fa/enable` responden 501 `TENANCY_ENCRYPTION_KEY_MISSING`.

O dentro de tu app: `app.use(adminMiddleware(createAdminApi(tenancy, { sessionSecret })))` en Express, o `registerAdminFastify(app, api)` en Fastify (antes de `tenancyPlugin`). Detalles de seguridad en [ADR 0010](docs/adr/0010-admin-api.md).

## Observabilidad

Cada operación y cada petición deja una línea JSON con `tenantId`, `operation`, `outcome`, `durationMs` y, si falla, `code`, `errorId` y el error con stack. Los errores también se guardan por tenant:

```ts
tenancy.observability.errors({ tenantId: 'bolivar' }); // errores recientes de bolivar
tenancy.observability.summary(); // totales por tenant y por código
tenancy.observability.logger.info({ pedidoId }, 'ok'); // tu log, con tenantId automático
```

Detalles y convenciones en [ADR 0005](docs/adr/0005-observabilidad.md). Para producción: `createTenancy({ logger: pino() })`.

## Más motores, mensajería y telemetría (Fase 8)

```ts
// PostgreSQL con un schema por tenant (en una sola base física)
database({ driver: postgres(), central: { url }, isolation: 'schema', credentials: 'per-tenant' });
// SQLite (un archivo por tenant) o SQL Server
database({
  driver: sqlite({ directory: './data' }),
  central: { url: 'sqlite://local/central' },
});
database({ driver: mssql(), central: { url: 'mssql://sa:...@localhost:1433/app' } });

createTenancy({
  cache: memcached({ servers: process.env.MEMCACHED_SERVERS }),
  // Con varias réplicas: los cambios de tenants y dominios llegan a todas al instante
  invalidation: redisInvalidation({ url: process.env.REDIS_URL }),
  // Trazas con tenant.id y traceId en los logs; métricas sin tenant por defecto (cardinalidad)
  telemetry: [openTelemetry(), prometheus({ perTenant: { maxTenants: 50 } })],
  events: { transports: [kafka({ brokers: ['kafka:9092'] }), nats({ servers: 'nats:4222' })] },
});

await tenancy.database.move('bolivar', { to: 'pg-2' }); // o: npx tenancy move bolivar --to=pg-2
```

Decisiones y límites en los ADR [0012](docs/adr/0012-mas-motores.md), [0013](docs/adr/0013-mensajeria-y-cache-distribuida.md), [0014](docs/adr/0014-telemetria.md) y [0015](docs/adr/0015-mover-tenants.md).

## Desarrollo

```bash
corepack enable
pnpm install
pnpm check          # lint + typecheck + reglas de arquitectura + build + tests
pnpm coverage       # incluye los tests de integración con MySQL y PostgreSQL (Testcontainers, requiere Docker)
TENANCY_SKIP_DB_TESTS=1 pnpm test   # sin Docker
docker compose up -d   # MySQL, PostgreSQL, Valkey y MinIO (para las fases siguientes)
pnpm --filter example-fastify-memory start
```

Las reglas de capas se verifican con `pnpm depcruise`: el dominio no importa nada externo, los casos de uso solo dominio y puertos, y el núcleo solo depende de `valibot`.
