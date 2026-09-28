import { consumeRedisStream, redisStreams } from '@tenancy-node/transport-redis-streams';
import { describe, expectTypeOf, it } from 'vitest';

// Prueba de tipos (la verifica `pnpm typecheck`): las opciones aceptan `process.env.X` sin `!`.
describe('env-driven options', () => {
  it('accept process.env values', () => {
    expectTypeOf(redisStreams).toBeCallableWith({
      url: process.env.REDIS_URL,
      stream: process.env.EVENTS_STREAM,
    });
    expectTypeOf(consumeRedisStream).toBeCallableWith({
      url: process.env.REDIS_URL,
      stream: process.env.EVENTS_STREAM,
      group: 'emails',
      consumer: 'a',
      handler: async () => undefined,
    });
  });
});
