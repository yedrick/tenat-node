import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packages = fileURLToPath(new URL('./packages', import.meta.url));

export default defineConfig({
  resolve: {
    // Los tests usan el código fuente de los paquetes, no el `dist` compilado.
    alias: [{ find: /^@tenancy-node\/([a-z0-9-]+)$/, replacement: `${packages}/$1/src/index.ts` }],
  },
  // La UI usa el runtime automático de JSX (sin importar React).
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'examples/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 300_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // Archivos que solo declaran tipos: no generan código que cubrir.
      exclude: [
        '**/index.ts',
        '**/ports/**',
        '**/plugins.ts',
        '**/drivers/driver.ts',
        '**/kysely-any.ts',
      ],
      thresholds: {
        'packages/core/src/**': { lines: 90, functions: 90, branches: 85, statements: 90 },
        'packages/db/src/**': { lines: 80, functions: 80, branches: 70, statements: 80 },
        'packages/admin-api/src/**': { lines: 80, functions: 80, branches: 70, statements: 80 },
      },
    },
  },
});
