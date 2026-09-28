# Panel de administración

El panel tiene dos paquetes:

- `@tenancy-node/admin-api`: la API HTTP (sin framework, sobre `node:http`). Hace todo el trabajo: autenticación, permisos, auditoría.
- `@tenancy-node/admin-ui`: una SPA en React compilada a archivos estáticos. Solo habla con la API por HTTP.

El panel da acceso a todos los tenants. Trátalo como la parte más sensible de tu instalación. Decisiones y límites en [ADR 0010](/adr/0010-admin-api) y [ADR 0011](/adr/0011-admin-ui).

## Requisitos

- El plugin de base de datos (`@tenancy-node/db`). Sin él, `createAdminApi` lanza `InvalidConfigError`. Usuarios, sesiones, auditoría y tokens de impersonación viven en tablas `tenancy_admin_*`, `tenancy_audit_log` y `tenancy_impersonation_tokens` de la base central (las crea `tenancy install`).
- Un secreto de al menos 32 caracteres para `sessionSecret`. Con el CLI se lee de `TENANCY_ADMIN_SECRET`.
- `encryptionKey` (`TENANCY_KEY`) en el plugin de base de datos si vas a usar **2FA o webhooks**: el secreto TOTP y el secreto de firma de cada webhook se guardan cifrados. Sin llave, `POST /auth/2fa/setup`, `POST /auth/2fa/enable` y crear un webhook responden 501 `TENANCY_ENCRYPTION_KEY_MISSING` (y el error queda en el log).

```bash
openssl rand -base64 48   # un valor para TENANCY_ADMIN_SECRET
```

## Primer usuario

```bash
npx tenancy install
npx tenancy admin:user tu@email.com --role=owner
```

Si no pasas contraseña, el CLI genera una y la muestra **una sola vez**. Para dar una propia sin que quede en el historial de la terminal, ponla en una variable de entorno:

```bash
ADMIN_PASS='una-contraseña-larga' npx tenancy admin:user tu@email.com --password-env=ADMIN_PASS
npx tenancy admin:user tu@email.com --reset-password   # nueva contraseña y cierra sus sesiones
```

| Opción                   | Qué hace                                                        |
| ------------------------ | --------------------------------------------------------------- |
| `--role`                 | `owner` (por defecto), `admin` o `support`                      |
| `--name`                 | Nombre visible. Por defecto, lo que va antes de `@` en el email |
| `--password-env=VAR`     | Lee la contraseña de esa variable                               |
| `--reset-password`       | El usuario ya existe: cambia su contraseña y cierra sus sesiones |

La contraseña debe tener entre 12 y 256 caracteres. El alta queda en la auditoría (`admin_user.create_cli` o `admin_user.password_reset_cli`).

## Levantar el panel

### En su propio proceso (recomendado)

```bash
TENANCY_ADMIN_SECRET=... npx tenancy admin:serve --port=4000 --ui
# API:  http://127.0.0.1:4000/admin/api
# UI:   http://127.0.0.1:4000/admin/
# Docs: http://127.0.0.1:4000/admin/api/openapi.json
```

| Opción               | Por defecto | Qué hace                                                                 |
| -------------------- | ----------- | ------------------------------------------------------------------------ |
| `--port`             | `4000`      | Puerto                                                                   |
| `--host`             | `127.0.0.1` | Interfaz. Con otro valor el CLI avisa que el panel queda expuesto         |
| `--ui`               | apagado     | Sirve también la interfaz en `/admin` (requiere `@tenancy-node/admin-ui`) |
| `--insecure-cookies` | apagado     | Cookies sin `Secure`. Solo para desarrollo local por `http`              |

Por defecto solo escucha en `127.0.0.1`: entras por VPN o túnel SSH. Se detiene con SIGINT/SIGTERM.

Lo mismo desde código, con `serveAdmin`:

```ts
import { createTenancy } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { serveAdmin } from '@tenancy-node/admin-api';

const tenancy = createTenancy({
  centralDomains: ['tuapp.com'],
  plugins: [
    database({
      driver: postgres(),
      central: { url: process.env.DATABASE_URL! },
      encryptionKey: process.env.TENANCY_KEY, // necesaria para la 2FA del panel
    }),
  ],
});

const admin = await serveAdmin(tenancy, {
  sessionSecret: process.env.TENANCY_ADMIN_SECRET!, // mínimo 32 caracteres
  port: 4000, // por defecto 4000
  host: '127.0.0.1', // por defecto: solo local
  ui: true, // sirve @tenancy-node/admin-ui en /admin
});
console.log(admin.url); // http://127.0.0.1:4000/admin/api

process.once('SIGTERM', async () => {
  await admin.close();
  await tenancy.close();
});
```

`serveAdmin` también borra las sesiones vencidas cada hora.

### Dentro de tu app

`createAdminApi(tenancy, options)` devuelve un objeto con `handle(req, res)`: responde si la ruta empieza con el prefijo y devuelve `false` si no es del panel.

::: code-group

```ts [Express]
import express from 'express';
import { tenancyMiddleware } from '@tenancy-node/adapter-express';
import { adminMiddleware, createAdminApi } from '@tenancy-node/admin-api';

const admin = createAdminApi(tenancy, { sessionSecret: process.env.TENANCY_ADMIN_SECRET! });

const app = express();
app.use(adminMiddleware(admin)); // antes del middleware de tenancy
app.use(tenancyMiddleware(tenancy));
app.listen(3000);
```

```ts [Fastify]
import Fastify from 'fastify';
import { tenancyPlugin } from '@tenancy-node/adapter-fastify';
import { createAdminApi, registerAdminFastify } from '@tenancy-node/admin-api';

const admin = createAdminApi(tenancy, { sessionSecret: process.env.TENANCY_ADMIN_SECRET!, ui: true });

const app = Fastify();
registerAdminFastify(app, admin); // siempre antes de tenancyPlugin
await app.register(tenancyPlugin, { tenancy });
await app.listen({ port: 3000 });
```

:::

`registerAdminFastify` se engancha en `onRequest`, antes de que Fastify lea el body, y toma la respuesta con `reply.hijack()`.

El panel **solo responde en los hosts permitidos**: por defecto los dominios centrales, `localhost`, `127.0.0.1` y `::1`. Una petición con el host de un tenant recibe 404.

### Opciones

```ts
const admin = createAdminApi(tenancy, {
  sessionSecret: process.env.TENANCY_ADMIN_SECRET!,
  prefix: '/admin/api', // la UI queda en el prefijo sin /api
  allowedHosts: ['admin.tuapp.com'], // por defecto: dominios centrales, localhost, 127.0.0.1 y ::1
  secureCookies: true, // false solo en desarrollo por http
  sessionTtlMs: 4 * 3_600_000, // por defecto 8 h
  loginRateLimit: { max: 5, windowMs: 15 * 60_000 },
  maskedColumns: /(password|secret|token|hash|salt|api_?key|otp|2fa|tarjeta)/i,
  publicDocs: false, // /openapi.json solo con sesión
  impersonationTtlSeconds: 60,
  impersonationUrl: ({ domain, token }) => `https://${domain}/entrar-como?token=${token}`,
});
```

| Opción                    | Por defecto                                            | Qué hace                                                    |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| `sessionSecret`           | obligatorio                                            | Secreto de los tokens CSRF (mínimo 32 caracteres)           |
| `prefix`                  | `/admin/api`                                           | Prefijo de la API                                           |
| `allowedHosts`            | dominios centrales + `localhost`, `127.0.0.1`, `::1`   | Hosts desde los que responde                                |
| `secureCookies`           | `true`                                                 | Cookie con `Secure`                                         |
| `sessionTtlMs`            | 8 h                                                    | Duración de la sesión                                       |
| `cookieName`              | `tenancy_admin`                                        | Nombre de la cookie                                         |
| `loginRateLimit`          | `{ max: 5, windowMs: 900000 }`                         | Intentos fallidos por IP y por email                        |
| `impersonationTtlSeconds` | `60`                                                   | Vida de los tokens de impersonación                         |
| `impersonationUrl`        | `https://<dominio principal>/tenancy/impersonate?token=` | URL que abre la sesión en la app del tenant                 |
| `maskedColumns`           | `/(password\|secret\|token\|hash\|salt\|api_?key\|otp\|2fa)/i` | Columnas que el explorador oculta                   |
| `bodyLimitBytes`          | 1 MiB                                                  | Tamaño máximo del body (413 si se pasa)                     |
| `publicDocs`              | `true`                                                 | `/openapi.json` sin autenticación                           |
| `issuer`                  | `tenancy-node`                                         | Nombre que muestra la app de autenticación (2FA)            |
| `ui`                      | apagado                                                | `true` sirve `@tenancy-node/admin-ui`; o la ruta de una UI compilada |

`serveAdmin` acepta además `port` y `host`.

## Autenticación

- **Contraseñas** con argon2id (19 MiB, 2 iteraciones, parámetros de OWASP). Mínimo 12 caracteres.
- **Login** con `POST /auth/login` y `{ email, password, code?, mode? }`. Un email inexistente responde igual y tarda lo mismo que uno con contraseña incorrecta.
- **Sesiones** de 8 h por defecto. El token (32 bytes) solo existe del lado del cliente; en la base se guarda su SHA-256.
  - `mode: 'cookie'` (por defecto, para el navegador): cookie `HttpOnly; SameSite=Strict; Secure`. La respuesta trae `csrfToken`.
  - `mode: 'token'` (para automatizar): la respuesta trae `token` y lo mandas como `Authorization: Bearer <token>`.
- **CSRF**: con cookie, toda petición que no sea `GET` debe traer `X-CSRF-Token` (HMAC de la sesión con `sessionSecret`). Si falta: 403 `ADMIN_CSRF`. Con Bearer no hace falta.
- **Límite de intentos**: 5 fallos cada 15 min por IP y por email. Después, 429 `ADMIN_TOO_MANY_ATTEMPTS` con `Retry-After`. El contador vive en memoria del proceso: con varias réplicas del panel, cada una cuenta los suyos.
- **2FA TOTP** (RFC 6238, 6 dígitos, 30 s, acepta un paso de desfase). Se activa en dos pasos: `POST /auth/2fa/setup` devuelve el secreto y la URL `otpauth://`; `POST /auth/2fa/enable` lo confirma con un código. Con 2FA, el login sin `code` responde 401 `ADMIN_2FA_REQUIRED`. Requiere `encryptionKey`: sin ella los dos pasos responden 501 `TENANCY_ENCRYPTION_KEY_MISSING`.
- Cambiar la contraseña cierra las demás sesiones. Cambiar el rol o desactivar a un usuario cierra todas las suyas.

Ejemplo para scripts:

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:4000/admin/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"tu@email.com","password":"...","mode":"token"}' | jq -r .token)

curl -s http://127.0.0.1:4000/admin/api/tenants?status=failed -H "authorization: Bearer $TOKEN"
```

## Roles

Cada ruta declara un permiso y el servidor lo verifica. La UI solo oculta lo que tu rol no puede hacer.

| Permiso                          | `support` | `admin` | `owner` |
| -------------------------------- | :-------: | :-----: | :-----: |
| Ver tenants, dominios, migraciones (`tenants:read`) |     ✓     |    ✓    |    ✓    |
| Explorador de datos (`data:read`) |     ✓     |    ✓    |    ✓    |
| Vaciar la caché de un tenant (`cache:flush`) |     ✓     |    ✓    |    ✓    |
| Impersonar (`impersonate`)       |     ✓     |    ✓    |    ✓    |
| Ver webhooks y eventos (`webhooks:read`, `events:read`) |     ✓     |    ✓    |    ✓    |
| Métricas y errores (`metrics:read`) |     ✓     |    ✓    |    ✓    |
| Crear y cambiar tenants, dominios, tema; suspender, mantenimiento (`tenants:write`) |           |    ✓    |    ✓    |
| Migrar y correr seeds (`migrations:run`) |           |    ✓    |    ✓    |
| Crear y cambiar webhooks (`webhooks:write`) |           |    ✓    |    ✓    |
| Reintentar eventos de la outbox (`events:retry`) |           |    ✓    |    ✓    |
| Ver la auditoría (`audit:read`)  |           |    ✓    |    ✓    |
| Borrar tenants (`tenants:delete`) |           |         |    ✓    |
| Administrar usuarios del panel (`users:manage`) |           |         |    ✓    |

Siempre queda al menos un `owner` activo: no puedes degradar, desactivar ni borrar al último. Nadie puede borrarse a sí mismo. `ROLES`, `can(role, permission)` y `permissionsOf(role)` están exportados si los necesitas.

## Qué hace la API

La lista completa, con cuerpos y parámetros, está en el documento OpenAPI 3.1 en `<prefijo>/openapi.json` (también `admin.openapi()` desde código). Resumen por área:

| Área          | Rutas principales                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`        | `/auth/login`, `/auth/logout`, `/auth/me`, `/auth/password`, `/auth/2fa/setup`, `/auth/2fa/enable`, `/auth/2fa/disable`                    |
| `tenants`     | `GET/POST /tenants`, `GET/PATCH/DELETE /tenants/:id`, `/tenants/:id/suspend`, `/activate`, `/maintenance`, `/retry`, `/progress`, `/theme`, `/cache/flush` |
| dominios      | `GET/POST /tenants/:id/domains`, `DELETE /domains/:domain`, `POST /domains/:domain/primary`                                                |
| `database`    | `GET /tenants/:id/migrations`, `POST /tenants/:id/migrate`, `POST /tenants/:id/seed`, `POST /migrate` (todos, con concurrencia)             |
| `data`        | `GET /tenants/:id/tables`, `GET /tenants/:id/tables/:table`                                                                               |
| webhooks      | `GET/POST /webhooks`, `PATCH/DELETE /webhooks/:id`, `/webhooks/:id/deliveries`, `/webhooks/:id/test`, `/webhooks/deliveries/:id/redeliver` (requiere `@tenancy-node/transport-webhook`) |
| eventos       | `GET /events/outbox`, `POST /events/outbox/retry` (requiere `@tenancy-node/outbox`)                                                      |
| `system`      | `GET /health` (pública), `GET /metrics`, `GET /errors`, `GET /audit`, `/users`                                                           |

Si falta el plugin de webhooks u outbox, esas rutas responden 404 `ADMIN_FEATURE_DISABLED`. Crear un webhook sin `encryptionKey` responde 501 `TENANCY_ENCRYPTION_KEY_MISSING`.

Borrar un tenant exige confirmar el id en el body: `DELETE /tenants/bolivar` con `{ "confirm": "bolivar" }`.

### Progreso en vivo (SSE)

`POST /tenants` y `POST /tenants/:id/retry` responden 202 y aprovisionan en segundo plano. El progreso se sigue con Server-Sent Events en `GET /tenants/:id/progress`:

| Evento   | Datos                                                       |
| -------- | ----------------------------------------------------------- |
| `step`   | `{ runId, step, status, attempt, durationMs, error }`       |
| `status` | `{ status }` cada vez que cambia el estado del tenant       |
| `done`   | `{ status }` al llegar a `active` o `failed`; luego se cierra |

El servidor lee los pasos de `tenancy_provisioning_steps` en la base, no de la memoria: funciona aunque el tenant se esté creando en otro proceso. Consulta cada 250 ms, manda un keep-alive cada 15 s y corta a los 10 minutos.

### Explorador de datos

Solo lectura, dentro de la base del tenant (en modo schema, solo las tablas de su schema).

- `GET /tenants/:id/tables`: tablas, columnas, tipo, cantidad de filas y si la columna está oculta.
- `GET /tenants/:id/tables/:table?page=1&perPage=50&sort=nombre&order=desc&filter.estado=activo`: filas, máximo 100 por página.

Tabla y columnas se validan contra la estructura real y los valores van parametrizados. Las columnas que coinciden con `maskedColumns` salen como `••••••` y no se pueden usar en `filter.` (403 `ADMIN_MASKED_COLUMN`). Cada lectura queda en la auditoría (`data.view`). No hay edición.

### Impersonación

`POST /tenants/:id/impersonate` con `{ user, redirect? }` crea un token de un solo uso para entrar como un usuario del tenant. Solo con el tenant activo. Responde `{ token, url, expiresAt }`: `url` sale de `impersonationUrl`, o por defecto `https://<dominio principal>/tenancy/impersonate?token=...` (o `null` si el tenant no tiene dominio). También publica el evento `admin.impersonation_started` en el tenant.

Tu app canjea el token con `consumeImpersonationToken`. La ruta tiene que correr en el contexto del tenant:

```ts
import express from 'express';
import { tenancyMiddleware } from '@tenancy-node/adapter-express';
import { consumeImpersonationToken } from '@tenancy-node/admin-api';

const app = express();
app.use(tenancyMiddleware(tenancy));

app.get('/entrar-como', async (req, res) => {
  // Lanza InvalidImpersonationTokenError si el token no sirve (vencido, usado o de otro tenant).
  const { userIdentifier, redirectPath } = await consumeImpersonationToken(
    tenancy,
    String(req.query.token),
  );
  await iniciarSesionComo(userIdentifier); // tu lógica de sesión
  res.redirect(redirectPath);
});
```

El token se guarda como hash, vence en 60 s por defecto, vale solo en su tenant y se marca como usado en la misma sentencia que lo valida. Al usarse deja un log `warn` con `operation: 'admin.impersonation_used'`. Cómo inicias la sesión del usuario es cosa de tu app.

## Auditoría

Cada acción queda en `tenancy_audit_log` con usuario, IP, tenant, objetivo y `changes` (`before`/`after` cuando aplica). Se registran también los logins fallidos (`auth.login_failed`, con el motivo) y cada lectura del explorador. Nunca se guardan contraseñas ni tokens. La tabla no tiene claves foráneas: la historia sobrevive al borrado del tenant.

Se consulta con `GET /audit?tenant=bolivar&user=3&action=tenant.&before=<id>&limit=50` (`action` filtra por prefijo; máximo 200 por página). Algunas acciones: `auth.login`, `tenant.create`, `tenant.suspend`, `tenant.delete`, `domain.*`, `database.migrate`, `cache.flush`, `data.view`, `admin.impersonation_started`, `admin_user.update`.

## Seguridad HTTP

- Solo JSON (`415` si no), body máximo de 1 MiB (`413` y cierre de la conexión).
- Headers en cada respuesta: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` y `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.
- Los errores 5xx responden `ADMIN_INTERNAL_ERROR` sin detalles. El detalle va al log (`operation: 'admin.request'`) y al registro de errores.
- Cada petición deja una línea de log con `operation: 'admin.request'`, `method`, `path` (la plantilla), `statusCode`, `adminUserId` y `durationMs`.

## La interfaz (`@tenancy-node/admin-ui`)

Instala `@tenancy-node/admin-ui` y pasa `ui: true` (o `--ui` en el CLI). La API busca el paquete desde el directorio actual y sirve su carpeta `dist` en el prefijo sin `/api` (`/admin`). También puedes pasar la ruta de una UI compilada: `ui: './mi-ui/dist'`.

Pantallas:

| Pantalla        | Qué muestra                                                                                          | Permiso         |
| --------------- | ---------------------------------------------------------------------------------------------------- | --------------- |
| Login           | Email, contraseña y código 2FA                                                                        | —               |
| Dashboard       | Tenants por estado, pools, salud, outbox y errores por tenant                                          | `metrics:read`  |
| Tenants         | Lista con búsqueda y filtros; alta de tenant con progreso en vivo                                     | `tenants:read`  |
| Detalle de tenant | Pestañas Resumen (acciones: suspender, mantenimiento, borrar, impersonar), Dominios, Tema (editor con vista previa), Base de datos (migraciones), Datos (explorador) y Errores | `tenants:read` (Datos: `data:read`) |
| Webhooks        | Endpoints, historial de entregas, reenvío y prueba                                                    | `webhooks:read` |
| Eventos         | Outbox por estado y dead-letter                                                                       | `events:read`   |
| Usuarios        | Usuarios del panel y sus roles                                                                        | `users:manage`  |
| Auditoría       | El registro de auditoría con filtros                                                                  | `audit:read`    |
| Mi cuenta       | Cambio de contraseña y 2FA                                                                            | —               |

La UI se sirve con una CSP estricta:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:;
connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none';
form-action 'self'; object-src 'none'
```

Nada inline ni de otros orígenes. Los assets con hash se cachean para siempre; `index.html` va con `no-cache`. Las rutas con `../` no salen de la carpeta de la UI. El token CSRF vive en memoria, no en `localStorage`. La UI está solo en español.

## Límites conocidos

- El límite de intentos de login y los errores de `GET /errors` son por proceso.
- El explorador de datos no permite editar.
- `consumeImpersonationToken` solo valida el token: iniciar la sesión del usuario lo haces tú.

Referencia completa: [`@tenancy-node/admin-api`](/referencia/api/@tenancy-node/admin-api/).
