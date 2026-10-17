# Cobros

Cobra a tus tenants dentro del sistema: cada tenant tiene una **suscripción** (plan, período,
monto y hasta cuándo está pagado), **facturas** y **pagos**. Funciona desde el primer día con
**pago manual** (transferencia, QR del banco, efectivo) que registras en el panel, y está lista
para conectar una **pasarela** (Stripe, Mercado Pago, un QR bancario con webhook) cuando la elijas.

```
subscribe() ──► factura del 1er período ──► pago (manual o pasarela) ──► período pagado hasta…
                                                                            │
      tenancy billing:run (una vez al día) ◄──────────────────────────────┘
        · factura el período siguiente 7 días antes
        · factura vencida → suscripción "en mora" (+ evento para avisar)
        · opcional: suspende N días después del vencimiento, y reactiva al pagar
```

Los montos se guardan en **centavos** (enteros): `150.50 BOB` = `15050`. En la API y el panel
puedes pasar montos con decimales (`amount: 150.5`).

## Configuración

```ts
const tenancy = createTenancy({
  plans: {
    basico: { label: 'Básico', price: { currency: 'BOB', monthly: 150, yearly: 1500 }, features: [...] },
    profesional: { label: 'Profesional', price: { currency: 'BOB', monthly: 300 }, features: [...] },
  },
  billing: {
    currency: 'BOB', // si un plan no tiene precio
    dueDays: 7, // días para pagar cada factura
    invoiceDaysBefore: 7, // factura el período siguiente 7 días antes
    suspendAfterDays: null, // por ejemplo 10: suspende 10 días después del vencimiento
    providers: [], // pasarelas en línea (ver abajo); el pago manual siempre está
  },
  plugins: [database({ ... })],
});
```

```bash
npx tenancy install # crea tenancy_billing_subscriptions, _invoices y _payments
```

## Suscribir un tenant

```ts
// Usa el precio del plan del tenant (mensual por defecto) y factura el primer período.
await tenancy.billing.subscribe('imagendent');

// Cambiar plan y período (también cambia el plan del tenant)
await tenancy.billing.subscribe('imagendent', { plan: 'profesional', period: 'yearly' });

// Precio especial, otra moneda, 14 días de prueba
await tenancy.billing.subscribe('rayx', { amount: 120, currency: 'USD', trialDays: 14 });
```

Desde el panel: **Tenant → Cobros**.

## Registrar un pago manual

```ts
const [factura] = (await tenancy.billing.invoices({ tenantId: 'imagendent', status: ['open'] })).items;

await tenancy.billing.pay(factura.id, {
  method: 'transfer', // transfer · qr · cash · card · lo que uses
  reference: 'BNB-778812', // nro. de comprobante
  recordedBy: 'ana@tuapp.com',
}); // sin amount: lo que falta pagar. Con amount: pago parcial.
```

Al completarse, la factura queda **pagada**, el período de la suscripción se extiende y, si estaba
suspendido por falta de pago, el tenant vuelve a estar activo.

Otras operaciones: `invoice(tenant)` (factura el próximo período), `invoice(tenant, { description, amount })`
(cobro suelto: instalación, capacitación), `void(id)` (anular sin pagos), `cancel(tenant)` (deja de facturar).

## El ciclo de cobro (una vez al día)

```bash
# crontab: todos los días a las 6:00
0 6 * * * cd /var/www/app && npx tenancy billing:run
```

o desde tu código (`await tenancy.billing.run()`), o con el botón **Correr ciclo de cobro** del panel.
Devuelve `{ invoiced, pastDue, suspended }` con los ids de los tenants.

## Avisar por correo o WhatsApp

Todo lo que pasa publica un evento:

| Evento                           | Cuándo                                         |
| -------------------------------- | ---------------------------------------------- |
| `billing.invoice_created`        | Nueva factura                                  |
| `billing.payment_recorded`       | Pago (también parcial)                         |
| `billing.invoice_paid`           | Factura pagada por completo                    |
| `billing.payment_failed`         | La pasarela rechazó un pago                    |
| `billing.subscription_past_due`  | Una factura venció sin pagar                   |
| `billing.tenant_suspended`       | Suspendido por falta de pago                   |
| `billing.subscription_updated`   | Alta, cambio o cancelación                     |

```ts
tenancy.events.on('billing.invoice_created', async ({ data }) => {
  await tenancy.notifications.send({
    title: 'Tu factura está lista',
    body: `${(data.amountCents / 100).toFixed(2)} ${data.currency}, vence el ${data.dueAt.slice(0, 10)}`,
    audience: { type: 'tenants', tenants: [data.tenantId] },
    roles: ['ADMIN'],
    level: 'info',
  });
});

tenancy.events.on('billing.subscription_past_due', async ({ data }) => {
  await whatsapp.enviar(data.tenantId, 'Tu pago está vencido. Evita la suspensión pagando hoy.');
}, { mode: 'queue' });
```

## Conectar una pasarela (cuando la elijas)

Una pasarela es un objeto con dos funciones: iniciar el cobro de una factura y leer su webhook.

```ts
import type { PaymentProvider } from '@tenancy-node/core';

export function miQr(options: { apiKey: string; secreto: string }): PaymentProvider {
  return {
    name: 'qr-banco',
    async createCheckout({ invoice, tenant, returnUrl }) {
      const res = await fetch('https://api.mibanco.bo/qr', {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          monto: invoice.amountCents - invoice.paidCents,
          moneda: invoice.currency,
          glosa: `${tenant.name}: ${invoice.description}`,
          callback: 'https://tuapp.com/admin/api/billing/webhooks/qr-banco',
        }),
      });
      const qr = await res.json();
      return { providerRef: qr.id, qr: qr.imagenBase64, expiresAt: new Date(qr.vence) };
    },
    async parseWebhook({ headers, body }) {
      verificarFirma(headers['x-firma'], body, options.secreto); // lanza si no coincide
      const evento = JSON.parse(body);
      if (evento.estado === 'PAGADO')
        return { type: 'paid', providerRef: evento.id, amountCents: evento.monto, reference: evento.transaccion };
      if (evento.estado === 'RECHAZADO') return { type: 'failed', providerRef: evento.id, reason: evento.motivo };
      return { type: 'ignored' };
    },
  };
}

createTenancy({ billing: { providers: [miQr({ apiKey: '...', secreto: '...' })] } });
```

- **Cobrar:** `await tenancy.billing.checkout(facturaId)` (o "Cobrar en línea" en el panel) devuelve
  `{ url?, qr?, expiresAt? }` para mostrar al cliente.
- **Webhook:** la pasarela llama a `POST /admin/api/billing/webhooks/<nombre>` (público; la firma la
  verifica `parseWebhook`). Responde 400 si la firma no es válida. Es idempotente: si la pasarela
  reintenta, el pago no se registra dos veces.
- Si el webhook lo recibe tu propia ruta: `await tenancy.billing.webhook('qr-banco', { headers, body })`.

Stripe, Mercado Pago o Libélula se conectan igual: un `PaymentProvider` de unas 40 líneas.

## Referencia

| API                                          | Qué hace                                                       |
| -------------------------------------------- | -------------------------------------------------------------- |
| `billing.subscribe(tenant, input?)`          | Alta o cambio de suscripción                                   |
| `billing.subscription(tenant)` · `cancel(tenant)` | Ver o cancelar                                            |
| `billing.invoice(tenant, input?)`            | Próximo período o cobro suelto                                 |
| `billing.invoices(query)` · `getInvoice(id)` | Facturas (`tenantId`, `status`, `dueBefore`)                   |
| `billing.pay(invoiceId, input?)`             | Registra un pago                                               |
| `billing.void(invoiceId)`                    | Anula una factura sin pagos                                    |
| `billing.checkout(invoiceId, { provider?, returnUrl? })` | Cobro en línea                                     |
| `billing.webhook(provider, { headers, body })` | Procesa el webhook de la pasarela                            |
| `billing.run()`                              | Ciclo de cobro                                                 |
| `billing.payments({ tenantId?, invoiceId? })` | Pagos                                                         |
| `billing.providers`                          | `['manual', ...]`                                              |
