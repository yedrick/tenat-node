import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { createTestTenancy, queueDriverContract } from '@tenancy-node/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bullmq } from '@tenancy-node/queue-bullmq';

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('BullMQ queue', () => {
  let container: StartedTestContainer;
  let url = '';
  let n = 0;

  beforeAll(async () => {
    container = await new GenericContainer('valkey/valkey:8-alpine').withExposedPorts(6379).start();
    url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  }, 180_000);
  afterAll(async () => {
    await container?.stop();
  });

  queueDriverContract('BullmqQueue (Valkey 8)', () => bullmq({ url, queueName: `q${n++}` }));

  it('processes tenant jobs and queue-mode listeners across a separate worker instance', async () => {
    const queueName = `app${n++}`;
    // "Proceso" web: solo encola
    const web = createTestTenancy({ queue: bullmq({ url, queueName }) });
    // "Proceso" worker: otra instancia que comparte la cola y la base de tenants
    const worker = createTestTenancy({ queue: bullmq({ url, queueName }) });
    const seen: string[] = [];
    for (const t of [web.tenancy, worker.tenancy]) {
      t.jobs.define<{ n: number }>(
        'sumar',
        async (data) => void seen.push(`${t.currentId()}:${data.n}`),
      );
    }
    await web.seed(['bolivar']);
    await worker.seed(['bolivar']);
    await web.tenancy.run('bolivar', () => web.tenancy.jobs.dispatch('sumar', { n: 41 }));
    await worker.tenancy.worker({ concurrency: 2 });
    const deadline = Date.now() + 10_000;
    while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['bolivar:41']);
    expect((await web.tenancy.health()).checks.queue?.ok).toBe(true);
    await web.tenancy.close();
    await worker.tenancy.close();
  });
});
