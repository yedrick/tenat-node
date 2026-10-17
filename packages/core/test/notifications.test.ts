import { createTestTenancy, notificationRepositoryContract } from '@tenancy-node/testing';
import { describe, expect, it } from 'vitest';
import {
  InMemoryNotificationRepository,
  InvalidNotificationError,
  NotificationNotFoundError,
  TenantNotIdentifiedError,
  createNotification,
  type EventEnvelope,
  type NotificationChannel,
  type NotificationDevice,
  type TenancyConfig,
} from '../src/index.js';

notificationRepositoryContract(
  'InMemoryNotificationRepository',
  () => new InMemoryNotificationRepository(),
);

const PLANS: TenancyConfig = {
  plans: {
    basico: { label: 'Básico', features: [] },
    pro: { label: 'Pro', features: [] },
  },
  defaultPlan: 'basico',
};

function fakeChannel(invalid: string[] = []) {
  const calls: { title: string; tokens: string[] }[] = [];
  const channel: NotificationChannel = {
    name: 'fake',
    async send(notification, devices: readonly NotificationDevice[]) {
      calls.push({ title: notification.title, tokens: devices.map((d) => d.token).sort() });
      const bad = devices.filter((d) => invalid.includes(d.token)).map((d) => d.token);
      return { sent: devices.length - bad.length, failed: bad.length, invalidTokens: bad };
    },
  };
  return { channel, calls };
}

async function setup(config: TenancyConfig = {}) {
  const test = createTestTenancy({ ...PLANS, ...config });
  const { tenancy } = test;
  await tenancy.tenants.create({ id: 'aa', plan: 'basico' });
  await tenancy.tenants.create({ id: 'bb', plan: 'pro' });
  await tenancy.tenants.create({ id: 'cc' }); // sin plan: usa basico
  await tenancy.tenants.create({ id: 'dd', plan: 'pro' });
  await tenancy.tenants.suspend('dd');
  return test;
}

describe('createNotification', () => {
  const now = new Date('2026-10-17T10:00:00Z');
  it('normalizes the audience, roles and link', () => {
    const n = createNotification(
      {
        title: '  Mantenimiento  ',
        audience: { type: 'tenants', tenants: ['bb', 'aa', 'bb'] },
        roles: ['ADMIN', 'ADMIN'],
        link: { url: '/novedades' },
      },
      'id1',
      now,
    );
    expect(n).toMatchObject({
      title: 'Mantenimiento',
      body: '',
      level: 'info',
      audience: { type: 'tenants', tenants: ['aa', 'bb'] },
      roles: ['ADMIN'],
      link: { url: '/novedades', label: 'Ver más' },
    });
    expect(createNotification({ title: 'x', roles: [] }, 'i', now).roles).toBeNull();
  });

  it.each([
    [{ title: '' }, 'title'],
    [{ title: 'x', body: 'a'.repeat(5001) }, 'body'],
    [{ title: 'x', level: 'urgent' }, 'level'],
    [{ title: 'x', audience: { type: 'tenants', tenants: [] } }, 'audience.tenants'],
    [{ title: 'x', audience: { type: 'plans', plans: ['ok', 'no válido'] } }, 'audience.plans'],
    [{ title: 'x', audience: { type: 'world' } }, 'audience.type'],
    [{ title: 'x', roles: 'ADMIN' }, 'roles'],
    [{ title: 'x', roles: [''] }, 'roles'],
    [{ title: 'x', link: { url: 'javascript:alert(1)' } }, 'link.url'],
    [{ title: 'x', link: { url: '/a', label: '' } }, 'link.label'],
    [{ title: 'x', startsAt: new Date('nope') }, 'startsAt'],
    [{ title: 'x', expiresAt: new Date('2026-10-17T09:00:00Z') }, 'expiresAt'],
  ])('rejects invalid input %#', (input, field) => {
    expect(() => createNotification(input as never, 'id', now)).toThrow(InvalidNotificationError);
    expect(() => createNotification(input as never, 'id', now)).toThrow(`"${field}"`);
  });
});

describe('tenancy.notifications', () => {
  it('reaches all, some or plan tenants, with read state per user and roles', async () => {
    const { tenancy, clock } = await setup();
    const events: EventEnvelope[] = [];
    tenancy.events.on('notification.*', (e) => void events.push(e), { mode: 'sync' });

    const all = await tenancy.notifications.send({
      title: 'Para todos',
      level: 'warning',
      createdBy: 'yo',
    });
    const some = await tenancy.notifications.send({
      title: 'Solo aa',
      audience: { type: 'tenants', tenants: ['aa'] },
    });
    const pro = await tenancy.notifications.send({
      title: 'Plan pro',
      audience: { type: 'plans', plans: ['pro'] },
    });
    const basico = await tenancy.notifications.send({
      title: 'Plan básico',
      audience: { type: 'plans', plans: ['basico'] },
    });
    const admins = await tenancy.notifications.send({ title: 'Solo admins', roles: ['ADMIN'] });
    await tenancy.notifications.send({
      title: 'Futuro',
      startsAt: new Date(clock.now().getTime() + 3_600_000),
    });
    expect(events.map((e) => e.type)).toEqual(Array(6).fill('notification.sent'));
    expect(events[0]!.data).toMatchObject({
      title: 'Para todos',
      audience: { type: 'all' },
      createdBy: 'yo',
    });

    const titles = async (id: string, options: object = {}) =>
      tenancy.run(id, async () =>
        (await tenancy.notifications.forTenant(options)).map((n) => n.title),
      );
    expect(await titles('aa')).toEqual(
      expect.arrayContaining(['Para todos', 'Solo aa', 'Plan básico']),
    );
    expect(await titles('aa')).toHaveLength(3);
    expect(await titles('bb')).toEqual(expect.arrayContaining(['Para todos', 'Plan pro']));
    expect(await titles('bb')).toHaveLength(2);
    // cc no tiene plan: recibe los del plan por defecto.
    expect(await titles('cc')).toContain('Plan básico');
    expect(await titles('cc', { roles: ['ADMIN'] })).toContain('Solo admins');

    await tenancy.run('aa', async () => {
      expect(await tenancy.notifications.unreadCount({ userId: 'u1' })).toBe(3);
      await tenancy.notifications.markRead(all.id, 'u1');
      // Un aviso de otro tenant no se marca.
      await tenancy.notifications.markRead([pro.id, some.id], 'u1');
      const list = await tenancy.notifications.forTenant({ userId: 'u1' });
      expect(
        list
          .filter((n) => n.read)
          .map((n) => n.id)
          .sort(),
      ).toEqual([all.id, some.id].sort());
      expect(
        await tenancy.notifications.forTenant({ userId: 'u1', unreadOnly: true }),
      ).toHaveLength(1);
      expect(await tenancy.notifications.unreadCount({ userId: 'u2' })).toBe(3);
      await tenancy.notifications.markRead('all', 'u2');
      expect(await tenancy.notifications.unreadCount({ userId: 'u2' })).toBe(0);
      await expect(tenancy.notifications.markRead('all', '')).rejects.toThrow(
        InvalidNotificationError,
      );
    });
    const stats = await tenancy.notifications.stats([all.id, pro.id, basico.id]);
    expect(stats.get(all.id)).toEqual({ tenants: 1, users: 2 });
    expect(stats.get(pro.id)).toEqual({ tenants: 0, users: 0 });

    expect(await tenancy.notifications.reach({ type: 'all' })).toBe(3); // dd está suspendido
    expect(await tenancy.notifications.reach({ type: 'plans', plans: ['basico'] })).toBe(2);
    expect(
      await tenancy.notifications.reach({ type: 'tenants', tenants: ['aa', 'dd', 'zz'] }),
    ).toBe(1);

    expect((await tenancy.notifications.list()).total).toBe(6);
    expect((await tenancy.notifications.get(admins.id))?.roles).toEqual(['ADMIN']);
    await tenancy.notifications.delete(admins.id);
    await expect(tenancy.notifications.delete(admins.id)).rejects.toThrow(
      NotificationNotFoundError,
    );
    await expect(tenancy.notifications.forTenant()).rejects.toThrow(TenantNotIdentifiedError);
  });

  it('hides expired notifications and caches the active list', async () => {
    const { tenancy, clock } = await setup({ notifications: { cacheTtlMs: 0 } });
    await tenancy.notifications.send({
      title: 'Corto',
      expiresAt: new Date(clock.now().getTime() + 60_000),
    });
    const count = () =>
      tenancy.run('aa', async () => (await tenancy.notifications.forTenant()).length);
    expect(await count()).toBe(1);
    clock.advance(61_000);
    expect(await count()).toBe(0);
  });

  it('delivers through channels to registered devices and drops invalid tokens', async () => {
    const { channel, calls } = fakeChannel(['token-malo-123']);
    const { tenancy } = await setup({ notifications: { channels: [channel] } });
    const delivered: EventEnvelope[] = [];
    tenancy.events.on('notification.delivered', (e) => void delivered.push(e), { mode: 'sync' });
    await tenancy.run('aa', async () => {
      await tenancy.notifications.devices.register({
        userId: 'u1',
        token: 'token-aa-1234',
        roles: ['ADMIN'],
      });
      await tenancy.notifications.devices.register({
        userId: 'u2',
        token: 'token-malo-123',
        platform: 'android',
      });
      await expect(
        tenancy.notifications.devices.register({ userId: 'u1', token: 'x' }),
      ).rejects.toThrow(InvalidNotificationError);
      await expect(
        tenancy.notifications.devices.register({
          userId: 'u1',
          token: 'token-aa-1234',
          platform: 'nokia' as never,
        }),
      ).rejects.toThrow(/platform/);
      await expect(
        tenancy.notifications.devices.register({ userId: '', token: 'token-aa-1234' }),
      ).rejects.toThrow(/userId/);
    });
    await tenancy.run('bb', () =>
      tenancy.notifications.devices.register({
        userId: 'u9',
        token: 'token-bb-1234',
        platform: 'ios',
      }),
    );
    expect(tenancy.notifications.channels).toEqual(['fake']);

    const n = await tenancy.notifications.send({ title: 'Hola' });
    await expect.poll(() => delivered.length).toBe(1);
    expect(calls[0]).toEqual({
      title: 'Hola',
      tokens: ['token-aa-1234', 'token-bb-1234', 'token-malo-123'],
    });
    expect(delivered[0]!.data).toEqual({
      notificationId: n.id,
      channel: 'fake',
      tenants: 3,
      devices: 3,
      sent: 2,
      failed: 1,
      removedTokens: 1,
    });
    expect(await tenancy.run('aa', () => tenancy.notifications.devices.list())).toHaveLength(1);

    // Dirigido a un rol: solo los dispositivos con ese rol.
    const admins = await tenancy.notifications.send({ title: 'Admins', roles: ['ADMIN'] });
    const result = await tenancy.notifications.deliver(admins.id);
    expect(result[0]).toMatchObject({ devices: 1, sent: 1 });
    await tenancy.notifications.devices.unregister('token-aa-1234');
    expect(
      await tenancy.run('aa', () => tenancy.notifications.devices.list({ userId: 'u1' })),
    ).toEqual([]);
    await expect(tenancy.notifications.deliver('nope')).rejects.toThrow(NotificationNotFoundError);
  });

  it('reports a failing channel and counts the devices as failed', async () => {
    const broken: NotificationChannel = {
      name: 'roto',
      send: async () => {
        throw new Error('FCM caído');
      },
    };
    const { tenancy } = await setup({ notifications: { channels: [broken] } });
    await tenancy.run('aa', () =>
      tenancy.notifications.devices.register({ userId: 'u1', token: 'token-aa-1234' }),
    );
    const n = await tenancy.notifications.send({
      title: 'x',
      audience: { type: 'tenants', tenants: ['aa'] },
    });
    const [result] = await tenancy.notifications.deliver(n.id);
    expect(result).toMatchObject({ devices: 1, failed: 1, sent: 0 });
    expect(
      tenancy.observability.errors().some((e) => e.operation === 'notifications.channel'),
    ).toBe(true);
  });

  it('queues the delivery when delivery is "queue"', async () => {
    const { channel, calls } = fakeChannel();
    const { tenancy } = await setup({ notifications: { channels: [channel], delivery: 'queue' } });
    await tenancy.run('aa', () =>
      tenancy.notifications.devices.register({ userId: 'u1', token: 'token-aa-1234' }),
    );
    await tenancy.notifications.send({ title: 'En cola' });
    expect(calls).toHaveLength(0);
    const worker = await tenancy.worker();
    await expect.poll(() => calls.length).toBe(1);
    await worker.close();
  });

  it('serves GET /tenancy/notifications without role-only notifications', async () => {
    const { tenancy } = await setup({ http: { notifications: true } });
    await tenancy.notifications.send({
      title: 'Público',
      link: { url: 'https://x.com', label: 'Ver' },
    });
    await tenancy.notifications.send({ title: 'Solo admins', roles: ['ADMIN'] });
    await tenancy.run('aa', async () => {
      const res = (await tenancy.http.handle({
        method: 'GET',
        path: '/tenancy/notifications',
        headers: {},
      }))!;
      expect(res.headers['cache-control']).toBe('no-store');
      const body = JSON.parse(res.body as string);
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        title: 'Público',
        link: { url: 'https://x.com', label: 'Ver' },
      });
      expect(body[0].audience).toBeUndefined();
    });
  });
});
