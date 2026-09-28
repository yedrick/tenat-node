# Ejemplo: microservicio de correos

```
App (tenancy) ──► tenancy_event_outbox ──► relay ──► RabbitMQ (exchange tenancy.events)
                                                        │  routing key: tenant.created
                                                        ▼
                                          microservicio-emails (cola propia)
                                          └─ idempotente por el id del CloudEvent
```

1. `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=app postgres:16-alpine`
2. `docker run -d -p 5672:5672 rabbitmq:4-alpine`
3. `pnpm --filter example-microservicio-emails service`
4. En otra terminal: `pnpm --filter example-microservicio-emails app -- bolivar "Club Bolívar" admin@bolivar.bo`

El servicio recibe un CloudEvent JSON estándar:

```json
{
  "specversion": "1.0",
  "id": "01K…",
  "type": "tenant.created",
  "source": "tenancy-node://tuapp.com",
  "time": "2026-09-25T15:30:00.000Z",
  "tenantid": "bolivar",
  "datacontenttype": "application/json",
  "data": {
    "id": "bolivar",
    "name": "Club Bolívar",
    "status": "provisioning",
    "plan": null,
    "data": { "ownerEmail": "admin@bolivar.bo" }
  }
}
```

Por eso el consumidor puede estar en cualquier lenguaje. La entrega es _al menos una vez_: el servicio guarda los `id` ya procesados y los repetidos se ignoran. El `id` se marca **después** de enviar el correo: si el mailer falla, el mensaje vuelve a la cola y la reentrega lo intenta otra vez (no se pierde).
