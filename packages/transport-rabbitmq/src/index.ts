import {
  CLOUDEVENTS_CONTENT_TYPE,
  parseCloudEvent,
  toCloudEvent,
  type CloudEvent,
  type EventTransport,
} from '@tenancy-node/core';
import amqp from 'amqplib';

export interface RabbitmqOptions {
  /** `amqp://user:pass@host:5672`. */
  url: string;
  /** Exchange tipo topic. Por defecto `tenancy.events`. */
  exchange?: string | undefined;
  name?: string;
}

/**
 * Transporte a RabbitMQ: exchange topic durable, mensajes persistentes y confirmaciones del broker.
 * La clave de enrutamiento es el tipo del evento (`tenant.created`) o `routingKey` de `forward`.
 */
export function rabbitmq(options: RabbitmqOptions): EventTransport {
  const exchange = options.exchange ?? 'tenancy.events';
  let connecting:
    Promise<{ connection: amqp.ChannelModel; channel: amqp.ConfirmChannel }> | undefined;

  const channel = () => {
    connecting ??= (async () => {
      const connection = await amqp.connect(options.url);
      const ch = await connection.createConfirmChannel();
      await ch.assertExchange(exchange, 'topic', { durable: true });
      // Si la conexión se cae, la próxima vez se vuelve a conectar.
      connection.on('close', () => (connecting = undefined));
      connection.on('error', () => (connecting = undefined));
      return { connection, channel: ch };
    })().catch((error: unknown) => {
      connecting = undefined;
      throw error;
    });
    return connecting;
  };

  return {
    name: options.name ?? 'rabbitmq',
    async send(event, { source, routingKey }) {
      const { channel: ch } = await channel();
      const cloud = toCloudEvent(event, source);
      ch.publish(exchange, routingKey ?? cloud.type, Buffer.from(JSON.stringify(cloud)), {
        persistent: true,
        contentType: CLOUDEVENTS_CONTENT_TYPE,
        messageId: cloud.id,
        type: cloud.type,
        timestamp: Math.floor(new Date(cloud.time).getTime() / 1000),
        headers: { tenantid: cloud.tenantid ?? '' },
      });
      // Falla si el broker no confirma: la outbox reintenta.
      await ch.waitForConfirms();
    },
    async ping() {
      await channel();
    },
    async close() {
      const current = await connecting?.catch(() => undefined);
      connecting = undefined;
      await current?.connection.close().catch(() => undefined);
    },
  };
}

export interface RabbitmqConsumerOptions {
  url: string;
  exchange?: string | undefined;
  /** Cola durable de este microservicio. */
  queue: string;
  /** Patrones de enrutamiento: `tenant.created`, `pedido.*`, `#`. */
  bindings: readonly string[];
  handler: (event: CloudEvent) => Promise<void>;
  /** Mensajes en vuelo por consumidor. Por defecto 10. */
  prefetch?: number;
  /** Intentos antes de descartar un mensaje que siempre falla. Por defecto 5. */
  maxAttempts?: number;
  onError?: (error: unknown, event: CloudEvent | undefined) => void;
}

/** Consume eventos: `ack` al terminar bien; si falla, se reintenta hasta `maxAttempts`. */
export async function consumeRabbitmq(
  options: RabbitmqConsumerOptions,
): Promise<{ stop(): Promise<void> }> {
  const exchange = options.exchange ?? 'tenancy.events';
  const connection = await amqp.connect(options.url);
  const ch = await connection.createChannel();
  await ch.assertExchange(exchange, 'topic', { durable: true });
  await ch.assertQueue(options.queue, { durable: true });
  for (const binding of options.bindings) await ch.bindQueue(options.queue, exchange, binding);
  await ch.prefetch(options.prefetch ?? 10);
  const maxAttempts = options.maxAttempts ?? 5;
  const attempts = new Map<string, number>();

  const { consumerTag } = await ch.consume(options.queue, (message) => {
    if (!message) return;
    let event: CloudEvent | undefined;
    void (async () => {
      try {
        event = parseCloudEvent(message.content.toString('utf8'));
        await options.handler(event);
        attempts.delete(message.properties.messageId as string);
        ch.ack(message);
      } catch (error) {
        options.onError?.(error, event);
        const id = String(message.properties.messageId ?? message.fields.deliveryTag);
        const n = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, n);
        // Reintentar hasta maxAttempts; después, descartar (o enviar a la dead-letter queue de la cola).
        ch.nack(message, false, n < maxAttempts);
        if (n >= maxAttempts) attempts.delete(id);
      }
    })();
  });

  return {
    async stop() {
      await ch.cancel(consumerTag).catch(() => undefined);
      await ch.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    },
  };
}
