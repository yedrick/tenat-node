import type { CloudEvent } from '@tenancy-node/core';
import { consumeRabbitmq } from '@tenancy-node/transport-rabbitmq';

export interface Mailer {
  send(message: { to: string; subject: string; body: string; tenant: string }): Promise<void>;
}

/** Guarda qué eventos ya se procesaron. En producción: una tabla o Redis. */
export interface ProcessedStore {
  /** `true` si el evento ya se procesó con éxito. */
  has(eventId: string): Promise<boolean>;
  /** Marca el evento como procesado. Se llama solo después de enviar el correo. */
  mark(eventId: string): Promise<void>;
}

export function memoryStore(): ProcessedStore {
  const seen = new Set<string>();
  return {
    async has(id) {
      return seen.has(id);
    },
    async mark(id) {
      seen.add(id);
    },
  };
}

interface TenantCreatedData {
  id: string;
  name: string;
  data: { ownerEmail?: string };
}

/**
 * Microservicio independiente: escucha `tenant.created` y envía el correo de bienvenida.
 * Es idempotente porque la entrega es "al menos una vez": un evento repetido no manda dos correos.
 * No depende de tenancy-node más que por el helper del consumidor; podría estar escrito en otro lenguaje.
 */
export async function startEmailService(options: {
  rabbitUrl: string;
  mailer: Mailer;
  store?: ProcessedStore;
  log?: (line: string) => void;
}) {
  const store = options.store ?? memoryStore();
  const log = options.log ?? ((line: string) => console.log(line));
  return consumeRabbitmq({
    url: options.rabbitUrl,
    queue: 'microservicio-emails',
    bindings: ['tenant.created'],
    handler: async (event: CloudEvent) => {
      if (await store.has(event.id)) {
        log(`evento ${event.id} repetido: se ignora`);
        return;
      }
      const tenant = event.data as TenantCreatedData;
      const to = tenant.data.ownerEmail ?? `admin@${tenant.id}.tuapp.com`;
      await options.mailer.send({
        to,
        tenant: tenant.id,
        subject: `¡Bienvenido a tuapp, ${tenant.name}!`,
        body: `Tu espacio ${tenant.id}.tuapp.com ya está listo.`,
      });
      // Se marca después de enviar: si el mailer falla, el mensaje vuelve a la cola y la nueva
      // entrega lo intenta otra vez. (Si el proceso muere justo entre el envío y la marca, el
      // correo puede salir dos veces: preferible a perderlo.)
      await store.mark(event.id);
      log(`correo de bienvenida enviado a ${to} (tenant ${tenant.id}, evento ${event.id})`);
    },
    onError: (error, event) =>
      log(
        `error procesando ${event?.id ?? '?'}: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
}
