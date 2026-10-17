# ADR 0017 — Avisos a los tenants y cobros

- **Estado:** aceptada
- **Fecha:** 2026-10-17

## Contexto

Una plataforma SaaS necesita hablarle a sus clientes (mantenimiento, novedades, facturas) y
cobrarles. Cada app lo resolvía a mano y fuera del panel.

## Decisiones

### Avisos

1. **Audiencia declarativa:** `all`, `tenants` o `plans` (plan efectivo, con `defaultPlan`), más
   `roles` opcionales. Se guarda la regla, no una fila por tenant: enviar a 10 000 tenants es
   una sola inserción, y un tenant nuevo ve los avisos vigentes "para todos".
2. **La librería no conoce a los usuarios de la app.** `forTenant({ userId, roles })` y
   `markRead(id, userId)` reciben el usuario desde la API de la app. Las lecturas se guardan por
   `(aviso, tenant, usuario)` en la base central, sin FK al tenant.
3. **Canales enchufables** (`NotificationChannel`): la entrega fuera de la app (push) no bloquea
   `send()`: va en segundo plano o en la cola (`delivery: 'queue'`, con reintentos). Los tokens
   que el proveedor rechaza se borran solos. `notification.sent` y `notification.delivered`
   permiten otros canales (correo, WhatsApp) sin tocar la librería.
4. **Firebase sin SDK:** `@tenancy-node/notify-firebase` usa la API HTTP v1 de FCM y firma el JWT
   de la cuenta de servicio con `node:crypto`. Sin dependencias pesadas y sin credenciales
   (`firebaseFromEnv()` devuelve `undefined`) la app arranca igual.
5. **Caché corta en proceso** (15 s) de los avisos vigentes: la campanita de cada petición no
   golpea la base central. Un aviso nuevo se ve al instante en la instancia que lo envió y en las
   demás en ≤ 15 s.

### Cobros

6. **Montos en centavos enteros** en la base y en el dominio; la API acepta decimales y los
   redondea una vez (`toCents`).
7. **El período pagado vive en la suscripción** (`currentPeriodEnd`). Pagar una factura de
   período lo extiende; las facturas sueltas no. La factura de un período es única: emitirla otra
   vez devuelve la existente (el ciclo diario puede correr varias veces sin duplicar).
8. **Pago manual primero, pasarela después.** `manual` siempre existe. Una pasarela es un
   `PaymentProvider` (`createCheckout` + `parseWebhook`): la firma la verifica la pasarela, y el
   webhook es idempotente (las pasarelas reintentan).
9. **El ciclo de cobro es explícito** (`billing.run()` / `tenancy billing:run` en un cron), no un
   temporizador escondido en la app web. Suspender por falta de pago está apagado por defecto
   (`suspendAfterDays: null`); si está activo, pagar reactiva al tenant.
10. **Todo publica eventos** (`billing.*`) para avisar por el canal que la app elija; los avisos
    de la librería son uno de ellos.

## Consecuencias

- `tenancy install` crea seis tablas nuevas en la base central (avisos, lecturas, dispositivos,
  suscripciones, facturas y pagos).
- La facturación legal (NIT, factura electrónica del SIN) queda fuera: la factura de la librería es
  el cobro interno; la app puede emitir la factura fiscal al escuchar `billing.invoice_paid`.
