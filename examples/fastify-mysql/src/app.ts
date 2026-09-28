import Fastify from 'fastify';
import { tenancyPlugin } from '@tenancy-node/adapter-fastify';
import { createAppTenancy, type TenancyOptions } from './tenancy.js';

/** Instala las tablas centrales, crea los tenants de ejemplo y arma la app (sin escuchar). */
export async function buildApp(options: TenancyOptions = {}) {
  const tenancy = createAppTenancy(options);
  await tenancy.database.install();
  for (const [id, name] of [
    ['bolivar', 'Club Bolívar'],
    ['tigre', 'The Strongest'],
  ] as const) {
    if (!(await tenancy.tenants.find(id))) await tenancy.tenants.create({ id, name });
  }

  const app = Fastify();
  await app.register(tenancyPlugin, { tenancy });

  app.get('/productos', async () =>
    tenancy.db().selectFrom('productos').selectAll().orderBy('id').execute(),
  );

  app.post<{ Body: { nombre: string; precio: number } }>('/productos', async (req) => {
    await tenancy.db().insertInto('productos').values(req.body).execute();
    return tenancy.sql`SELECT COUNT(*) AS total FROM productos`;
  });

  // Contexto central: estado de tenants, pools y errores por tenant
  app.get('/admin/estado', async () => ({
    tenants: (await tenancy.tenants.list()).items.map((t) => ({
      id: t.id.value,
      status: t.status,
      db: t.database?.name,
    })),
    pools: tenancy.database.pools().servers,
    errores: tenancy.observability.summary(),
  }));

  app.addHook('onClose', () => tenancy.close());
  return { app, tenancy };
}
