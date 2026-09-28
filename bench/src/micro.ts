/**
 * Costo del núcleo por petición, sin red ni base de datos: resolver el tenant, abrir su
 * contexto y usar la caché. Todo en memoria, con 1 000 tenants.
 *
 *   pnpm --filter tenancy-node-bench micro
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createTenancy, NoopLogger } from '@tenancy-node/core';
import { Bench } from 'tinybench';
import { save } from './report.js';

const TENANTS = 1_000;
const make = (lookupCache: boolean) =>
  createTenancy({ logger: new NoopLogger(), centralDomains: ['app.test'], ...(lookupCache ? {} : { lookupCache: false }) });
const cached = make(true);
const uncached = make(false);
for (const t of [cached, uncached])
  for (let i = 0; i < TENANTS; i++) await t.tenants.create({ id: `t${i}`, domain: `t${i}.test` });

let n = 0;
const nextHost = () => `t${n++ % TENANTS}.test`;
const request = () => ({ host: nextHost(), path: '/', headers: {} });
const als = new AsyncLocalStorage<number>();
await cached.run('t1', () => cached.cache().set('k', { v: 1 }));

const bench = new Bench({ time: 1_500, warmup: true });
bench
  .add('baseline: AsyncLocalStorage.run + await', async () => {
    await als.run(1, async () => als.getStore());
  })
  .add('resolve (dominio, caché de búsqueda)', async () => {
    await cached.resolve(request());
  })
  .add('resolve (dominio, sin caché de búsqueda)', async () => {
    await uncached.resolve(request());
  })
  .add('openRequestScope + run + close (una petición)', async () => {
    const scope = await cached.openRequestScope(request());
    await scope.run(async () => cached.currentId());
    await scope.close();
  })
  .add('tenancy.run(id) con tenant conocido', async () => {
    await cached.run(`t${n++ % TENANTS}`, async () => cached.currentId());
  })
  .add('tenancy.cache().get (memoria)', async () => {
    await cached.run('t1', () => cached.cache().get('k'));
  })
  .add('tema: toCss() cacheado', async () => {
    await cached.run('t1', async () => cached.theme().toCss());
  });

await bench.run();
const rows = bench.tasks.map((t) => ({
  name: t.name,
  opsPerSec: Math.round(t.result!.throughput.mean),
  meanUs: Number((t.result!.latency.mean * 1000).toFixed(2)),
  p99Us: Number(((t.result!.latency.p99 ?? 0) * 1000).toFixed(2)),
  samples: t.result!.latency.samples.length,
}));
console.table(rows);
save('micro', { tenants: TENANTS, results: rows });
await cached.close();
await uncached.close();
