import { RedisCacheStore, redis, redisInvalidation } from '@tenancy-node/cache-redis';
import { describe, expectTypeOf, it } from 'vitest';

// Prueba de tipos (la verifica `pnpm typecheck`): con `exactOptionalPropertyTypes`, las opciones
// que suelen venir del entorno aceptan `process.env.X` (`string | undefined`) sin `!`.
describe('env-driven options', () => {
  it('accept process.env values', () => {
    expectTypeOf(redis).toBeCallableWith({
      url: process.env.REDIS_URL,
      keyPrefix: process.env.CACHE_PREFIX,
    });
    expectTypeOf(redisInvalidation).toBeCallableWith({
      url: process.env.REDIS_URL,
      channel: process.env.INVALIDATION_CHANNEL,
    });
    expectTypeOf(RedisCacheStore).toBeConstructibleWith({ url: process.env.REDIS_URL });
  });
});
