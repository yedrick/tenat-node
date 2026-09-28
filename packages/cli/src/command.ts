import type { ParseArgsConfig } from 'node:util';
import type { CliTenancy } from './config-loader.js';
import type { CliIO } from './io.js';
import type { Output } from './output.js';

export type OptionsConfig = NonNullable<ParseArgsConfig['options']>;

export interface ParsedArgs {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

export interface CommandContext {
  args: ParsedArgs;
  out: Output;
  io: CliIO;
  verbose: boolean;
  /** Carga la configuración (solo los comandos que la necesitan). */
  tenancy(): Promise<CliTenancy>;
  /** Se activa con SIGINT/SIGTERM (comandos que corren hasta que se los detiene). */
  signal: AbortSignal;
}

/** Un comando del CLI (patrón Command): valida argumentos y llama a la API de tenancy. */
export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly options?: OptionsConfig;
  /** Texto de ayuda de cada opción. */
  readonly help?: Record<string, string>;
  run(context: CommandContext): Promise<number>;
}

/** Error de uso: argumentos inválidos (código de salida 2). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

export function stringOption(args: ParsedArgs, name: string): string | undefined {
  const value = args.values[name];
  return typeof value === 'string' ? value : undefined;
}

export function listOption(args: ParsedArgs, name: string): string[] | undefined {
  const value = args.values[name];
  if (value === undefined || typeof value === 'boolean') return undefined;
  const list = (Array.isArray(value) ? value : [value])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim());
  return list.filter(Boolean);
}

export function intOption(args: ParsedArgs, name: string, fallback: number, min = 1): number {
  const raw = stringOption(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min)
    throw new UsageError(`--${name} must be an integer >= ${min}`);
  return value;
}

export function requirePositional(args: ParsedArgs, index: number, name: string): string {
  const value = args.positionals[index];
  if (!value) throw new UsageError(`Missing <${name}>`);
  return value;
}
