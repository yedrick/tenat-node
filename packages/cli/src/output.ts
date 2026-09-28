import { TenancyError } from '@tenancy-node/core';
import type { CliIO } from './io.js';

const CODES = { red: 31, green: 32, yellow: 33, cyan: 36, gray: 90, bold: 1 } as const;
type Color = keyof typeof CODES;

/** Salida del CLI: texto con colores en terminal, o JSON con `--json`. */
export class Output {
  readonly json: boolean;
  private readonly colors: boolean;

  constructor(
    private readonly io: CliIO,
    options: { json?: boolean; color?: boolean } = {},
  ) {
    this.json = options.json ?? false;
    this.colors = (options.color ?? true) && io.isTTY && !io.env.NO_COLOR && !this.json;
  }

  paint(color: Color, text: string): string {
    return this.colors ? `\u001b[${CODES[color]}m${text}\u001b[0m` : text;
  }

  line(text = ''): void {
    if (!this.json) this.io.stdout.write(`${text}\n`);
  }

  info(text: string): void {
    this.line(text);
  }

  success(text: string): void {
    this.line(`${this.paint('green', '✓')} ${text}`);
  }

  warn(text: string): void {
    if (!this.json) this.io.stderr.write(`${this.paint('yellow', '!')} ${text}\n`);
  }

  /** Errores siempre a stderr, también en modo JSON. */
  error(text: string): void {
    this.io.stderr.write(`${this.paint('red', '✗')} ${text}\n`);
  }

  /** Describe un error con su código estable (TENANCY_*). */
  describeError(error: unknown, verbose = false): string {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof TenancyError ? error.code : error instanceof Error ? error.name : 'ERROR';
    const stack =
      verbose && error instanceof Error && error.stack
        ? `\n${this.paint('gray', error.stack)}`
        : '';
    return `${this.paint('bold', code)} ${message}${stack}`;
  }

  /** Imprime un valor como JSON (solo en modo `--json`). */
  data(value: unknown): void {
    if (this.json) this.io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  /** Lista de pares clave/valor alineados. */
  pairs(rows: readonly (readonly [string, unknown])[]): void {
    const width = Math.max(...rows.map(([k]) => k.length));
    for (const [key, value] of rows)
      this.line(`  ${this.paint('gray', key.padEnd(width))}  ${formatCell(value)}`);
  }

  table(headers: readonly string[], rows: readonly (readonly unknown[])[]): void {
    if (this.json) return;
    if (rows.length === 0) {
      this.line(this.paint('gray', '(sin resultados)'));
      return;
    }
    const cells = rows.map((row) => row.map((cell) => formatCell(cell)));
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...cells.map((row) => (row[i] ?? '').length)),
    );
    const render = (row: readonly string[]) =>
      row
        .map((cell, i) => cell.padEnd(widths[i]!))
        .join('  ')
        .trimEnd();
    this.line(this.paint('bold', render(headers)));
    this.line(this.paint('gray', widths.map((w) => '─'.repeat(w)).join('  ')));
    for (const row of cells) this.line(render(row));
  }
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (value instanceof Date) return value.toISOString().replace('T', ' ').slice(0, 19);
  if (typeof value === 'boolean') return value ? 'sí' : 'no';
  return String(value);
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
