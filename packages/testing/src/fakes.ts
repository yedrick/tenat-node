import type { Clock, IdGenerator, LogFn, Logger } from '@tenancy-node/core';

/** Reloj controlable para tests. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(date: Date | string): void {
    this.current = new Date(date).getTime();
  }
}

/** Genera ids predecibles: 'id-000001', 'id-000002'... */
export class SequentialIdGenerator implements IdGenerator {
  private next = 1;

  constructor(private readonly prefix = 'id-') {}

  generate(): string {
    return `${this.prefix}${String(this.next++).padStart(6, '0')}`;
  }
}

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string | undefined;
  fields: Record<string, unknown>;
}

/** Logger que guarda las líneas en memoria para inspeccionarlas en los tests. */
export class MemoryLogger implements Logger {
  readonly entries: LogEntry[];
  readonly debug: LogFn;
  readonly info: LogFn;
  readonly warn: LogFn;
  readonly error: LogFn;

  constructor(
    private readonly bindings: Record<string, unknown> = {},
    entries: LogEntry[] = [],
  ) {
    this.entries = entries;
    this.debug = this.method('debug');
    this.info = this.method('info');
    this.warn = this.method('warn');
    this.error = this.method('error');
  }

  child(bindings: Record<string, unknown>): Logger {
    return new MemoryLogger({ ...this.bindings, ...bindings }, this.entries);
  }

  find(predicate: (entry: LogEntry) => boolean): LogEntry[] {
    return this.entries.filter(predicate);
  }

  clear(): void {
    this.entries.length = 0;
  }

  private method(level: LogEntry['level']): LogFn {
    return ((first: string | Record<string, unknown>, message?: string) => {
      this.entries.push(
        typeof first === 'string'
          ? { level, message: first, fields: { ...this.bindings } }
          : { level, message, fields: { ...this.bindings, ...first } },
      );
    }) as LogFn;
  }
}
