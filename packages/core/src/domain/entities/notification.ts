import { InvalidNotificationError } from '../errors/errors.js';

export const NOTIFICATION_LEVELS = ['info', 'success', 'warning', 'critical'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/** A quién llega un aviso: todos los tenants, algunos, o los de ciertos planes. */
export type NotificationAudience =
  | { type: 'all' }
  | { type: 'tenants'; tenants: readonly string[] }
  | { type: 'plans'; plans: readonly string[] };

/** Aviso de la plataforma a sus tenants (mantenimiento, novedades, cobros...). */
export interface Notification {
  id: string;
  title: string;
  body: string;
  level: NotificationLevel;
  audience: NotificationAudience;
  /** Roles de la app que lo ven (`['ADMIN']`). `null` = todos. Lo filtra `forTenant({ roles })`. */
  roles: readonly string[] | null;
  /** Botón opcional ("Ver detalles"). */
  link: { url: string; label: string } | null;
  /** Desde cuándo se muestra. `null` = desde que se envía. */
  startsAt: Date | null;
  /** Hasta cuándo se muestra. `null` = sin vencimiento. */
  expiresAt: Date | null;
  /** Quién lo envió (email del panel, `cli`...). */
  createdBy: string | null;
  createdAt: Date;
}

export interface NewNotification {
  title: string;
  body?: string;
  level?: NotificationLevel;
  /** Por defecto, todos los tenants. */
  audience?: NotificationAudience;
  roles?: readonly string[] | null;
  link?: { url: string; label?: string } | null;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  createdBy?: string | null;
}

const MAX_TARGETS = 1000;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const LINK = /^(https?:\/\/|\/)[^\s"'<>\\]{0,2000}$/;

/** Valida y normaliza un aviso nuevo. */
export function createNotification(input: NewNotification, id: string, now: Date): Notification {
  const fail = (field: string, reason: string) => new InvalidNotificationError(field, reason);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length === 0 || title.length > 150)
    throw fail('title', 'must have 1 to 150 characters');
  const body = (input.body ?? '').trim();
  if (body.length > 5000) throw fail('body', 'must have at most 5000 characters');
  const level = input.level ?? 'info';
  if (!NOTIFICATION_LEVELS.includes(level))
    throw fail('level', `must be one of ${NOTIFICATION_LEVELS.join(', ')}`);

  const audience = normalizeAudience(input.audience ?? { type: 'all' }, fail);

  let roles: string[] | null = null;
  if (input.roles !== undefined && input.roles !== null) {
    if (!Array.isArray(input.roles)) throw fail('roles', 'must be an array');
    for (const r of input.roles)
      if (typeof r !== 'string' || r.length === 0 || r.length > 64)
        throw fail('roles', `invalid role "${String(r)}"`);
    roles = input.roles.length > 0 ? [...new Set(input.roles)] : null;
  }

  let link: Notification['link'] = null;
  if (input.link) {
    if (typeof input.link.url !== 'string' || !LINK.test(input.link.url))
      throw fail('link.url', 'must be an http(s) URL or an absolute path');
    const label = (input.link.label ?? 'Ver más').trim();
    if (label.length === 0 || label.length > 60)
      throw fail('link.label', 'must have 1 to 60 characters');
    link = { url: input.link.url, label };
  }

  const startsAt = input.startsAt ?? null;
  const expiresAt = input.expiresAt ?? null;
  for (const [field, value] of [
    ['startsAt', startsAt],
    ['expiresAt', expiresAt],
  ] as const) {
    if (value !== null && (!(value instanceof Date) || Number.isNaN(value.getTime())))
      throw fail(field, 'must be a valid date');
  }
  if (expiresAt && expiresAt.getTime() <= (startsAt ?? now).getTime())
    throw fail('expiresAt', 'must be after the start');

  return {
    id,
    title,
    body,
    level,
    audience,
    roles,
    link,
    startsAt,
    expiresAt,
    createdBy: input.createdBy ?? null,
    createdAt: now,
  };
}

function normalizeAudience(
  audience: NotificationAudience,
  fail: (field: string, reason: string) => Error,
): NotificationAudience {
  if (!audience || typeof audience !== 'object') throw fail('audience', 'is required');
  if (audience.type === 'all') return { type: 'all' };
  if (audience.type !== 'tenants' && audience.type !== 'plans')
    throw fail('audience.type', 'must be all, tenants or plans');
  const field = audience.type;
  const values = (audience as { tenants?: unknown; plans?: unknown })[field];
  if (!Array.isArray(values) || values.length === 0)
    throw fail(`audience.${field}`, 'must be a non-empty array');
  if (values.length > MAX_TARGETS) throw fail(`audience.${field}`, `at most ${MAX_TARGETS} items`);
  for (const v of values)
    if (typeof v !== 'string' || !KEY.test(v))
      throw fail(`audience.${field}`, `invalid value "${String(v)}"`);
  const unique = [...new Set(values as string[])].sort();
  return field === 'tenants'
    ? { type: 'tenants', tenants: unique }
    : { type: 'plans', plans: unique };
}

/** ¿El aviso le llega a este tenant (con su plan efectivo) en este momento? */
export function notificationReaches(
  n: Notification,
  tenant: { id: string; plan: string | null },
  now: Date,
): boolean {
  if (n.startsAt && n.startsAt.getTime() > now.getTime()) return false;
  if (n.expiresAt && n.expiresAt.getTime() <= now.getTime()) return false;
  if (n.audience.type === 'all') return true;
  if (n.audience.type === 'tenants') return n.audience.tenants.includes(tenant.id);
  return tenant.plan !== null && n.audience.plans.includes(tenant.plan);
}

export const DEVICE_PLATFORMS = ['web', 'android', 'ios'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** Dispositivo de un usuario de un tenant que recibe notificaciones push (Firebase, etc.). */
export interface NotificationDevice {
  /** Token del proveedor (FCM, APNs...). Único. */
  token: string;
  tenantId: string;
  userId: string;
  platform: DevicePlatform;
  /** Roles del usuario en la app, para avisos dirigidos a ciertos roles. */
  roles: readonly string[] | null;
  lastSeenAt: Date;
}

/**
 * Canal que entrega los avisos fuera de la app (push con Firebase, correo, WhatsApp...).
 * `@tenancy-node/notify-firebase` es uno; puedes escribir el tuyo.
 */
export interface NotificationChannel {
  readonly name: string;
  /** Envía el aviso a los dispositivos. Devuelve los tokens que ya no sirven (se borran). */
  send(
    notification: Notification,
    devices: readonly NotificationDevice[],
  ): Promise<{ sent: number; failed: number; invalidTokens: readonly string[] }>;
}
