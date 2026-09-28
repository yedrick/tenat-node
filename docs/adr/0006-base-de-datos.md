# ADR 0006 — Base de datos: plugin, tablas centrales y aprovisionamiento

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Contexto

La Fase 2 agrega MySQL/MariaDB y PostgreSQL (una base por tenant) sin que el núcleo conozca Kysely ni ningún motor.

## Decisiones

1. **Plugin, no dependencia del núcleo.** `@tenancy-node/db` es un `TenancyPlugin`: aporta los repositorios SQL, el aprovisionamiento, el `DatabaseBootstrapper` y los métodos `db()`, `centralDb()`, `sql`, `pool()` y `database.*`. `createTenancy({ plugins: [database({ driver: mysql(), ... })] })` los tipa automáticamente.
2. **Drivers como Strategy.** `@tenancy-node/db-mysql` y `@tenancy-node/db-postgres` implementan `DatabaseDriver` (crear/borrar bases y usuarios, candados, detección de duplicados). `@tenancy-node/db` no importa `mysql2` ni `pg` (regla `db-is-engine-agnostic`).
3. **Una sola fuente de migraciones** para las 11 tablas `tenancy_*`, escrita con el schema builder de Kysely. El prefijo se aplica con `TablePrefixPlugin`, así las consultas del paquete usan nombres cortos y tipados.
4. **Columnas de base del tenant anulables.** `database_server_id` y `database_name` quedan en `NULL` hasta que el aprovisionamiento ubica al tenant (el plan v3 las tenía `NOT NULL`). Así un tenant puede existir antes de tener base y se evita inventar un nombre antes de validar colisiones.
5. **Tablas de control.** Migraciones del paquete: `tenancy_migrations` (central). Tus migraciones centrales: `tenancy_central_migrations`. Migraciones de cada tenant: `tenancy_migrations` en su base. El `Migrator` de Kysely agrega su tabla de candado `*_lock`.
6. **Aprovisionamiento idempotente con candado.** `GET_LOCK` / `pg_try_advisory_lock` por tenant; cada paso queda en `tenancy_provisioning_steps` y en el log (`operation: provisioning.step`). Al reintentar se saltan los pasos que ya terminaron (salvo si hubo `cleanup`), así el seed no corre dos veces.
7. **Inserción que detecta duplicados.** `TenantWriter.insert` y `DomainWriter.create` lanzan `TenantAlreadyExistsError` / `DomainAlreadyTakenError` a partir de la restricción única de la base: dos creaciones en paralelo nunca crean el mismo tenant.
8. **Pools con conteo de referencias.** `ConnectionPoolRegistry` (LRU por servidor) nunca cierra un pool en uso; si todos están ocupados excede el límite temporalmente, lo avisa en el log y vuelve al límite al liberarse.
9. **Secretos cifrados con AES-256-GCM** (`tn1.<kid>.<iv>.<tag>.<datos>`). El id de la llave permite convivir con llaves anteriores (`previousKeys`) y `database.rotateKey()` vuelve a cifrar todo.

## Consecuencias

- En MySQL el DDL no es transaccional: si `install()` falla a mitad, hay que revisar la base antes de reintentar.
- Crear el tenant y sus dominios todavía no es atómico: si falla el alta de un dominio, el tenant queda creado sin él (la outbox de la Fase 5 hace atómicos los eventos, no esta alta).
- Los tests de integración usan Testcontainers (Docker). `TENANCY_SKIP_DB_TESTS=1` los salta.
