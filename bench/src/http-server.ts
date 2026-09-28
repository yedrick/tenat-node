// Servidor de un modo del benchmark HTTP; corre en su propio proceso para no competir con autocannon.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { createTenancy, NoopLogger } from '@tenancy-node/core';
import { withTenancy } from '@tenancy-node/adapter-node';
import { tenancyPlugin } from '@tenancy-node/adapter-fastify';

const mode = process.argv[2];
const TENANTS = Number(process.argv[3] ?? 1000);
const tenancy = createTenancy({ logger: new NoopLogger(), centralDomains: ['app.test'] });
for (let i = 0; i < TENANTS; i++) await tenancy.tenants.create({ id: `t${i}`, domain: `t${i}.test` });
const hostTenant = (host: string | undefined) => (host ?? '').split('.')[0]!;

let port: number;
const listen = async (server: http.Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};
if (mode === 'node') port = await listen(http.createServer((req, res) => res.end(hostTenant(req.headers.host))));
else if (mode === 'node-tenancy')
  port = await listen(http.createServer(withTenancy(tenancy, (_req, res) => void res.end(tenancy.currentId()))));
else if (mode === 'node-tenancy-nolog')
  port = await listen(
    http.createServer(withTenancy(tenancy, (_req, res) => void res.end(tenancy.currentId()), { logRequests: false })),
  );
else {
  const app = Fastify();
  if (mode === 'fastify') app.get('/', async (req) => hostTenant(req.headers.host));
  else {
    await app.register(tenancyPlugin, { tenancy, ...(mode === 'fastify-tenancy-nolog' ? { logRequests: false } : {}) });
    app.get('/', async () => tenancy.currentId());
  }
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
}
process.send?.({ port });
process.on('SIGINT', () => process.exit(0));
