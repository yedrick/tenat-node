import type { Readable } from 'node:stream';

export interface WritableLike {
  write(chunk: string): unknown;
}

/** Entrada y salida del CLI. Se inyecta para poder testear sin tocar la terminal real. */
export interface CliIO {
  stdout: WritableLike;
  stderr: WritableLike;
  stdin: Readable;
  cwd: string;
  env: Record<string, string | undefined>;
  /** `true` si stdout es una terminal interactiva (colores y confirmaciones). */
  isTTY: boolean;
}

export function processIO(): CliIO {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    cwd: process.cwd(),
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
  };
}
