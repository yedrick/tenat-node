# Ejemplo: Fastify con MySQL (una base por tenant)

Cada tenant tiene su propia base de MySQL, creada, migrada (`migrations/tenant/*.sql`) y sembrada al crearlo. Con `TENANCY_KEY`, además, su propio usuario de MySQL con la contraseña cifrada en la base central.

```sh
docker run -d --name tenancy-mysql -e MYSQL_ROOT_PASSWORD=secret -e MYSQL_DATABASE=tenancy -p 3306:3306 mysql:8.0
pnpm install && pnpm build          # en la raíz del repositorio
TENANCY_KEY=$(npx tenancy key:generate) pnpm --filter example-fastify-mysql start

curl -H 'Host: bolivar.localhost' localhost:3000/productos
curl -H 'Host: bolivar.localhost' -H 'content-type: application/json' \
     -d '{"nombre":"Gorra","precio":50}' localhost:3000/productos
curl -H 'Host: localhost' localhost:3000/admin/estado   # tenants, pools y errores por tenant
```

El test (`test/app.test.ts`) levanta MySQL 8 con Testcontainers: `pnpm vitest run examples/fastify-mysql`.
