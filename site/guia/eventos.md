# Eventos

Cada cambio importante (crear un tenant, agregar un dominio, migrar una base) publica un evento. Puedes escucharlo en el mismo proceso, mandarlo a una cola o reenviarlo a otros servicios como CloudEvent: por webhook, RabbitMQ, Redis Streams, Kafka o NATS. Las decisiones están en los ADR [0009](/adr/0009-eventos-avanzados) y [0013](/adr/0013-mensajeria-y-cache-distribuida).

## El bus en el proceso

```ts
// sync: se espera; si lanza, la operación se cancela
tenancy.events.on(
  'tenant.creating',
  (event) => {
    if (event.data.plan && !planesPermitidos.has(event.data.plan)) throw new Error('Plan inválido');
  },
  { mode: 'sync' },
);

// async (por defecto): corre después, no bloquea; si falla, queda en el log
const quitar = tenancy.events.on('tenant.*', (event) => {
  console.log(event.type, event.tenantId, event.id);
});

await tenancy.tenants.create({ id: 'bolivar', plan: 'pro' });
await tenancy.events.flush(); // espera los listeners async (tests, scripts)
quitar();
```

Cada listener recibe un sobre congelado: `id` (ULID), `type`, `tenantId` (`null` = central), `time` (`Date`) y `data`. `on` devuelve la función para quitarlo.

### Modos

| Modo              | Cuándo corre                                    | Si falla                                                             |
| ----------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| `async` (defecto) | Después de publicar, en el mismo proceso        | Queda en el log y en `tenancy.observability.errors()` como `events.listener`. La operación sigue |
| `sync`            | Antes de que la operación continúe              | El error sube a quien llamó: la operación falla                      |
| `queue`           | En un worker, con reintentos                    | Se reintenta según `retries` y `backoff` ([Colas](/guia/cache-archivos-colas#listeners-en-modo-queue)) |

Los listeners `async` conservan el contexto del tenant que publicó: dentro de ellos, `tenancy.current()` y `tenancy.cache()` son de ese tenant. `tenancy.close()` espera los pendientes.

::: warning `sync` no es una transacción
Un listener `sync` de `tenant.creating` cancela la creación antes de guardar nada. Pero `tenant.created` se publica después de guardar el tenant y **antes** de aprovisionarlo: si un listener `sync` de `tenant.created` lanza, `create()` falla, el tenant queda guardado y su base no se crea. Para trabajo que puede fallar, usa `async` o `queue`.
:::

### Patrones

| Patrón           | Coincide con                                                       |
| ---------------- | ------------------------------------------------------------------ |
| `tenant.created` | Solo ese tipo                                                      |
| `tenant.*`       | Todo lo que empieza con `tenant.` (a cualquier profundidad)        |
| `*`              | Todos los eventos, incluidos `tenancy.initialized` y `tenancy.ended` |

No hay comodines en medio (`*.created` no funciona).

## Catálogo tipado

`TenancyEventMap` asocia cada tipo con su `data`. Con un tipo conocido, TypeScript infiere el `data` del listener. Para agregar los tuyos, usa declaration merging:

```ts
declare module '@tenancy-node/core' {
  interface TenancyEventMap {
    'pedido.creado': { pedidoId: number; total: number };
  }
}

const tenancy = createTenancy();
await tenancy.tenants.create({ id: 'bolivar' });

tenancy.events.on('pedido.creado', (event) => {
  event.data.total; // number
});

await tenancy.run('bolivar', async () => {
  const envelope = await tenancy.events.publish('pedido.creado', { pedidoId: 1, total: 250 });
  envelope.tenantId; // 'bolivar', tomado del contexto
});
```

`publish` toma el `tenantId` del contexto. Los tipos solo existen al compilar; para validar en tiempo de ejecución registra un esquema Valibot con `tenancy.events.define('pedido.creado', esquema)`: publicar datos inválidos lanza `InvalidEventDataError` (`TENANCY_INVALID_EVENT_DATA`). La validación aplica a `tenancy.events.publish`, no a los eventos del paquete.

### Eventos del paquete

| Evento                       | `data`                                             | Cuándo                                                 |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| `tenant.creating`            | `id, name, status, plan, data`                     | Antes de guardar. Un listener `sync` puede cancelarlo  |
| `tenant.created`             | igual                                              | Guardado, antes de aprovisionar                        |
| `tenant.provisioned`         | igual                                              | Aprovisionamiento terminado                            |
| `tenant.provisioning_failed` | igual + `error`                                    | Falló el aprovisionamiento                             |
| `tenant.updated`             | igual + `changes` (campos cambiados)               | `tenants.update`                                       |
| `tenant.suspended`           | igual                                              | `tenants.suspend`                                      |
| `tenant.activated`           | igual                                              | `tenants.activate`                                     |
| `tenant.maintenance`         | igual + `message`                                  | `tenants.maintenance`                                  |
| `tenant.deleted`             | igual                                              | `tenants.delete`                                       |
| `domain.created`             | `tenantId, domain, isPrimary`                      | Dominio agregado (también al crear el tenant)          |
| `domain.deleted`             | igual                                              | Dominio quitado                                        |
| `domain.primary_changed`     | igual                                              | Cambio de dominio principal                            |
| `database.created`           | `tenantId, serverId, database`                     | Base creada (plugin `@tenancy-node/db`)                |
| `database.migrated`          | igual                                              | Migraciones aplicadas                                  |
| `database.seeded`            | igual                                              | Seed ejecutado                                         |
| `database.deleted`           | igual                                              | Base borrada                                           |
| `database.moved`             | `tenantId, database, from, to, rows, sourceDropped` | `tenancy move` terminó ([Mover tenants](/guia/mover-tenants)) |
| `theme.updated`              | `tenantId, theme` (`null` si se reseteó)           | `theme.update` o `theme.reset` ([Tema](/guia/tema))    |
| `tenancy.initialized`        | `tenantId`                                         | Se abrió el contexto de un tenant (cada petición)      |
| `tenancy.ended`              | `tenantId`                                         | Se cerró ese contexto                                  |

`tenancy.initialized` y `tenancy.ended` solo se publican si hay algún listener que coincida, porque ocurren en cada petición.

## CloudEvents

Todo evento que sale del proceso es un CloudEvent 1.0 en JSON:

```json
{
  "specversion": "1.0",
  "id": "01J8...",
  "type": "tenant.created",
  "source": "tenancy-node://tuapp.com",
  "time": "2026-09-28T14:00:00.000Z",
  "tenantid": "bolivar",
  "datacontenttype": "application/json",
  "data": { "id": "bolivar", "name": "Club Bolívar", "status": "provisioning", "plan": null, "data": {} }
}
```

`tenantid` es una extensión (`null` = central). El `id` es el mismo en todos los reintentos: los consumidores deduplican con él. `source` sale de `events.source` o, si falta, del primer dominio central. El núcleo exporta las funciones para leerlo y escribirlo:

```ts
// En el consumidor: valida y convierte (lanza TENANCY_INVALID_CLOUDEVENT si no es válido)
const event = parseCloudEvent<{ pedidoId: number }>(cuerpo);
event.tenantid; // 'bolivar'
const sobre = fromCloudEvent(event); // { id, type, tenantId, time: Date, data }
```

`toCloudEvent(sobre, source)` hace lo inverso.

## Reenviar eventos: `forward`

```ts
import { createTenancy } from '@tenancy-node/core';
import { rabbitmq } from '@tenancy-node/transport-rabbitmq';
import { kafka } from '@tenancy-node/transport-kafka';

const tenancy = createTenancy({
  centralDomains: ['tuapp.com'],
  events: {
    transports: [
      rabbitmq({ url: process.env.RABBIT_URL! }),
      kafka({ brokers: ['kafka:9092'] }),
    ],
    source: 'tenancy-node://tuapp.com', // por defecto, el primer dominio central
  },
});

tenancy.events.forward('tenant.*', { transport: 'rabbitmq' });
tenancy.events.forward('pedido.*', { transport: ['rabbitmq', 'kafka'] });
tenancy.events.forward('factura.emitida', { transport: 'kafka', routingKey: 'facturas' });
```

- `transport` es el nombre de uno o más transportes. Un nombre desconocido lanza `InvalidConfigError`, igual que dos transportes con el mismo nombre (usa la opción `name` si necesitas dos del mismo tipo).
- `routingKey` cambia el destino: la clave de enrutamiento en RabbitMQ, el stream en Redis, el topic en Kafka y el subject en NATS. Sin `routingKey`: el tipo del evento en RabbitMQ, `<subjectPrefix>.<tipo>` en NATS y el stream o topic configurado en Redis y Kafka. El transporte de webhooks la ignora.
- `'*'` no incluye `tenancy.initialized/ended`. Si los necesitas, reenvíalos con su nombre.
- `forward` devuelve la función para dejar de reenviar.

**Sin outbox**, el envío sale fuera de la petición (como un listener `async`) con 3 intentos: espera 200 ms y luego 1 s. Si el tercero falla, el error queda como `events.transport` bajo el tenant y el evento se pierde. **Con outbox**, el evento se guarda antes de que la operación continúe y un relay lo entrega. Ver [Outbox](#outbox-transaccional).

## Transportes

| Transporte     | Paquete                                | Orden                                                  | Persistencia                                           | Duplicados                                                    |
| -------------- | -------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------- |
| Webhooks       | `@tenancy-node/transport-webhook`      | Sin garantía (los reintentos cambian el orden)         | Entregas en la base central                            | Una entrega por `(endpoint, evento)`: un reenvío no duplica   |
| RabbitMQ       | `@tenancy-node/transport-rabbitmq`     | Sin garantía: el consumidor procesa hasta `prefetch` en paralelo | Exchange durable, mensajes persistentes, confirmación del broker | Sin deduplicación en el broker (`messageId` = id del evento) |
| Redis Streams  | `@tenancy-node/transport-redis-streams` | Orden del stream; lo que se reintenta llega después    | La de tu Redis (AOF/RDB), recortado con `MAXLEN ~`     | Sin deduplicación                                             |
| Kafka          | `@tenancy-node/transport-kafka`        | Por tenant: la clave es el `tenantId` (una partición)  | Log replicado (`acks: -1`)                             | Productor idempotente; un reenvío de la outbox sí duplica      |
| NATS JetStream | `@tenancy-node/transport-nats`         | Por subject; un `nak` cambia el orden                  | Stream de JetStream                                    | El servidor descarta repetidos por `Nats-Msg-Id` dentro de su ventana |

En todos, la entrega es **al menos una vez**: deduplica con el `id` del CloudEvent en el consumidor. Cada paquete trae un consumidor que confirma solo después de que tu handler termina bien. No necesitas tenancy-node en el otro servicio para leer los eventos: son JSON estándar.

### RabbitMQ

```ts
import { rabbitmq, consumeRabbitmq } from '@tenancy-node/transport-rabbitmq';

rabbitmq({ url: 'amqp://user:pass@rabbit:5672', exchange: 'tenancy.events' });

// En el microservicio
const consumidor = await consumeRabbitmq({
  url: 'amqp://user:pass@rabbit:5672',
  queue: 'servicio-emails', // cola durable de este servicio
  bindings: ['tenant.created', 'pedido.*'],
  prefetch: 10,
  maxAttempts: 5,
  handler: async (event) => {
    // deduplica con event.id: la entrega es al menos una vez
  },
  onError: (error, event) => console.error(event?.id, error),
});
await consumidor.stop();
```

El transporte publica en un exchange `topic` (`tenancy.events` por defecto) y espera la confirmación del broker; se reconecta solo si la conexión se cae. El tenant va también en el header `tenantid`. Los `bindings` usan la sintaxis de RabbitMQ (`*` es una palabra, `#` cualquier cantidad).

::: warning La cola la crea el consumidor
Un exchange `topic` descarta los mensajes que no tienen cola. Los eventos publicados antes de que el consumidor cree y enlace su cola por primera vez se pierden, aunque el broker los haya confirmado.
:::

`consumeRabbitmq` cuenta los intentos en memoria del proceso: tras `maxAttempts` (5) hace `nack` sin reencolar, y el mensaje se descarta o va a la dead-letter exchange si la configuraste en la cola.

### Redis Streams

```ts
import { redisStreams, consumeRedisStream } from '@tenancy-node/transport-redis-streams';

redisStreams({ url: 'redis://redis:6379', stream: 'tenancy:events', maxLen: 100_000 });

const consumidor = consumeRedisStream({
  url: 'redis://redis:6379',
  stream: 'tenancy:events',
  group: 'servicio-emails', // un grupo por servicio
  consumer: `emails-${process.pid}`, // una instancia dentro del grupo
  claimIdleMs: 30_000,
  maxAttempts: 5, // después se confirma y se descarta
  deadLetterStream: 'tenancy:events:dead', // opcional: copia de lo descartado
  handler: async (event) => {
    // si lanza, no se confirma (XACK) y se reintenta con XAUTOCLAIM
  },
  onError: (error, event) => console.error(event?.tenantid, error),
});
await consumidor.stop();
```

Cada entrada lleva los campos `id`, `type`, `tenantid` y `event` (el CloudEvent). El grupo se crea desde el principio del stream si no existe. `consumeRedisStream` no es `async`. Un mensaje que falla se retoma cada `claimIdleMs`; tras `maxAttempts` entregas (5, contadas por Redis en la lista de pendientes del grupo) se confirma y se descarta, y `onError` recibe un error `discarded after N failed deliveries`. Una entrada sin un campo `event` válido se confirma y se informa enseguida, sin reintentos. Con `deadLetterStream`, lo descartado se copia a ese stream con sus campos, más `error` y `sourceid`. Los errores de Redis dentro del bucle (conexión, stream o grupo borrados) también llegan a `onError` y el consumidor sigue intentando. Opciones extra: `batch` (50), `blockMs` (1000), `client`/`redisOptions` en el transporte y `name` (`redis-streams`).

### Kafka

```ts
import { kafka, consumeKafka } from '@tenancy-node/transport-kafka';

kafka({ brokers: ['kafka:9092'], topic: 'tenancy.events', clientId: 'miapp' });

const consumidor = await consumeKafka({
  brokers: ['kafka:9092'],
  groupId: 'servicio-emails',
  topics: ['tenancy.events'],
  fromBeginning: true,
  handler: async (event) => {
    // el offset se confirma solo si esto termina bien
  },
});
await consumidor.stop();
```

El productor es idempotente, con `acks: -1` y `allowAutoTopicCreation`. La clave del mensaje es el `tenantId` (`central` para eventos centrales), así los eventos de un tenant conservan su orden. Headers: `content-type`, `ce_id`, `ce_type`, `ce_tenantid`. SSL y SASL van en la opción `kafka` (en los dos lados). Si el handler lanza, kafkajs reintenta el mismo mensaje y la partición no avanza hasta que pase.

### NATS JetStream

```ts
import { nats, consumeNats } from '@tenancy-node/transport-nats';

nats({ servers: 'nats:4222', stream: 'TENANCY', subjectPrefix: 'tenancy' });

const consumidor = await consumeNats({
  servers: 'nats:4222',
  stream: 'TENANCY',
  durable: 'servicio-emails',
  filterSubject: 'tenancy.tenant.*',
  maxDeliver: 5,
  connection: { user: 'emails', pass: process.env.NATS_PASS ?? '' }, // o token, tls...
  handler: async (event) => {
    // ack al terminar; si lanza, nak con 200 ms de espera
  },
});
await consumidor.stop();
```

El subject es `<subjectPrefix>.<tipo>` (`tenancy.tenant.created`). El transporte crea el stream (`TENANCY`, subjects `tenancy.>`) si no existe, con la configuración por defecto del servidor. Si usas `routingKey`, que quede dentro de `tenancy.>`: si no, ningún stream lo captura y el envío falla.

`consumeNats` acepta `connection` con las mismas opciones de conexión que `nats()` (usuario, token, TLS, `name`...), menos `servers`. Límites: el consumidor durable se crea solo si no existe (cambiar `maxDeliver` o `filterSubject` después no lo actualiza) y el stream tiene que existir antes.

## Outbox transaccional

Sin outbox, si el broker está caído tres intentos seguidos, el evento se pierde. Con `@tenancy-node/outbox`, `forward` guarda el evento en la tabla `tenancy_event_outbox` de la base central (una fila por destino) antes de que la operación continúe, y un relay lo entrega después.

```ts
import { createTenancy } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { outbox } from '@tenancy-node/outbox';
import { rabbitmq } from '@tenancy-node/transport-rabbitmq';

const tenancy = createTenancy({
  centralDomains: ['tuapp.com'],
  events: { transports: [rabbitmq({ url: process.env.RABBIT_URL! })] },
  plugins: [
    database({ driver: postgres(), central: { url: process.env.DATABASE_URL! } }),
    outbox({ maxAttempts: 10, baseDelayMs: 5000, batchSize: 100, lockMs: 60_000 }),
  ],
});
tenancy.events.forward('tenant.created', { transport: 'rabbitmq' });

// Relay en segundo plano (lo mismo que `npx tenancy outbox:relay`)
const relay = tenancy.outbox.startRelay();
await relay.stop(); // termina el lote en curso

await tenancy.outbox.relayOnce(); // { claimed, published, retried, dead }
await tenancy.outbox.stats(); // { pending, processing, published, failed }
await tenancy.outbox.failed({ tenantId: 'bolivar', limit: 20 });
await tenancy.outbox.retry({ tenantId: 'bolivar' }); // o { id } o 'all'
await tenancy.outbox.prune(); // borra publicados más viejos que retentionDays
```

Necesita el plugin de base de datos, registrado **antes** que `outbox()`. La tabla la crea `npx tenancy install`.

| Opción           | Por defecto | Qué hace                                                            |
| ---------------- | ----------- | ------------------------------------------------------------------- |
| `maxAttempts`    | `10`        | Intentos por evento y destino antes del dead-letter                 |
| `baseDelayMs`    | `5000`      | Espera base entre intentos: `baseDelayMs · 2^(intento−1)`, tope 1 h |
| `batchSize`      | `100`       | Eventos por lote. Si el lote sale lleno, el relay sigue sin esperar |
| `pollIntervalMs` | `1000`      | Espera cuando no hay pendientes                                     |
| `lockMs`         | `60000`     | Lease de un lote reservado                                          |
| `retentionDays`  | `7`         | Días que se conservan los publicados (`startRelay` limpia cada hora) |

Cómo funciona el relay:

1. En una transacción, reserva un lote de filas `pending` vencidas (o `processing` con el lease vencido) con `FOR UPDATE SKIP LOCKED`, y las marca `processing` con `locked_until`. En SQL Server usa `UPDLOCK, READPAST`; en SQLite, la transacción misma serializa.
2. Entrega cada evento fuera de la transacción. Si sale bien, `published`. Si falla, vuelve a `pending` con la próxima espera; al agotar `maxAttempts`, queda `failed` (dead-letter).
3. Varios relays pueden correr a la vez sin tomar las mismas filas. Si uno muere, otro retoma su lote cuando vence el lease.

En el log, un reintento pendiente es `warn` (`outbox.deliver`) y el dead-letter es `error` (`outbox.dead_letter`), los dos con el tenant.

```bash
npx tenancy outbox:relay                 # hasta SIGINT/SIGTERM (también despacha webhooks)
npx tenancy outbox:status --tenant=bolivar  # sale con código 1 si hay eventos fallidos
npx tenancy outbox:retry --all           # o --id=<id de la fila> o --tenant=<id>
```

::: warning Límites
- La garantía es **al menos una vez**: si el relay muere entre el envío y el `UPDATE`, el evento sale otra vez.
- La outbox vive en la base central. El evento se guarda en la misma operación que el cambio, pero no en la misma transacción SQL; y un cambio en la base de un tenant no puede compartir transacción con la central.
- Si la outbox no responde, la operación falla (el evento no se pierde en silencio).
- El orden no está garantizado: un evento que se reintenta sale después de los siguientes.
:::

## Webhooks

El plugin `webhooks()` registra endpoints HTTP (globales o por tenant), firma cada envío con HMAC-SHA256 y reintenta con espera. Es un transporte más, llamado `webhooks`, y se reenvía solo: el plugin llama a `forward(options.forward ?? '*', { transport: 'webhooks' })`.

```ts
import { createTenancy } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { outbox } from '@tenancy-node/outbox';
import { webhooks } from '@tenancy-node/transport-webhook';

const tenancy = createTenancy({
  centralDomains: ['tuapp.com'],
  plugins: [
    database({
      driver: postgres(),
      central: { url: process.env.DATABASE_URL! },
      encryptionKey: process.env.TENANCY_KEY, // los secretos de los endpoints se guardan cifrados
    }),
    outbox(),
    webhooks({ forward: '*', timeoutMs: 10_000, circuitThreshold: 5 }),
  ],
});

const { endpoint, secret } = await tenancy.webhooks.register({
  tenant: 'bolivar', // sin tenant (o null): webhook global, recibe eventos de todos
  name: 'ERP',
  url: 'https://erp.bolivar.bo/hook',
  events: ['pedido.*', 'tenant.updated'],
});
// Guarda `secret`: no se vuelve a mostrar

await tenancy.webhooks.test(endpoint.id); // envía webhook.test y devuelve { ok, status, ms }
await tenancy.webhooks.deliveries(endpoint.id, { status: 'dead' });
await tenancy.webhooks.update(endpoint.id, { active: false });
const nuevoSecreto = await tenancy.webhooks.rotateSecret(endpoint.id);
```

Sin `encryptionKey`, `register` falla. Con `forward: '*'` y outbox, **cada** evento deja una fila en la outbox aunque ningún endpoint lo quiera; si solo te interesan algunos, usa un patrón más estrecho (`forward: 'pedido.*'`).

El transporte crea una entrega por endpoint activo que coincide (los globales, más los del tenant del evento). Qué endpoints coinciden se decide al entregar: un endpoint nuevo no recibe eventos anteriores. Después, un despachador envía las entregas:

- Con outbox, `npx tenancy outbox:relay` corre los dos.
- Sin outbox, llama tú a `tenancy.webhooks.startDispatcher()` (el CLI exige la outbox).

Puedes correr varios despachadores a la vez (varias réplicas o procesos): cada uno reserva su lote con un bloqueo que vuelve a comprobar que la entrega sigue vencida (`FOR UPDATE SKIP LOCKED`; en SQL Server, `UPDLOCK, READPAST`), así una entrega que otro ya reservó o terminó no se envía de nuevo. La reserva dura `max(timeoutMs × 3, 30 s)`: si el proceso muere a mitad del envío, la entrega se retoma después (y el receptor puede recibirla dos veces; deduplica con `x-tenancy-delivery` o el `id` del evento).

| Opción                 | Por defecto                    | Qué hace                                                     |
| ---------------------- | ------------------------------ | ------------------------------------------------------------ |
| `retrySchedule`        | 1 min, 5 min, 30 min, 2 h, 12 h | Esperas entre intentos (6 intentos en total). Después, `dead` |
| `circuitThreshold`     | `5`                            | Fallos seguidos que abren el circuito del endpoint           |
| `circuitCooldownMs`    | `600000`                       | Pausa con el circuito abierto                                |
| `timeoutMs`            | `10000`                        | Tiempo máximo de cada petición                               |
| `allowPrivateNetworks` | `false`                        | Solo desarrollo y tests: permite destinos internos           |
| `batchSize`            | `50`                           | Entregas por lote                                            |
| `pollIntervalMs`       | `1000`                         | Espera cuando no hay entregas                                |
| `forward`              | `'*'`                          | Patrón de eventos que llegan al transporte                   |

La API también tiene `list({ tenant })`, `get(id)`, `remove(id)`, `redeliver(deliveryId)` (vuelve a `pending` con el contador en cero) y `dispatchOnce()`.

### Qué recibe el endpoint

Un `POST` con el CloudEvent como cuerpo y estos headers:

| Header                | Valor                                         |
| --------------------- | --------------------------------------------- |
| `content-type`        | `application/cloudevents+json`                |
| `x-tenancy-signature` | `t=<unix>,v1=<hex HMAC-SHA256 de "<t>.<cuerpo>">` |
| `x-tenancy-event`     | Tipo del evento                               |
| `x-tenancy-delivery`  | Id de la entrega                              |
| `x-tenancy-attempt`   | Número de intento                             |

Cualquier respuesta 2xx es éxito. Todo lo demás (incluidas las redirecciones, que no se siguen) cuenta como fallo y se reintenta. Se guardan el código, la duración y hasta 2000 caracteres de la respuesta.

### Verificar la firma

```ts
import { createServer } from 'node:http';
import { parseCloudEvent } from '@tenancy-node/core';
import { verifyWebhook } from '@tenancy-node/transport-webhook';

const secret = process.env.WEBHOOK_SECRET!;

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf8'); // el cuerpo crudo, sin re-serializar

  const header = req.headers['x-tenancy-signature'];
  if (!verifyWebhook({ secret, body, header: typeof header === 'string' ? header : undefined })) {
    res.writeHead(401).end();
    return;
  }
  const event = parseCloudEvent(body);
  // deduplica con event.id y procesa
  res.writeHead(204).end(); // cualquier 2xx es éxito; lo demás se reintenta
}).listen(4000);
```

`verifyWebhook` compara en tiempo constante y rechaza firmas con más de `toleranceSeconds` (300) de diferencia con tu reloj, contra repeticiones. Firma el cuerpo crudo: si tu framework ya parseó el JSON, volver a serializarlo puede cambiar los bytes y la firma no coincide. Si el receptor no usa Node, la firma es HMAC-SHA256 estándar de `"<t>.<cuerpo>"` en hexadecimal.

### Circuit breaker

Cada endpoint cuenta sus fallos seguidos. Al llegar a `circuitThreshold`, el circuito se abre y el endpoint se pausa `circuitCooldownMs` (queda `webhook.circuit_open` en el log). Cuando vence la pausa pasa a `half_open`: la próxima entrega es la prueba. Si sale bien, se cierra; si falla, se vuelve a abrir. Un envío exitoso pone el contador en cero, y `update` con `active: true` o una URL nueva cierra el circuito.

### Protección SSRF

Al registrar, al actualizar y antes de cada envío, la URL tiene que cumplir:

- solo `http:` o `https:`, sin usuario ni contraseña en la URL;
- el host tiene que resolver, y ninguna de sus IPs puede ser interna: loopback, redes privadas (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local y metadata de nubes (`169.254/16`, `fe80::/10`), CGNAT (`100.64/10`), multicast y reservadas;
- no se siguen redirecciones.

Una URL que no cumple lanza `UnsafeWebhookUrlError` (`TENANCY_UNSAFE_WEBHOOK_URL`). Límite conocido: entre la resolución DNS y la conexión, un ataque de _DNS rebinding_ sigue siendo posible. Si necesitas más, envía los webhooks por un proxy de salida.

Referencia: [`core`](/referencia/api/@tenancy-node/core/), [`outbox`](/referencia/api/@tenancy-node/outbox/), [`transport-webhook`](/referencia/api/@tenancy-node/transport-webhook/), [`transport-rabbitmq`](/referencia/api/@tenancy-node/transport-rabbitmq/), [`transport-redis-streams`](/referencia/api/@tenancy-node/transport-redis-streams/), [`transport-kafka`](/referencia/api/@tenancy-node/transport-kafka/), [`transport-nats`](/referencia/api/@tenancy-node/transport-nats/).
