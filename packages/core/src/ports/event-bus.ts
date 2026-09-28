import type { DomainEvent } from '../domain/index.js';

/** Evento listo para entregar: el evento de dominio más `id` y `time`. */
export interface EventEnvelope<TData = unknown, TType extends string = string> {
  /** ULID único; los consumidores lo usan para ser idempotentes. */
  readonly id: string;
  readonly type: TType;
  readonly tenantId: string | null;
  readonly time: Date;
  readonly data: TData;
}

/**
 * - `sync`: se espera antes de continuar; si lanza, la operación se cancela.
 * - `async`: se ejecuta en el mismo proceso después de publicar; no bloquea y sus errores solo se registran.
 */
export type ListenerMode = 'sync' | 'async';

export interface ListenerOptions {
  mode?: ListenerMode;
}

export type EventListener<TData = unknown, TType extends string = string> = (
  event: EventEnvelope<TData, TType>,
) => void | Promise<void>;

export interface EventBus {
  /**
   * Registra un listener. `pattern` puede ser un tipo exacto (`tenant.created`),
   * un prefijo con comodín (`tenant.*`) o `*` para todos. Devuelve la función para quitarlo.
   */
  on(pattern: string, listener: EventListener, options?: ListenerOptions): () => void;
  publish(event: DomainEvent): Promise<EventEnvelope>;
  hasListeners(type: string): boolean;
  /** Espera a que terminen los listeners `async` en curso. */
  flush(): Promise<void>;
}
