import type { EventBus, EventEnvelope } from '@tenancy-node/core';
import { beforeEach, describe, expect, it } from 'vitest';

type Factory<T> = () => T | Promise<T>;

/** Suite que todo `EventBus` debe pasar. */
export function eventBusContract(name: string, factory: Factory<EventBus>): void {
  describe(`EventBus contract: ${name}`, () => {
    let bus: EventBus;
    beforeEach(async () => {
      bus = await factory();
    });

    it('delivers sync listeners before publish resolves', async () => {
      const seen: string[] = [];
      bus.on('a.b', (e) => void seen.push(e.type), { mode: 'sync' });
      await bus.publish({ type: 'a.b', data: 1, tenantId: 't1' });
      expect(seen).toEqual(['a.b']);
    });

    it('propagates errors from sync listeners', async () => {
      bus.on(
        'a.b',
        () => {
          throw new Error('nope');
        },
        { mode: 'sync' },
      );
      await expect(bus.publish({ type: 'a.b', data: 1, tenantId: null })).rejects.toThrow('nope');
    });

    it('delivers async listeners after publish without blocking', async () => {
      const seen: EventEnvelope[] = [];
      bus.on('a.b', (e) => void seen.push(e));
      const envelope = await bus.publish({ type: 'a.b', data: { x: 1 }, tenantId: 't1' });
      expect(seen).toHaveLength(0);
      await bus.flush();
      expect(seen).toEqual([envelope]);
      expect(envelope.id).toBeTruthy();
      expect(envelope.tenantId).toBe('t1');
    });

    it('does not let async listener errors reach the publisher', async () => {
      bus.on('a.b', () => {
        throw new Error('ignored');
      });
      await expect(bus.publish({ type: 'a.b', data: 1, tenantId: null })).resolves.toBeDefined();
      await bus.flush();
    });

    it('supports wildcards and unsubscribe', async () => {
      const seen: string[] = [];
      const off = bus.on('tenant.*', (e) => void seen.push(e.type), { mode: 'sync' });
      bus.on('*', (e) => void seen.push(`*:${e.type}`), { mode: 'sync' });
      await bus.publish({ type: 'tenant.created', data: null, tenantId: null });
      await bus.publish({ type: 'domain.created', data: null, tenantId: null });
      off();
      await bus.publish({ type: 'tenant.deleted', data: null, tenantId: null });
      expect(seen).toEqual([
        'tenant.created',
        '*:tenant.created',
        '*:domain.created',
        '*:tenant.deleted',
      ]);
      expect(bus.hasListeners('tenant.x')).toBe(true);
    });
  });
}
