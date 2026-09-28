import type { LogFn, Logger } from '../ports/index.js';

const noop: LogFn = () => {};

/** Logger que no hace nada (Null Object). */
export class NoopLogger implements Logger {
  debug = noop;
  info = noop;
  warn = noop;
  error = noop;
  child(): Logger {
    return this;
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Logger JSON por consola. Para producción se recomienda pasar `pino()`. */
export class ConsoleLogger implements Logger {
  readonly debug: LogFn;
  readonly info: LogFn;
  readonly warn: LogFn;
  readonly error: LogFn;

  constructor(
    private readonly level: LogLevel = 'info',
    private readonly bindings: Record<string, unknown> = {},
  ) {
    this.debug = this.method('debug');
    this.info = this.method('info');
    this.warn = this.method('warn');
    this.error = this.method('error');
  }

  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger(this.level, { ...this.bindings, ...bindings });
  }

  private method(level: LogLevel): LogFn {
    if (LEVELS[level] < LEVELS[this.level]) return noop;
    return ((first: string | Record<string, unknown>, message?: string) => {
      const fields = typeof first === 'string' ? { msg: first } : { ...first, msg: message };
      const line = JSON.stringify(
        { level, time: new Date().toISOString(), ...this.bindings, ...fields },
        errorReplacer,
      );
      (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    }) as LogFn;
  }
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}
