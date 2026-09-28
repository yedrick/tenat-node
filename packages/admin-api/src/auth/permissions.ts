export const ROLES = ['owner', 'admin', 'support'] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'tenants:read'
  | 'tenants:write'
  | 'tenants:delete'
  | 'data:read'
  | 'cache:flush'
  | 'migrations:run'
  | 'impersonate'
  | 'webhooks:read'
  | 'webhooks:write'
  | 'events:read'
  | 'events:retry'
  | 'metrics:read'
  | 'audit:read'
  | 'users:manage'
  | 'self';

/**
 * Matriz de permisos:
 * - support: ver todo lo operativo, vaciar caché e impersonar (soporte al cliente).
 * - admin: además cambia tenants, dominios, tema, migraciones, webhooks y reintenta eventos.
 * - owner: además borra tenants y administra usuarios del panel.
 */
const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  support: new Set<Permission>([
    'self',
    'tenants:read',
    'data:read',
    'cache:flush',
    'impersonate',
    'webhooks:read',
    'events:read',
    'metrics:read',
  ]),
  admin: new Set<Permission>([
    'self',
    'tenants:read',
    'tenants:write',
    'data:read',
    'cache:flush',
    'migrations:run',
    'impersonate',
    'webhooks:read',
    'webhooks:write',
    'events:read',
    'events:retry',
    'metrics:read',
    'audit:read',
  ]),
  owner: new Set<Permission>([
    'self',
    'tenants:read',
    'tenants:write',
    'tenants:delete',
    'data:read',
    'cache:flush',
    'migrations:run',
    'impersonate',
    'webhooks:read',
    'webhooks:write',
    'events:read',
    'events:retry',
    'metrics:read',
    'audit:read',
    'users:manage',
  ]),
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].has(permission);
}

export function permissionsOf(role: Role): Permission[] {
  return [...MATRIX[role]];
}
