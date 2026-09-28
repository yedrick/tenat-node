import * as v from 'valibot';
import { ROLES, type Role } from '../auth/permissions.js';
import type { AdminContext } from '../context.js';
import { AdminHttpError, route } from '../http.js';

function requireFeature<T>(value: T | undefined, name: string): T {
  if (!value)
    throw new AdminHttpError(404, 'ADMIN_FEATURE_DISABLED', `The ${name} plugin is not installed`);
  return value;
}

export function eventRoutes(ctx: AdminContext) {
  const t = ctx.tenancy;
  const hooks = () => requireFeature(t.webhooks, 'webhooks (@tenancy-node/transport-webhook)');
  const outbox = () => requireFeature(t.outbox, 'outbox (@tenancy-node/outbox)');
  const id = (value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1)
      throw new AdminHttpError(404, 'ADMIN_NOT_FOUND', 'Not found');
    return n;
  };
  const WebhookBody = v.object({
    tenant: v.optional(v.nullable(v.string())),
    name: v.string(),
    url: v.string(),
    events: v.array(v.string()),
  });

  return [
    route({
      method: 'GET',
      path: '/webhooks',
      permission: 'webhooks:read',
      tag: 'webhooks',
      summary: 'Endpoints registrados (?tenant=id o ?tenant= para los globales)',
      async handler(request) {
        const tenant = request.query.has('tenant')
          ? request.query.get('tenant') || null
          : undefined;
        return { body: await hooks().list(tenant === undefined ? {} : { tenant }) };
      },
    }),
    route({
      method: 'POST',
      path: '/webhooks',
      permission: 'webhooks:write',
      tag: 'webhooks',
      summary: 'Registra un endpoint. La respuesta trae el secreto de firma una sola vez',
      body: WebhookBody,
      async handler(request) {
        const result = await hooks().register({
          ...request.body,
          tenant: request.body.tenant ?? null,
        });
        await ctx.record(request, {
          action: 'webhook.create',
          tenantId: result.endpoint.tenantId,
          targetType: 'webhook',
          targetId: result.endpoint.id,
          changes: {
            after: {
              name: result.endpoint.name,
              url: result.endpoint.url,
              events: result.endpoint.events,
            },
          },
        });
        return { status: 201, body: result };
      },
    }),
    route({
      method: 'PATCH',
      path: '/webhooks/:id',
      permission: 'webhooks:write',
      tag: 'webhooks',
      summary: 'Cambia URL, eventos, nombre o lo activa/desactiva',
      body: v.object({
        name: v.optional(v.string()),
        url: v.optional(v.string()),
        events: v.optional(v.array(v.string())),
        active: v.optional(v.boolean()),
      }),
      async handler(request) {
        const before = await hooks().get(id(request.params.id!));
        if (!before)
          throw new AdminHttpError(404, 'TENANCY_WEBHOOK_NOT_FOUND', 'Webhook not found');
        const b = request.body;
        const after = await hooks().update(before.id, {
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.url !== undefined ? { url: b.url } : {}),
          ...(b.events !== undefined ? { events: b.events } : {}),
          ...(b.active !== undefined ? { active: b.active } : {}),
        });
        await ctx.record(request, {
          action: 'webhook.update',
          tenantId: after.tenantId,
          targetType: 'webhook',
          targetId: after.id,
          changes: { before, after },
        });
        return { body: after };
      },
    }),
    route({
      method: 'DELETE',
      path: '/webhooks/:id',
      permission: 'webhooks:write',
      tag: 'webhooks',
      summary: 'Elimina un endpoint y su historial',
      async handler(request) {
        const endpoint = await hooks().get(id(request.params.id!));
        if (!endpoint)
          throw new AdminHttpError(404, 'TENANCY_WEBHOOK_NOT_FOUND', 'Webhook not found');
        await hooks().remove(endpoint.id);
        await ctx.record(request, {
          action: 'webhook.delete',
          tenantId: endpoint.tenantId,
          targetType: 'webhook',
          targetId: endpoint.id,
          changes: { before: endpoint },
        });
        return { status: 204 };
      },
    }),
    route({
      method: 'GET',
      path: '/webhooks/:id/deliveries',
      permission: 'webhooks:read',
      tag: 'webhooks',
      summary: 'Historial de entregas (?status=failed|dead...)',
      async handler(request) {
        const status = request.query.get('status') as
          'pending' | 'success' | 'failed' | 'dead' | null;
        return {
          body: await hooks().deliveries(id(request.params.id!), {
            limit: 100,
            ...(status ? { status } : {}),
          }),
        };
      },
    }),
    route({
      method: 'POST',
      path: '/webhooks/deliveries/:id/redeliver',
      permission: 'webhooks:write',
      tag: 'webhooks',
      summary: 'Vuelve a enviar una entrega (por ejemplo, desde dead-letter)',
      async handler(request) {
        await hooks().redeliver(id(request.params.id!));
        await ctx.record(request, {
          action: 'webhook.redeliver',
          targetType: 'webhook_delivery',
          targetId: request.params.id!,
        });
        return { status: 202 };
      },
    }),
    route({
      method: 'POST',
      path: '/webhooks/:id/test',
      permission: 'webhooks:write',
      tag: 'webhooks',
      summary: 'Envía un evento webhook.test al endpoint',
      async handler(request) {
        const result = await hooks().test(id(request.params.id!));
        await ctx.record(request, {
          action: 'webhook.test',
          targetType: 'webhook',
          targetId: request.params.id!,
          changes: result,
        });
        return { body: result };
      },
    }),
    route({
      method: 'GET',
      path: '/events/outbox',
      permission: 'events:read',
      tag: 'events',
      summary: 'Eventos de la outbox por estado y dead-letter (?tenant=id)',
      async handler(request) {
        const tenant = request.query.get('tenant') ?? undefined;
        return {
          body: {
            stats: await outbox().stats(),
            failed: await outbox().failed({ limit: 100, ...(tenant ? { tenantId: tenant } : {}) }),
          },
        };
      },
    }),
    route({
      method: 'POST',
      path: '/events/outbox/retry',
      permission: 'events:retry',
      tag: 'events',
      summary:
        'Vuelve a poner en cola eventos del dead-letter ({ id } | { tenantId } | { all: true })',
      body: v.union([
        v.object({ id: v.string() }),
        v.object({ tenantId: v.string() }),
        v.object({ all: v.literal(true) }),
      ]),
      async handler(request) {
        const b = request.body as { id?: string; tenantId?: string; all?: true };
        const count = await outbox().retry(
          b.id ? { id: b.id } : b.tenantId ? { tenantId: b.tenantId } : 'all',
        );
        await ctx.record(request, {
          action: 'outbox.retry',
          tenantId: b.tenantId ?? null,
          changes: { ...b, retried: count },
        });
        return { body: { retried: count } };
      },
    }),
  ];
}

export function systemRoutes(ctx: AdminContext) {
  const t = ctx.tenancy;
  const UserBody = v.object({
    email: v.pipe(v.string(), v.email(), v.maxLength(191)),
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(150)),
    password: v.string(),
    role: v.picklist(ROLES),
  });
  const guardLastOwner = async (
    userId: number,
    change: { role?: Role; isActive?: boolean; delete?: boolean },
  ) => {
    const user = await ctx.users.get(userId);
    const losesOwner =
      user.role === 'owner' &&
      user.isActive &&
      (change.delete || change.isActive === false || (change.role && change.role !== 'owner'));
    if (losesOwner && (await ctx.users.activeOwners()) <= 1) {
      throw new AdminHttpError(409, 'ADMIN_LAST_OWNER', 'There must be at least one active owner');
    }
    return user;
  };

  return [
    route({
      method: 'GET',
      path: '/health',
      permission: null,
      tag: 'system',
      summary: 'Estado de la base central, caché, cola, almacenamiento y transportes',
      async handler() {
        const report = await t.health();
        return { status: report.status === 'ok' ? 200 : 503, body: report };
      },
    }),
    route({
      method: 'GET',
      path: '/metrics',
      permission: 'metrics:read',
      tag: 'system',
      summary: 'Tenants por estado, pools, salud, errores por tenant y outbox',
      async handler() {
        const byStatus = await ctx.central.db
          .selectFrom('tenants')
          .select(['status', (eb) => eb.fn.countAll<number | string>().as('n')])
          .where('deleted_at', 'is', null)
          .groupBy('status')
          .execute();
        const since = new Date(Date.now() - 30 * 86_400_000);
        const recent = await ctx.central.db
          .selectFrom('tenants')
          .select((eb) => eb.fn.countAll<number | string>().as('n'))
          .where('created_at', '>=', since)
          .executeTakeFirstOrThrow();
        return {
          body: {
            tenants: {
              byStatus: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
              createdLast30Days: Number(recent.n),
            },
            pools: t.database.pools().servers,
            health: await t.health(),
            errors: t.observability.summary().slice(0, 20),
            outbox: t.outbox ? await t.outbox.stats() : null,
          },
        };
      },
    }),
    route({
      method: 'GET',
      path: '/errors',
      permission: 'metrics:read',
      tag: 'system',
      summary: 'Errores recientes de este proceso (?tenant=id, ?limit)',
      async handler(request) {
        const tenant = request.query.get('tenant');
        const errors = t.observability.errors({
          limit: Math.min(Number(request.query.get('limit') ?? 50) || 50, 500),
          ...(tenant !== null ? { tenantId: tenant || null } : {}),
        });
        return { body: errors.map(({ stack: _s, ...e }) => e) };
      },
    }),
    route({
      method: 'GET',
      path: '/audit',
      permission: 'audit:read',
      tag: 'system',
      summary: 'Registro de auditoría (?tenant, ?user, ?action=prefijo, ?before=id, ?limit)',
      async handler(request) {
        const q = request.query;
        return {
          body: await ctx.audit.list({
            ...(q.get('tenant') ? { tenantId: q.get('tenant')! } : {}),
            ...(q.get('user') ? { adminUserId: Number(q.get('user')) } : {}),
            ...(q.get('action') ? { action: q.get('action')! } : {}),
            ...(q.get('before') ? { before: Number(q.get('before')) } : {}),
            limit: Number(q.get('limit') ?? 50) || 50,
          }),
        };
      },
    }),
    route({
      method: 'GET',
      path: '/users',
      permission: 'users:manage',
      tag: 'users',
      summary: 'Usuarios del panel',
      async handler() {
        return { body: await ctx.users.list() };
      },
    }),
    route({
      method: 'POST',
      path: '/users',
      permission: 'users:manage',
      tag: 'users',
      summary: 'Crea un usuario del panel',
      body: UserBody,
      async handler(request) {
        const user = await ctx.users.create(request.body);
        await ctx.record(request, {
          action: 'admin_user.create',
          targetType: 'admin_user',
          targetId: user.id,
          changes: { after: { email: user.email, role: user.role } },
        });
        return { status: 201, body: user };
      },
    }),
    route({
      method: 'PATCH',
      path: '/users/:id',
      permission: 'users:manage',
      tag: 'users',
      summary: 'Cambia nombre, rol o lo activa/desactiva (desactivar cierra sus sesiones)',
      body: v.object({
        name: v.optional(v.string()),
        role: v.optional(v.picklist(ROLES)),
        active: v.optional(v.boolean()),
      }),
      async handler(request) {
        const userId = Number(request.params.id);
        const b = request.body;
        const before = await guardLastOwner(userId, {
          ...(b.role ? { role: b.role } : {}),
          ...(b.active !== undefined ? { isActive: b.active } : {}),
        });
        const after = await ctx.users.update(userId, {
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.role !== undefined ? { role: b.role } : {}),
          ...(b.active !== undefined ? { isActive: b.active } : {}),
        });
        if (b.active === false || (b.role && b.role !== before.role))
          await ctx.sessions.destroyForUser(userId);
        await ctx.record(request, {
          action: 'admin_user.update',
          targetType: 'admin_user',
          targetId: userId,
          changes: { before, after },
        });
        return { body: after };
      },
    }),
    route({
      method: 'DELETE',
      path: '/users/:id',
      permission: 'users:manage',
      tag: 'users',
      summary: 'Elimina un usuario del panel',
      async handler(request) {
        const userId = Number(request.params.id);
        if (userId === request.user!.id)
          throw new AdminHttpError(
            409,
            'ADMIN_CANNOT_DELETE_SELF',
            'You cannot delete your own user',
          );
        const before = await guardLastOwner(userId, { delete: true });
        await ctx.users.delete(userId);
        await ctx.record(request, {
          action: 'admin_user.delete',
          targetType: 'admin_user',
          targetId: userId,
          changes: { before },
        });
        return { status: 204 };
      },
    }),
  ];
}
