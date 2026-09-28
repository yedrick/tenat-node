# ADR 0013 — Memcached, Kafka, NATS e invalidación entre instancias

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Decisiones

1. **Memcached no borra por prefijo**, así que cada tenant tiene un **número de versión** dentro de sus llaves (`tenancy:<tenant>:v<n>:<llave>`). `flushTenant` incrementa la versión: lo anterior queda inalcanzable y vence solo. La versión se recuerda ~1 s en el proceso: tras un flush en otra réplica, esta lo ve como mucho 1 s después. Las llaves largas (>200 bytes) o con espacios o caracteres de control se guardan como hash.
2. **Kafka** (`kafkajs`): productor idempotente, `acks: -1`, y la **clave del mensaje es el `tenantId`**: los eventos de un tenant van a la misma partición y conservan su orden. `consumeKafka` confirma el offset solo si el handler termina bien.
3. **NATS JetStream:** el stream se crea si falta, y el id del evento va en `Nats-Msg-Id`, así el servidor descarta los duplicados de un reenvío de la outbox. `consumeNats` usa un consumidor durable con `ack` explícito, `nak` con espera y `maxDeliver`.
4. **Puerto `InvalidationBus` en el núcleo.** Las cachés de búsqueda (tenants y dominios) avisan cada cambio; el núcleo junta los de una misma operación en **un solo mensaje** y aplica los que llegan de otras instancias, ignorando los propios. El tema no necesita mensaje: su clave de render incluye `updatedAt`. La implementación con Redis pub/sub (`redisInvalidation()`) está en `@tenancy-node/cache-redis`.
5. **Un fallo del bus nunca falla la escritura:** queda en el log (`cache.invalidation.publish`) y en el registro de errores, y el TTL de la caché sigue poniendo el límite. La entrega es "a lo sumo una vez", como Redis pub/sub.

## Consecuencias

- `tenancy.tenants.invalidate(id)` olvida la entrada **del tenant** (no la de sus dominios) en la caché de búsqueda de todas las instancias; lo usa `tenancy move`.
- Probado contra Memcached 1.6, Kafka 3.9 (KRaft), NATS 2 con JetStream y Valkey 8.
