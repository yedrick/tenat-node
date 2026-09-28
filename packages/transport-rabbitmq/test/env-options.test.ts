import { consumeRabbitmq, rabbitmq } from '@tenancy-node/transport-rabbitmq';
import { describe, expectTypeOf, it } from 'vitest';

// Prueba de tipos (la verifica `pnpm typecheck`): las opciones opcionales aceptan `process.env.X`.
describe('env-driven options', () => {
  it('accept process.env values', () => {
    expectTypeOf(rabbitmq).toBeCallableWith({
      url: 'amqp://localhost',
      exchange: process.env.RABBIT_EXCHANGE,
    });
    expectTypeOf(consumeRabbitmq).toBeCallableWith({
      url: 'amqp://localhost',
      exchange: process.env.RABBIT_EXCHANGE,
      queue: 'emails',
      bindings: ['#'],
      handler: async () => undefined,
    });
  });
});
