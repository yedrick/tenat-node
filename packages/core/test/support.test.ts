import { describe, expect, it } from 'vitest';
import {
  LruCache,
  MemoryCacheStore,
  SystemClock,
  UlidGenerator,
  errorResponseBody,
  forEachConcurrent,
  httpStatusFor,
  requestLikeFromNode,
  themeToCss,
  Theme,
  ThemeRenderer,
  TenantNotFoundError,
  TenantInMaintenanceError,
  InvalidTenantIdError,
  TenantProvisioningError,
  TenancyError,
} from '../src/index.js';
import type { IncomingMessage } from 'node:http';

describe('LruCache', () => {
  it('evicts the least recently used entry', () => {
    const lru = new LruCache<string, number>({ max: 2 });
    lru.set('a', 1).set('b', 2);
    expect(lru.get('a')).toBe(1);
    lru.set('c', 3);
    expect(lru.has('b')).toBe(false);
    expect([...lru.keys()]).toEqual(['a', 'c']);
    expect(lru.size).toBe(2);
    expect(lru.deleteWhere((v) => v === 3)).toBe(1);
    expect(lru.delete('a')).toBe(true);
    lru.set('x', 1);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(() => new LruCache({ max: 0 })).toThrow(RangeError);
  });

  it('expires entries by TTL', () => {
    let now = 0;
    const lru = new LruCache<string, number>({ max: 10, ttlMs: 100, now: () => now });
    lru.set('a', 1);
    lru.set('forever', 2, 0);
    now = 99;
    expect(lru.get('a')).toBe(1);
    now = 100;
    expect(lru.get('a')).toBeUndefined();
    expect(lru.get('forever')).toBe(2);
  });
});

describe('MemoryCacheStore', () => {
  it('supports TTL in seconds and ignores undefined values', async () => {
    let now = 0;
    const store = new MemoryCacheStore({ now: () => now });
    await store.set('a', 1, 1);
    await store.set('b', 1);
    await store.set('b', undefined);
    now = 1000;
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('b')).toBeUndefined();
  });
});

describe('UlidGenerator', () => {
  it('generates sortable, unique, 26-char ids', () => {
    let now = 1_700_000_000_000;
    const gen = new UlidGenerator(() => now);
    const a = gen.generate();
    const b = gen.generate();
    now++;
    const c = gen.generate();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b && b < c).toBe(true);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    const many = new Set(Array.from({ length: 10_000 }, () => new UlidGenerator().generate()));
    expect(many.size).toBe(10_000);
  });
});

describe('forEachConcurrent', () => {
  it('limits concurrency and rejects bad limits', async () => {
    let running = 0;
    let peak = 0;
    await forEachConcurrent([1, 2, 3, 4, 5, 6], 2, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running--;
    });
    expect(peak).toBe(2);
    await expect(forEachConcurrent([], 0, async () => {})).rejects.toThrow(RangeError);
    await expect(
      forEachConcurrent([1, 2, 3], 1, async (n) => {
        if (n === 2) throw new Error('two');
      }),
    ).rejects.toThrow('two');
  });
});

describe('theme rendering', () => {
  it('renders every variable and caches by key', () => {
    const theme = Theme.create({
      primary: '#E4002B',
      secondary: '#FFD100',
      accent: '#000',
      background: '#fff',
      text: '#111',
      font: 'Inter',
      radius: 'lg',
      mode: 'auto',
      custom: { 'nav-height': '64px' },
    });
    expect(themeToCss(theme)).toBe(
      [
        ':root {',
        '  --color-primary: #E4002B;',
        '  --color-secondary: #FFD100;',
        '  --color-accent: #000;',
        '  --color-background: #FFF;',
        '  --color-text: #111;',
        "  --font-main: 'Inter', system-ui, sans-serif;",
        '  --radius: 1rem;',
        '  --nav-height: 64px;',
        '  color-scheme: light dark;',
        '}',
        '',
      ].join('\n'),
    );
    const renderer = new ThemeRenderer();
    const first = renderer.render('k', theme);
    expect(renderer.render('k', Theme.create({ primary: '#000', secondary: '#000' }))).toBe(first);
    expect(first.etag).toMatch(/^"[\w-]+"$/);
    renderer.clear();
    expect(renderer.render('k', theme)).not.toBe(first);
    expect(
      themeToCss(Theme.create({ primary: '#000', secondary: '#fff', mode: 'dark' })),
    ).toContain('color-scheme: dark;');
  });
});

describe('http helpers', () => {
  it('maps errors to status codes and safe bodies', () => {
    expect(httpStatusFor(new TenantNotFoundError('x'))).toBe(404);
    expect(httpStatusFor(new InvalidTenantIdError('X'))).toBe(422);
    expect(httpStatusFor(new TenantInMaintenanceError('x', null))).toBe(503);
    expect(httpStatusFor(new TenancyError('OTHER', 'x'))).toBe(500);
    expect(httpStatusFor(new Error('x'))).toBe(500);
    expect(errorResponseBody(new TenantNotFoundError('x')).error.code).toBe(
      'TENANCY_TENANT_NOT_FOUND',
    );
    expect(errorResponseBody(new TenantInMaintenanceError('x', 'Back at 5')).error.message).toBe(
      'Back at 5',
    );
    expect(errorResponseBody(new TenantProvisioningError('x', new Error('secret')))).toEqual({
      error: { code: 'TENANCY_INTERNAL_ERROR', message: 'Internal Server Error' },
    });
  });

  it('builds a RequestLike from node requests', () => {
    const req = {
      url: '/a/b?x=1',
      headers: { host: 'a.com', 'x-forwarded-host': 'b.com, c.com' },
    } as unknown as IncomingMessage;
    expect(requestLikeFromNode(req)).toMatchObject({ host: 'a.com', path: '/a/b' });
    expect(requestLikeFromNode(req, { trustProxy: true }).host).toBe('b.com');
    expect(requestLikeFromNode({ headers: {} } as IncomingMessage).path).toBe('/');
  });

  it('SystemClock returns now', () => {
    expect(Math.abs(new SystemClock().now().getTime() - Date.now())).toBeLessThan(1000);
  });
});
