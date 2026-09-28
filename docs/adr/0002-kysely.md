# ADR 0002 — Kysely como capa SQL

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Contexto

Se necesita hablar con MySQL/MariaDB y PostgreSQL (y después SQLite y SQL Server), generar el DDL de las tablas `tenancy_*` para cada motor y exponer una API tipada al usuario, sin imponer un ORM.

## Decisión

Se usa Kysely: es liviano, tiene dialectos para todos los motores objetivo, incluye un migrador y tipado de consultas. Kysely vive **solo** en el paquete `@tenancy-node/db` y en los drivers; el núcleo no lo importa.

## Consecuencias

- Las migraciones del paquete se escriben una vez con el schema builder de Kysely.
- Los usuarios de otros ORM usan los paquetes `orm-*`, que reciben la conexión del tenant desde el puerto `ConnectionProvider`.
