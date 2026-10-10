import { request as httpRequest } from 'node:http';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTenancy } from '@tenancy-node/core';
import {
  AdminHttpError,
  consumeImpersonationToken,
  serveAdmin,
  totp,
  type TenantUser,
} from '@tenancy-node/admin-api';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { outbox } from '@tenancy-node/outbox';
import { MemoryLogger } from '@tenancy-node/testing';
import { webhooks } from '@tenancy-node/transport-webhook';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
}

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('Admin API (PostgreSQL, HTTP)', () => {
  let container: StartedPostgreSqlContainer;
  let tenancy: ReturnType<typeof makeTenancy>;
  let admin: Awaited<ReturnType<typeof serveAdmin>>;
  let port = 0;
  let url = '';
  const logger = new MemoryLogger();
  const PASSWORD = 'contraseña-muy-segura-123';

  const makeTenancy = (url: string, withKey = true) =>
    createTenancy({
      centralDomains: ['tuapp.com'],
      logger,
      plugins: [
        database({
          driver: postgres(),
          central: { url },
          ...(withKey ? { encryptionKey: 'base64:' + Buffer.alloc(32, 9).toString('base64') } : {}),
          migrations: {
            tenant: {
              '001_clientes': {
                up: (db) =>
                  db.schema
                    .createTable('clientes')
                    .addColumn('id', 'integer', (c) => c.primaryKey())
                    .addColumn('nombre', 'text', (c) => c.notNull())
                    .addColumn('password_hash', 'text')
                    .execute(),
              },
            },
          },
          seed: async (db) => {
            await db
              .insertInto('clientes')
              .values([
                { id: 1, nombre: 'Ana', password_hash: '$argon2id$secreto' },
                { id: 2, nombre: 'Beto', password_hash: null },
                { id: 3, nombre: 'Carla', password_hash: 'x' },
              ])
              .execute();
          },
        }),
        outbox(),
        webhooks({ allowPrivateNetworks: true }),
      ],
    });

  const call = (
    method: string,
    path: string,
    options: {
      body?: unknown;
      raw?: string | Buffer;
      headers?: Record<string, string>;
      host?: string;
    } = {},
  ) =>
    new Promise<Response>((resolve, reject) => {
      const payload =
        options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path: `/admin/api${path}`,
          headers: {
            host: options.host ?? '127.0.0.1',
            ...(payload !== undefined
              ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
              : {}),
            ...options.headers,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (c: Buffer) => (text += c.toString()));
          res.on('end', () => {
            let body: unknown = undefined;
            try {
              body = text ? JSON.parse(text) : undefined;
            } catch {
              body = undefined;
            }
            resolve({ status: res.statusCode!, headers: res.headers, body, text });
          });
        },
      );
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  /** Login con cookie: devuelve los headers para las siguientes peticiones (cookie + CSRF). */
  const login = async (email: string, password = PASSWORD, extra: Record<string, unknown> = {}) => {
    const res = await call('POST', '/auth/login', { body: { email, password, ...extra } });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    return {
      cookie,
      csrf: res.body.csrfToken as string,
      headers: { cookie, 'x-csrf-token': res.body.csrfToken as string },
    };
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withUsername('admin')
      .withPassword('secret')
      .withDatabase('app')
      .start();
    url = `postgres://admin:secret@${container.getHost()}:${container.getPort()}/app`;
    tenancy = makeTenancy(url);
    await tenancy.database.install();
    admin = await serveAdmin(tenancy, {
      port: 0,
      sessionSecret: 'x'.repeat(40),
      secureCookies: false,
      loginRateLimit: { max: 3, windowMs: 60_000 },
    });
    port = (admin.server.address() as { port: number }).port;
    const users = await import('../src/auth/users.js');
    const { AdminUsers } = users;
    const repo = new AdminUsers(tenancy.database.central());
    await repo.create({
      email: 'owner@tuapp.com',
      name: 'Dueña',
      password: PASSWORD,
      role: 'owner',
    });
    await repo.create({
      email: 'admin@tuapp.com',
      name: 'Admin',
      password: PASSWORD,
      role: 'admin',
    });
    await repo.create({
      email: 'soporte@tuapp.com',
      name: 'Soporte',
      password: PASSWORD,
      role: 'support',
    });
  }, 300_000);
  afterAll(async () => {
    await admin?.close();
    await tenancy?.close();
    await container?.stop();
  });

  describe('authentication and sessions', () => {
    it('logs in with an httpOnly cookie, requires CSRF for changes and logs out', async () => {
      const res = await call('POST', '/auth/login', {
        body: { email: 'OWNER@tuapp.com', password: PASSWORD },
      });
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({
        email: 'owner@tuapp.com',
        role: 'owner',
        twoFactorEnabled: false,
      });
      expect(res.body.token).toBeUndefined();
      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toMatch(
        /^tenancy_admin=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/admin; Max-Age=28800$/,
      );
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toBe('no-store');

      const cookie = setCookie.split(';')[0]!;
      expect((await call('GET', '/auth/me', { headers: { cookie } })).body.permissions).toContain(
        'users:manage',
      );
      const noCsrf = await call('POST', '/tenants/bolivar/suspend', { headers: { cookie } });
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body.error.code).toBe('ADMIN_CSRF');
      const wrongCsrf = await call('POST', '/auth/logout', {
        headers: { cookie, 'x-csrf-token': 'x'.repeat(43) },
      });
      expect(wrongCsrf.status).toBe(403);
      expect(
        (
          await call('POST', '/auth/logout', {
            headers: { cookie, 'x-csrf-token': res.body.csrfToken },
          })
        ).status,
      ).toBe(204);
      expect((await call('GET', '/auth/me', { headers: { cookie } })).status).toBe(401);
    });

    it('issues bearer tokens for automation (no CSRF needed)', async () => {
      const res = await call('POST', '/auth/login', {
        body: { email: 'admin@tuapp.com', password: PASSWORD, mode: 'token' },
      });
      expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.headers['set-cookie']).toBeUndefined();
      const me = await call('GET', '/auth/me', {
        headers: { authorization: `Bearer ${res.body.token}` },
      });
      expect(me.body.user.role).toBe('admin');
      expect(
        (await call('GET', '/auth/me', { headers: { authorization: 'Bearer nope' } })).status,
      ).toBe(401);
    });

    it('gives the same answer for unknown emails and wrong passwords, and rate-limits', async () => {
      const unknown = await call('POST', '/auth/login', {
        body: { email: 'nadie@tuapp.com', password: 'loquesea' },
      });
      const wrong = await call('POST', '/auth/login', {
        body: { email: 'soporte@tuapp.com', password: 'incorrecta' },
      });
      expect([unknown.status, wrong.status]).toEqual([401, 401]);
      expect(unknown.body).toEqual(wrong.body);
      await call('POST', '/auth/login', {
        body: { email: 'soporte@tuapp.com', password: 'incorrecta' },
      });
      await call('POST', '/auth/login', {
        body: { email: 'soporte@tuapp.com', password: 'incorrecta' },
      });
      const blocked = await call('POST', '/auth/login', {
        body: { email: 'soporte@tuapp.com', password: PASSWORD },
      });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      // El bloqueo es por IP y por email: se limpia para que los demás tests puedan entrar
      admin.api.context.limiter.clear();
      const failures = await tenancy.database
        .central()
        .db.selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'auth.login_failed')
        .execute();
      expect(failures.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(failures)).not.toContain('incorrecta');
    });

    it('supports two-factor authentication', async () => {
      const { headers } = await login('admin@tuapp.com');
      const setup = await call('POST', '/auth/2fa/setup', { headers });
      expect(setup.body.otpauthUrl).toContain('otpauth://totp/tenancy-node%3Aadmin%40tuapp.com');
      expect(
        (
          await call('POST', '/auth/2fa/enable', {
            headers,
            body: { secret: setup.body.secret, code: '000000' },
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await call('POST', '/auth/2fa/enable', {
            headers,
            body: { secret: setup.body.secret, code: totp(setup.body.secret) },
          })
        ).status,
      ).toBe(204);

      const withoutCode = await call('POST', '/auth/login', {
        body: { email: 'admin@tuapp.com', password: PASSWORD },
      });
      expect(withoutCode.body.error.code).toBe('ADMIN_2FA_REQUIRED');
      const withCode = await login('admin@tuapp.com', PASSWORD, { code: totp(setup.body.secret) });
      expect(
        (
          await call('POST', '/auth/2fa/disable', {
            headers: withCode.headers,
            body: { password: PASSWORD },
          })
        ).status,
      ).toBe(204);
    });
  });

  describe('two-factor authentication without encryptionKey', () => {
    it('answers 501 TENANCY_ENCRYPTION_KEY_MISSING and logs it', async () => {
      const keyless = makeTenancy(url, false);
      const server = await serveAdmin(keyless, {
        port: 0,
        sessionSecret: 'x'.repeat(40),
        secureCookies: false,
      });
      const previousPort = port;
      port = (server.server.address() as { port: number }).port;
      try {
        const { headers } = await login('owner@tuapp.com');
        const setup = await call('POST', '/auth/2fa/setup', { headers });
        expect(setup.status).toBe(501);
        expect(setup.body.error.code).toBe('TENANCY_ENCRYPTION_KEY_MISSING');
        const secret = 'A'.repeat(32);
        const enable = await call('POST', '/auth/2fa/enable', {
          headers,
          body: { secret, code: totp(secret) },
        });
        expect(enable.status).toBe(501);
        expect(enable.body.error).toEqual({
          code: 'TENANCY_ENCRYPTION_KEY_MISSING',
          message: 'An encryption key is required: set `encryptionKey` (TENANCY_KEY)',
        });
        expect(
          keyless.observability.errors().filter((e) => e.code === 'TENANCY_ENCRYPTION_KEY_MISSING'),
        ).toHaveLength(2);
      } finally {
        port = previousPort;
        await server.close();
        await keyless.close();
      }
    });
  });

  describe('tenants', () => {
    it('creates a tenant in the background and streams its progress over SSE', async () => {
      const { headers } = await login('owner@tuapp.com');
      const created = await call('POST', '/tenants', {
        headers,
        body: { id: 'bolivar', name: 'Club Bolívar', domain: 'bolivar.tuapp.com', plan: 'pro' },
      });
      expect(created.status).toBe(202);
      expect(created.body).toEqual({
        id: 'bolivar',
        progress: '/admin/api/tenants/bolivar/progress',
      });

      const sse = await call('GET', '/tenants/bolivar/progress', { headers });
      expect(sse.headers['content-type']).toBe('text/event-stream; charset=utf-8');
      const events = [...sse.text.matchAll(/event: (\w+)\ndata: (.+)\n\n/g)].map((m) => [
        m[1],
        JSON.parse(m[2]!),
      ]);
      const steps = events.filter(([e]) => e === 'step').map(([, d]) => `${d.step}:${d.status}`);
      expect(steps).toEqual(
        expect.arrayContaining([
          'placement:completed',
          'createDatabase:completed',
          'migrate:completed',
          'seed:completed',
        ]),
      );
      expect(events.at(-1)).toEqual(['done', { status: 'active' }]);

      expect((await call('POST', '/tenants', { headers, body: { id: 'bolivar' } })).status).toBe(
        409,
      );
      const invalid = await call('POST', '/tenants', { headers, body: { id: 'Id Malo' } });
      expect(invalid.status).toBe(422);
      expect(invalid.body.error.code).toBe('TENANCY_INVALID_TENANT_ID');
    });

    it('shows details without secrets, lists, updates with audit and changes status', async () => {
      const { headers } = await login('admin@tuapp.com');
      const detail = await call('GET', '/tenants/bolivar', { headers });
      expect(detail.body.tenant).toMatchObject({
        id: 'bolivar',
        status: 'active',
        plan: 'pro',
        database: { name: 'tenant_bolivar', serverId: 'default' },
      });
      expect(detail.text).not.toContain('passwordEncrypted');
      expect(detail.body.domains).toEqual([
        expect.objectContaining({ domain: 'bolivar.tuapp.com', isPrimary: true }),
      ]);
      expect(detail.body.provisioning.map((s: { step: string }) => s.step)).toContain('migrate');

      expect((await call('GET', '/tenants?search=bol&status=active', { headers })).body.total).toBe(
        1,
      );
      expect((await call('GET', '/tenants?status=nope', { headers })).status).toBe(422);
      const patched = await call('PATCH', '/tenants/bolivar', {
        headers,
        body: { plan: 'enterprise', data: { pais: 'BO' } },
      });
      expect(patched.body).toMatchObject({ plan: 'enterprise', data: { pais: 'BO' } });
      expect(
        (
          await call('POST', '/tenants/bolivar/maintenance', {
            headers,
            body: { message: 'Vuelvo en 5' },
          })
        ).body.status,
      ).toBe('maintenance');
      expect((await call('POST', '/tenants/bolivar/activate', { headers })).body.status).toBe(
        'active',
      );

      const audit = await call('GET', '/audit?tenant=bolivar&action=tenant.', { headers });
      const update = audit.body.find((a: { action: string }) => a.action === 'tenant.update');
      expect(update.changes).toEqual({
        before: { plan: 'pro', data: {} },
        after: { plan: 'enterprise', data: { pais: 'BO' } },
      });
      expect(update.adminUserId).toBeTypeOf('number');
      expect(audit.body.map((a: { action: string }) => a.action)).toEqual(
        expect.arrayContaining(['tenant.maintenance', 'tenant.activate', 'tenant.create']),
      );
    });

    it('manages theme, domains, migrations and cache', async () => {
      const { headers } = await login('admin@tuapp.com');
      expect(
        (await call('PUT', '/tenants/bolivar/theme', { headers, body: { primary: '#E4002B' } }))
          .body.primary,
      ).toBe('#E4002B');
      expect(
        (await call('PUT', '/tenants/bolivar/theme', { headers, body: { primary: 'rojo' } }))
          .status,
      ).toBe(422);
      expect(
        (
          await call('POST', '/tenants/bolivar/domains', {
            headers,
            body: { domain: 'clubbolivar.com' },
          })
        ).status,
      ).toBe(201);
      expect(
        (await call('POST', '/domains/clubbolivar.com/primary', { headers })).body.isPrimary,
      ).toBe(true);
      expect((await call('DELETE', '/domains/clubbolivar.com', { headers })).status).toBe(204);
      const migrations = await call('GET', '/tenants/bolivar/migrations', { headers });
      expect(migrations.body).toEqual([{ name: '001_clientes', executedAt: expect.any(String) }]);
      expect((await call('POST', '/tenants/bolivar/migrate', { headers })).body).toEqual({
        ok: true,
      });
      expect(
        (await call('POST', '/migrate', { headers, body: { concurrency: 2 } })).body.succeeded,
      ).toEqual(['bolivar']);
      await tenancy.run('bolivar', () => tenancy.cache().set('k', 1));
      expect((await call('POST', '/tenants/bolivar/cache/flush', { headers })).status).toBe(204);
      expect(await tenancy.run('bolivar', () => tenancy.cache().get('k'))).toBeUndefined();
      expect((await call('DELETE', '/tenants/bolivar/theme', { headers })).status).toBe(204);
    });

    it('shows the effective theme and uploads the logo to the tenant storage', async () => {
      const { headers } = await login('admin@tuapp.com');
      const detail = await call('GET', '/tenants/bolivar', { headers });
      expect(detail.body.tenant.theme).toBeNull();
      // Sin tema propio, el editor recibe el tema por defecto de la app (no un azul fijo).
      expect(detail.body.effectiveTheme).toEqual(tenancy.theme.defaults.toJSON());
      expect(detail.body.defaultTheme).toEqual(tenancy.theme.defaults.toJSON());
      expect(detail.body.previewDomain).toBe('bolivar.tuapp.com');
      expect(detail.body.logoUrl).toBeNull();

      const upload = (raw: string | Buffer, type: string, as = headers) =>
        call('PUT', '/tenants/bolivar/theme/logo', {
          headers: { ...as, 'content-type': type },
          raw,
        });
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('datos'),
      ]);
      const first = await upload(png, 'image/png');
      expect(first.status).toBe(200);
      const path = first.body.theme.logo as string;
      expect(path).toMatch(/^theme\/logo-[0-9a-f]{16}\.png$/);
      expect(first.body.logoUrl).toBe(`//bolivar.tuapp.com/tenancy/assets/${path}`);
      expect(await tenancy.run('bolivar', () => tenancy.storage().get(path))).toEqual(
        new Uint8Array(png),
      );
      // La ruta queda en el tema del tenant (base central).
      expect((await tenancy.tenants.find('bolivar'))!.theme!.logo).toBe(path);

      // Un logo nuevo reemplaza al anterior y borra el archivo viejo.
      const second = await upload(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'image/jpeg');
      expect(second.body.theme.logo).toMatch(/\.jpg$/);
      expect(await tenancy.run('bolivar', () => tenancy.storage().exists(path))).toBe(false);

      // El tipo se decide por el contenido: un SVG (o un PNG falso) no pasa.
      const svg = await upload(
        '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>',
        'image/png',
      );
      expect([svg.status, svg.body.error.code]).toEqual([415, 'ADMIN_UNSUPPORTED_IMAGE']);
      expect((await call('PUT', '/tenants/bolivar/theme/logo', { headers })).status).toBe(422);
      const big = await upload(Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png');
      expect(big.status).toBe(413);
      const support = await login('soporte@tuapp.com');
      expect((await upload(png, 'image/png', support.headers)).status).toBe(403);

      const audited = await tenancy.database
        .central()
        .db.selectFrom('audit_log')
        .select('tenant_id')
        .where('action', '=', 'theme.logo_upload')
        .execute();
      expect(audited).toEqual([{ tenant_id: 'bolivar' }, { tenant_id: 'bolivar' }]);
      expect((await call('DELETE', '/tenants/bolivar/theme', { headers })).status).toBe(204);
      await tenancy.run('bolivar', () => tenancy.storage().deleteAll());
    });

    it('edits and removes keys of tenant.data', async () => {
      const { headers } = await login('admin@tuapp.com');
      const set = await call('PATCH', '/tenants/bolivar', {
        headers,
        body: { data: { telefono: '555-1234', borrar: 'x' } },
      });
      expect(set.body.data).toMatchObject({ telefono: '555-1234', borrar: 'x' });
      const removed = await call('PATCH', '/tenants/bolivar', {
        headers,
        body: { removeData: ['borrar'] },
      });
      expect(removed.body.data.telefono).toBe('555-1234');
      expect(removed.body.data).not.toHaveProperty('borrar');
    });

    it('enforces roles on every route', async () => {
      const support = await login('soporte@tuapp.com');
      expect((await call('GET', '/tenants', { headers: support.headers })).status).toBe(200);
      const forbidden = await call('PATCH', '/tenants/bolivar', {
        headers: support.headers,
        body: { plan: 'x' },
      });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.error.message).toContain('support');
      const adminUser = await login('admin@tuapp.com');
      expect(
        (
          await call('DELETE', '/tenants/bolivar', {
            headers: adminUser.headers,
            body: { confirm: 'bolivar' },
          })
        ).status,
      ).toBe(403);
      expect((await call('GET', '/users', { headers: adminUser.headers })).status).toBe(403);
      expect((await call('GET', '/tenants')).status).toBe(401);
    });

    it('only answers on central hosts', async () => {
      const { headers } = await login('owner@tuapp.com');
      expect((await call('GET', '/tenants', { headers, host: 'bolivar.tuapp.com' })).status).toBe(
        404,
      );
      expect((await call('GET', '/tenants', { headers, host: 'tuapp.com' })).status).toBe(200);
    });
  });

  describe('data explorer (read-only)', () => {
    it('lists tables and rows, masks sensitive columns, filters, sorts and audits', async () => {
      const { headers } = await login('soporte@tuapp.com');
      const tables = await call('GET', '/tenants/bolivar/tables', { headers });
      expect(tables.body).toEqual([
        expect.objectContaining({
          name: 'clientes',
          rows: 3,
          columns: expect.arrayContaining([
            expect.objectContaining({ name: 'password_hash', masked: true }),
          ]),
        }),
      ]);
      const rows = await call(
        'GET',
        '/tenants/bolivar/tables/clientes?sort=nombre&order=desc&perPage=2',
        { headers },
      );
      expect(rows.body).toMatchObject({ table: 'clientes', total: 3, page: 1, perPage: 2 });
      expect(rows.body.rows.map((r: { nombre: string }) => r.nombre)).toEqual(['Carla', 'Beto']);
      expect(rows.body.rows[0].password_hash).toBe('••••••');
      expect(rows.body.rows[1].password_hash).toBeNull();
      expect(rows.text).not.toContain('secreto');

      const filtered = await call('GET', '/tenants/bolivar/tables/clientes?filter.nombre=Ana', {
        headers,
      });
      expect(filtered.body.rows).toEqual([{ id: 1, nombre: 'Ana', password_hash: '••••••' }]);
      expect(
        (await call('GET', '/tenants/bolivar/tables/clientes?filter.password_hash=x', { headers }))
          .status,
      ).toBe(403);
      expect(
        (
          await call(
            'GET',
            `/tenants/bolivar/tables/clientes?sort=${encodeURIComponent('nombre;DROP TABLE clientes')}`,
            { headers },
          )
        ).status,
      ).toBe(422);
      expect(
        (await call('GET', '/tenants/bolivar/tables/tenancy_migrations', { headers })).status,
      ).toBe(404);
      expect(
        (
          await call(
            'GET',
            `/tenants/bolivar/tables/${encodeURIComponent('clientes; DROP TABLE clientes')}`,
            { headers },
          )
        ).status,
      ).toBe(404);
      const audit = await tenancy.database
        .central()
        .db.selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'data.view')
        .execute();
      expect(audit.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('impersonation', () => {
    it('issues single-use short-lived tokens valid only for their tenant', async () => {
      const { headers } = await login('soporte@tuapp.com');
      const res = await call('POST', '/tenants/bolivar/impersonate', {
        headers,
        body: { user: 'ana@bolivar.bo', redirect: '/pedidos' },
      });
      expect(res.status).toBe(201);
      expect(res.body.url).toBe(
        `https://bolivar.tuapp.com/tenancy/impersonate?token=${res.body.token}`,
      );
      expect(
        (
          await call('POST', '/tenants/bolivar/impersonate', {
            headers,
            body: { user: 'x', redirect: '//evil.com' },
          })
        ).status,
      ).toBe(422);

      await tenancy.tenants.create({ id: 'tigre' });
      await expect(
        tenancy.run('tigre', () => consumeImpersonationToken(tenancy, res.body.token)),
      ).rejects.toThrow(/invalid, expired or already used/);
      const used = await tenancy.run('bolivar', () =>
        consumeImpersonationToken(tenancy, res.body.token),
      );
      expect(used).toMatchObject({ userIdentifier: 'ana@bolivar.bo', redirectPath: '/pedidos' });
      await expect(
        tenancy.run('bolivar', () => consumeImpersonationToken(tenancy, res.body.token)),
      ).rejects.toThrow(/already used/);
      const stored = await tenancy.database
        .central()
        .db.selectFrom('impersonation_tokens')
        .selectAll()
        .execute();
      expect(JSON.stringify(stored)).not.toContain(res.body.token);
    });
  });

  describe('webhooks, events, metrics and users', () => {
    it('manages webhooks and the outbox dead-letter', async () => {
      const { headers } = await login('admin@tuapp.com');
      const created = await call('POST', '/webhooks', {
        headers,
        body: {
          tenant: 'bolivar',
          name: 'ERP',
          url: 'http://127.0.0.1:9/hook',
          events: ['pedido.*'],
        },
      });
      expect(created.status).toBe(201);
      expect(created.body.secret).toMatch(/^whsec_/);
      const id = created.body.endpoint.id as number;
      expect((await call('GET', '/webhooks?tenant=bolivar', { headers })).body).toHaveLength(1);
      expect(
        (await call('PATCH', `/webhooks/${id}`, { headers, body: { active: false } })).body
          .isActive,
      ).toBe(false);
      expect((await call('GET', `/webhooks/${id}/deliveries`, { headers })).body).toEqual([]);
      expect((await call('POST', `/webhooks/${id}/test`, { headers })).body.ok).toBe(false);
      const outbox = await call('GET', '/events/outbox', { headers });
      expect(outbox.body.stats).toHaveProperty('pending');
      expect(
        (await call('POST', '/events/outbox/retry', { headers, body: { all: true } })).body,
      ).toEqual({ retried: 0 });
      expect((await call('DELETE', `/webhooks/${id}`, { headers })).status).toBe(204);
    });

    it('reports metrics, errors, health and the OpenAPI document', async () => {
      const { headers } = await login('soporte@tuapp.com');
      const metrics = await call('GET', '/metrics', { headers });
      expect(metrics.body.tenants.byStatus.active).toBeGreaterThanOrEqual(1);
      expect(metrics.body.health.checks.database.ok).toBe(true);
      expect(Array.isArray((await call('GET', '/errors', { headers })).body)).toBe(true);
      expect((await call('GET', '/health')).status).toBe(200);

      const spec = await call('GET', '/openapi.json');
      expect(spec.body.openapi).toBe('3.1.0');
      expect(Object.keys(spec.body.paths)).toContain('/admin/api/tenants/{id}');
      const post = spec.body.paths['/admin/api/tenants'].post;
      expect(post['x-permission']).toBe('tenants:write');
      expect(post.requestBody.content['application/json'].schema.properties.id).toEqual({
        type: 'string',
      });
      expect(spec.body.components.securitySchemes.bearerAuth).toEqual({
        type: 'http',
        scheme: 'bearer',
      });
    });

    it('manages admin users with guards for the last owner and self-deletion', async () => {
      const owner = await login('owner@tuapp.com');
      const created = await call('POST', '/users', {
        headers: owner.headers,
        body: { email: 'nuevo@tuapp.com', name: 'Nuevo', password: 'corta', role: 'support' },
      });
      expect(created.body.error.code).toBe('ADMIN_WEAK_PASSWORD');
      const ok = await call('POST', '/users', {
        headers: owner.headers,
        body: { email: 'nuevo@tuapp.com', name: 'Nuevo', password: PASSWORD, role: 'support' },
      });
      expect(ok.status).toBe(201);
      expect(
        (
          await call('POST', '/users', {
            headers: owner.headers,
            body: { email: 'nuevo@tuapp.com', name: 'X', password: PASSWORD, role: 'support' },
          })
        ).status,
      ).toBe(409);

      // Desactivar a un usuario cierra sus sesiones
      const nuevo = await login('nuevo@tuapp.com');
      expect(
        (
          await call('PATCH', `/users/${ok.body.id}`, {
            headers: owner.headers,
            body: { active: false },
          })
        ).body.isActive,
      ).toBe(false);
      expect((await call('GET', '/auth/me', { headers: { cookie: nuevo.cookie } })).status).toBe(
        401,
      );

      const me = (await call('GET', '/auth/me', { headers: owner.headers })).body.user;
      expect(
        (
          await call('PATCH', `/users/${me.id}`, {
            headers: owner.headers,
            body: { role: 'admin' },
          })
        ).body.error.code,
      ).toBe('ADMIN_LAST_OWNER');
      expect(
        (await call('DELETE', `/users/${me.id}`, { headers: owner.headers })).body.error.code,
      ).toBe('ADMIN_CANNOT_DELETE_SELF');
      expect(
        (await call('GET', '/users', { headers: owner.headers })).body.map(
          (u: { email: string }) => u.email,
        ),
      ).toContain('nuevo@tuapp.com');
    });

    it('deletes a tenant only with explicit confirmation', async () => {
      const { headers } = await login('owner@tuapp.com');
      expect(
        (await call('DELETE', '/tenants/tigre', { headers, body: { confirm: 'otro' } })).body.error
          .code,
      ).toBe('ADMIN_CONFIRMATION_REQUIRED');
      expect(
        (await call('DELETE', '/tenants/tigre', { headers, body: { confirm: 'tigre' } })).status,
      ).toBe(204);
      expect((await call('GET', '/tenants/tigre', { headers })).status).toBe(404);
    });
  });

  describe('mounted inside an application', () => {
    it('works in Express and Fastify next to the tenancy middleware', async () => {
      const { createAdminApi, adminMiddleware, registerAdminFastify } =
        await import('@tenancy-node/admin-api');
      const { tenancyMiddleware } = await import('@tenancy-node/adapter-express');
      const { tenancyPlugin } = await import('@tenancy-node/adapter-fastify');
      const express = (await import('express')).default;
      const Fastify = (await import('fastify')).default;
      const supertest = (await import('supertest')).default;
      const api = createAdminApi(tenancy, { sessionSecret: 'y'.repeat(40), secureCookies: false });

      const app = express();
      app.use(adminMiddleware(api));
      app.use(tenancyMiddleware(tenancy));
      app.get('/hola', (_req, res) => void res.send(`hola ${tenancy.currentId()}`));
      expect((await supertest(app).get('/admin/api/health').set('Host', 'tuapp.com')).status).toBe(
        200,
      );
      expect(
        (
          await supertest(app)
            .post('/admin/api/auth/login')
            .set('Host', 'tuapp.com')
            .send({ email: 'owner@tuapp.com', password: PASSWORD })
        ).status,
      ).toBe(200);
      expect((await supertest(app).get('/hola').set('Host', 'bolivar.tuapp.com')).text).toBe(
        'hola bolivar',
      );
      expect(
        (await supertest(app).get('/admin/api/health').set('Host', 'bolivar.tuapp.com')).status,
      ).toBe(404);

      const fastify = Fastify();
      registerAdminFastify(fastify, api);
      await fastify.register(tenancyPlugin, { tenancy });
      fastify.get('/hola', async () => `hola ${tenancy.currentId()}`);
      await fastify.ready();
      const login = await fastify.inject({
        method: 'POST',
        url: '/admin/api/auth/login',
        headers: { host: 'tuapp.com', 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'owner@tuapp.com', password: PASSWORD, mode: 'token' }),
      });
      expect(login.statusCode).toBe(200);
      const me = await fastify.inject({
        url: '/admin/api/auth/me',
        headers: { host: 'tuapp.com', authorization: `Bearer ${login.json().token}` },
      });
      expect(me.json().user.email).toBe('owner@tuapp.com');
      expect(
        (await fastify.inject({ url: '/hola', headers: { host: 'bolivar.tuapp.com' } })).body,
      ).toBe('hola bolivar');
      await fastify.close();
    });
  });

  describe('HTTP hardening', () => {
    it('answers 404 ADMIN_FEATURE_DISABLED for tenant users when the app does not configure them', async () => {
      const { headers } = await login('owner@tuapp.com');
      const res = await call('GET', '/tenants/bolivar/users', { headers });
      expect([res.status, res.body.error.code]).toEqual([404, 'ADMIN_FEATURE_DISABLED']);
      expect((await call('GET', '/auth/me', { headers })).body.config.tenantUsers).toBeNull();
    });

    it('rejects bad bodies, unknown routes and wrong methods', async () => {
      const { headers } = await login('owner@tuapp.com');
      expect((await call('POST', '/tenants', { headers, raw: '{"id":' })).body.error.code).toBe(
        'ADMIN_INVALID_JSON',
      );
      expect(
        (
          await call('POST', '/tenants', {
            headers: { ...headers, 'content-type': 'text/plain' },
            raw: 'x',
          })
        ).status,
      ).toBe(415);
      expect(
        (
          await call('POST', '/tenants', {
            headers,
            raw: JSON.stringify({ id: 'x'.repeat(2 * 1024 * 1024) }),
          })
        ).status,
      ).toBe(413);
      const invalid = await call('POST', '/tenants', { headers, body: { id: 5 } });
      expect(invalid.status).toBe(422);
      expect(invalid.body.error.details[0].path).toBe('id');
      expect((await call('GET', '/nada', { headers })).status).toBe(404);
      expect((await call('PUT', '/tenants', { headers })).status).toBe(405);
      const lines = logger.find(
        (e) => e.fields.operation === 'admin.request' && e.fields.statusCode === 405,
      );
      expect(lines[0]?.fields).toMatchObject({
        method: 'PUT',
        path: '/tenants',
        adminUserId: null,
      });
    });
  });

  describe('behind a proxy, with app-declared tenant fields', () => {
    let proxied: Awaited<ReturnType<typeof serveAdmin>>;
    let mainPort = 0;
    const appUsers = new Map<string, (TenantUser & { passwordHash?: string })[]>();
    const passwords: (string | undefined)[] = [];
    beforeAll(async () => {
      proxied = await serveAdmin(tenancy, {
        port: 0,
        sessionSecret: 'x'.repeat(40),
        secureCookies: false,
        trustProxy: 1,
        loginRateLimit: { max: 2, windowMs: 60_000 },
        tenantFields: [
          { key: 'adminEmail', label: 'Email del administrador', type: 'email', required: true },
        ],
        tenantUsers: {
          roles: [
            { value: 'ADMIN', label: 'Administrador' },
            { value: 'RECEPCION', label: 'Recepción' },
          ],
          async list({ search, page, perPage }, tenant) {
            // Corre en el contexto del tenant: la app usaría tenancy.db() acá.
            const all = (appUsers.get(tenancy.currentId()!) ?? []).filter(
              (u) => !search || u.name.includes(search) || u.email?.includes(search),
            );
            expect(tenant.id.value).toBe(tenancy.currentId());
            return { items: all.slice((page - 1) * perPage, page * perPage), total: all.length };
          },
          async create(input) {
            const list = appUsers.get(tenancy.currentId()!) ?? [];
            if (list.some((u) => u.email === input.email))
              throw new AdminHttpError(409, 'APP_EMAIL_TAKEN', 'Ese email ya existe');
            passwords.push(input.password);
            const user = {
              id: `u${list.length + 1}`,
              name: input.name,
              email: input.email,
              role: input.role ?? null,
              passwordHash: 'no-debe-salir',
            };
            appUsers.set(tenancy.currentId()!, [...list, user]);
            return user;
          },
        },
      });
      mainPort = port;
      port = (proxied.server.address() as { port: number }).port;
    });
    afterAll(async () => {
      port = mainPort;
      await proxied?.close();
    });

    it('rate-limits each client by its X-Forwarded-For address, not the proxy', async () => {
      const from = (ip: string, email: string, password = 'incorrecta') =>
        call('POST', '/auth/login', {
          body: { email, password },
          headers: { 'x-forwarded-for': ip },
        });
      // Correos distintos: solo cuenta el límite por IP.
      await from('203.0.113.1', 'uno@tuapp.com');
      await from('203.0.113.1', 'dos@tuapp.com');
      expect((await from('203.0.113.1', 'tres@tuapp.com')).status).toBe(429);
      // Otro cliente detrás del mismo proxy sigue entrando.
      expect((await from('198.51.100.7', 'owner@tuapp.com', PASSWORD)).status).toBe(200);
      // Un X-Forwarded-For falso que agrega el cliente no cambia la IP que ve el proxy de confianza.
      expect((await from('1.2.3.4, 203.0.113.1', 'cuatro@tuapp.com')).status).toBe(429);
      const failures = await tenancy.database
        .central()
        .db.selectFrom('audit_log')
        .select('ip')
        .where('action', '=', 'auth.login_failed')
        .where('ip', '=', '203.0.113.1')
        .execute();
      expect(failures.length).toBeGreaterThanOrEqual(2);
      proxied.api.context.limiter.clear();
    });

    it('lists and creates the app users of a tenant through tenantUsers', async () => {
      const { headers } = await login('owner@tuapp.com');
      const me = await call('GET', '/auth/me', { headers });
      expect(me.body.config.tenantUsers).toEqual({
        canCreate: true,
        roles: [
          { value: 'ADMIN', label: 'Administrador' },
          { value: 'RECEPCION', label: 'Recepción' },
        ],
      });
      expect((await call('GET', '/tenants/bolivar/users', { headers })).body).toEqual({
        items: [],
        total: 0,
        page: 1,
        perPage: 20,
      });
      const created = await call('POST', '/tenants/bolivar/users', {
        headers,
        body: {
          name: ' Ana Pérez ',
          email: 'ANA@bolivar.bo',
          role: 'ADMIN',
          password: 'Clave-segura-1',
        },
      });
      expect(created.status).toBe(201);
      // Solo los campos conocidos: el hash que devuelve la app no sale.
      expect(created.body).toEqual({
        id: 'u1',
        name: 'Ana Pérez',
        email: 'ana@bolivar.bo',
        role: 'ADMIN',
        active: true,
        lastLoginAt: null,
      });
      expect(passwords).toEqual(['Clave-segura-1']);
      const listed = await call('GET', '/tenants/bolivar/users?search=Ana', { headers });
      expect(listed.body.items.map((u: TenantUser) => u.id)).toEqual(['u1']);

      // Errores de la app y validaciones del panel
      const taken = await call('POST', '/tenants/bolivar/users', {
        headers,
        body: { name: 'Otra', email: 'ana@bolivar.bo' },
      });
      expect([taken.status, taken.body.error.code]).toEqual([409, 'APP_EMAIL_TAKEN']);
      const badRole = await call('POST', '/tenants/bolivar/users', {
        headers,
        body: { name: 'X', email: 'x@bolivar.bo', role: 'DIOS' },
      });
      expect(badRole.status).toBe(422);
      expect((await call('GET', '/tenants/nadie/users', { headers })).status).toBe(404);
      const support = await login('soporte@tuapp.com');
      expect(
        (
          await call('POST', '/tenants/bolivar/users', {
            headers: support.headers,
            body: { name: 'X', email: 'x@bolivar.bo' },
          })
        ).status,
      ).toBe(403);

      // La auditoría nunca guarda la contraseña.
      const audited = await tenancy.database
        .central()
        .db.selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'tenant_user.create')
        .execute();
      expect(audited).toHaveLength(1);
      expect(JSON.stringify(audited)).not.toContain('Clave-segura-1');
      expect(JSON.stringify(audited)).not.toContain('no-debe-salir');
    });

    it('sends the declared fields to the UI and requires them on create', async () => {
      const { headers } = await login('owner@tuapp.com');
      const me = await call('GET', '/auth/me', { headers });
      expect(me.body.config).toMatchObject({
        centralDomains: ['tuapp.com'],
        tenantFields: [
          { key: 'adminEmail', label: 'Email del administrador', type: 'email', required: true },
        ],
      });
      const missing = await call('POST', '/tenants', { headers, body: { id: 'sucre' } });
      expect(missing.status).toBe(422);
      expect(missing.body.error.details).toEqual([
        { path: 'data.adminEmail', message: 'Email del administrador is required' },
      ]);
      const created = await call('POST', '/tenants', {
        headers,
        body: { id: 'sucre', data: { adminEmail: 'jefe@sucre.bo', telefono: '4-123' } },
      });
      expect(created.status).toBe(202);
      await call('GET', '/tenants/sucre/progress', { headers });
      expect((await tenancy.tenants.find('sucre'))!.data).toEqual({
        adminEmail: 'jefe@sucre.bo',
        telefono: '4-123',
      });
      await tenancy.tenants.delete('sucre');
    });
  });
});
