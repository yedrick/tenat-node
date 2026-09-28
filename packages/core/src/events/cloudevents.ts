import * as v from 'valibot';
import { TenancyError } from '../domain/index.js';
import type { EventEnvelope } from '../ports/index.js';

/** Evento en formato CloudEvents 1.0 (JSON estructurado). Lo entiende cualquier lenguaje. */
export interface CloudEvent<TData = unknown> {
  specversion: '1.0';
  /** ULID: los consumidores deduplican con este id (entrega al menos una vez). */
  id: string;
  type: string;
  source: string;
  /** ISO 8601 en UTC. */
  time: string;
  /** Extensión: tenant del evento (`null` = central). */
  tenantid: string | null;
  datacontenttype: 'application/json';
  data: TData;
}

export const CLOUDEVENTS_CONTENT_TYPE = 'application/cloudevents+json';

export class InvalidCloudEventError extends TenancyError {
  constructor(reason: string) {
    super('TENANCY_INVALID_CLOUDEVENT', `Invalid CloudEvent: ${reason}`);
  }
}

export function toCloudEvent<T>(envelope: EventEnvelope<T>, source: string): CloudEvent<T> {
  return {
    specversion: '1.0',
    id: envelope.id,
    type: envelope.type,
    source,
    time: envelope.time.toISOString(),
    tenantid: envelope.tenantId,
    datacontenttype: 'application/json',
    data: envelope.data,
  };
}

const CloudEventSchema = v.object({
  specversion: v.literal('1.0'),
  id: v.pipe(v.string(), v.minLength(1)),
  type: v.pipe(v.string(), v.minLength(1)),
  source: v.pipe(v.string(), v.minLength(1)),
  time: v.pipe(v.string(), v.isoTimestamp()),
  tenantid: v.optional(v.nullable(v.string()), null),
  datacontenttype: v.optional(v.string(), 'application/json'),
  data: v.optional(v.unknown()),
});

/** Lee un CloudEvent (texto u objeto) y lo valida. */
export function parseCloudEvent<T = unknown>(input: string | unknown): CloudEvent<T> {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new InvalidCloudEventError('not valid JSON');
    }
  }
  const result = v.safeParse(CloudEventSchema, value);
  if (!result.success) {
    throw new InvalidCloudEventError(
      result.issues.map((i) => `${v.getDotPath(i) ?? '(root)'}: ${i.message}`).join('; '),
    );
  }
  return result.output as CloudEvent<T>;
}

export function fromCloudEvent<T>(event: CloudEvent<T>): EventEnvelope<T> {
  return Object.freeze({
    id: event.id,
    type: event.type,
    tenantId: event.tenantid,
    time: new Date(event.time),
    data: event.data,
  });
}
