import { consumeNats, nats } from '@tenancy-node/transport-nats';
import { describe, expectTypeOf, it } from 'vitest';

// Prueba de tipos (la verifica `pnpm typecheck`): las opciones opcionales aceptan `process.env.X`
// y el consumidor recibe las mismas opciones de conexión que el transporte.
describe('env-driven options', () => {
  it('accept process.env values and connection options', () => {
    expectTypeOf(nats).toBeCallableWith({
      servers: 'localhost:4222',
      stream: process.env.NATS_STREAM,
      subjectPrefix: process.env.NATS_PREFIX,
    });
    expectTypeOf(consumeNats).toBeCallableWith({
      servers: 'localhost:4222',
      stream: process.env.NATS_STREAM,
      durable: 'emails',
      connection: { token: 's3cret', tls: {} },
      handler: async () => undefined,
    });
  });
});
