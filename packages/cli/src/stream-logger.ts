import type { LogFn, Logger } from '@tenancy-node/core';
import type { WritableLike } from './io.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSink {
  stream: WritableLike;
  /** Nivel mínimo que se escribe en este destino. */
  level: LogLevel;
}

/**
 * Logger del CLI: líneas JSON (mismo formato que el resto del paquete) hacia uno o más destinos.
 * Por defecto stderr solo recibe `error`; `--log-file` guarda todo; `--verbose` muestra todo.
 */
export class StreamLogger implements Logger {
  readonly debug: LogFn;
  readonly info: LogFn;
  readonly warn: LogFn;
  readonly error: LogFn;

  constructor(
    private readonly sinks: readonly LogSink[],
    private readonly bindings: Record<string, unknown> = {},
  ) {
    this.debug = this.method('debug');
    this.info = this.method('info');
    this.warn = this.method('warn');
    this.error = this.method('error');
  }

  child(bindings: Record<string, unknown>): Logger {
    return new StreamLogger(this.sinks, { ...this.bindings, ...bindings });
  }

  private method(level: LogLevel): LogFn {
    return ((first: string | Record<string, unknown>, message?: string) => {
      const targets = this.sinks.filter((sink) => LEVELS[level] >= LEVELS[sink.level]);
      if (targets.length === 0) return;
      const fields = typeof first === 'string' ? { msg: first } : { ...first, msg: message };
      const line = `${JSON.stringify(
        { level, time: new Date().toISOString(), ...this.bindings, ...fields },
        (_k, v: unknown) =>
          v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v,
      )}\n`;
      for (const sink of targets) sink.stream.write(line);
    }) as LogFn;
  }
}
