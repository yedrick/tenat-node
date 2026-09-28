import { randomBytes } from 'node:crypto';
import {
  TenantId,
  TenantNotFoundError,
  isTenantStatus,
  type Tenant,
  type TenantStatus,
} from '@tenancy-node/core';
import { sql } from 'kysely';
import { paginate } from '@tenancy-node/db';
import * as v from 'valibot';
import { sha256 } from '../auth/sessions.js';
import type { AdminContext } from '../context.js';
import { AdminHttpError, route, type AdminRequest } from '../http.js';

export function tenantJson(t: Tenant) {
  const s = t.toSnapshot();
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    plan: s.plan,
    data: s.data,
    theme: s.theme,
    // Nunca la contraseña de la base (ni cifrada).
    database: s.database
      ? { serverId: s.database.serverId, name: s.database.name, username: s.database.username }
      : null,
    maintenanceMessage: s.maintenanceMessage,
    provisionedAt: s.provisionedAt,
    suspendedAt: s.suspendedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

const TenantIdParam = (value: string) => {
  if (!TenantId.isValid(value)) throw new TenantNotFoundError(value);
  return value;
};

const ThemeBody = v.record(v.string(), v.unknown());
const CreateBody = v.object({
  id: v.string(),
  name: v.optional(v.pipe(v.string(), v.maxLength(150))),
  plan: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(50)))),
  data: v.optional(v.record(v.string(), v.unknown())),
  domain: v.optional(v.union([v.string(), v.array(v.string())])),
  theme: v.optional(ThemeBody),
});

function page(request: AdminRequest, maxPerPage = 100) {
  const pageNumber = Math.max(1, Number(request.query.get('page') ?? 1) || 1);
  const perPage = Math.min(
    maxPerPage,
    Math.max(1, Number(request.query.get('perPage') ?? 20) || 20),
  );
  return { page: pageNumber, perPage };
}

export function tenantRoutes(ctx: AdminContext) {
  const t = ctx.tenancy;

  /** Lanza la creación (o el reintento) en segundo plano; el progreso se ve por SSE. */
  const background = (id: string, fn: () => Promise<unknown>) => {
    void fn().catch(() => {
      // El error ya quedó registrado por la operación (tenants.create) con su tenant.
    });
    return { status: 202, body: { id, progress: `${ctx.options.prefix}/tenants/${id}/progress` } };
  };

  return [
    route({
      method: 'GET',
      path: '/tenants',
      permission: 'tenants:read',
      tag: 'tenants',
      summary: 'Lista tenants con búsqueda, filtro por estado y páginas',
      query: {
        search: 'texto en id o nombre',
        status: 'estados separados por coma',
        page: 'página',
        perPage: 'por página (máx. 100)',
      },
      async handler(request) {
        const status = request.query.get('status')?.split(',').filter(Boolean);
        for (const s of status ?? [])
          if (!isTenantStatus(s))
            throw new AdminHttpError(422, 'ADMIN_INVALID_STATUS', `Unknown status ${s}`);
        const search = request.query.get('search') ?? undefined;
        const result = await t.tenants.list({
          ...page(request),
          ...(status ? { status: status as TenantStatus[] } : {}),
          ...(search ? { search } : {}),
        });
        return { body: { ...result, items: result.items.map(tenantJson) } };
      },
    }),
    route({
      method: 'POST',
      path: '/tenants',
      permission: 'tenants:write',
      tag: 'tenants',
      summary: 'Crea un tenant; responde 202 y el progreso se sigue en /tenants/:id/progress (SSE)',
      body: CreateBody,
      async handler(request) {
        const input = request.body;
        TenantId.create(input.id);
        if (await t.tenants.find(input.id))
          throw new AdminHttpError(
            409,
            'TENANCY_TENANT_ALREADY_EXISTS',
            `Tenant "${input.id}" already exists`,
          );
        await ctx.record(request, {
          action: 'tenant.create',
          tenantId: input.id,
          changes: { after: { ...input } },
        });
        return background(input.id, () =>
          t.tenants.create({
            id: input.id,
            ...(input.name ? { name: input.name } : {}),
            ...(input.plan !== undefined ? { plan: input.plan } : {}),
            ...(input.data ? { data: input.data } : {}),
            ...(input.domain ? { domain: input.domain } : {}),
            ...(input.theme ? { theme: input.theme } : {}),
          }),
        );
      },
    }),
    route({
      method: 'GET',
      path: '/tenants/:id',
      permission: 'tenants:read',
      tag: 'tenants',
      summary: 'Detalle: datos, dominios, último aprovisionamiento y errores recientes',
      async handler(request) {
        const tenant = await t.tenants.findOrFail(TenantIdParam(request.params.id!));
        const [domains, steps] = await Promise.all([
          t.domains.list(tenant.id.value),
          t.database.provisioningSteps(tenant.id.value),
        ]);
        const lastRun = steps.at(-1)?.runId;
        return {
          body: {
            tenant: tenantJson(tenant),
            domains: domains.map((d) => ({
              id: d.id,
              domain: d.domain.value,
              isPrimary: d.isPrimary,
              verifiedAt: d.verifiedAt,
            })),
            provisioning: steps.filter((s) => s.runId === lastRun),
            errors: t.observability
              .errors({ tenantId: tenant.id.value, limit: 20 })
              .map(({ stack: _s, ...e }) => e),
          },
        };
      },
    }),
    route({
      method: 'PATCH',
      path: '/tenants/:id',
      permission: 'tenants:write',
      tag: 'tenants',
      summary: 'Cambia nombre, plan o datos (los datos se combinan)',
      body: v.object({
        name: v.optional(v.string()),
        plan: v.optional(v.nullable(v.string())),
        data: v.optional(v.record(v.string(), v.unknown())),
      }),
      async handler(request) {
        const before = tenantJson(await t.tenants.findOrFail(TenantIdParam(request.params.id!)));
        const b = request.body;
        const after = tenantJson(
          await t.tenants.update(before.id, {
            ...(b.name !== undefined ? { name: b.name } : {}),
            ...(b.plan !== undefined ? { plan: b.plan } : {}),
            ...(b.data !== undefined ? { data: b.data } : {}),
          }),
        );
        await ctx.record(request, {
          action: 'tenant.update',
          tenantId: before.id,
          changes: { before: pick(before, b), after: pick(after, b) },
        });
        return { body: after };
      },
    }),
    ...(['suspend', 'activate', 'maintenance'] as const).map((action) =>
      route({
        method: 'POST',
        path: `/tenants/:id/${action}`,
        permission: 'tenants:write',
        tag: 'tenants',
        summary: {
          suspend: 'Suspende el tenant (423 en sus dominios)',
          activate: 'Reactiva el tenant',
          maintenance: 'Pone el tenant en mantenimiento (503)',
        }[action],
        body: v.optional(
          v.object({ message: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(255)))) }),
          {},
        ),
        async handler(request) {
          const id = TenantIdParam(request.params.id!);
          const before = (await t.tenants.findOrFail(id)).status;
          const tenant =
            action === 'suspend'
              ? await t.tenants.suspend(id)
              : action === 'activate'
                ? await t.tenants.activate(id)
                : await t.tenants.maintenance(
                    id,
                    (request.body as { message?: string | null }).message ?? null,
                  );
          await ctx.record(request, {
            action: `tenant.${action}`,
            tenantId: id,
            changes: { before: { status: before }, after: { status: tenant.status } },
          });
          return { body: tenantJson(tenant) };
        },
      }),
    ),
    route({
      method: 'POST',
      path: '/tenants/:id/retry',
      permission: 'tenants:write',
      tag: 'tenants',
      summary: 'Reintenta el aprovisionamiento de un tenant fallido (progreso por SSE)',
      async handler(request) {
        const tenant = await t.tenants.findOrFail(TenantIdParam(request.params.id!));
        if (tenant.status !== 'failed')
          throw new AdminHttpError(
            409,
            'ADMIN_NOT_FAILED',
            `Tenant "${tenant.id.value}" is ${tenant.status}, not failed`,
          );
        await ctx.record(request, { action: 'tenant.retry', tenantId: tenant.id.value });
        return background(tenant.id.value, () => t.tenants.retryProvisioning(tenant.id.value));
      },
    }),
    route({
      method: 'DELETE',
      path: '/tenants/:id',
      permission: 'tenants:delete',
      tag: 'tenants',
      summary: 'Elimina el tenant, su base y sus dominios (confirmar con { "confirm": "<id>" })',
      body: v.object({ confirm: v.string() }),
      async handler(request) {
        const id = TenantIdParam(request.params.id!);
        if (request.body.confirm !== id)
          throw new AdminHttpError(
            422,
            'ADMIN_CONFIRMATION_REQUIRED',
            `Send { "confirm": "${id}" } to delete this tenant`,
          );
        const before = tenantJson(await t.tenants.findOrFail(id));
        await t.tenants.delete(id);
        await ctx.record(request, { action: 'tenant.delete', tenantId: id, changes: { before } });
        return { status: 204 };
      },
    }),
    route({
      method: 'GET',
      path: '/tenants/:id/progress',
      permission: 'tenants:read',
      tag: 'tenants',
      streaming: true,
      summary: 'Progreso del aprovisionamiento en vivo (Server-Sent Events: step, status, done)',
      async handler(request) {
        const id = TenantIdParam(request.params.id!);
        const res = request.res;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        const send = (event: string, data: unknown) =>
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        let closed = false;
        res.on('close', () => (closed = true));
        const seen = new Map<string, string>();
        let lastStatus = '';
        const deadline = Date.now() + 10 * 60_000;
        let beat = Date.now();
        while (!closed && Date.now() < deadline) {
          // Se lee de la base (no de la caché): el tenant puede estar creándose en otro proceso.
          const row = await ctx.central.db
            .selectFrom('tenants')
            .select(['status'])
            .where('id', '=', id)
            .executeTakeFirst();
          if (row) {
            for (const step of await t.database.provisioningSteps(id)) {
              const key = `${step.id}`;
              if (seen.get(key) !== step.status) {
                seen.set(key, step.status);
                send('step', {
                  runId: step.runId,
                  step: step.step,
                  status: step.status,
                  attempt: step.attempt,
                  durationMs: step.durationMs,
                  error: step.error,
                });
              }
            }
            if (row.status !== lastStatus) {
              lastStatus = row.status;
              send('status', { status: row.status });
            }
            if (row.status === 'active' || row.status === 'failed') {
              send('done', { status: row.status });
              break;
            }
          }
          if (Date.now() - beat > 15_000) {
            res.write(': keep-alive\n\n');
            beat = Date.now();
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        res.end();
      },
    }),
    route({
      method: 'PUT',
      path: '/tenants/:id/theme',
      permission: 'tenants:write',
      tag: 'theme',
      summary: 'Cambia parte del tema (colores, logo, tipografía...)',
      body: ThemeBody,
      async handler(request) {
        const id = TenantIdParam(request.params.id!);
        const before = (await t.tenants.findOrFail(id)).theme?.toJSON() ?? null;
        const theme = await t.theme.update(id, request.body);
        await ctx.record(request, {
          action: 'theme.update',
          tenantId: id,
          changes: { before, after: theme.toJSON() },
        });
        return { body: theme.toJSON() };
      },
    }),
    route({
      method: 'DELETE',
      path: '/tenants/:id/theme',
      permission: 'tenants:write',
      tag: 'theme',
      summary: 'Vuelve al tema por defecto',
      async handler(request) {
        const id = TenantIdParam(request.params.id!);
        await t.theme.reset(id);
        await ctx.record(request, { action: 'theme.reset', tenantId: id });
        return { status: 204 };
      },
    }),
    route({
      method: 'GET',
      path: '/tenants/:id/domains',
      permission: 'tenants:read',
      tag: 'domains',
      summary: 'Dominios del tenant',
      async handler(request) {
        const domains = await t.domains.list(TenantIdParam(request.params.id!));
        return {
          body: domains.map((d) => ({
            id: d.id,
            domain: d.domain.value,
            isPrimary: d.isPrimary,
            verifiedAt: d.verifiedAt,
          })),
        };
      },
    }),
    route({
      method: 'POST',
      path: '/tenants/:id/domains',
      permission: 'tenants:write',
      tag: 'domains',
      summary: 'Agrega un dominio',
      body: v.object({
        domain: v.pipe(v.string(), v.maxLength(253)),
        primary: v.optional(v.boolean()),
      }),
      async handler(request) {
        const id = TenantIdParam(request.params.id!);
        const domain = await t.domains.add(id, request.body.domain, {
          primary: request.body.primary ?? false,
        });
        await ctx.record(request, {
          action: 'domain.add',
          tenantId: id,
          targetType: 'domain',
          targetId: domain.domain.value,
        });
        return {
          status: 201,
          body: { id: domain.id, domain: domain.domain.value, isPrimary: domain.isPrimary },
        };
      },
    }),
    route({
      method: 'DELETE',
      path: '/domains/:domain',
      permission: 'tenants:write',
      tag: 'domains',
      summary: 'Quita un dominio',
      async handler(request) {
        const name = request.params.domain!;
        await t.domains.remove(name);
        await ctx.record(request, {
          action: 'domain.remove',
          targetType: 'domain',
          targetId: name,
        });
        return { status: 204 };
      },
    }),
    route({
      method: 'POST',
      path: '/domains/:domain/primary',
      permission: 'tenants:write',
      tag: 'domains',
      summary: 'Marca el dominio como principal',
      async handler(request) {
        const domain = await t.domains.setPrimary(request.params.domain!);
        await ctx.record(request, {
          action: 'domain.primary',
          tenantId: domain.tenantId.value,
          targetType: 'domain',
          targetId: domain.domain.value,
        });
        return { body: { domain: domain.domain.value, isPrimary: true } };
      },
    }),
    route({
      method: 'GET',
      path: '/tenants/:id/migrations',
      permission: 'tenants:read',
      tag: 'database',
      summary: 'Migraciones ejecutadas y pendientes del tenant',
      async handler(request) {
        return { body: await t.database.status(TenantIdParam(request.params.id!)) };
      },
    }),
    ...(['migrate', 'seed'] as const).map((action) =>
      route({
        method: 'POST',
        path: `/tenants/:id/${action}`,
        permission: 'migrations:run',
        tag: 'database',
        summary:
          action === 'migrate'
            ? 'Corre las migraciones pendientes del tenant'
            : 'Corre el seed del tenant',
        async handler(request) {
          const id = TenantIdParam(request.params.id!);
          const result = await t.database[action]({ tenants: [id] });
          await ctx.record(request, {
            action: `database.${action}`,
            tenantId: id,
            changes: { ok: result.failed.length === 0 },
          });
          if (result.failed.length > 0) {
            const error = result.failed[0]!.error;
            throw new AdminHttpError(
              500,
              'ADMIN_OPERATION_FAILED',
              error instanceof Error ? error.message : String(error),
            );
          }
          return { body: { ok: true } };
        },
      }),
    ),
    route({
      method: 'POST',
      path: '/migrate',
      permission: 'migrations:run',
      tag: 'database',
      summary: 'Migra todos los tenants (o los indicados) con concurrencia',
      body: v.optional(
        v.object({
          tenants: v.optional(v.array(v.string())),
          concurrency: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
        }),
        {},
      ),
      async handler(request) {
        const b = request.body as { tenants?: string[]; concurrency?: number };
        const result = await t.database.migrate({
          ...(b.tenants ? { tenants: b.tenants } : {}),
          concurrency: b.concurrency ?? 5,
        });
        await ctx.record(request, {
          action: 'database.migrate_all',
          changes: {
            succeeded: result.succeeded.length,
            failed: result.failed.map((f) => f.tenantId),
          },
        });
        return {
          body: {
            succeeded: result.succeeded,
            failed: result.failed.map((f) => ({
              tenantId: f.tenantId,
              error: f.error instanceof Error ? f.error.message : String(f.error),
            })),
          },
        };
      },
    }),
    route({
      method: 'POST',
      path: '/tenants/:id/cache/flush',
      permission: 'cache:flush',
      tag: 'tenants',
      summary: 'Vacía la caché del tenant',
      async handler(request) {
        const id = TenantIdParam(request.params.id!);
        await t.run(id, () => t.cache().flush());
        await ctx.record(request, { action: 'cache.flush', tenantId: id });
        return { status: 204 };
      },
    }),
    route({
      method: 'POST',
      path: '/tenants/:id/impersonate',
      permission: 'impersonate',
      tag: 'impersonation',
      summary: 'Crea un token de un solo uso para entrar como un usuario del tenant',
      body: v.object({
        user: v.pipe(v.string(), v.minLength(1), v.maxLength(191)),
        redirect: v.optional(v.pipe(v.string(), v.regex(/^\/(?!\/)/), v.maxLength(500))),
      }),
      async handler(request) {
        const tenant = await t.tenants.findOrFail(TenantIdParam(request.params.id!));
        if (!tenant.isActive)
          throw new AdminHttpError(
            409,
            'ADMIN_TENANT_NOT_ACTIVE',
            `Tenant "${tenant.id.value}" is ${tenant.status}`,
          );
        const token = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + ctx.options.impersonationTtlSeconds * 1000);
        await ctx.central.db
          .insertInto('impersonation_tokens')
          .values({
            token_hash: sha256(token),
            tenant_id: tenant.id.value,
            user_identifier: request.body.user,
            admin_user_id: request.user!.id,
            redirect_path: request.body.redirect ?? '/',
            expires_at: expiresAt,
            created_at: new Date(),
          })
          .execute();
        const primary =
          (await t.domains.list(tenant.id.value)).find((d) => d.isPrimary)?.domain.value ?? null;
        const url = ctx.options.impersonationUrl
          ? ctx.options.impersonationUrl({ tenantId: tenant.id.value, domain: primary, token })
          : primary
            ? `https://${primary}/tenancy/impersonate?token=${token}`
            : null;
        await ctx.record(request, {
          action: 'admin.impersonation_started',
          tenantId: tenant.id.value,
          targetType: 'user',
          targetId: request.body.user,
        });
        await t.run(tenant, () =>
          t.events.publish('admin.impersonation_started', {
            tenantId: tenant.id.value,
            user: request.body.user,
            adminUserId: request.user!.id,
          }),
        );
        return { status: 201, body: { token, url, expiresAt } };
      },
    }),
    ...dataExplorer(ctx),
  ];
}

function pick(value: Record<string, unknown>, keys: object) {
  return Object.fromEntries(Object.keys(keys).map((k) => [k, value[k]]));
}

/** Explorador de datos de solo lectura. Tablas y columnas se validan contra la estructura real. */
function dataExplorer(ctx: AdminContext) {
  const t = ctx.tenancy;
    // En modo schema, tables() devuelve solo las del schema del tenant (nunca las de otros tenants).
  const tables = (id: string) => t.run(id, () => t.database.tables());
  return [
    route({
      method: 'GET',
      path: '/tenants/:id/tables',
      permission: 'data:read',
      tag: 'data',
      summary: 'Tablas de la base del tenant, con sus columnas y cantidad de filas',
      async handler(request) {
        const id = TenantIdParam(request.params.id!);
        const list = await tables(id);
        const counts = await t.run(id, () =>
          Promise.all(
            list.map(async (table) =>
              Number(
                (
                  await t
                    .db()
                    .selectFrom(table.name)
                    .select((eb) => eb.fn.countAll().as('n'))
                    .executeTakeFirstOrThrow()
                ).n,
              ),
            ),
          ),
        );
        return {
          body: list.map((table, i) => ({
            name: table.name,
            rows: counts[i],
            columns: table.columns.map((c) => ({
              name: c.name,
              type: c.dataType,
              nullable: c.isNullable,
              masked: ctx.options.maskedColumns.test(c.name),
            })),
          })),
        };
      },
    }),
    route({
      method: 'GET',
      path: '/tenants/:id/tables/:table',
      permission: 'data:read',
      tag: 'data',
      summary:
        'Filas de una tabla (solo lectura): ?page, perPage (máx. 100), sort=col, order=asc|desc, filter.<col>=valor',
      async handler(request) {
        const id = TenantIdParam(request.params.id!);
        const table = (await tables(id)).find((x) => x.name === request.params.table);
        if (!table)
          throw new AdminHttpError(
            404,
            'ADMIN_TABLE_NOT_FOUND',
            `Table "${request.params.table}" not found`,
          );
        const columns = new Set(table.columns.map((c) => c.name));
        const { page: pageNumber, perPage } = page(request);
        const sort = request.query.get('sort');
        if (sort && !columns.has(sort))
          throw new AdminHttpError(422, 'ADMIN_INVALID_COLUMN', `Unknown column "${sort}"`);
        const order = request.query.get('order') === 'desc' ? 'desc' : 'asc';
        const filters: [string, string][] = [];
        for (const [key, value] of request.query) {
          if (!key.startsWith('filter.')) continue;
          const column = key.slice(7);
          if (!columns.has(column))
            throw new AdminHttpError(422, 'ADMIN_INVALID_COLUMN', `Unknown column "${column}"`);
          if (ctx.options.maskedColumns.test(column))
            throw new AdminHttpError(403, 'ADMIN_MASKED_COLUMN', `Column "${column}" is masked`);
          filters.push([column, value]);
        }
        const result = await t.run(id, async () => {
          let base = t.db().selectFrom(table.name);
          for (const [column, value] of filters) base = base.where(sql.ref(column), '=', value);
          const [count, rows] = await Promise.all([
            base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow(),
            (sort ? base.orderBy(sql.ref(sort), order) : base.orderBy(sql`(select null)`))
              .selectAll()
              .$call((q) => paginate(t.database.connection().kind, q, perPage, (pageNumber - 1) * perPage))
              .execute(),
          ]);
          return { total: Number(count.n), rows: rows as Record<string, unknown>[] };
        });
        const masked = result.rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([k, value]) => [
              k,
              ctx.options.maskedColumns.test(k) && value !== null ? '••••••' : value,
            ]),
          ),
        );
        await ctx.record(request, {
          action: 'data.view',
          tenantId: id,
          targetType: 'table',
          targetId: table.name,
          changes: { page: pageNumber, filters: Object.fromEntries(filters) },
        });
        return {
          body: { table: table.name, page: pageNumber, perPage, total: result.total, rows: masked },
        };
      },
    }),
  ];
}
