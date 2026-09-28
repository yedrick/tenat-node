import { kafka } from '@tenancy-node/transport-kafka';
import { describe, expectTypeOf, it } from 'vitest';

// Prueba de tipos (la verifica `pnpm typecheck`): las opciones opcionales aceptan `process.env.X`.
describe('env-driven options', () => {
  it('accept process.env values', () => {
    expectTypeOf(kafka).toBeCallableWith({
      brokers: ['localhost:9092'],
      clientId: process.env.KAFKA_CLIENT_ID,
      topic: process.env.KAFKA_TOPIC,
    });
  });
});
