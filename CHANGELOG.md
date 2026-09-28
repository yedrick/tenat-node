# Cambios

Los cambios de cada paquete desde 0.8.0 quedan en su propio `CHANGELOG.md` (los genera changesets).

## 0.8.0 — primera versión pública

- **Núcleo:** tenant por petición con `AsyncLocalStorage`, resolvers (dominio, subdominio, ruta, header), casos de uso, eventos tipados, tema y observabilidad por tenant (logs con `tenantId`, registro de errores por tenant).
- **Frameworks:** Fastify 5, Express 4/5 y `node:http`, con rutas opcionales (`/tenancy/me`, `theme.css`, archivos, health).
- **Bases de datos:** una base por tenant en MySQL/MariaDB, PostgreSQL, SQLite y SQL Server, o un schema por tenant en PostgreSQL. Credenciales compartidas o por tenant (cifradas con AES-256-GCM), varios servidores, aprovisionamiento idempotente, migraciones y `tenancy move`.
- **ORMs:** Knex, Drizzle, Prisma, TypeORM, Sequelize y MikroORM, con sus migradores.
- **Recursos por tenant:** caché (memoria, Redis/Valkey, Memcached), archivos (local, S3), colas (memoria, BullMQ) e invalidación entre instancias con Redis pub/sub.
- **Eventos:** CloudEvents, outbox transaccional, webhooks firmados, RabbitMQ, Redis Streams, Kafka y NATS JetStream.
- **Operación:** CLI (`npx tenancy`), Admin API y panel React, OpenTelemetry y Prometheus.
