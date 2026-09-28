import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  // Desarrollo: `pnpm dev` con `tenancy admin:serve` corriendo en el puerto 4000.
  server: { proxy: { '/admin/api': 'http://127.0.0.1:4000' } },
});
