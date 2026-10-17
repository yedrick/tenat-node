import {
  DEVICE_PLATFORMS,
  InvalidNotificationError,
  NotificationNotFoundError,
  TenantId,
  createNotification,
  notificationReaches,
  type DevicePlatform,
  type NewNotification,
  type Notification,
  type NotificationAudience,
  type NotificationChannel,
  type NotificationDevice,
  type Tenant,
} from '../domain/index.js';
import type {
  Clock,
  IdGenerator,
  NotificationRepository,
  Page,
  TenantRepository,
} from '../ports/index.js';

/** Aviso tal como lo ve un usuario de un tenant. */
export interface TenantNotification extends Notification {
  /** `true` si este usuario ya lo leyó (sin `userId`, siempre `false`). */
  read: boolean;
}

export interface ForTenantOptions {
  /** Por defecto, el tenant del contexto. */
  tenant?: Tenant;
  /** Usuario de tu app: marca `read` en cada aviso. */
  userId?: string;
  /** Roles del usuario: deja fuera los avisos dirigidos a otros roles. */
  roles?: readonly string[];
  /** Solo los no leídos (requiere `userId`). */
  unreadOnly?: boolean;
}

export interface RegisterDeviceInput {
  userId: string;
  token: string;
  platform?: DevicePlatform;
  roles?: readonly string[] | null;
}

export interface NotificationDelivery {
  notificationId: string;
  channel: string;
  tenants: number;
  devices: number;
  sent: number;
  failed: number;
  removedTokens: number;
}

export interface NotificationsApi {
  /**
   * Envía un aviso a todos los tenants, a algunos (`{ type: 'tenants', tenants }`) o a los de
   * ciertos planes (`{ type: 'plans', plans }`). Publica `notification.sent` y, con canales
   * configurados (Firebase...), lo entrega a los dispositivos registrados en segundo plano.
   */
  send(input: NewNotification): Promise<Notification>;
  get(id: string): Promise<Notification | undefined>;
  /** Todos los avisos (panel), más nuevos primero. */
  list(query?: { page?: number; perPage?: number }): Promise<Page<Notification>>;
  /** Retira un aviso: deja de mostrarse y se borran sus lecturas. */
  delete(id: string): Promise<void>;
  /** Avisos vigentes para un tenant (por defecto, el del contexto). */
  forTenant(options?: ForTenantOptions): Promise<TenantNotification[]>;
  unreadCount(options: ForTenantOptions & { userId: string }): Promise<number>;
  /** Marca leídos uno, varios o `'all'` (todos los vigentes del tenant). */
  markRead(
    ids: string | readonly string[] | 'all',
    userId: string,
    options?: { tenant?: Tenant; roles?: readonly string[] },
  ): Promise<void>;
  /** Cuántos tenants (activos) alcanza una audiencia. Para la vista previa del panel. */
  reach(audience: NotificationAudience): Promise<number>;
  /** Lecturas por aviso. */
  stats(ids: readonly string[]): Promise<Map<string, { tenants: number; users: number }>>;
  /** Vuelve a entregar un aviso por los canales (por ejemplo, después de configurar Firebase). */
  deliver(id: string): Promise<NotificationDelivery[]>;
  /** Dispositivos para push. Se registran desde la app del tenant (el token lo da el SDK del proveedor). */
  readonly devices: {
    register(input: RegisterDeviceInput, tenant?: Tenant): Promise<void>;
    unregister(token: string): Promise<void>;
    list(options?: { tenant?: Tenant; userId?: string }): Promise<NotificationDevice[]>;
  };
  /** Nombres de los canales configurados. */
  readonly channels: readonly string[];
}

export interface NotificationServiceDeps {
  repository: NotificationRepository;
  tenants: TenantRepository;
  channels: readonly NotificationChannel[];
  clock: Clock;
  ids: IdGenerator;
  /** Plan efectivo de un tenant (con `defaultPlan`). */
  planOf(tenant: Tenant): string | null;
  current(): Tenant;
  publish(type: string, data: unknown): Promise<unknown>;
  /** Corre la entrega fuera de la petición (en segundo plano o en la cola). */
  schedule(id: string): Promise<void>;
  report(error: unknown, context: Record<string, unknown>): void;
  cacheTtlMs: number;
}

const DEVICE_BATCH = 500;
const TENANT_BATCH = 500;
const TOKEN = /^[\x21-\x7e]{8,512}$/;

export function createNotificationService(deps: NotificationServiceDeps): NotificationsApi {
  const repo = deps.repository;
  let cache: { at: number; items: Notification[] } | undefined;
  const active = async () => {
    const now = deps.clock.now().getTime();
    if (!cache || now - cache.at > deps.cacheTtlMs)
      cache = { at: now, items: await repo.active(deps.clock.now()) };
    return cache.items;
  };
  const clear = () => (cache = undefined);

  const visible = async (options: ForTenantOptions) => {
    const tenant = options.tenant ?? deps.current();
    const target = { id: tenant.id.value, plan: deps.planOf(tenant) };
    const now = deps.clock.now();
    const items = (await active()).filter(
      (n) =>
        notificationReaches(n, target, now) &&
        (!n.roles || (options.roles ?? []).some((r) => n.roles!.includes(r))),
    );
    return { tenant, items };
  };

  /** Recorre los tenants activos que alcanza la audiencia, por lotes. */
  async function* reached(audience: NotificationAudience): AsyncGenerator<Tenant[]> {
    if (audience.type === 'tenants') {
      for (let i = 0; i < audience.tenants.length; i += TENANT_BATCH) {
        const batch: Tenant[] = [];
        for (const raw of audience.tenants.slice(i, i + TENANT_BATCH)) {
          const id = TenantId.tryCreate(raw);
          const tenant = id ? await deps.tenants.findById(id) : undefined;
          if (tenant?.status === 'active') batch.push(tenant);
        }
        if (batch.length > 0) yield batch;
      }
      return;
    }
    for (let page = 1; ; page++) {
      const result = await deps.tenants.list({ status: 'active', page, perPage: TENANT_BATCH });
      const batch =
        audience.type === 'all'
          ? result.items
          : result.items.filter((t) => {
              const plan = deps.planOf(t);
              return plan !== null && audience.plans.includes(plan);
            });
      if (batch.length > 0) yield batch;
      if (page * TENANT_BATCH >= result.total) return;
    }
  }

  const deliver = async (id: string): Promise<NotificationDelivery[]> => {
    const notification = await repo.findById(id);
    if (!notification) throw new NotificationNotFoundError(id);
    const results = deps.channels.map((channel) => ({
      notificationId: id,
      channel: channel.name,
      tenants: 0,
      devices: 0,
      sent: 0,
      failed: 0,
      removedTokens: 0,
    }));
    if (results.length === 0) return results;
    for await (const tenants of reached(notification.audience)) {
      const devices = (await repo.devices(tenants.map((t) => t.id.value))).filter(
        (d) => !notification.roles || (d.roles ?? []).some((r) => notification.roles!.includes(r)),
      );
      for (const [i, channel] of deps.channels.entries()) {
        const result = results[i]!;
        result.tenants += tenants.length;
        for (let j = 0; j < devices.length; j += DEVICE_BATCH) {
          const chunk = devices.slice(j, j + DEVICE_BATCH);
          result.devices += chunk.length;
          try {
            const outcome = await channel.send(notification, chunk);
            result.sent += outcome.sent;
            result.failed += outcome.failed;
            if (outcome.invalidTokens.length > 0)
              result.removedTokens += await repo.deleteDevices(outcome.invalidTokens);
          } catch (error) {
            result.failed += chunk.length;
            deps.report(error, { notificationId: id, channel: channel.name });
          }
        }
      }
    }
    for (const result of results) await deps.publish('notification.delivered', result);
    return results;
  };

  return {
    channels: deps.channels.map((c) => c.name),
    async send(input) {
      const notification = createNotification(input, deps.ids.generate(), deps.clock.now());
      await repo.insert(notification);
      clear();
      await deps.publish('notification.sent', {
        id: notification.id,
        title: notification.title,
        body: notification.body,
        level: notification.level,
        audience: notification.audience,
        roles: notification.roles,
        link: notification.link,
        startsAt: notification.startsAt?.toISOString() ?? null,
        expiresAt: notification.expiresAt?.toISOString() ?? null,
        createdBy: notification.createdBy,
      });
      if (deps.channels.length > 0) await deps.schedule(notification.id);
      return notification;
    },
    get: (id) => repo.findById(id),
    list: (query) => repo.list(query),
    async delete(id) {
      if (!(await repo.delete(id))) throw new NotificationNotFoundError(id);
      clear();
    },
    async forTenant(options = {}) {
      const { tenant, items } = await visible(options);
      const read =
        options.userId === undefined
          ? new Set<string>()
          : await repo.readIds(
              tenant.id.value,
              options.userId,
              items.map((n) => n.id),
            );
      return items
        .map((n) => ({ ...structuredClone(n), read: read.has(n.id) }))
        .filter((n) => !options.unreadOnly || !n.read);
    },
    async unreadCount(options) {
      return (await this.forTenant({ ...options, unreadOnly: true })).length;
    },
    async markRead(ids, userId, options = {}) {
      if (typeof userId !== 'string' || userId.length === 0 || userId.length > 191)
        throw new InvalidNotificationError('userId', 'must have 1 to 191 characters');
      const { tenant, items } = await visible(options);
      const allowed = new Set(items.map((n) => n.id));
      const list = ids === 'all' ? [...allowed] : ([] as string[]).concat(ids as string | string[]);
      const entries = list
        .filter((id) => allowed.has(id))
        .map((notificationId) => ({ notificationId, tenantId: tenant.id.value, userId }));
      if (entries.length > 0) await repo.markRead(entries, deps.clock.now());
    },
    async reach(audience) {
      const normalized = createNotification(
        { title: 'x', audience },
        'preview',
        deps.clock.now(),
      ).audience;
      let n = 0;
      for await (const batch of reached(normalized)) n += batch.length;
      return n;
    },
    stats: (ids) => repo.readStats(ids),
    deliver,
    devices: {
      async register(input, tenant) {
        const target = tenant ?? deps.current();
        if (typeof input.token !== 'string' || !TOKEN.test(input.token))
          throw new InvalidNotificationError('token', 'is not a valid device token');
        if (
          typeof input.userId !== 'string' ||
          input.userId.length === 0 ||
          input.userId.length > 191
        )
          throw new InvalidNotificationError('userId', 'must have 1 to 191 characters');
        const platform = input.platform ?? 'web';
        if (!DEVICE_PLATFORMS.includes(platform))
          throw new InvalidNotificationError(
            'platform',
            `must be one of ${DEVICE_PLATFORMS.join(', ')}`,
          );
        await repo.saveDevice({
          token: input.token,
          tenantId: target.id.value,
          userId: input.userId,
          platform,
          roles: input.roles && input.roles.length > 0 ? [...input.roles] : null,
          lastSeenAt: deps.clock.now(),
        });
      },
      async unregister(token) {
        await repo.deleteDevices([token]);
      },
      list: (options = {}) =>
        repo.devices([(options.tenant ?? deps.current()).id.value], options.userId),
    },
  };
}
