// Proceso del servidor de la prueba de carga: crea los tenants (si faltan) y atiende HTTP.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTenancy, forEachConcurrent, NoopLogger } from '@tenancy-node/core';
import { withTenancy } from '@tenancy-node/adapter-node';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import type { Migration } from 'kysely';

const [url, countArg, lookupArg] = process.argv.slice(2);
const TENANTS = Number(countArg);
const notas: Migration = {
  up: (db) =>
    db.schema
      .createTable('notas')
      .addColumn('id', 'serial', (c) => c.primaryKey())
      .addColumn('texto', 'varchar(100)', (c) => c.notNull())
      .execute(),
};
const tenancy = createTenancy({
  logger: new NoopLogger(),
  centralDomains: ['app.test'],
  ...(lookupArg === 'no-cache' ? { lookupCache: false as const } : {}),
  plugins: [
    database({
      driver: postgres(),
      central: { url: url!, pool: { max: 20 } },
      isolation: 'schema',
      pool: { max: 20 },
      migrations: { tenant: { '001_notas': notas } },
      // Cada tenant guarda su propio id: la respuesta demuestra que se leyó su schema.
      seed: async (db, tenant) => void (await db.insertInto('notas').values({ texto: tenant.id.value }).execute()),
    }),
  ],
});
await tenancy.database.install();

const ids = Array.from({ length: TENANTS }, (_, i) => `t${i}`);
const existing = (await tenancy.tenants.list({ perPage: 1 })).total;
const durations: number[] = [];
const started = performance.now();
if (existing < TENANTS) {
  let done = 0;
  await forEachConcurrent(ids.slice(existing), 16, async (id) => {
    const t0 = performance.now();
    await tenancy.tenants.create({ id, domain: `${id}.test` });
    durations.push(performance.now() - t0);
    if (++done % 1000 === 0) process.send?.({ progress: existing + done });
  });
}
const creationMs = performance.now() - started;
const pct = (p: number) => {
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!) : 0;
};

const server = http.createServer(
  withTenancy(tenancy, async (_req, res) => {
    const row = await tenancy.db().selectFrom('notas').select('texto').executeTakeFirstOrThrow();
    res.end(`${tenancy.currentId()}:${row.texto}`);
  }),
);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.send?.({
  port: (server.address() as AddressInfo).port,
  created: durations.length,
  creationSeconds: Math.round(creationMs / 100) / 10,
  createP50Ms: pct(0.5),
  createP99Ms: pct(0.99),
});
process.on('message', async (m) => {
  if (m !== 'stats') return;
  const pools = tenancy.database.pools();
  process.send?.({
    rssMb: Math.round(process.memoryUsage().rss / 1024 ** 2),
    heapMb: Math.round(process.memoryUsage().heapUsed / 1024 ** 2),
    pools: pools.servers,
  });
});
process.on('SIGINT', async () => {
  server.close();
  await tenancy.close();
  process.exit(0);
});
