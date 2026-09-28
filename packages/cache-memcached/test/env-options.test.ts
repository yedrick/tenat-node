import { memcached } from '@tenancy-node/cache-memcached';
import { describe, expectTypeOf, it } from 'vitest';

// Prueba de tipos (la verifica `pnpm typecheck`): las opciones aceptan `process.env.X` sin `!`.
describe('env-driven options', () => {
  it('accept process.env values', () => {
    expectTypeOf(memcached).toBeCallableWith({
      servers: process.env.MEMCACHED_SERVERS,
      username: process.env.MEMCACHED_USER,
      password: process.env.MEMCACHED_PASSWORD,
      keyPrefix: process.env.CACHE_PREFIX,
    });
  });
});
