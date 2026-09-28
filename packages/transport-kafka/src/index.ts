import { CLOUDEVENTS_CONTENT_TYPE, parseCloudEvent, toCloudEvent, type CloudEvent, type EventTransport } from '@tenancy-node/core';
import { Kafka, Partitioners, logLevel, type KafkaConfig, type Producer } from 'kafkajs';

export interface KafkaTransportOptions {
  brokers: string[];
  clientId?: string | undefined;
  /** Topic por defecto (o `routingKey` de `forward`). Por defecto `tenancy.events`. */
  topic?: string | undefined;
  kafka?: Omit<KafkaConfig, 'brokers' | 'clientId'>;
  name?: string;
}

/**
 * Transporte a Kafka. La clave del mensaje es el `tenantId`: los eventos de un mismo tenant
 * van a la misma partición y conservan su orden. Productor idempotente.
 */
export function kafka(options: KafkaTransportOptions): EventTransport {
  const client = new Kafka({ brokers: options.brokers, clientId: options.clientId ?? 'tenancy-node', logLevel: logLevel.WARN, ...options.kafka });
  let producer: Promise<Producer> | undefined;
  const connect = () => {
    producer ??= (async () => {
      const p = client.producer({ createPartitioner: Partitioners.DefaultPartitioner, idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: true });
      await p.connect();
      return p;
    })().catch((error: unknown) => {
      producer = undefined;
      throw error;
    });
    return producer;
  };
  return {
    name: options.name ?? 'kafka',
    async send(event, { source, routingKey }) {
      const cloud = toCloudEvent(event, source);
      await (await connect()).send({
        topic: routingKey ?? options.topic ?? 'tenancy.events',
        acks: -1,
        messages: [
          {
            key: cloud.tenantid ?? 'central',
            value: JSON.stringify(cloud),
            headers: { 'content-type': CLOUDEVENTS_CONTENT_TYPE, ce_id: cloud.id, ce_type: cloud.type, ce_tenantid: cloud.tenantid ?? '' },
          },
        ],
      });
    },
    async ping() {
      await connect();
    },
    async close() {
      const current = await producer?.catch(() => undefined);
      producer = undefined;
      await current?.disconnect();
    },
  };
}

export interface KafkaConsumerOptions {
  brokers: string[];
  /** Grupo de consumidores (cada microservicio el suyo). */
  groupId: string;
  topics?: string[];
  /** Si lanza, el mensaje no se confirma y kafkajs lo reintenta. */
  handler: (event: CloudEvent) => Promise<void>;
  fromBeginning?: boolean;
  onError?: (error: unknown, event: CloudEvent | undefined) => void;
  /** Opciones de kafkajs (SSL, SASL, `logLevel`, `logCreator` para mandar sus logs a tu logger). */
  kafka?: Omit<KafkaConfig, 'brokers' | 'clientId'>;
}

/** Consume eventos: el offset se confirma solo después de que el handler termina bien. */
export async function consumeKafka(options: KafkaConsumerOptions): Promise<{ stop(): Promise<void> }> {
  const client = new Kafka({ brokers: options.brokers, clientId: `${options.groupId}-consumer`, logLevel: logLevel.WARN, ...options.kafka });
  const consumer = client.consumer({ groupId: options.groupId, retry: { retries: 5 } });
  await consumer.connect();
  for (const topic of options.topics ?? ['tenancy.events']) await consumer.subscribe({ topic, fromBeginning: options.fromBeginning ?? true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      let event: CloudEvent | undefined;
      try {
        event = parseCloudEvent(message.value?.toString('utf8') ?? '');
        await options.handler(event);
      } catch (error) {
        options.onError?.(error, event);
        throw error;
      }
    },
  });
  return { stop: () => consumer.disconnect() };
}
