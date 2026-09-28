import {
  createTestTenancy,
  FakeClock,
  MemoryLogger,
  SequentialIdGenerator,
} from '@tenancy-node/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConsoleLogger,
  ContextualLogger,
  MemoryErrorTracker,
  NoopLogger,
  TenantNotFoundError,
  errorCode,
  errorMessage,
  errorName,
  errorStack,
  type TrackedError,
} from '../src/index.js';

describe('operation logs', () => {
  it('logs every write with tenantId, operation, outcome and duration', async () => {
    const { tenancy, logger } = createTestTenancy();
    await tenancy.tenants.create({ id: 'bolivar' });
    await tenancy.tenants.suspend('bolivar');

    const ops = logger.find((e) => e.fields.outcome === 'success').map((e) => e.fields);
    expect(ops).toEqual([
      expect.objectContaining({
        operation: 'tenants.create',
        tenantId: 'bolivar',
        component: 'tenancy',
      }),
      expect.objectContaining({ operation: 'tenants.suspend', tenantId: 'bolivar' }),
    ]);
    expect(ops[0]?.durationMs).toBeTypeOf('number');
    expect(logger.find((e) => e.fields.operation === 'tenants.create')[0]?.level).toBe('info');
  });

  it('logs reads at debug level', async () => {
    const { tenancy, logger } = createTestTenancy();
    await tenancy.tenants.list();
    expect(logger.find((e) => e.fields.operation === 'tenants.list')[0]?.level).toBe('debug');
  });

  it('records client errors as warn and server errors as error, tracked per tenant', async () => {
    const { tenancy, logger } = createTestTenancy({
      provisioning: {
        provision: () => Promise.reject(new Error('db down')),
        deprovision: async () => {},
      },
    });
    await expect(tenancy.tenants.suspend('ghost')).rejects.toThrow(TenantNotFoundError);
    await expect(tenancy.tenants.create({ id: 'bolivar' })).rejects.toThrow();

    const warn = logger.find((e) => e.level === 'warn')[0]!;
    expect(warn.fields).toMatchObject({
      operation: 'tenants.suspend',
      tenantId: 'ghost',
      outcome: 'error',
      code: 'TENANCY_TENANT_NOT_FOUND',
    });
    expect(warn.fields.errorId).toBeTypeOf('string');
    expect(warn.fields.err).toBeInstanceOf(TenantNotFoundError);

    const error = logger.find((e) => e.level === 'error')[0]!;
    expect(error.fields).toMatchObject({
      operation: 'tenants.create',
      tenantId: 'bolivar',
      code: 'TENANCY_PROVISIONING_FAILED',
    });
    expect(error.message).toBe(
      'tenants.create failed: Provisioning of tenant "bolivar" failed: db down',
    );

    const bolivarErrors = tenancy.observability.errors({ tenantId: 'bolivar' });
    expect(bolivarErrors).toHaveLength(1);
    expect(bolivarErrors[0]).toMatchObject({
      operation: 'tenants.create',
      code: 'TENANCY_PROVISIONING_FAILED',
    });
    expect(bolivarErrors[0]?.id).toBe(error.fields.errorId);
    expect(tenancy.observability.summary()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId: 'bolivar',
          total: 1,
          byCode: { TENANCY_PROVISIONING_FAILED: 1 },
        }),
        expect.objectContaining({ tenantId: 'ghost', total: 1 }),
      ]),
    );
    tenancy.observability.clear('ghost');
    expect(tenancy.observability.errors({ tenantId: 'ghost' })).toEqual([]);
    tenancy.observability.clear();
    expect(tenancy.observability.errors()).toEqual([]);
  });

  it('reports async listener failures with the event and tenant', async () => {
    const { tenancy, logger, seed } = createTestTenancy();
    await seed(['bolivar']);
    tenancy.events.on('pedido.creado', () => {
      throw new Error('mailer down');
    });
    await tenancy.run('bolivar', () => tenancy.events.publish('pedido.creado', { id: 1 }));
    await tenancy.events.flush();

    const [tracked] = tenancy.observability.errors({ tenantId: 'bolivar' });
    expect(tracked).toMatchObject({
      operation: 'events.listener',
      message: 'mailer down',
      code: 'Error',
    });
    expect(tracked?.context).toMatchObject({ eventType: 'pedido.creado' });
    expect(logger.find((e) => e.fields.operation === 'events.listener')[0]?.level).toBe('error');
  });

  it('reports errors in runForEach per tenant and resolve failures', async () => {
    const { tenancy, seed } = createTestTenancy();
    await seed(['a1', 'b2']);
    await tenancy.runForEach((t) => {
      if (t.id.value === 'b2') throw new Error('bad data');
    });
    expect(tenancy.observability.errors({ tenantId: 'b2' })[0]).toMatchObject({
      operation: 'tenancy.runForEach.item',
      message: 'bad data',
    });
    await expect(tenancy.resolve({ host: 'ghost.app.test', headers: {} })).rejects.toThrow();
    expect(tenancy.observability.errors({ limit: 1 })[0]).toMatchObject({
      operation: 'tenancy.resolve',
      context: { host: 'ghost.app.test' },
    });
  });

  it('lets the app report its own errors with the current tenant', async () => {
    const { tenancy, seed } = createTestTenancy();
    await seed(['bolivar']);
    await tenancy.run('bolivar', () => {
      tenancy.observability.report('checkout', new TypeError('bad cart'), { cartId: 9 });
      tenancy.observability.logger.info({ orderId: 1 }, 'order placed');
    });
    expect(tenancy.observability.errors({ tenantId: 'bolivar' })[0]).toMatchObject({
      operation: 'checkout',
      code: 'TypeError',
      context: { cartId: 9 },
    });
  });
});

describe('ContextualLogger', () => {
  it('adds the tenantId of the context to every line', () => {
    const inner = new MemoryLogger();
    let current: string | null = 'bolivar';
    const logger = new ContextualLogger(inner, () => current);
    logger.info('hello');
    logger.warn({ a: 1 }, 'with fields');
    logger.error({ tenantId: 'explicit' });
    current = null;
    logger.child({ req: 1 }).debug('child');
    expect(inner.entries.map((e) => [e.level, e.message, e.fields.tenantId])).toEqual([
      ['info', 'hello', 'bolivar'],
      ['warn', 'with fields', 'bolivar'],
      ['error', undefined, 'explicit'],
      ['debug', 'child', null],
    ]);
    expect(inner.entries[3]?.fields.req).toBe(1);
  });
});

describe('MemoryErrorTracker', () => {
  const tracked = (tenantId: string | null, n: number): TrackedError => ({
    id: `e${n}`,
    tenantId,
    operation: 'op',
    code: n % 2 ? 'A' : 'B',
    name: 'Error',
    message: `m${n}`,
    stack: undefined,
    time: new Date(1000 + n),
    context: {},
  });

  it('keeps a bounded ring buffer per tenant and evicts old tenants', () => {
    const tracker = new MemoryErrorTracker({ perTenant: 2, maxTenants: 2 });
    tracker.record(tracked('a', 1));
    tracker.record(tracked('a', 2));
    tracker.record(tracked('a', 3));
    expect(tracker.recent({ tenantId: 'a' }).map((e) => e.id)).toEqual(['e3', 'e2']);
    expect(tracker.summary()[0]).toMatchObject({ tenantId: 'a', total: 3, byCode: { A: 2, B: 1 } });
    tracker.record(tracked(null, 4));
    tracker.record(tracked('c', 5));
    expect(tracker.recent({ tenantId: 'a' })).toEqual([]);
    expect(tracker.recent({ tenantId: null }).map((e) => e.id)).toEqual(['e4']);
    expect(
      tracker
        .summary()
        .map((s) => s.tenantId)
        .sort(),
    ).toEqual(['c', null].sort());
    expect(tracker.recent({ limit: 1 }).map((e) => e.id)).toEqual(['e5']);
  });
});

describe('error details', () => {
  it('extracts stable information from any thrown value', () => {
    const withCode = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    expect(errorCode(withCode)).toBe('ECONNREFUSED');
    expect(errorCode(new RangeError('x'))).toBe('RangeError');
    expect(errorCode('boom')).toBe('UNKNOWN_ERROR');
    expect(errorName('boom')).toBe('string');
    expect(errorMessage('boom')).toBe('boom');
    expect(errorStack('boom')).toBeUndefined();
    expect(errorStack(new Error('x'))).toContain('Error: x');
  });
});

describe('loggers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('ConsoleLogger writes JSON lines filtered by level', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new ConsoleLogger('info', { app: 'x' }).child({ tenantId: 'bolivar' });
    logger.debug('hidden');
    logger.info('shown');
    logger.error({ err: new Error('boom') }, 'failed');
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      level: 'info',
      app: 'x',
      tenantId: 'bolivar',
      msg: 'shown',
    });
    const line = JSON.parse(err.mock.calls[0]![0] as string);
    expect(line).toMatchObject({
      level: 'error',
      msg: 'failed',
      err: { name: 'Error', message: 'boom' },
    });
    expect(line.err.stack).toContain('boom');
  });

  it('NoopLogger does nothing', () => {
    const logger = new NoopLogger();
    logger.info('x');
    logger.error({ a: 1 });
    expect(logger.child()).toBe(logger);
  });

  it('fakes are deterministic', () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    clock.advance(1000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.000Z');
    clock.set('2027-01-01T00:00:00.000Z');
    expect(clock.now().getUTCFullYear()).toBe(2027);
    const ids = new SequentialIdGenerator('x');
    expect([ids.generate(), ids.generate()]).toEqual(['x000001', 'x000002']);
    const logger = new MemoryLogger();
    logger.info('a');
    logger.clear();
    expect(logger.entries).toEqual([]);
  });
});
