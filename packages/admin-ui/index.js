import { URL, fileURLToPath } from 'node:url';

/** Carpeta con la SPA compilada (la sirve @tenancy-node/admin-api con `ui: true`). */
export const distPath = fileURLToPath(new URL('./dist', import.meta.url));
