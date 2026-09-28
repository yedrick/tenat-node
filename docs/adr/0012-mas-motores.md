# ADR 0012 — PostgreSQL en modo schema, SQLite y SQL Server

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Decisiones

1. **Modo schema (`isolation: 'schema'`, solo PostgreSQL).** Todos los tenants viven en una base física (`schemaDatabase`, por defecto la central) y cada uno tiene su schema. Con credenciales compartidas hay **un pool base por servidor** y, por tenant, una instancia Kysely que fija `search_path` en cada conexión reservada. Sin `public` en el `search_path`, así una tabla que no existe en el schema del tenant falla y no lee la de otro. Con `credentials: 'per-tenant'`, cada tenant tiene un rol dueño solo de su schema: aunque el código se equivoque, **PostgreSQL** impide leer otro schema o las tablas centrales (hay un test que lo prueba).
2. **El driver declara lo que sabe hacer** (`supportsSchemas`, `scope`, `createSchema`, `grantSchema`...). El plugin valida la configuración al arrancar: modo schema con un driver sin schemas, o credenciales por tenant en SQLite, son errores de configuración y no fallos a mitad del aprovisionamiento.
3. **SQLite** (`better-sqlite3`): un archivo por tenant (`<directorio>/<base>.sqlite`) con WAL, `busy_timeout` y `foreign_keys = ON`. No tiene usuarios ni `information_schema`. El candado es un `Map` a nivel de módulo: sirve dentro de **un solo proceso**. Es para desarrollo, tests y apps de escritorio o edge.
4. **SQL Server** (Tedious + tarn): candados con `sp_getapplock`, login + usuario `db_owner` por tenant, `SINGLE_USER WITH ROLLBACK IMMEDIATE` antes de borrar una base, y deadlocks (1205/1222) como errores transitorios que se reintentan.
5. **Las diferencias de SQL viven en `dialect.ts`** (`insertReturningId`, `likeLower`, `paginate`) y en `MssqlDdlPlugin`, que traduce los tipos (`varchar → nvarchar`, `boolean → bit`, `RESTRICT → NO ACTION`). Los repositorios siguen siendo uno solo para los cuatro motores y pasan la misma suite de contrato.
6. **ORMs.** Knex, TypeORM, Sequelize y MikroORM fijan el `search_path` en modo schema. Drizzle no (su driver no lo permite de forma segura) y lo rechaza con un error claro. TypeORM, Sequelize y MikroORM traen su migrador, se prueban con `EntitySchema`/`Model.init` en ambos modos contra PostgreSQL. Aceptan MySQL y SQL Server (arman la conexión), pero esos dos motores todavía no tienen test propio con cada ORM; en SQL Server, la configuración TLS (`trustServerCertificate`) la pones tú en las opciones del ORM. Drizzle y Prisma aceptan solo MySQL y PostgreSQL, y lo verifican al conectar. MikroORM se fija en la v6 porque la v7 exige Node 22.

## Consecuencias

- La suite de integración recibe `isolation` y `capabilities`, y lo que un motor no tiene se salta en vez de fallar: PostgreSQL (base y schema) 25/25, SQLite 22 + 3 saltados, SQL Server 2022 24 + 1 saltado.
- `tenancy schema` (modelos de las tablas centrales) no está disponible para SQLite ni SQL Server.
