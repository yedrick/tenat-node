import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { CliIO } from '@tenancy-node/cli';

export interface MemoryIO extends CliIO {
  out(): string;
  err(): string;
  /** stdout y stderr sin códigos de color. */
  all(): string;
}

export function memoryIO(
  cwd: string,
  options: { isTTY?: boolean; input?: string; env?: Record<string, string | undefined> } = {},
): MemoryIO {
  let stdout = '';
  let stderr = '';
  const stdin = new PassThrough();
  if (options.input !== undefined) stdin.end(options.input);
  return {
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    stdin,
    cwd,
    env: { ...process.env, NO_COLOR: undefined, ...options.env },
    isTTY: options.isTTY ?? false,
    out: () => stdout,
    err: () => stderr,
    // eslint-disable-next-line no-control-regex
    all: () => (stdout + stderr).replace(/\u001b\[\d+m/g, ''),
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const packagesDir = path.resolve(here, '../..');

/**
 * Directorio temporal dentro del repo: la configuración resuelve `@tenancy-node/*` desde el workspace,
 * es decir los paquetes compilados (`dist`), igual que en el proyecto de un usuario.
 */
export async function tempProject(): Promise<string> {
  const base = path.join(here, '.tmp');
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, 'project-'));
}
