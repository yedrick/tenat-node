/**
 * Ejemplo: Fastify + MySQL, una base por tenant.
 *
 *   docker run -d --name tenancy-mysql -e MYSQL_ROOT_PASSWORD=secret -e MYSQL_DATABASE=tenancy -p 3306:3306 mysql:8.0
 *   pnpm --filter example-fastify-mysql start
 *   curl -H 'Host: bolivar.localhost' localhost:3000/productos
 */
import { buildApp } from './app.js';

const { app } = await buildApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '127.0.0.1' });
console.log(`Listening on http://localhost:${port}`);
