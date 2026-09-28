/**
 * Ejemplo mínimo: tenants en memoria + Fastify.
 *
 *   pnpm --filter example-fastify-memory start
 *   curl -H 'Host: bolivar.localhost' localhost:3000/whoami
 *   curl -H 'Host: tigre.localhost'   localhost:3000/theme.css
 *   curl -H 'Host: localhost'         localhost:3000/admin/errors
 */
import { buildApp } from './app.js';

const { app } = await buildApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '127.0.0.1' });
console.log(`Listening on http://localhost:${port}`);
