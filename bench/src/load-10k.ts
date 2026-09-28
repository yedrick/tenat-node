/**
 * Prueba de carga con 10 000 tenants en PostgreSQL 16 (un schema por tenant, una sola base):
 *
 * 1. Crea los 10 000 tenants (schema + migración + seed), 16 en paralelo.
 * 2. Carga HTTP (autocannon) repartida al azar entre los 10 000, con una consulta a la base
 *    del tenant en cada petición. Cada respuesta se verifica: debe traer el dato de SU schema.
 * 3. Lo mismo sin la caché de búsqueda, para ver cuánto aporta.
 *
 *   pnpm --filter tenancy-node-bench load            (LOAD_TENANTS=10000 LOAD_SECONDS=30)
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import autocannon from 'autocannon';
import { save } from './report.js';

const TENANTS = Number(process.env.LOAD_TENANTS ?? 10_000);
const SECONDS = Number(process.env.LOAD_SECONDS ?? 30);
const CONNECTIONS = 100;

console.log(`PostgreSQL 16 + ${TENANTS} tenants...`);
const pg = await new PostgreSqlContainer('postgres:16-alpine')
  .withUsername('admin')
  .withPassword('secret')
  .withDatabase('app')
  .withCommand(['postgres', '-c', 'max_connections=300', '-c', 'shared_buffers=512MB', '-c', 'fsync=off'])
  .start();
const url = `postgres://admin:secret@${pg.getHost()}:${pg.getPort()}/app`;

const request = <T>(child: ChildProcess, message: string) =>
  new Promise<T>((resolve) => {
    child.once('message', (m) => resolve(m as T));
    child.send(message);
  });

async function phase(name: string, mode: 'cache' | 'no-cache') {
  const child = fork(fileURLToPath(new URL('./load-server.ts', import.meta.url)), [url, String(TENANTS), mode], {
    execArgv: ['--import', 'tsx'],
  });
  const ready = await new Promise<Record<string, number>>((resolve) =>
    child.on('message', (m) => {
      const msg = m as Record<string, number>;
      if ('progress' in msg) console.log(`  ${msg.progress} tenants creados`);
      if ('port' in msg) resolve(msg);
    }),
  );
  child.removeAllListeners('message');
  if (ready.created) console.log(`  creación: ${ready.creationSeconds}s, p50 ${ready.createP50Ms} ms, p99 ${ready.createP99Ms} ms`);

  let wrong = 0;
  let checked = 0;
  const result = await autocannon({
    url: `http://127.0.0.1:${ready.port}`,
    connections: CONNECTIONS,
    duration: SECONDS,
    requests: [
      {
        setupRequest: (req, context) => {
          const id = `t${Math.floor(Math.random() * TENANTS)}`;
          (context as { id?: string }).id = id;
          return { ...req, headers: { ...req.headers, host: `${id}.test` } };
        },
        // La respuesta es "<tenant del contexto>:<dato leído de su schema>": ambos deben ser el del Host.
        onResponse: (_status, body, context) => {
          checked++;
          const id = (context as { id?: string }).id;
          if (body !== `${id}:${id}`) wrong++;
        },
      },
    ],
  });
  const stats = await request<Record<string, unknown>>(child, 'stats');
  child.kill('SIGINT');
  await new Promise((r) => child.once('exit', r));
  const row = {
    name,
    reqPerSec: Math.round(result.requests.average),
    latencyP50Ms: result.latency.p50,
    latencyP99Ms: result.latency.p99,
    requests: result.requests.total,
    errors: result.errors + result.timeouts + result.non2xx,
    checked,
    wrongTenant: wrong,
    serverRssMb: stats.rssMb,
    serverHeapMb: stats.heapMb,
    ...(ready.created
      ? { creation: { tenants: ready.created, seconds: ready.creationSeconds, p50Ms: ready.createP50Ms, p99Ms: ready.createP99Ms } }
      : {}),
  };
  console.log(row);
  return row;
}

const results = [await phase('10k tenants, caché de búsqueda', 'cache'), await phase('10k tenants, sin caché de búsqueda', 'no-cache')];
await pg.stop();
save('load-10k', {
  tenants: TENANTS,
  connections: CONNECTIONS,
  durationSeconds: SECONDS,
  setup: 'PostgreSQL 16 en Docker (misma máquina), isolation: schema, credenciales compartidas, pool max 20, fsync=off',
  results,
});
