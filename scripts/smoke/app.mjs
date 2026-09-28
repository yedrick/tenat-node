// Humo desde ESM con los tarballs publicados: SQLite, node:http, métricas y aislamiento.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTenancy } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { sqlite } from '@tenancy-node/db-sqlite';
import { withTenancy } from '@tenancy-node/adapter-node';
import { prometheus } from '@tenancy-node/prometheus';

const metrics = prometheus();
const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };
const tenancy = createTenancy({
  centralDomains: ['app.test'],
  logger: silent,
  telemetry: metrics,
  plugins: [
    database({
      driver: sqlite({ directory: './data' }),
      central: { url: 'sqlite://local/central' },
      migrations: { tenant: { '001': { up: (db) => db.schema.createTable('notas').addColumn('id', 'integer', (c) => c.primaryKey()).addColumn('texto', 'text').execute() } } },
    }),
  ],
});
await tenancy.database.install();
for (const id of ['bolivar', 'tigre']) if (!(await tenancy.tenants.find(id))) await tenancy.tenants.create({ id, domain: `${id}.test` });
await tenancy.run('bolivar', () => tenancy.db().insertInto('notas').values({ id: Date.now() % 100000, texto: 'hola' }).execute());

const server = http.createServer(withTenancy(tenancy, async (req, res) => {
  const n = await tenancy.db().selectFrom('notas').select((eb) => eb.fn.countAll().as('n')).executeTakeFirst();
  res.end(JSON.stringify({ tenant: tenancy.currentId(), notas: Number(n.n) }));
}));
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const results = {};
for (const host of ['bolivar.test', 'tigre.test', 'nadie.test']) {
  const [status, body] = await new Promise((resolve) => http.get({ port, path: '/', headers: { host } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve([r.statusCode, b])); }));
  results[host] = [status, body];
}
assert.deepEqual(results['bolivar.test']?.[0], 200);
assert.match(results['bolivar.test'][1], /"tenant":"bolivar"/);
assert.match(results['tigre.test'][1], /"tenant":"tigre","notas":0/);
assert.equal(results['nadie.test'][0], 404);
assert.match(await metrics.metrics(), /tenancy_http_request_duration_seconds_count\{method="GET",route="unmatched",status_class="2xx"\} 2/);
server.close();
await tenancy.close();
console.log('esm ok');
