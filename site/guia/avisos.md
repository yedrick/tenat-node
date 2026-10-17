# Avisos y notificaciones push

Avisos de la plataforma a sus tenants: mantenimiento, novedades, recordatorios de pago. Se envían
a **todos**, a **algunos tenants** o a **los de ciertos planes**; cada app los muestra (por
ejemplo, en una campanita) y, si configuras Firebase, también llegan como notificación push al
celular o al navegador.

```
 Panel /admin · CLI · tu código
            │  tenancy.notifications.send()
            ▼
   tenancy_notifications ──► tu app: forTenant() → campanita, markRead()
            │
            └──► canales (en segundo plano) ──► Firebase ──► celulares y navegadores
```

## Enviar un aviso

```ts
// A todos
await tenancy.notifications.send({
  title: 'Mantenimiento el sábado',
  body: 'El sistema no estará disponible de 2:00 a 4:00.',
  level: 'warning', // info · success · warning · critical
  expiresAt: new Date('2026-11-02'),
});

// A algunos tenants
await tenancy.notifications.send({
  title: 'Tu factura de noviembre está lista',
  audience: { type: 'tenants', tenants: ['imagendent', 'rayx'] },
  link: { url: '/facturas', label: 'Ver factura' },
});

// A los de un plan, y solo a ciertos roles de tu app
await tenancy.notifications.send({
  title: 'Nuevo módulo de reportes',
  audience: { type: 'plans', plans: ['profesional', 'clinica'] },
  roles: ['ADMIN'],
  startsAt: new Date('2026-11-01T08:00:00'), // programado
});
```

También desde el panel (**Avisos**: con vista previa y "Llegará a N tenants") y desde la CLI:

```bash
npx tenancy notify "Mantenimiento el sábado" --body="De 2 a 4" --level=warning --expires=2026-11-02
npx tenancy notify "Novedades" --plans=profesional,clinica --link=https://tuapp.com/novedades
```

| Campo       | Qué es                                                                                  |
| ----------- | --------------------------------------------------------------------------------------- |
| `title`     | Hasta 150 caracteres                                                                    |
| `body`      | Hasta 5000 caracteres                                                                   |
| `level`     | `info` (por defecto), `success`, `warning`, `critical`                                  |
| `audience`  | `{ type: 'all' }` (por defecto), `{ type: 'tenants', tenants }`, `{ type: 'plans', plans }` |
| `roles`     | Solo los usuarios con esos roles (los roles son de tu app)                              |
| `link`      | `{ url, label? }`: `https://...` o una ruta (`/facturas`)                                |
| `startsAt`  | Desde cuándo se muestra                                                                 |
| `expiresAt` | Hasta cuándo se muestra                                                                 |

Un aviso por plan usa el plan **efectivo**: los tenants sin plan reciben los avisos de `defaultPlan`.
Los tenants suspendidos no cuentan para "Llegará a N tenants" ni reciben push.

## Mostrarlos en tu app

La librería no conoce a tus usuarios: tu API le pasa el id y los roles del usuario logueado.

```ts
// GET /api/avisos → los avisos vigentes del tenant, con "leído" por usuario
app.get('/api/avisos', async (req, res) => {
  const avisos = await tenancy.notifications.forTenant({
    userId: String(req.user.id),
    roles: [req.user.rol],
  });
  res.json(avisos); // [{ id, title, body, level, link, read, createdAt, ... }]
});

app.get('/api/avisos/sin-leer', async (req, res) => {
  res.json({
    total: await tenancy.notifications.unreadCount({ userId: String(req.user.id), roles: [req.user.rol] }),
  });
});

app.post('/api/avisos/:id/leido', async (req, res) => {
  await tenancy.notifications.markRead(req.params.id, String(req.user.id), { roles: [req.user.rol] });
  res.status(204).end();
});

app.post('/api/avisos/leer-todos', async (req, res) => {
  await tenancy.notifications.markRead('all', String(req.user.id), { roles: [req.user.rol] });
  res.status(204).end();
});
```

`markRead` solo marca avisos que ese tenant puede ver: un id de otro tenant se ignora.

En el frontend, una campanita con el contador y la lista es suficiente:

```tsx
function Campanita() {
  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const cargar = () => fetch('/api/avisos').then((r) => r.json()).then(setAvisos);
  useEffect(() => {
    cargar();
    const timer = setInterval(cargar, 60_000); // o al recibir el push
    return () => clearInterval(timer);
  }, []);
  const sinLeer = avisos.filter((a) => !a.read).length;
  return (
    <Popover trigger={<Bell badge={sinLeer} />}>
      {avisos.map((a) => (
        <Aviso key={a.id} nivel={a.level} onOpen={() => fetch(`/api/avisos/${a.id}/leido`, { method: 'POST' })}>
          <b>{a.title}</b> {a.body} {a.link && <a href={a.link.url}>{a.link.label}</a>}
        </Aviso>
      ))}
    </Popover>
  );
}
```

::: tip Sin usuarios (pantalla pública, kiosco)
Con `http: { notifications: true }`, `GET /tenancy/notifications` devuelve los avisos vigentes del
tenant (sin estado de lectura y sin los dirigidos a roles), con `Cache-Control: no-store`.
:::

## Notificaciones push con Firebase

### 1. Configura el canal

```bash
npm install @tenancy-node/notify-firebase
```

En la consola de Firebase: **Configuración del proyecto → Cuentas de servicio → Generar nueva clave
privada**. Guarda el JSON en una variable de entorno (o la ruta del archivo en
`GOOGLE_APPLICATION_CREDENTIALS`).

```ts
import { firebaseFromEnv } from '@tenancy-node/notify-firebase';

const push = firebaseFromEnv(); // undefined si no hay credenciales: la app arranca igual, sin push

const tenancy = createTenancy({
  notifications: {
    channels: push ? [push] : [],
    // delivery: 'queue', // con un worker: reintentos y no ocupa el proceso web
  },
});
```

```bash
# .env
FIREBASE_SERVICE_ACCOUNT='{"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...","client_email":"..."}'
# o
GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/firebase.json
```

O directo: `firebase({ serviceAccount, defaultLink: '/avisos', concurrency: 20 })`.

### 2. Registra los dispositivos

El SDK de Firebase de tu frontend (web o móvil) entrega un **token** por dispositivo. Tu API lo
guarda con el usuario y el tenant:

```ts
app.post('/api/dispositivos', async (req, res) => {
  await tenancy.notifications.devices.register({
    userId: String(req.user.id),
    token: req.body.token, // de getToken() de Firebase
    platform: req.body.platform, // 'web' | 'android' | 'ios'
    roles: [req.user.rol],
  });
  res.status(204).end();
});

// Al cerrar sesión
app.delete('/api/dispositivos/:token', async (req, res) => {
  await tenancy.notifications.devices.unregister(req.params.token);
  res.status(204).end();
});
```

```ts
// Frontend web (firebase/messaging)
const token = await getToken(getMessaging(app), { vapidKey: 'TU_VAPID_KEY' });
await fetch('/api/dispositivos', { method: 'POST', body: JSON.stringify({ token, platform: 'web' }), headers: { 'content-type': 'application/json' } });
```

### 3. Listo

Cada `send()` entrega el aviso en segundo plano a los dispositivos de los tenants (y roles) que
alcanza. Los tokens que Firebase rechaza (app desinstalada, sesión vieja) se borran solos. El
mensaje lleva `notification.title/body` y en `data`: `notificationId`, `level` y `link`.

Cada entrega publica `notification.delivered` con el resultado:

```ts
tenancy.events.on('notification.delivered', ({ data }) => {
  // { notificationId, channel: 'firebase', tenants, devices, sent, failed, removedTokens }
});
```

Desde el panel, **Reenviar push** vuelve a entregar un aviso (por ejemplo, después de configurar Firebase).

## Otros canales (correo, WhatsApp...)

Un canal es un objeto con `name` y `send(aviso, dispositivos)`. Para avisos por correo, lo más
simple es escuchar el evento:

```ts
tenancy.events.on(
  'notification.sent',
  async ({ data }) => {
    if (data.level !== 'critical') return;
    await mailer.enviarATodosLosAdmins(data.title, data.body);
  },
  { mode: 'queue' },
);
```

## Referencia

| API                                                    | Qué hace                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| `notifications.send(input)`                            | Guarda, publica `notification.sent` y entrega por los canales    |
| `notifications.forTenant({ userId?, roles?, unreadOnly?, tenant? })` | Avisos vigentes con `read`                           |
| `notifications.unreadCount({ userId, roles? })`        | Cuántos no leyó                                                 |
| `notifications.markRead(id \| ids \| 'all', userId, { roles? })` | Marca leídos                                          |
| `notifications.reach(audience)`                        | Cuántos tenants activos alcanza                                 |
| `notifications.list()` · `get(id)` · `delete(id)`      | Panel: todos los avisos; retirar uno                            |
| `notifications.stats(ids)`                             | Lecturas por aviso: `{ tenants, users }`                        |
| `notifications.deliver(id)`                            | Vuelve a entregar por los canales                               |
| `notifications.devices.register / unregister / list`   | Dispositivos para push                                          |

Los avisos, sus lecturas y los dispositivos se guardan en la base central (`tenancy_notifications`,
`tenancy_notification_reads`, `tenancy_notification_devices`) con `@tenancy-node/db`; sin base, en memoria.
