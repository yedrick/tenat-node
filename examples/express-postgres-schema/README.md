# Ejemplo: Express, PostgreSQL por schema y TypeORM

Todos los tenants en **una sola base** de PostgreSQL, cada uno en su schema y con su propio rol. El rol de un tenant no puede leer el schema de otro ni las tablas centrales: si el código se equivoca, PostgreSQL lo rechaza (el test lo comprueba).

- `isolation: 'schema'` y `credentials: 'per-tenant'` en `database()`.
- TypeORM por tenant (`await tenancy.typeorm()`) con una migración de TypeORM que corre en cada schema nuevo.
- Métricas Prometheus en `/metrics`, con la ruta como plantilla y sin etiqueta de tenant.

```sh
docker run -d --name tenancy-pg -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=app -p 5432:5432 postgres:16-alpine
pnpm install && pnpm build          # en la raíz del repositorio
TENANCY_KEY=$(npx tenancy key:generate) pnpm --filter example-express-postgres-schema start

curl -X POST localhost:3000/tenants -H 'content-type: application/json' -d '{"id":"bolivar","name":"Bolívar","domain":"bolivar.test"}'
curl -X POST localhost:3000/tareas -H 'Host: bolivar.test' -H 'content-type: application/json' -d '{"titulo":"Vender entradas"}'
curl localhost:3000/tareas -H 'Host: bolivar.test'
curl localhost:3000/metrics
```

El test levanta PostgreSQL 16 con Testcontainers: `pnpm vitest run examples/express-postgres-schema`.
