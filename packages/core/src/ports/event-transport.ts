import type { EventEnvelope } from './event-bus.js';

/** Salida de eventos hacia otros sistemas (webhook, Redis Streams, RabbitMQ, Kafka, NATS...). */
export interface EventTransport {
  readonly name: string;
  /** Entrega el evento. Si lanza, quien lo llama reintenta (outbox o reintento en proceso). */
  send(event: EventEnvelope, options: { source: string; routingKey?: string }): Promise<void>;
  ping?(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Destino durable de los eventos que salen del proceso (la outbox). Si hay uno configurado,
 * `forward` guarda el evento ahí en lugar de enviarlo directo, y un relay lo entrega después.
 */
export interface EventSink {
  accept(
    event: EventEnvelope,
    destinations: readonly { transport: string; routingKey?: string }[],
  ): Promise<void>;
}
