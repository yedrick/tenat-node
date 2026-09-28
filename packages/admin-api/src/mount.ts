import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminApi } from './admin.js';

/** Middleware para Express/Connect: `app.use(adminMiddleware(api))`. */
export function adminMiddleware(api: AdminApi) {
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    api.handle(req, res).then((handled) => {
      if (!handled) next();
    }, next);
  };
}

interface FastifyLike {
  addHook(
    name: 'onRequest',
    hook: (
      request: { raw: IncomingMessage; url: string },
      reply: { raw: ServerResponse; hijack(): void },
      done: () => void,
    ) => void,
  ): unknown;
}

/**
 * Monta la Admin API en Fastify. Se engancha en `onRequest` (antes de que Fastify lea el body)
 * y debe registrarse **antes** que `tenancyPlugin`.
 */
export function registerAdminFastify(app: FastifyLike, api: AdminApi): void {
  app.addHook('onRequest', (request, reply, done) => {
    const path = request.url.split('?', 1)[0]!;
    const base = api.uiPath ?? api.prefix;
    if (path !== base && !path.startsWith(`${base}/`)) return done();
    reply.hijack();
    void api.handle(request.raw, reply.raw);
  });
}
