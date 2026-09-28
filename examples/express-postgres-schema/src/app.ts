import express from 'express';
import { ConsoleLogger, createTenancy, type Logger } from '@tenancy-node/core';
import { tenancyErrorHandler, tenancyMiddleware } from '@tenancy-node/adapter-express';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { typeormIntegration, typeormMigrator } from '@tenancy-node/orm-typeorm';
import { prometheus } from '@tenancy-node/prometheus';
import { TareaSchema, Tareas1767225600000 } from './entities.js';

export interface AppOptions {
  databaseUrl: string;
  /** Llave para cifrar la contraseña del rol de cada tenant (`npx tenancy key:generate`). */
  encryptionKey: string;
  logger?: Logger;
}

/**
 * Express + PostgreSQL con un schema por tenant (en una sola base) y un rol propio por tenant:
 * aunque el código se equivoque, PostgreSQL no deja leer el schema de otro.
 */
export async function buildApp(options: AppOptions) {
  const metrics = prometheus();
  const tenancy = createTenancy({
    centralDomains: ['localhost'],
    logger: options.logger ?? new ConsoleLogger('info'),
    telemetry: metrics,
    plugins: [
      database({
        driver: postgres(),
        central: { url: options.databaseUrl },
        isolation: 'schema',
        credentials: 'per-tenant',
        encryptionKey: options.encryptionKey,
        migrations: { tenant: typeormMigrator({ migrations: [Tareas1767225600000] }) },
      }),
      typeormIntegration({ entities: [TareaSchema] }),
    ],
  });
  await tenancy.database.install();

  const app: express.Express = express();
  app.use(express.json());
  // Métricas antes del middleware: /metrics es del contexto central y no necesita tenant.
  app.get('/metrics', async (_req, res) => {
    res.type(metrics.contentType).send(await metrics.metrics());
  });
  // Solo para el ejemplo: en una app real, los tenants se crean desde el panel o el CLI (con auth).
  app.post('/tenants', async (req, res, next) => {
    try {
      const tenant = await tenancy.tenants.create({ id: req.body.id, name: req.body.name, domain: req.body.domain });
      res.status(201).json({ id: tenant.id.value, schema: tenant.database?.schema });
    } catch (error) {
      next(error);
    }
  });
  app.use(tenancyMiddleware(tenancy, { skip: (req) => req.path === '/metrics' || req.path === '/tenants' }));

  const tareas = async () => (await tenancy.typeorm()).getRepository(TareaSchema);
  app.get('/tareas', async (_req, res) => {
    res.json(await (await tareas()).find({ order: { id: 'ASC' } }));
  });
  app.post('/tareas', async (req, res) => {
    res.status(201).json(await (await tareas()).save({ titulo: String(req.body.titulo) }));
  });
  app.use(tenancyErrorHandler(tenancy));

  return { app, tenancy, metrics };
}
