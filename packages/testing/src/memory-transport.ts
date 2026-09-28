import {
  toCloudEvent,
  type CloudEvent,
  type EventEnvelope,
  type EventTransport,
} from '@tenancy-node/core';

/** Transporte que guarda los eventos en memoria. Puede fallar a propósito (`failTimes`, `down`). */
export class MemoryTransport implements EventTransport {
  readonly received: (CloudEvent & { routingKey?: string })[] = [];
  /** Cuántos envíos más van a fallar. */
  failTimes = 0;
  /** Mientras sea `true`, todos los envíos fallan. */
  down = false;
  attempts = 0;
  closed = false;

  constructor(readonly name = 'memory') {}

  async send(
    event: EventEnvelope,
    options: { source: string; routingKey?: string },
  ): Promise<void> {
    this.attempts++;
    if (this.down || this.failTimes > 0) {
      if (this.failTimes > 0) this.failTimes--;
      throw new Error(`${this.name} unavailable`);
    }
    this.received.push({
      ...toCloudEvent(event, options.source),
      ...(options.routingKey ? { routingKey: options.routingKey } : {}),
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
