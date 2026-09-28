/**
 * Costo de tenancy en HTTP real (autocannon, keep-alive): el mismo endpoint con y sin tenancy,
 * en node:http y en Fastify (servidor en otro proceso), repartiendo las peticiones entre 1 000 tenants por dominio.
 *
 *   pnpm --filter tenancy-node-bench http
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import autocannon from 'autocannon';
import { save } from './report.js';

const TENANTS = 1_000;
const DURATION = Number(process.env.BENCH_SECONDS ?? 10);
const CONNECTIONS = 50;

async function load(port: number, name: string) {
  let n = 0;
  let wrong = 0;
  const result = await autocannon({
    url: `http://127.0.0.1:${port}`,
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [
      {
        setupRequest: (req) => ({ ...req, headers: { ...req.headers, host: `t${n++ % TENANTS}.test` } }),
        // Aislamiento bajo carga: cada respuesta debe traer el tenant de su propio Host.
        onResponse: (_status, body, context) => {
          void context;
          if (!/^t\d+$/.test(body)) wrong++;
        },
      },
    ],
  });
  const row = {
    name,
    reqPerSec: Math.round(result.requests.average),
    latencyP50Ms: result.latency.p50,
    latencyP99Ms: result.latency.p99,
    errors: result.errors + result.non2xx,
    wrongTenant: wrong,
  };
  console.log(row);
  return row;
}

const MODES = [
  ['node', 'node:http sin tenancy'],
  ['node-tenancy', 'node:http + withTenancy'],
  ['node-tenancy-nolog', 'node:http + withTenancy (sin log por petición)'],
  ['fastify', 'Fastify sin tenancy'],
  ['fastify-tenancy', 'Fastify + tenancyPlugin'],
  ['fastify-tenancy-nolog', 'Fastify + tenancyPlugin (sin log por petición)'],
] as const;

const rows = [];
for (const [mode, name] of MODES) {
  const child = fork(fileURLToPath(new URL('./http-server.ts', import.meta.url)), [mode, String(TENANTS)], {
    execArgv: ['--import', 'tsx'],
  });
  const port = await new Promise<number>((resolve) => child.once('message', (m) => resolve((m as { port: number }).port)));
  rows.push(await load(port, name));
  child.kill();
}
console.table(rows);
save('http', { tenants: TENANTS, connections: CONNECTIONS, durationSeconds: DURATION, results: rows });
