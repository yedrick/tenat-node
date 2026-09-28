import Fastify from 'fastify';
import { ConsoleLogger, createTenancy, type Logger } from '@tenancy-node/core';
import { tenancyPlugin } from '@tenancy-node/adapter-fastify';

/** Arma la app sin escuchar en un puerto: así los tests la usan con `app.inject()`. */
export async function buildApp(options: { logger?: Logger } = {}) {
  const tenancy = createTenancy({
    centralDomains: ['localhost'],
    logger: options.logger ?? new ConsoleLogger('info'),
  });

  await tenancy.tenants.create({
    id: 'bolivar',
    name: 'Club Bolívar',
    theme: { primary: '#E4002B', secondary: '#FFD100' },
  });
  await tenancy.tenants.create({
    id: 'tigre',
    name: 'Club The Strongest',
    theme: { primary: '#FFD100', secondary: '#000000' },
  });

  tenancy.events.on('pedido.creado', (e) => {
    tenancy.observability.logger.info({ pedido: e.data }, 'Pedido recibido');
  });

  const app = Fastify();
  await app.register(tenancyPlugin, { tenancy });

  app.get('/whoami', async (req) => ({
    tenant: tenancy.currentId() ?? null,
    name: req.tenant?.name ?? 'central',
  }));

  app.get('/theme.css', async (_req, reply) => {
    const theme = tenancy.theme();
    return reply.type('text/css').header('etag', theme.etag()).send(theme.toCss());
  });

  app.post('/pedidos', async () => {
    const pedido = { id: Date.now(), total: 450 };
    await tenancy.events.publish('pedido.creado', pedido);
    return pedido;
  });

  app.get('/boom', async () => {
    throw new Error(`Algo falló en ${tenancy.currentId()}`);
  });

  // Contexto central: errores recientes por tenant (observabilidad)
  app.get('/admin/errors', async () => ({
    summary: tenancy.observability.summary(),
    recent: tenancy.observability.errors({ limit: 20 }).map(({ stack: _stack, ...e }) => e),
  }));

  app.addHook('onClose', () => tenancy.close());
  return { app, tenancy };
}
