import { createReadStream, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

/** CSP del panel: solo recursos propios; nada inline ni de otros orígenes. */
export const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

/** Carpeta de la SPA: una ruta propia o `@tenancy-node/admin-ui` instalado en el proyecto. */
export function resolveUiRoot(ui: true | string): string {
  if (typeof ui === 'string') return path.resolve(ui);
  try {
    const pkg = createRequire(path.join(process.cwd(), 'noop.js')).resolve(
      '@tenancy-node/admin-ui/package.json',
    );
    return path.join(path.dirname(pkg), 'dist');
  } catch {
    throw new Error(
      'ui: true needs @tenancy-node/admin-ui installed (or pass the path of the built UI)',
    );
  }
}

/** Sirve un archivo de la SPA (o `index.html` para las rutas del navegador). */
export function serveUi(
  root: string,
  basePath: string,
  req: IncomingMessage,
  res: ServerResponse,
  securityHeaders: Record<string, string>,
): void {
  const url = new URL(req.url ?? '/', 'http://ui.local');
  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname.slice(basePath.length)).replace(/^\/+/, '');
  } catch {
    relative = '';
  }
  const target = path.resolve(root, relative || 'index.html');
  // Nunca fuera de la carpeta de la UI.
  const inside = target === root || target.startsWith(root + path.sep);
  const isFile = inside && existsSync(target) && statSync(target).isFile();
  const file = isFile ? target : path.join(root, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Admin UI not built');
    return;
  }
  const ext = path.extname(file);
  const hashed = isFile && /\/assets\//.test(file.split(path.sep).join('/'));
  res.writeHead(200, {
    ...securityHeaders,
    'content-security-policy': UI_CSP,
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    // Los assets llevan hash en el nombre: se cachean para siempre. index.html nunca.
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}
