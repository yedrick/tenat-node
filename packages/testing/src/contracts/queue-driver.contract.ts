import type { QueueDriver, QueuedJob } from '@tenancy-node/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Factory<T> = () => T | Promise<T>;

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the queue');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Suite que todo `QueueDriver` debe pasar (memoria, BullMQ...). */
export function queueDriverContract(name: string, factory: Factory<QueueDriver>): void {
  describe(`QueueDriver contract: ${name}`, () => {
    let queue: QueueDriver;
    const closers: (() => Promise<void>)[] = [];
    beforeEach(async () => {
      queue = await factory();
    });
    afterEach(async () => {
      for (const close of closers.splice(0)) await close();
      await queue.close();
    });

    it('delivers jobs with their name, tenant and serialized data', async () => {
      const seen: QueuedJob[] = [];
      await queue.enqueue({
        name: 'email',
        tenantId: 'bolivar',
        data: { to: 'a@b.c', n: 1 },
        options: {},
      });
      const worker = await queue.process(async (job) => void seen.push(job), { concurrency: 2 });
      closers.push(() => worker.close());
      await queue.enqueue({
        name: 'report',
        tenantId: null,
        data: { when: '2026-01-01' },
        options: {},
      });
      await waitFor(() => seen.length === 2);
      const byName = Object.fromEntries(seen.map((j) => [j.name, j]));
      expect(byName.email).toMatchObject({
        tenantId: 'bolivar',
        data: { to: 'a@b.c', n: 1 },
        attempt: 1,
        maxAttempts: 1,
      });
      expect(byName.report).toMatchObject({ tenantId: null, data: { when: '2026-01-01' } });
      expect(typeof byName.email!.id).toBe('string');
    });

    it('retries failed jobs up to the configured attempts', async () => {
      const attempts: number[] = [];
      const worker = await queue.process(
        async (job) => {
          attempts.push(job.attempt);
          if (job.attempt < 3) throw new Error(`fail ${job.attempt}`);
        },
        { concurrency: 1 },
      );
      closers.push(() => worker.close());
      await queue.enqueue({
        name: 'flaky',
        tenantId: 't1',
        data: null,
        options: { attempts: 5, backoff: { type: 'fixed', delayMs: 10 } },
      });
      await waitFor(() => attempts.length === 3);
      await new Promise((r) => setTimeout(r, 100));
      expect(attempts).toEqual([1, 2, 3]);
    });

    it('stops after the last attempt', async () => {
      const attempts: number[] = [];
      const worker = await queue.process(
        async (job) => {
          attempts.push(job.attempt);
          throw new Error('always');
        },
        { concurrency: 1 },
      );
      closers.push(() => worker.close());
      await queue.enqueue({
        name: 'dead',
        tenantId: 't1',
        data: null,
        options: { attempts: 2, backoff: { type: 'fixed', delayMs: 10 } },
      });
      await waitFor(() => attempts.length === 2);
      await new Promise((r) => setTimeout(r, 150));
      expect(attempts).toEqual([1, 2]);
    });
  });
}
