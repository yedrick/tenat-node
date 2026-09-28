import type { DomainEvent } from '../domain/index.js';
import type {
  Clock,
  EventBus,
  EventEnvelope,
  EventListener,
  IdGenerator,
  ListenerMode,
  ListenerOptions,
  Logger,
} from '../ports/index.js';

interface Registration {
  readonly matches: (type: string) => boolean;
  readonly listener: EventListener;
  readonly mode: ListenerMode;
}

export interface InProcessEventBusDeps {
  ids: IdGenerator;
  clock: Clock;
  logger: Logger;
  /** Tenant del contexto actual; se usa cuando el evento no trae `tenantId`. */
  currentTenantId: () => string | null;
  /** Se llama cuando un listener `async` falla. Por defecto se escribe en el log. */
  onListenerError?: (error: unknown, event: EventEnvelope) => void;
}

/** EventBus en el mismo proceso (Observer / Pub-Sub). */
export class InProcessEventBus implements EventBus {
  private registrations: Registration[] = [];
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: InProcessEventBusDeps) {}

  on(pattern: string, listener: EventListener, options: ListenerOptions = {}): () => void {
    const registration: Registration = {
      matches: matcher(pattern),
      listener,
      mode: options.mode ?? 'async',
    };
    this.registrations = [...this.registrations, registration];
    return () => {
      this.registrations = this.registrations.filter((r) => r !== registration);
    };
  }

  hasListeners(type: string): boolean {
    return this.registrations.some((r) => r.matches(type));
  }

  async publish(event: DomainEvent): Promise<EventEnvelope> {
    const envelope: EventEnvelope = Object.freeze({
      id: this.deps.ids.generate(),
      type: event.type,
      tenantId: event.tenantId !== undefined ? event.tenantId : this.deps.currentTenantId(),
      time: this.deps.clock.now(),
      data: event.data,
    });

    const matching = this.registrations.filter((r) => r.matches(envelope.type));
    for (const registration of matching) {
      if (registration.mode === 'sync') await registration.listener(envelope);
      else this.schedule(registration.listener, envelope);
    }
    return envelope;
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private handleListenerError(error: unknown, envelope: EventEnvelope): void {
    try {
      if (this.deps.onListenerError) {
        this.deps.onListenerError(error, envelope);
        return;
      }
    } catch {
      // si el reporte falla, se usa el log directo
    }
    this.deps.logger.error(
      {
        tenantId: envelope.tenantId,
        operation: 'events.listener',
        outcome: 'error',
        eventId: envelope.id,
        eventType: envelope.type,
        err: error,
      },
      `Async listener for "${envelope.type}" failed`,
    );
  }

  private schedule(listener: EventListener, envelope: EventEnvelope): void {
    // setImmediate conserva el contexto de AsyncLocalStorage de quien publica.
    const task = new Promise<void>((resolve) => {
      setImmediate(() => {
        Promise.resolve()
          .then(() => listener(envelope))
          .catch((error: unknown) => this.handleListenerError(error, envelope))
          .finally(resolve);
      });
    });
    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
  }
}

function matcher(pattern: string): (type: string) => boolean {
  if (pattern === '*') return () => true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return (type) => type.startsWith(prefix);
  }
  return (type) => type === pattern;
}
