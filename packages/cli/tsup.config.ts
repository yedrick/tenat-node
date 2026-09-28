import { defineConfig } from 'tsup';

// Los paquetes opcionales (admin-api, db, outbox...) se cargan del proyecto del usuario; nunca se empaquetan.
const external = [/^@tenancy-node\//];

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    target: 'node20',
    external,
  },
  {
    entry: ['src/bin.ts'],
    format: ['esm'],
    sourcemap: true,
    target: 'node20',
    external,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
