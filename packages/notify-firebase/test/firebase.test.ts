import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestTenancy } from '@tenancy-node/testing';
import {
  InvalidConfigError,
  createNotification,
  type NotificationDevice,
} from '@tenancy-node/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firebase, firebaseFromEnv } from '@tenancy-node/notify-firebase';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
  project_id: 'clinicas-demo',
  client_email: 'push@clinicas-demo.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

/** Servidor falso de Google: OAuth (verifica la firma del JWT) y FCM v1. */
function fakeGoogle() {
  const state = { tokenRequests: 0, messages: [] as any[], failAll: false }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (req.url === '/token') {
        state.tokenRequests++;
        const assertion = new URLSearchParams(body).get('assertion')!;
        const [h, c, s] = assertion.split('.');
        const ok = createVerify('RSA-SHA256')
          .update(`${h}.${c}`)
          .verify(publicKey, Buffer.from(s!, 'base64url'));
        const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
        if (
          !ok ||
          claims.iss !== account.client_email ||
          !claims.scope.includes('firebase.messaging')
        ) {
          res.writeHead(401).end('bad jwt');
          return;
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ access_token: 'ya29.fake', expires_in: 3600 }));
        return;
      }
      if (req.url === '/v1/projects/clinicas-demo/messages:send') {
        if (req.headers.authorization !== 'Bearer ya29.fake') return void res.writeHead(401).end();
        const { message } = JSON.parse(body);
        state.messages.push(message);
        if (state.failAll) return void res.writeHead(500).end('{"error":{"status":"INTERNAL"}}');
        if (message.token.startsWith('dead'))
          return void res
            .writeHead(404, { 'content-type': 'application/json' })
            .end(
              JSON.stringify({
                error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] },
              }),
            );
        if (message.token.startsWith('flaky'))
          return void res.writeHead(503).end(JSON.stringify({ error: { status: 'UNAVAILABLE' } }));
        res.writeHead(200).end(JSON.stringify({ name: 'projects/clinicas-demo/messages/1' }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  return { server, state };
}

const device = (token: string): NotificationDevice => ({
  token,
  tenantId: 'aa',
  userId: 'u1',
  platform: 'web',
  roles: null,
  lastSeenAt: new Date(),
});

describe('firebase channel', () => {
  const google = fakeGoogle();
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((r) => google.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(google.server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => google.server.close(() => r())));
  const make = (extra = {}) =>
    firebase({
      serviceAccount: account,
      endpoints: { token: `${base}/token`, api: base },
      ...extra,
    });

  it('signs a JWT, caches the access token and sends one message per device', async () => {
    const channel = make({ defaultLink: '/avisos' });
    const n = createNotification(
      {
        title: 'Mantenimiento',
        body: 'Sábado 2 a 4',
        level: 'critical',
        link: { url: 'https://x.com/a' },
      },
      'N1',
      new Date(),
    );
    const result = await channel.send(n, [
      device('tok-aaaaaaaa'),
      device('dead-bbbbbbb'),
      device('flaky-cccccc'),
    ]);
    expect(result).toEqual({ sent: 1, failed: 2, invalidTokens: ['dead-bbbbbbb'] });
    const ok = google.state.messages.find((m) => m.token === 'tok-aaaaaaaa');
    expect(ok).toEqual({
      token: 'tok-aaaaaaaa',
      notification: { title: 'Mantenimiento', body: 'Sábado 2 a 4' },
      data: { notificationId: 'N1', level: 'critical', link: 'https://x.com/a' },
      android: { priority: 'high' },
      apns: { headers: { 'apns-priority': '10' } },
      webpush: { fcm_options: { link: 'https://x.com/a' } },
    });
    await channel.send(createNotification({ title: 'Otro' }, 'N2', new Date()), [
      device('tok-dddddddd'),
    ]);
    expect(google.state.tokenRequests).toBe(1);
    const last = google.state.messages.at(-1);
    expect(last.data).toEqual({ notificationId: 'N2', level: 'info', link: '/avisos' });
    expect(last.webpush).toBeUndefined();
    expect(await channel.send(createNotification({ title: 'x' }, 'N3', new Date()), [])).toEqual({
      sent: 0,
      failed: 0,
      invalidTokens: [],
    });
  });

  it('throws when every message fails (bad config) and uses custom data', async () => {
    google.state.failAll = true;
    const channel = make({ data: () => ({ custom: '1' }) });
    await expect(
      channel.send(createNotification({ title: 'x' }, 'N4', new Date()), [device('tok-eeeeeeee')]),
    ).rejects.toThrow(/every message failed/);
    expect(google.state.messages.at(-1).data).toEqual({ custom: '1' });
    google.state.failAll = false;
  });

  it('fails clearly with a wrong key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const channel = firebase({
      serviceAccount: {
        ...account,
        private_key: other.export({ type: 'pkcs8', format: 'pem' }).toString(),
      },
      endpoints: { token: `${base}/token`, api: base },
    });
    await expect(
      channel.send(createNotification({ title: 'x' }, 'N5', new Date()), [device('tok-ffffffff')]),
    ).rejects.toThrow(/token request failed \(401\)/);
  });

  it('reads the service account from JSON text, a file or the environment', async () => {
    const escaped = JSON.stringify({
      ...account,
      private_key: account.private_key.replace(/\n/g, '\\n'),
    });
    expect(firebase({ serviceAccount: escaped }).name).toBe('firebase');
    const dir = await mkdtemp(path.join(tmpdir(), 'fcm-'));
    const file = path.join(dir, 'sa.json');
    await writeFile(file, JSON.stringify(account));
    expect(firebase({ serviceAccount: file }).name).toBe('firebase');
    expect(firebaseFromEnv({})).toBeUndefined();
    expect(
      firebaseFromEnv({ GOOGLE_APPLICATION_CREDENTIALS: file, FIREBASE_PROJECT_ID: 'otro' })?.name,
    ).toBe('firebase');
    expect(() => firebase({ serviceAccount: '{nope' })).toThrow(InvalidConfigError);
    expect(() => firebase({ serviceAccount: { project_id: 'x' } as never })).toThrow(
      /client_email/,
    );
    expect(() => firebase({ serviceAccount: { ...account, project_id: '' } })).toThrow(/projectId/);
  });

  it('delivers tenancy notifications end to end and removes dead tokens', async () => {
    const { tenancy } = createTestTenancy({ notifications: { channels: [make()] } });
    await tenancy.tenants.create({ id: 'aa' });
    await tenancy.run('aa', async () => {
      await tenancy.notifications.devices.register({ userId: 'u1', token: 'tok-gggggggg' });
      await tenancy.notifications.devices.register({ userId: 'u2', token: 'dead-hhhhhhh' });
    });
    const n = await tenancy.notifications.send({ title: 'Hola' });
    const [result] = await tenancy.notifications.deliver(n.id);
    expect(result).toMatchObject({
      channel: 'firebase',
      devices: 2,
      sent: 1,
      failed: 1,
      removedTokens: 1,
    });
    expect(await tenancy.run('aa', () => tenancy.notifications.devices.list())).toHaveLength(1);
  });
});
