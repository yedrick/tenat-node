import { bullmq } from '@tenancy-node/queue-bullmq';
import { describe, expectTypeOf, it } from 'vitest';

// Prueba de tipos (la verifica `pnpm typecheck`): las opciones aceptan `process.env.X` sin `!`.
describe('env-driven options', () => {
  it('accept process.env values', () => {
    expectTypeOf(bullmq).toBeCallableWith({
      url: process.env.REDIS_URL,
      queueName: process.env.QUEUE_NAME,
      prefix: process.env.QUEUE_PREFIX,
    });
  });
});
