# Hoja de ruta

Estado de cada fase del plan (v3). `[x]` = hecho y verificado con tests; `[ ]` = pendiente.

## Fase 0 — Base del proyecto ✅

- [x] Monorepo con pnpm, Turborepo, tsup, Vitest, ESLint, Changesets
- [x] dependency-cruiser con las reglas de capas
- [x] CI en GitHub Actions (Node 20 / 22)
- [x] Docker Compose con MySQL, Postgres, Valkey y MinIO
- [x] Primeros ADRs (arquitectura hexagonal, Kysely, AsyncLocalStorage, DI manual, observabilidad)

## Fase 1 — Núcleo ✅

- [x] Dominio: `Tenant`, `Domain`, `Theme`, value objects y errores
- [x] Puertos (interfaces)
- [x] Contexto con `AsyncLocalStorage` (`run`, `current`, `central`, `runForEach`)
- [x] Resolvers y cadena
- [x] `CachedTenantRepository` (decorator con LRU) + `CachedDomainRepository`
- [x] `EventBus` en proceso con modos `sync` y `async`
- [x] Facade `tenancy` y composition root
- [x] Adaptadores Fastify, Express y `node:http`
- [x] Paquete `testing` con tests de contrato
- [x] **Tests de aislamiento concurrente**
- [x] Observabilidad: logs estructurados con `tenantId`, registro de errores por tenant (ADR 0005)

## Fase 2 — Base de datos ✅

Verificado contra motores reales con Testcontainers: MySQL 8, MariaDB 11 y PostgreSQL 16 (24 tests de integración cada uno).

- [x] Migraciones del paquete: todas las tablas `tenancy_*` para MySQL y PostgreSQL
- [x] Repositorios de tenants, dominios y servidores (pasan las mismas suites de contrato que los de memoria)
- [x] Cifrado AES-256-GCM de credenciales con rotación de llaves (`database.rotateKey()`)
- [x] Integración Kysely y `ConnectionPoolRegistry` con LRU por servidor
- [x] Driver MySQL/MariaDB (base por tenant, credenciales compartidas o por tenant)
- [x] Driver PostgreSQL (base por tenant, credenciales compartidas o por tenant)
- [x] Pipeline de aprovisionamiento idempotente, con candados, estados, reintentos y limpieza
- [x] Estrategias de ubicación en varios servidores (`least-tenants`, `weighted`, `fixed`, función propia)
- [x] `centralDb()`, acceso entre tenants y `tenancy.sql` (SQL puro parametrizado)
- [x] Puerto `Migrator` con Kysely y archivos `.sql`
- [x] Ejemplo `examples/fastify-mysql` funcionando

## Fase 3 — CLI ✅

Probado de punta a punta contra PostgreSQL real, también como binario (`node dist/bin.js`). Detalles en [docs/cli.md](cli.md) y ADR 0007.

- [x] `init` (con detección de framework, ORM, lenguaje, tipo de módulos, motor y gestor de paquetes), `install`, `create`, `list`, `migrate`, `rollback`, `seed`, `run`, `delete`
- [x] `servers:add`, `servers:list`, creación masiva desde CSV (validación previa, concurrencia, `--dry-run`), `key:rotate`
- [x] Extras: `migrate:status`, `key:generate`, `--json`, `--log-file`, `--verbose`, códigos de salida, confirmación en `delete`

> **Hito v0.1 ✅:** usable en un proyecto real con MySQL o Postgres.

## Fase 4 — Caché, archivos, colas y tema ✅

Verificado contra servicios reales con Testcontainers: Valkey 8 (caché y BullMQ), SeaweedFS (S3) y PostgreSQL 16 (Knex y Drizzle). Detalles en ADR 0008.

- [x] Caché: Redis/Valkey (`SCAN` + `UNLINK` para vaciar un tenant), memoria y `remember()`
- [x] Archivos: local, memoria y S3 (URLs públicas o firmadas), con rutas protegidas contra `../`
- [x] Colas: BullMQ y memoria, `tenancy.jobs`, `tenancy.worker()`, modo `queue` de eventos y comando `tenancy worker`
- [x] Tema por tenant: helpers (`toCss`, `toJson`, ETag) y caché
- [x] Ruta `/tenancy/theme.css` (ETag y 304)
- [x] `/tenancy/me` (solo `publicFields`)
- [x] Rutas HTTP opcionales (`http.me`, `http.theme`, `http.assets`, `http.health`), apagadas por defecto, en Fastify, Express y node:http
- [x] Integraciones ORM: Prisma, Drizzle y Knex (instancia por tenant con LRU, y sus migradores)
- [x] `tenancy schema` para generar modelos de las tablas centrales (Prisma, Drizzle y TypeORM)
- [ ] Colas separadas por tenant (hoy: cola compartida con `tenantId` en cada trabajo)
- [ ] Prueba de `orm-prisma` contra un cliente Prisma generado real (hoy: cliente de reemplazo)

## Fase 5 — Eventos avanzados ✅

Verificado contra servicios reales: PostgreSQL 16 y MySQL 8 (outbox), RabbitMQ 4 y Valkey 8 (Redis Streams), y un servidor HTTP que verifica las firmas. Detalles en ADR 0009.

- [x] Sobre CloudEvents y catálogo tipado (`TenancyEventMap` + esquemas Valibot para eventos propios)
- [x] Outbox + relay con `SKIP LOCKED` (varios relays en paralelo, lease, dead-letter, reenvío, limpieza)
- [x] Transporte webhook con HMAC, reintentos, circuit breaker y dead-letter (más SSRF y timeouts)
- [x] Transportes Redis Streams y RabbitMQ (con consumidores)
- [x] Ejemplo `microservicio-emails` (probado de punta a punta, idempotente)
- [x] CLI: `outbox:relay`, `outbox:status`, `outbox:retry`

> **Hito v0.3 ✅:** eventos listos para producción.

## Fase 6 — Admin API ✅

Probada por HTTP real contra PostgreSQL 16 (sin sesión, sin CSRF, con el rol equivocado, desde el host de un tenant, con bodies inválidos). Detalles en ADR 0010.

- [x] Autenticación (argon2id, sesiones con cookie o Bearer, CSRF, límite de intentos, 2FA TOTP), roles y auditoría
- [x] Endpoints de tenants, dominios, tema, migraciones y caché
- [x] Progreso en vivo (SSE)
- [x] Explorador de datos (solo lectura, columnas sensibles ocultas)
- [x] Webhooks, outbox y dead-letter
- [x] Impersonación (tokens de un solo uso)
- [x] Documentación OpenAPI 3.1
- [x] `admin:serve` en proceso y puerto separados (y `admin:user`); montaje en Express y Fastify
- [ ] Edición de datos desde el explorador (por rol y con auditoría)

## Fase 7 — Admin UI ✅

Probada en Chromium real contra PostgreSQL (Playwright), con CSP estricta y sin errores en la consola. Detalles en ADR 0011.

- [x] Login (con 2FA y aviso de bloqueo) y layout
- [x] Dashboard con métricas (tenants por estado, salud, outbox, pools y errores por tenant)
- [x] Tenants: lista con búsqueda y filtros, creación con progreso en vivo y detalle
- [x] Editor de tema con vista previa
- [x] Dominios, migraciones y explorador de datos
- [x] Webhooks e historial de entregas (y dead-letter de la outbox)
- [x] Usuarios y auditoría (y "Mi cuenta": contraseña y 2FA)
- [ ] Traducción a otros idiomas (hoy solo español)

> **Hito v0.5 ✅:** paquete con panel de administración completo.

## Fase 8 — Más drivers y transportes ✅

Verificado contra servicios reales con Testcontainers: PostgreSQL 16 (base y schema), SQLite, SQL Server 2022, MySQL 8, Memcached 1.6, Kafka 3.9, NATS 2 (JetStream) y Valkey 8. Detalles en los ADR 0012 a 0015.

- [x] PostgreSQL modo schema (con rol por tenant que no puede leer otros schemas)
- [x] SQLite
- [x] SQL Server
- [x] Memcached
- [x] Transportes Kafka y NATS (con consumidores)
- [x] Invalidación entre instancias con Redis pub/sub
- [x] OpenTelemetry y métricas Prometheus
- [x] Integraciones ORM: TypeORM, Sequelize y MikroORM
- [x] `tenancy move` para mover un tenant entre servidores
- [ ] `tenancy move` para SQL Server y SQLite, y test propio en modo schema
- [ ] `tenancy schema` para SQLite y SQL Server; Drizzle en modo schema

> **Hito v0.8 ✅:** cuatro motores, cinco transportes, seis ORMs y telemetría.

## Fase 9 — Publicación

Paquetes verificados como se publican: `pnpm pack`, publint, arethetypeswrong y una app de humo instalada con npm fuera del monorepo (ESM, CJS y el binario `tenancy`). Detalles en `scripts/check-packages.mjs`.

- [x] Sitio de documentación con guías y referencia (VitePress: 15 guías con ejemplos que compilan, referencia de la API con TypeDoc y los ADR; se publica en GitHub Pages)
- [x] Ejemplos funcionando en `examples/` (4, cada uno con su test contra el motor real)
- [x] Benchmarks publicados (núcleo, costo por petición en HTTP y carga con base de datos)
- [x] Prueba de carga con 10 000 tenants (PostgreSQL por schema: 10 000 creados en 55 s; 4 551 req/s con una consulta por petición y 0 respuestas con el tenant equivocado en 197 337)
- [x] Metadatos de publicación, CHANGELOG y workflows de CI, documentación y release (changesets con provenance)
- [ ] Publicar en npm (0.8.0)

> **Hito v1.0:** versión estable.
