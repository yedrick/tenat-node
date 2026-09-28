# ADR 0008 — Caché, archivos, colas, rutas HTTP e integraciones con ORMs

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Decisiones

1. **Mismo patrón para cada recurso.** Un puerto crudo que no conoce tenants (`CacheStore`, `StorageDriver`, `QueueDriver`) y un envoltorio que aísla por tenant (`TenantCache` → `tenant:{id}:`, `TenantStorage` → `{id}/`, trabajos con `tenantId`). Los drivers de memoria vienen en el núcleo; Redis/Valkey, S3 y BullMQ son paquetes aparte. Cada driver pasa la misma suite de contrato (`@tenancy-node/testing`).
2. **Rutas de archivo seguras.** `normalizeStoragePath` rechaza `..`, rutas absolutas, `\` y bytes nulos, y el driver local verifica además que la ruta final quede dentro de su raíz.
3. **Colas.** `tenancy.jobs.define/dispatch` y `tenancy.worker()`. Cada trabajo corre en el contexto de su tenant. Los intentos con reintentos pendientes quedan como `warn` y el último intento fallido como `error` (`operation: queue.job`). El modo `queue` de los eventos es un trabajo interno `event:<nombre>`: la petición espera solo a que quede encolado.
4. **Rutas HTTP opcionales independientes del framework.** `TenancyHttpRoutes` devuelve `{ status, headers, body }` y los adaptadores solo la conectan. Todas apagadas por defecto; `/tenancy/health` responde en cualquier host (balanceadores); las rutas de tenant nunca responden en el contexto central; `/tenancy/me` solo muestra `publicFields`.
5. **ORMs.** `tenancy.knex()` y `tenancy.prisma()`: una instancia por conexión de tenant en un LRU (`TenantInstances`); al descartarla se cierra después de un tiempo de gracia para no cortar consultas en curso. `tenancy.drizzle()` reutiliza el pool nativo del tenant (no abre conexiones). La app pasa sus propias funciones (`drizzle`, `migrate`, `PrismaClient`), así los tipos del ORM quedan del lado de la app y el paquete no fija versiones.
6. **Migradores externos.** El puerto `TenancyMigrator` recibe un `MigrationContext` (conexión, URL y pool nativo del tenant) para Knex, Drizzle y Prisma (`prisma migrate deploy` con la `DATABASE_URL` del tenant).
7. **Errores de pools.** Los pools de `pg`/`mysql2` tienen manejador de `'error'` (sin él, un reinicio de la base tumba el proceso); el error queda como `db.pool.error`.
8. **`tenancy schema`** genera modelos Prisma, Drizzle o TypeORM leyendo `information_schema` de la base real (en MariaDB, JSON se reconoce por `CHECK (json_valid(...))`).

## Pendiente

- Colas separadas por tenant (hoy: una cola compartida con `tenantId` en cada trabajo).
- Probar `orm-prisma` contra un Prisma generado real (hoy: cliente de reemplazo y migrador con un proceso real).
- La imagen `minio/minio` ya no se publica: los tests de S3 usan SeaweedFS.
