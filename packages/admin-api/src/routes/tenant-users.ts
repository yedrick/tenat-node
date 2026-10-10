import { TenantId, TenantNotFoundError, type Tenant } from '@tenancy-node/core';
import * as v from 'valibot';
import type { AdminContext, TenantUser, TenantUsersAdapter } from '../context.js';
import { AdminHttpError, route } from '../http.js';

const CreateUserBody = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email(), v.maxLength(191)),
  role: v.optional(v.pipe(v.string(), v.maxLength(100))),
  password: v.optional(v.pipe(v.string(), v.minLength(8), v.maxLength(256))),
});

/** Lo que el panel muestra de un usuario: solo campos conocidos (nunca un hash que la app devuelva). */
function userJson(user: TenantUser) {
  return {
    id: String(user.id),
    name: user.name,
    email: user.email ?? null,
    role: user.role ?? null,
    active: user.active ?? true,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

/** Usuarios de la app dentro de cada tenant, a través del `tenantUsers` que da la app. */
export function tenantUserRoutes(ctx: AdminContext) {
  const t = ctx.tenancy;
  const adapter = (): TenantUsersAdapter => {
    const users = ctx.options.tenantUsers;
    if (!users)
      throw new AdminHttpError(
        404,
        'ADMIN_FEATURE_DISABLED',
        'Tenant users are not configured (createAdminApi({ tenantUsers }))',
      );
    return users;
  };
  /** Los usuarios viven en la base del tenant: tiene que estar aprovisionado. */
  const activeTenant = async (id: string): Promise<Tenant> => {
    if (!TenantId.isValid(id)) throw new TenantNotFoundError(id);
    const tenant = await t.tenants.findOrFail(id);
    if (!tenant.database || tenant.status === 'provisioning' || tenant.status === 'failed')
      throw new AdminHttpError(
        409,
        'ADMIN_TENANT_NOT_READY',
        `Tenant "${id}" is ${tenant.status}: its database is not ready`,
      );
    return tenant;
  };

  return [
    route({
      method: 'GET',
      path: '/tenants/:id/users',
      permission: 'tenants:read',
      tag: 'tenant-users',
      summary: 'Usuarios de la app en el tenant (requiere la opción tenantUsers)',
      query: { search: 'nombre o email', page: 'página', perPage: 'por página (máx. 100)' },
      async handler(request) {
        const users = adapter();
        const tenant = await activeTenant(request.params.id!);
        const page = Math.max(1, Number(request.query.get('page') ?? 1) || 1);
        const perPage = Math.min(
          100,
          Math.max(1, Number(request.query.get('perPage') ?? 20) || 20),
        );
        const search = request.query.get('search')?.trim() || undefined;
        const result = await t.run(tenant, () =>
          users.list({ page, perPage, ...(search ? { search } : {}) }, tenant),
        );
        return {
          body: { items: result.items.map(userJson), total: result.total, page, perPage },
        };
      },
    }),
    route({
      method: 'POST',
      path: '/tenants/:id/users',
      permission: 'tenants:write',
      tag: 'tenant-users',
      summary: 'Crea un usuario de la app en el tenant (la contraseña nunca queda en la auditoría)',
      body: CreateUserBody,
      async handler(request) {
        const users = adapter();
        if (!users.create)
          throw new AdminHttpError(
            404,
            'ADMIN_FEATURE_DISABLED',
            'This app does not allow creating users from the panel',
          );
        const tenant = await activeTenant(request.params.id!);
        const { name, email, role, password } = request.body;
        if (role !== undefined && users.roles?.length && !users.roles.some((r) => r.value === role))
          throw new AdminHttpError(422, 'ADMIN_VALIDATION_FAILED', 'Invalid request body', [
            { path: 'role', message: `Unknown role "${role}"` },
          ]);
        const created = userJson(
          await t.run(tenant, () =>
            users.create!(
              {
                name,
                email,
                ...(role !== undefined ? { role } : {}),
                ...(password !== undefined ? { password } : {}),
              },
              tenant,
            ),
          ),
        );
        await ctx.record(request, {
          action: 'tenant_user.create',
          tenantId: tenant.id.value,
          targetType: 'user',
          targetId: created.id,
          changes: {
            after: { name: created.name, email: created.email, role: created.role },
            initialPassword: password !== undefined,
          },
        });
        return { status: 201, body: created };
      },
    }),
  ];
}
