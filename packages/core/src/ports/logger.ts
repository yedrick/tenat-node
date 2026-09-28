export interface LogFn {
  (message: string): void;
  (bindings: Record<string, unknown>, message?: string): void;
}

/** Interfaz compatible con pino: se puede pasar `pino()` directamente. */
export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  child(bindings: Record<string, unknown>): Logger;
}
