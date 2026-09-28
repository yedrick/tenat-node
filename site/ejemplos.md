# Ejemplos

Cada ejemplo vive en [`examples/`](https://github.com/yedrick/tenat-node/tree/main/examples) y tiene un test que lo levanta contra el motor real (con Testcontainers), así que se verifica en cada cambio del repositorio.

| Ejemplo | Qué muestra | Motor |
| ------- | ----------- | ----- |
| [`fastify-memory`](https://github.com/yedrick/tenat-node/tree/main/examples/fastify-memory) | Lo mínimo: tenants por subdominio, tema en CSS, eventos y errores por tenant | Ninguno (memoria) |
| [`fastify-mysql`](https://github.com/yedrick/tenat-node/tree/main/examples/fastify-mysql) | Una base por tenant con migraciones `.sql`, seed y un usuario de MySQL por tenant | MySQL 8 |
| [`express-postgres-schema`](https://github.com/yedrick/tenat-node/tree/main/examples/express-postgres-schema) | Un schema por tenant con rol propio (PostgreSQL impide leer otros schemas), TypeORM y `/metrics` de Prometheus | PostgreSQL 16 |
| [`microservicio-emails`](https://github.com/yedrick/tenat-node/tree/main/examples/microservicio-emails) | Outbox transaccional hacia RabbitMQ y un microservicio que envía un correo de bienvenida por tenant, idempotente ante reentregas | PostgreSQL 16 + RabbitMQ 4 |

## Correr un ejemplo

```sh
git clone https://github.com/yedrick/tenat-node.git && cd tenat-node
pnpm install && pnpm build
pnpm --filter example-fastify-memory start
curl -H 'Host: bolivar.localhost' localhost:3000/whoami
```

Cada carpeta tiene su `README.md` con los comandos para levantar el motor con Docker y probarlo con `curl`. Para correr su test:

```sh
pnpm vitest run examples/fastify-mysql
```
