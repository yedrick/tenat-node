/**
 *   docker run -d --name tenancy-pg -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=app -p 5432:5432 postgres:16-alpine
 *   TENANCY_KEY=$(npx tenancy key:generate) pnpm --filter example-express-postgres-schema start
 */
import { buildApp } from './app.js';

const key = process.env.TENANCY_KEY;
if (!key) throw new Error('Set TENANCY_KEY (npx tenancy key:generate)');
const { app } = await buildApp({
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:secret@127.0.0.1:5432/app',
  encryptionKey: key,
});
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
