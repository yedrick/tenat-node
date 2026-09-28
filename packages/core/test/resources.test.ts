import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createTestTenancy,
  queueDriverContract,
  storageDriverContract,
} from '@tenancy-node/testing';
import { describe, expect, it } from 'vitest';
import {
  InvalidStoragePathError,
  LocalStorage,
  MemoryQueue,
  MemoryStorage,
  backoffDelay,
  contentTypeFor,
  normalizeStoragePath,
  type EventEnvelope,
  type QueueDriver,
} from '../src/index.js';

storageDriverContract(
  'LocalStorage',
  async () => new LocalStorage({ root: await mkdtemp(path.join(tmpdir(), 'tenancy-storage-')) }),
);
storageDriverContract('MemoryStorage', () => new MemoryStorage());
queueDriverContract('MemoryQueue', () => new MemoryQueue());

describe('storage', () => {
  it.each(['../x', 'a/../../b', '/etc/passwd', 'a\\b', 'a\0b', '', '.', 'a/..'])(
    'rejects unsafe path %j',
    (p) => {
      expect(() => normalizeStoragePath(p)).toThrow(InvalidStoragePathError);
    },
  );

  it('normalizes safe paths', () => {
    expect(normalizeStoragePath('./logos//logo.png')).toBe('logos/logo.png');
  });

  it('isolates files per tenant and central', async () => {
    const { tenancy, seed } = createTestTenancy();
    await seed(['bolivar', 'tigre']);
    await tenancy.run('bolivar', () => tenancy.storage().put('logo.png', 'B'));
    await tenancy.run('tigre', () => tenancy.storage().put('logo.png', 'T'));
    await tenancy.storage().put('planes.pdf', 'C');

    expect(await tenancy.run('bolivar', () => tenancy.storage().getText('logo.png'))).toBe('B');
    expect(await tenancy.run('tigre', () => tenancy.storage().getText('logo.png'))).toBe('T');
    expect(await tenancy.storage().getText('logo.png')).toBeUndefined();
    await tenancy.run('bolivar', async () => {
      const storage = tenancy.storage();
      await storage.put('docs/a.txt', 'aa');
      expect((await storage.list()).map((f) => f.path)).toEqual(['docs/a.txt', 'logo.png']);
      expect((await storage.list('docs')).map((f) => f.path)).toEqual(['docs/a.txt']);
      expect(await storage.exists('docs/a.txt')).toBe(true);
      await storage.delete('docs/a.txt');
      expect(await storage.url('logo.png')).toBe('/tenancy/assets/logo.png');
      expect(await storage.url('https://cdn.x/logo.png')).toBe('https://cdn.x/logo.png');
      expect(storage.key('logo.png')).toBe('bolivar/logo.png');
      await expect(storage.get('../tigre/logo.png')).rejects.toThrow(InvalidStoragePathError);
      await storage.deleteAll();
      expect(await storage.list()).toEqual([]);
    });
    expect(await tenancy.run('tigre', () => tenancy.storage().getText('logo.png'))).toBe('T');
  });

  it('deletes the files of a deleted tenant and keeps the others', async () => {
    const storage = new MemoryStorage();
    const { tenancy, seed } = createTestTenancy({ storage });
    await seed(['bolivar', 'tigre']);
    await tenancy.run('bolivar', () => tenancy.storage().put('docs/a.txt', 'B'));
    await tenancy.run('tigre', () => tenancy.storage().put('logo.png', 'T'));
    await tenancy.storage().put('planes.pdf', 'C');

    await tenancy.tenants.delete('bolivar');
    await tenancy.events.flush();
    expect((await storage.list('')).map((f) => f.key).sort()).toEqual([
      'central/planes.pdf',
      'tigre/logo.png',
    ]);
    await tenancy.close();
  });

  it('reports a storage failure on tenant deletion without failing the delete', async () => {
    const storage = new MemoryStorage();
    storage.deletePrefix = async () => {
      throw new Error('bucket unavailable');
    };
    const { tenancy, seed, logger } = createTestTenancy({ storage });
    await seed(['bolivar']);
    await tenancy.tenants.delete('bolivar');
    await tenancy.events.flush();
    expect(await tenancy.tenants.find('bolivar')).toBeUndefined();
    const [error] = tenancy.observability.errors({ tenantId: 'bolivar' });
    expect(error).toMatchObject({
      operation: 'storage.delete_tenant',
      tenantId: 'bolivar',
      message: 'bucket unavailable',
    });
    expect(
      logger.find((e) => e.level === 'error' && e.fields.operation === 'storage.delete_tenant'),
    ).toEqual([expect.objectContaining({ fields: expect.objectContaining({ tenantId: 'bolivar' }) })]);
    await tenancy.close();
  });

  it('local driver refuses keys that escape its root', async () => {
    const storage = new LocalStorage({ root: await mkdtemp(path.join(tmpdir(), 'tenancy-root-')) });
    await expect(storage.put('../escape.txt', 'x')).rejects.toThrow(/escapes/);
    await storage.ping();
    expect(await storage.get('bolivar')).toBeUndefined();
    await storage.put('a/b/c.txt', 'x');
    await storage.deletePrefix('a/b/c');
    expect(await storage.exists('a/b/c.txt')).toBe(false);
  });
});

describe('queues and jobs', () => {
  it('runs jobs in the context of their tenant, with retries logged per attempt', async () => {
    const queue = new MemoryQueue();
    const { tenancy, seed, logger } = createTestTenancy({ queue });
    await seed(['bolivar', 'tigre']);
    const seen: string[] = [];
    let failures = 0;
    tenancy.jobs.define<{ to: string }>(
      'email',
      async (data, { tenant, job }) => {
        expect(tenancy.currentId()).toBe(tenant?.id.value);
        if (data.to === 'flaky' && failures++ < 2) throw new Error('smtp down');
        seen.push(`${tenancy.currentId() ?? 'central'}:${data.to}:${job.attempt}`);
      },
      { attempts: 3, backoff: { type: 'fixed', delayMs: 5 } },
    );
    expect(() => tenancy.jobs.define('email', async () => {})).toThrow(/already defined/);
    expect(tenancy.jobs.names()).toEqual(['email']);

    await tenancy.run('bolivar', () => tenancy.jobs.dispatch('email', { to: 'a' }));
    await tenancy.run('tigre', () => tenancy.jobs.dispatch('email', { to: 'flaky' }));
    await tenancy.jobs.dispatch('email', { to: 'central' });
    await expect(tenancy.jobs.dispatch('nope')).rejects.toThrow(/not defined/);

    await tenancy.worker({ concurrency: 2 });
    await queue.drain();
    expect(seen.sort()).toEqual(['bolivar:a:1', 'central:central:1', 'tigre:flaky:3']);
    const attempts = logger.find(
      (e) => e.fields.operation === 'queue.job' && e.fields.tenantId === 'tigre',
    );
    expect(attempts.map((e) => [e.level, e.fields.attempt])).toEqual([
      ['warn', 1],
      ['warn', 2],
      ['info', 3],
    ]);
    await tenancy.close();
  });

  it('records a dead job as an error for its tenant', async () => {
    const queue = new MemoryQueue();
    const { tenancy, seed, logger } = createTestTenancy({ queue });
    await seed(['bolivar']);
    tenancy.jobs.define(
      'report',
      async () => {
        throw new Error('pdf engine crashed');
      },
      { attempts: 2 },
    );
    await tenancy.run('bolivar', () => tenancy.jobs.dispatch('report', {}));
    await tenancy.worker();
    await queue.drain();
    const [dead] = tenancy.observability.errors({ tenantId: 'bolivar' });
    expect(dead).toMatchObject({
      operation: 'queue.job',
      message: 'pdf engine crashed',
      context: { job: 'report', attempt: 2, maxAttempts: 2 },
    });
    expect(logger.find((e) => e.fields.operation === 'queue.job').map((e) => e.level)).toEqual([
      'warn',
      'error',
    ]);
  });

  it('reports jobs that no worker handler knows', async () => {
    const queue: QueueDriver = new MemoryQueue();
    const { tenancy } = createTestTenancy({ queue });
    await queue.enqueue({ name: 'ghost', tenantId: null, data: null, options: {} });
    await tenancy.worker();
    await (queue as MemoryQueue).drain();
    expect(tenancy.observability.errors()[0]).toMatchObject({
      operation: 'queue.job',
      context: { job: 'ghost' },
    });
  });

  it('runs "queue" mode listeners in a worker, out of the request path', async () => {
    const queue = new MemoryQueue();
    const { tenancy } = createTestTenancy({ queue });
    const received: EventEnvelope[] = [];
    let calls = 0;
    tenancy.events.on(
      'tenant.created',
      async (e) => {
        calls++;
        if (calls === 1) throw new Error('first try fails');
        received.push(e);
      },
      { mode: 'queue', retries: 2, backoff: { type: 'fixed', delayMs: 5 } },
    );
    tenancy.events.on('tenant.created', async () => {}, { mode: 'queue', name: 'welcome-email' });
    expect(tenancy.jobs.names()).toEqual(['event:tenant.created#1', 'event:welcome-email']);

    await tenancy.tenants.create({ id: 'bolivar' });
    // La creación no esperó al listener: solo quedó encolado
    expect(received).toEqual([]);
    await tenancy.worker();
    await queue.drain();
    expect(received).toHaveLength(1);
    expect(received[0]!.tenantId).toBe('bolivar');
    expect(received[0]!.time).toBeInstanceOf(Date);
    expect(received[0]!.data).toMatchObject({ id: 'bolivar' });
  });

  it('worker close() waits for the jobs in progress', async () => {
    const queue = new MemoryQueue();
    const { tenancy } = createTestTenancy({ queue });
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      tenancy.jobs.define('lento', async () => {
        resolve();
        await new Promise<void>((r) => (release = r));
        finished = true;
      });
    });
    let finished = false;
    await tenancy.jobs.dispatch('lento');
    await tenancy.jobs.dispatch('lento');
    const worker = await tenancy.worker({ concurrency: 1 });
    await started;

    let closed = false;
    const closing = worker.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(finished).toBe(true);
    // El segundo trabajo no empezó: el worker ya estaba cerrado.
    expect(queue.size).toBe(1);
    await tenancy.close();
  });

  it('computes backoff delays', () => {
    expect(backoffDelay({}, 3)).toBe(0);
    expect(backoffDelay({ backoff: { type: 'fixed', delayMs: 100 } }, 3)).toBe(100);
    expect(backoffDelay({ backoff: { type: 'exponential', delayMs: 100 } }, 3)).toBe(400);
  });
});

describe('optional HTTP routes', () => {
  const get = (path: string, headers: Record<string, string> = {}) => ({
    method: 'GET',
    path,
    headers,
  });

  it('are all disabled by default', async () => {
    const { tenancy } = createTestTenancy();
    expect(tenancy.http.enabled).toBe(false);
    expect(await tenancy.http.handle(get('/tenancy/me'))).toBeUndefined();
    expect(await tenancy.http.handle(get('/tenancy/health'))).toBeUndefined();
  });

  it('serve theme.css with ETag/304, public /me fields and tenant assets', async () => {
    const { tenancy } = createTestTenancy({
      http: { me: true, theme: true, assets: true, health: true },
      publicFields: ['name', 'plan', 'locale', 'features', 'secret-not-present'],
    });
    await tenancy.tenants.create({
      id: 'bolivar',
      name: 'Club Bolívar',
      plan: 'pro',
      data: { locale: 'es-BO', features: ['tienda'], apiKey: 'NO-EXPONER' },
      theme: { primary: '#E4002B', logo: 'logos/logo.png' },
    });
    await tenancy.run('bolivar', async () => {
      await tenancy.storage().put('logos/logo.png', 'PNG');

      const css = (await tenancy.http.handle(get('/tenancy/theme.css')))!;
      expect(css.status).toBe(200);
      expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
      expect(css.body).toContain('--color-primary: #E4002B;');
      const again = await tenancy.http.handle(
        get('/tenancy/theme.css', { 'if-none-match': css.headers.etag! }),
      );
      expect(again?.status).toBe(304);

      const me = (await tenancy.http.handle(get('/tenancy/me')))!;
      expect(JSON.parse(me.body as string)).toEqual({
        id: 'bolivar',
        theme: { primary: '#E4002B', secondary: '#64748B', logo: '/tenancy/assets/logos/logo.png' },
        name: 'Club Bolívar',
        plan: 'pro',
        locale: 'es-BO',
        features: ['tienda'],
      });
      expect(me.body).not.toContain('NO-EXPONER');

      const asset = (await tenancy.http.handle(get('/tenancy/assets/logos/logo.png')))!;
      expect(asset.status).toBe(200);
      expect(asset.headers['content-type']).toBe('image/png');
      expect(Buffer.from(asset.body as Uint8Array).toString()).toBe('PNG');
      expect((await tenancy.http.handle(get('/tenancy/assets/nada.png')))?.status).toBe(404);
      expect(
        (await tenancy.http.handle(get('/tenancy/assets/..%2F..%2Fetc%2Fpasswd')))?.status,
      ).toBe(400);
      expect(
        (await tenancy.http.handle({ method: 'HEAD', path: '/tenancy/theme.css', headers: {} }))
          ?.body,
      ).toBe('');
      expect(
        await tenancy.http.handle({ method: 'POST', path: '/tenancy/me', headers: {} }),
      ).toBeUndefined();
    });

    // En el contexto central las rutas de tenant no responden
    expect((await tenancy.http.handle(get('/tenancy/me')))?.status).toBe(404);
    expect(tenancy.http.isHealth('GET', '/tenancy/health')).toBe(true);
    const health = (await tenancy.http.handle(get('/tenancy/health')))!;
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body as string)).toEqual({ status: 'ok', checks: {} });
  });

  it('reports failing health checks with 503 and logs them', async () => {
    const { tenancy } = createTestTenancy({
      http: { health: true, prefix: '/_t' },
      cache: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
        flushTenant: async () => {},
        ping: async () => Promise.reject(new Error('redis unreachable')),
      },
    });
    const response = (await tenancy.http.handle(get('/_t/health')))!;
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body as string).checks.cache).toMatchObject({
      ok: false,
      error: 'redis unreachable',
    });
    expect(tenancy.observability.errors()[0]).toMatchObject({
      operation: 'health.check',
      context: { check: 'cache' },
    });
  });

  it('knows content types', () => {
    expect(contentTypeFor('a.SVG')).toBe('image/svg+xml');
    expect(contentTypeFor('noext')).toBe('application/octet-stream');
  });
});
