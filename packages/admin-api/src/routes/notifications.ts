import type { Notification, NotificationAudience } from '@tenancy-node/core';
import * as v from 'valibot';
import type { AdminContext } from '../context.js';
import { route } from '../http.js';

const Audience = v.variant('type', [
  v.object({ type: v.literal('all') }),
  v.object({ type: v.literal('tenants'), tenants: v.array(v.string()) }),
  v.object({ type: v.literal('plans'), plans: v.array(v.string()) }),
]);

const isoDate = v.pipe(v.string(), v.isoTimestamp());

const NotificationBody = v.object({
  title: v.string(),
  body: v.optional(v.string()),
  level: v.optional(v.picklist(['info', 'success', 'warning', 'critical'])),
  audience: v.optional(Audience),
  roles: v.optional(v.nullable(v.array(v.string()))),
  link: v.optional(v.nullable(v.object({ url: v.string(), label: v.optional(v.string()) }))),
  startsAt: v.optional(v.nullable(isoDate)),
  expiresAt: v.optional(v.nullable(isoDate)),
});

export function notificationRoutes(ctx: AdminContext) {
  const t = ctx.tenancy;
  const withStats = async (items: Notification[]) => {
    const stats = await t.notifications.stats(items.map((n) => n.id));
    return items.map((n) => ({ ...n, reads: stats.get(n.id) ?? { tenants: 0, users: 0 } }));
  };
  return [
    route({
      method: 'GET',
      path: '/notifications',
      permission: 'tenants:read',
      tag: 'notifications',
      summary: 'Avisos enviados, más nuevos primero, con cuántos tenants y usuarios los leyeron',
      query: { page: 'página', perPage: 'por página (máx. 100)' },
      async handler(request) {
        const result = await t.notifications.list({
          page: Number(request.query.get('page') ?? 1) || 1,
          perPage: Number(request.query.get('perPage') ?? 20) || 20,
        });
        return {
          body: {
            ...result,
            items: await withStats(result.items),
            channels: t.notifications.channels,
          },
        };
      },
    }),
    route({
      method: 'POST',
      path: '/notifications/reach',
      permission: 'tenants:read',
      tag: 'notifications',
      summary: 'Cuántos tenants activos alcanza una audiencia (vista previa antes de enviar)',
      body: v.object({ audience: Audience }),
      async handler(request) {
        return {
          body: {
            tenants: await t.notifications.reach(request.body.audience as NotificationAudience),
          },
        };
      },
    }),
    route({
      method: 'POST',
      path: '/notifications',
      permission: 'notifications:send',
      tag: 'notifications',
      summary: 'Envía un aviso a todos los tenants, a algunos o a los de ciertos planes',
      body: NotificationBody,
      async handler(request) {
        const b = request.body;
        const notification = await t.notifications.send({
          title: b.title,
          ...(b.body !== undefined ? { body: b.body } : {}),
          ...(b.level ? { level: b.level } : {}),
          ...(b.audience ? { audience: b.audience as NotificationAudience } : {}),
          ...(b.roles !== undefined ? { roles: b.roles } : {}),
          ...(b.link !== undefined
            ? {
                link: b.link
                  ? { url: b.link.url, ...(b.link.label ? { label: b.link.label } : {}) }
                  : null,
              }
            : {}),
          ...(b.startsAt ? { startsAt: new Date(b.startsAt) } : {}),
          ...(b.expiresAt ? { expiresAt: new Date(b.expiresAt) } : {}),
          createdBy: request.user?.email ?? null,
        });
        await ctx.record(request, {
          action: 'notification.send',
          targetType: 'notification',
          targetId: notification.id,
          changes: {
            after: {
              title: notification.title,
              audience: notification.audience,
              level: notification.level,
            },
          },
        });
        return { status: 201, body: notification };
      },
    }),
    route({
      method: 'POST',
      path: '/notifications/:id/deliver',
      permission: 'notifications:send',
      tag: 'notifications',
      summary: 'Vuelve a entregar un aviso por los canales (push)',
      async handler(request) {
        const results = await t.notifications.deliver(request.params.id!);
        await ctx.record(request, {
          action: 'notification.deliver',
          targetType: 'notification',
          targetId: request.params.id!,
        });
        return { body: results };
      },
    }),
    route({
      method: 'DELETE',
      path: '/notifications/:id',
      permission: 'notifications:send',
      tag: 'notifications',
      summary: 'Retira un aviso: deja de mostrarse en todos los tenants',
      async handler(request) {
        const before = await t.notifications.get(request.params.id!);
        await t.notifications.delete(request.params.id!);
        await ctx.record(request, {
          action: 'notification.delete',
          targetType: 'notification',
          targetId: request.params.id!,
          changes: { before: before ? { title: before.title } : null },
        });
        return { status: 204 };
      },
    }),
  ];
}
