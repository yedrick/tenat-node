import { parseCloudEvent, toCloudEvent, type CloudEvent, type EventTransport } from '@tenancy-node/core';
import { AckPolicy, DeliverPolicy, connect, headers, type ConnectionOptions, type NatsConnection } from 'nats';

export interface NatsTransportOptions {
  servers: string | string[];
  /** Stream de JetStream. Se crea si no existe. Por defecto `TENANCY`. */
  stream?: string | undefined;
  /** Prefijo de los subjects: `<prefix>.<tipo>`. Por defecto `tenancy`. */
  subjectPrefix?: string | undefined;
  connection?: Omit<ConnectionOptions, 'servers'>;
  name?: string;
}

/**
 * Transporte a NATS JetStream: persistente y con confirmación. El id del evento va en
 * `Nats-Msg-Id`, así el servidor descarta duplicados dentro de su ventana.
 */
export function nats(options: NatsTransportOptions): EventTransport {
  const stream = options.stream ?? 'TENANCY';
  const prefix = options.subjectPrefix ?? 'tenancy';
  let connecting: Promise<NatsConnection> | undefined;
  const conn = () => {
    connecting ??= (async () => {
      const nc = await connect({ servers: options.servers, ...options.connection });
      const jsm = await nc.jetstreamManager();
      await jsm.streams.info(stream).catch(() => jsm.streams.add({ name: stream, subjects: [`${prefix}.>`] }));
      return nc;
    })().catch((error: unknown) => {
      connecting = undefined;
      throw error;
    });
    return connecting;
  };
  return {
    name: options.name ?? 'nats',
    async send(event, { source, routingKey }) {
      const cloud = toCloudEvent(event, source);
      const h = headers();
      h.set('Nats-Msg-Id', cloud.id);
      h.set('ce-type', cloud.type);
      h.set('ce-tenantid', cloud.tenantid ?? '');
      await (await conn()).jetstream().publish(routingKey ?? `${prefix}.${cloud.type}`, JSON.stringify(cloud), { headers: h, msgID: cloud.id });
    },
    async ping() {
      await (await conn()).flush();
    },
    async close() {
      const nc = await connecting?.catch(() => undefined);
      connecting = undefined;
      await nc?.drain();
    },
  };
}

export interface NatsConsumerOptions {
  servers: string | string[];
  stream?: string | undefined;
  /** Consumidor durable (cada microservicio el suyo). */
  durable: string;
  /** Subjects: `tenancy.tenant.*`, `tenancy.>`. Por defecto todos. */
  filterSubject?: string;
  handler: (event: CloudEvent) => Promise<void>;
  /** Opciones de conexión (autenticación, TLS, nombre…), igual que en `nats()`. */
  connection?: Omit<ConnectionOptions, 'servers'>;
  /** Entregas antes de descartar un mensaje que siempre falla. Por defecto 5. */
  maxDeliver?: number;
  onError?: (error: unknown, event: CloudEvent | undefined) => void;
}

/** Consume con un consumidor durable: `ack` al terminar bien, `nak` con espera si falla. */
export async function consumeNats(options: NatsConsumerOptions): Promise<{ stop(): Promise<void> }> {
  const stream = options.stream ?? 'TENANCY';
  const nc = await connect({ servers: options.servers, ...options.connection });
  const jsm = await nc.jetstreamManager();
  await jsm.consumers
    .info(stream, options.durable)
    .catch(() =>
      jsm.consumers.add(stream, {
        durable_name: options.durable,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_deliver: options.maxDeliver ?? 5,
        ...(options.filterSubject ? { filter_subject: options.filterSubject } : {}),
      }),
    );
  const consumer = await nc.jetstream().consumers.get(stream, options.durable);
  const messages = await consumer.consume();
  const loop = (async () => {
    for await (const message of messages) {
      let event: CloudEvent | undefined;
      try {
        event = parseCloudEvent(message.string());
        await options.handler(event);
        message.ack();
      } catch (error) {
        options.onError?.(error, event);
        message.nak(200);
      }
    }
  })();
  return {
    async stop() {
      messages.stop();
      await loop.catch(() => undefined);
      await nc.drain();
    },
  };
}
