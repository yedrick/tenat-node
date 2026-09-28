# ADR 0009 — Eventos hacia afuera: CloudEvents, outbox, webhooks y brokers

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Decisiones

1. **Formato estándar.** Todo evento que sale del proceso es un CloudEvent 1.0 JSON con la extensión `tenantid`. El `id` (ULID) permite a los consumidores ser idempotentes. `parseCloudEvent` valida lo que llega.
2. **`tenancy.events.forward(patrón, { transport })`.** Sin outbox, el envío es directo, fuera de la petición, con 3 intentos; el fallo final queda como `events.transport` bajo el tenant. `'*'` excluye `tenancy.initialized/ended` (uno por petición).
3. **Outbox (`@tenancy-node/outbox`).** Si está instalada, `forward` guarda el evento (una fila por destino) antes de que la operación continúe: si la outbox no responde, la operación falla en vez de perder el evento en silencio. El relay reserva lotes con `FOR UPDATE SKIP LOCKED` y un _lease_ (`locked_until`): varios relays trabajan en paralelo y si uno muere otro retoma su lote. Reintentos con espera exponencial; al agotarlos, dead-letter (`status = failed`) con reenvío manual. Garantía: **al menos una vez**.
4. **Webhooks (`@tenancy-node/transport-webhook`).** Son un transporte más (`webhooks`): crean una entrega por endpoint que coincide, única por `(endpoint, evento)`, así un evento reenviado no duplica entregas. Firma `t=<unix>,v1=<HMAC-SHA256(t.body)>` con tolerancia contra repeticiones y comparación en tiempo constante. Reintentos 1 min / 5 min / 30 min / 2 h / 12 h, circuit breaker por endpoint (abierto → pausa → half_open), dead-letter y reenvío. Protección SSRF: solo http(s), sin credenciales en la URL, sin redirecciones y ningún destino que resuelva a IPs internas o de metadata.
5. **Brokers.** RabbitMQ (exchange topic durable, mensajes persistentes, _publisher confirms_) y Redis Streams (`XADD` con `MAXLEN ~`, grupos de consumidores, `XAUTOCLAIM`). Cada paquete trae un consumidor con confirmación después de procesar.
6. **Eventos propios validados.** `tenancy.events.define(tipo, esquemaValibot)`: publicar datos inválidos lanza `TENANCY_INVALID_EVENT_DATA`.

## Límites conocidos

- La outbox vive en la base central. Para los eventos del paquete (creación de tenants, etc.) el evento se guarda en la misma operación, pero no en la misma transacción SQL que el cambio; y los cambios de datos en la base de un tenant no pueden compartir transacción con la central. Una outbox por base de tenant queda como mejora futura.
- La protección SSRF resuelve el DNS antes de cada envío; un ataque de _DNS rebinding_ entre esa resolución y la conexión sigue siendo posible. Para máxima seguridad, enviar los webhooks por un proxy de salida.
- Los endpoints reciben los eventos que se entregan después de registrarse (la coincidencia se decide al entregar).
