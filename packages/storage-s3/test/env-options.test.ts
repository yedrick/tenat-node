import { s3 } from '@tenancy-node/storage-s3';
import { describe, expectTypeOf, it } from 'vitest';

// Prueba de tipos (la verifica `pnpm typecheck`): las opciones opcionales aceptan `process.env.X`.
describe('env-driven options', () => {
  it('accept process.env values', () => {
    expectTypeOf(s3).toBeCallableWith({
      bucket: 'archivos',
      region: process.env.S3_REGION,
      endpoint: process.env.S3_ENDPOINT,
      keyPrefix: process.env.S3_PREFIX,
      publicUrl: process.env.S3_PUBLIC_URL,
    });
  });
});
