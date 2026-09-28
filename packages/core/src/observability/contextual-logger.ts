import type { LogFn, Logger } from '../ports/index.js';

/**
 * Logger que agrega `tenantId` del contexto actual a cada línea,
 * así cualquier log de la aplicación se puede filtrar por tenant.
 */
export class ContextualLogger implements Logger {
  readonly debug: LogFn;
  readonly info: LogFn;
  readonly warn: LogFn;
  readonly error: LogFn;

  constructor(
    private readonly inner: Logger,
    private readonly currentTenantId: () => string | null,
  ) {
    this.debug = this.wrap('debug');
    this.info = this.wrap('info');
    this.warn = this.wrap('warn');
    this.error = this.wrap('error');
  }

  child(bindings: Record<string, unknown>): Logger {
    return new ContextualLogger(this.inner.child(bindings), this.currentTenantId);
  }

  private wrap(level: 'debug' | 'info' | 'warn' | 'error'): LogFn {
    return ((first: string | Record<string, unknown>, message?: string) => {
      const fields = typeof first === 'string' ? {} : first;
      const text = typeof first === 'string' ? first : message;
      const bindings =
        'tenantId' in fields ? fields : { tenantId: this.currentTenantId(), ...fields };
      if (text === undefined) this.inner[level](bindings);
      else this.inner[level](bindings, text);
    }) as LogFn;
  }
}
