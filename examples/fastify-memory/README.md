# Ejemplo: Fastify con tenants en memoria

Lo mínimo para ver tenancy-node funcionando, sin base de datos: dos tenants creados al arrancar, identificados por subdominio.

```sh
pnpm install && pnpm build          # en la raíz del repositorio
pnpm --filter example-fastify-memory start

curl -H 'Host: bolivar.localhost' localhost:3000/whoami      # {"tenant":"bolivar",...}
curl -H 'Host: tigre.localhost'   localhost:3000/theme.css   # variables CSS del tema de tigre
curl -H 'Host: tigre.localhost'   localhost:3000/boom        # 500, queda en el log con tenantId
curl -H 'Host: localhost'         localhost:3000/admin/errors # errores recientes por tenant
```

- `src/app.ts` arma la app (la usan el servidor y el test).
- `test/app.test.ts` la prueba con `app.inject()`: `pnpm vitest run examples/fastify-memory`.
