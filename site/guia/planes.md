# Planes y módulos

Cada proyecto declara **sus** módulos y **sus** planes en la configuración. La librería no conoce
módulos concretos ("reportes", "caja"): solo hace cumplir lo que digas ahí, en todas partes a la vez.

```
              tenancy.config.ts  (features + plans)
                       │
   ┌──────────┬────────┼──────────────┬──────────────┬───────────────┐
   ▼          ▼        ▼              ▼              ▼               ▼
 API        Límites  /tenancy/me    Panel /admin   CLI           GET /tenancy/plans
 requireFeature  assertLimit  (menú del frontend)  (plan y módulos)  (precios de la web comercial)
```

Como todo sale de un solo lugar, el menú, los permisos de la API, el panel y los precios
públicos nunca se contradicen.

## Conectarlo en un proyecto (5 pasos)

### 1. Declara módulos y planes

```ts
// tenancy.config.ts
import { defineConfig } from '@tenancy-node/core';

export default defineConfig({
  centralDomains: ['tuapp.com'],

  // Catálogo de módulos: llave → nombre visible (o { label, description }).
  features: {
    agenda: 'Agenda de citas',
    caja: 'Caja chica',
    reportes: { label: 'Reportes', description: 'Reportes y PDF' },
    finanzas: 'Depósitos y pagos a terceros',
  },

  plans: {
    basico: {
      label: 'Básico',
      price: { currency: 'BOB', monthly: 150, yearly: 1500 },
      features: ['agenda', 'caja'],
      limits: { usuarios: 3 },
    },
    profesional: {
      label: 'Profesional',
      price: { currency: 'BOB', monthly: 300, yearly: 3000 },
      features: ['agenda', 'caja', 'reportes'],
      limits: { usuarios: 10 },
      highlight: true, // "el más elegido" en la web comercial
    },
    clinica: {
      label: 'Clínica',
      features: '*', // todos los módulos del catálogo
      limits: { usuarios: null }, // sin límite
    },
    interno: { label: 'Interno', features: '*', public: false }, // no sale en la web
  },

  // Plan de los tenants que no tienen uno.
  defaultPlan: 'basico',

  http: { me: true, theme: true, plans: true },
  publicFields: ['name', 'plan', 'planLabel', 'features', 'limits'],
  // ...plugins, base de datos, etc.
});
```

| Campo del plan | Qué es                                                                               |
| -------------- | ------------------------------------------------------------------------------------ |
| `label`        | Nombre visible                                                                       |
| `features`     | Módulos del plan, o `'*'` para todos                                                 |
| `limits`       | `{ usuarios: 3 }`. `null` o sin la llave = sin límite                                 |
| `price`        | `{ currency, monthly?, yearly? }` para la web comercial. Sin precio: "a consultar"   |
| `public`       | Por defecto `true`. `false` lo oculta de `GET /tenancy/plans` (planes internos)      |
| `highlight`    | Plan destacado en la web comercial                                                   |
| `description`  | Texto corto opcional                                                                 |

La configuración se valida al arrancar: un plan que nombra un módulo que no está en `features`,
un límite negativo o un `defaultPlan` que no existe lanzan `InvalidConfigError`.

### 2. Actualiza la base central

```bash
npx tenancy install
```

Agrega la columna `features` a `tenancy_tenants` (módulos sueltos de cada tenant) y la tabla
`tenancy_leads` (solicitudes de la web comercial). Es idempotente.

::: warning Al actualizar desde 0.10
Corre `tenancy install` **antes** de desplegar la versión nueva: sin la columna `features`,
guardar un tenant falla.
:::

### 3. Protege la API

**Express**

```ts
import { requireFeature, tenancyMiddleware } from '@tenancy-node/adapter-express';

app.use(tenancyMiddleware(tenancy));
app.use('/api/reportes', requireFeature(tenancy, 'reportes'), reportesRouter);
app.use('/api/finanzas', requireFeature(tenancy, 'finanzas'), finanzasRouter);
```

**Fastify**

```ts
import { requireFeature, tenancyPlugin } from '@tenancy-node/adapter-fastify';

await app.register(tenancyPlugin, { tenancy });

// Una ruta
app.get('/api/reportes', { preHandler: requireFeature(tenancy, 'reportes') }, handler);

// Un grupo de rutas
await app.register(async (reportes) => {
  reportes.addHook('preHandler', requireFeature(tenancy, 'reportes'));
  reportes.get('/api/reportes/ventas', ventas);
  reportes.get('/api/reportes/pdf', pdf);
});
```

**`node:http` o cualquier otro lugar**

```ts
tenancy.features.require('reportes'); // lanza FeatureNotInPlanError (403)
```

Con varios módulos (`requireFeature(tenancy, 'reportes', 'finanzas')`) se exigen **todos**.
Si el plan no los incluye, la respuesta es:

```http
HTTP/1.1 403 Forbidden

{ "error": { "code": "TENANCY_FEATURE_NOT_IN_PLAN",
             "message": "The plan of tenant \"imagendent\" does not include \"reportes\"",
             "details": { "tenantId": "imagendent", "feature": "reportes", "plan": "basico" } } }
```

Aunque alguien escriba la dirección a mano, la API lo rechaza: el menú solo es comodidad.

### 4. Límites del plan

La librería no conoce tus tablas: **tu app cuenta**, la librería decide.

```ts
app.post('/api/usuarios', async (req, res) => {
  const total = await db.selectFrom('usuarios').select(db.fn.countAll().as('n')).executeTakeFirst();
  tenancy.features.assertLimit('usuarios', Number(total?.n)); // 403 si ya llegó
  // ...crear el usuario
});
```

```http
HTTP/1.1 403 Forbidden

{ "error": { "code": "TENANCY_PLAN_LIMIT_REACHED",
             "message": "The plan of tenant \"imagendent\" allows 3 usuarios",
             "details": { "tenantId": "imagendent", "limit": "usuarios", "max": 3, "plan": "basico" } } }
```

Con `details.max` el frontend muestra "Tu plan permite 3 usuarios". También tienes
`tenancy.features.limit('usuarios')` (`3`, o `null` sin límite) y
`tenancy.features.remaining('usuarios', total)`.

### 5. Muestra solo lo del plan en el frontend

`/tenancy/me` trae el plan, sus módulos y límites (con `publicFields` del paso 1):

```json
{
  "id": "imagendent",
  "name": "Imagendent",
  "plan": "basico",
  "planLabel": "Básico",
  "features": ["agenda", "caja"],
  "limits": { "usuarios": 3 },
  "theme": { "primary": "#0F766E", "secondary": "#64748B" }
}
```

Ejemplo con React (sirve igual con Vue, Svelte o JavaScript puro):

```tsx
// useTenant.ts
export function useTenant() {
  const [me, setMe] = useState<{ features: string[]; limits: Record<string, number | null> }>();
  useEffect(() => {
    fetch('/tenancy/me').then((r) => r.json()).then(setMe);
  }, []);
  return { me, has: (feature: string) => me?.features.includes(feature) ?? false };
}

// Menú: cada entrada dice qué módulo necesita.
const MENU = [
  { to: '/pacientes', label: 'Pacientes' }, // siempre
  { to: '/agenda', label: 'Agenda', feature: 'agenda' },
  { to: '/reportes', label: 'Reportes', feature: 'reportes' },
];
const { has } = useTenant();
const visible = MENU.filter((item) => !item.feature || has(item.feature));

// Ruta protegida: si entran por enlace a un módulo que no tienen.
function ModuleRoute({ feature, children }: { feature: string; children: ReactNode }) {
  const { me, has } = useTenant();
  if (!me) return null;
  if (!has(feature))
    return (
      <div>
        <h2>Este módulo no está en tu plan</h2>
        <a href="https://wa.me/59170000000?text=Quiero%20mejorar%20mi%20plan">Solicitar mejora</a>
      </div>
    );
  return children;
}
```

Y en tu cliente HTTP, trata los dos códigos de forma general:

```ts
if (body.error?.code === 'TENANCY_PLAN_LIMIT_REACHED')
  toast(`Tu plan permite ${body.error.details.max} ${body.error.details.limit}`);
if (body.error?.code === 'TENANCY_FEATURE_NOT_IN_PLAN') navigate('/mejorar-plan');
```

::: tip Plan + rol
Los roles de tu app siguen igual. Ahora mandan **los dos**: una ruta exige el módulo
(`requireFeature`) y además el permiso del rol (tu middleware de siempre).
:::

`/tenancy/me` se cachea 5 minutos en el navegador por defecto (`http.cacheControl`). Después de
cambiar el plan, recargar la página lo actualiza al vencer; si quieres verlo al instante, usa
`http: { cacheControl: 'no-cache' }` (el ETag sigue evitando volver a descargarlo).

## Cambiar el plan de un tenant

Desde el panel (Tenant → Plan), la CLI o el código:

```ts
await tenancy.plans.assign('imagendent', 'profesional');

// Módulos sueltos sin cambiar de plan: "Básico + Reportes", y un límite propio.
await tenancy.plans.assign('imagendent', 'basico', {
  add: ['reportes'],
  remove: ['caja'],
  limits: { usuarios: 5 },
});

// También con tenants.update / tenants.create:
await tenancy.tenants.create({ id: 'rayx', plan: 'clinica' });
```

`assign` sin el tercer argumento conserva los módulos sueltos que tenía; `null` los quita.
Un plan que no existe en la configuración lanza `InvalidTenantDataError` (422).

Cada cambio publica `tenant.plan_changed`:

```ts
tenancy.events.on('tenant.plan_changed', async ({ data }) => {
  // data: { id, plan, previousPlan, overrides, features, limits, ... }
  await avisarAlCliente(data.id, `Tu plan ahora es ${data.plan}`);
});
```

### Al bajar de plan

- **No se borra nada.** El módulo se oculta y la API lo rechaza; al volver a subir, todo reaparece.
- **Límites:** si tenía 8 usuarios y baja a un plan de 3, no se borra a nadie: solo no puede crear más
  (`assertLimit` rechaza mientras `total >= 3`).
- **Plan que ya no existe:** si quitas un plan de la configuración y algún tenant lo tenía, no se
  rompe nada: ese tenant queda sin módulos de plan (conserva sus módulos sueltos) y queda un aviso
  en el log una vez. El panel lo muestra en "Planes" como plan desconocido.

::: tip Antes de activar los planes en una app que ya está en producción
Asigna un plan a cada tenant actual (o define `defaultPlan`) **antes** de desplegar los
`requireFeature`, así nadie pierde módulos el día del cambio:
`npx tenancy tenant:plan imagendent clinica`.
:::

## Editar planes desde el panel (sin desplegar)

La configuración es la base; desde el panel (**Planes → Editar**) o el código se pueden cambiar
nombre, descripción, precio, módulos, límites, "más elegido" y visibilidad, y crear planes nuevos.
El **catálogo de módulos** (`features`) sigue en el código: un plan del panel solo usa módulos que
tu app ya hace cumplir con `requireFeature`.

```ts
await tenancy.plans.update('basico', {
  price: { currency: 'BOB', monthly: 180, yearly: 1800 },
  limits: { usuarios: 5 },
  highlight: true,
}, { by: 'ana@tuapp.com' });

await tenancy.plans.create('premium', { label: 'Premium', features: '*', price: { currency: 'BOB', monthly: 500 } });

await tenancy.plans.remove('basico'); // plan de código: vuelve a la configuración → 'reset'
await tenancy.plans.remove('premium'); // plan del panel: se archiva → 'archived' (409 si lo usan tenants)
```

- Los cambios se guardan en `tenancy_plan_settings` y se validan igual que la configuración
  (`TENANCY_INVALID_PLAN` 422).
- `features.has()`, `limit()` y `requireFeature` siguen siendo **síncronos**: el catálogo se carga
  al arrancar (la primera petición espera esa carga), y cada cambio se avisa a las demás instancias
  por el bus de invalidación (`redisInvalidation`) y se recarga cada 60 s por las dudas
  (`planSettings.refreshMs`).
- `GET /tenancy/plans` y `/tenancy/me` muestran los valores editados al instante.
- Cada cambio publica `plan.updated` (`{ planId, action: 'created' | 'updated' | 'reset' | 'archived', by }`).
- Panel: permiso `plans:write` (admin y owner). API: `POST /plans`, `PATCH /plans/:id`, `DELETE /plans/:id`.

## Marca de la plataforma

Nombre, logo, favicon, color y contacto de la plataforma (el dominio central), editables desde el
panel (**Plataforma**) para la web comercial, los correos y el panel:

```ts
createTenancy({
  http: { platform: true }, // GET /tenancy/platform y /tenancy/platform/assets/*
  platform: { defaults: { name: 'IONIX', primary: '#0F766E', contact: { whatsapp: '59170000000' } } },
});

await tenancy.platform.update({
  contact: { email: 'ventas@ionix.bo' },
  salesNotifyTo: ['jefe@ionix.bo'], // privado: no sale en la ruta pública
});
```

`GET /tenancy/platform` responde en cualquier host, con CORS abierto y ETag:

```json
{
  "name": "IONIX",
  "logoUrl": "/tenancy/platform/assets/logo-3f2a9c1b7d4e5f60.png",
  "faviconUrl": null,
  "primary": "#0F766E",
  "contact": { "whatsapp": "59170000000", "email": "ventas@ionix.bo" }
}
```

- El logo y el favicon se suben desde el panel (`PUT /admin/api/platform/logo`, PNG/JPEG/GIF/WebP; el
  favicon también ICO) al almacenamiento central (`platform/…`). Con disco local se sirven en
  `/tenancy/platform/assets/…`; con S3, `logoUrl` apunta al bucket.
- El WhatsApp se guarda solo con dígitos y código de país: arma el enlace con `https://wa.me/${whatsapp}`.
- El evento `lead.created` trae `notifyTo` (los `salesNotifyTo`) para el aviso por correo.
- `platform.updated` (`{ fields, by }`) se publica en cada cambio. Permiso del panel: `platform:write`.

## Sin planes

Sin `plans` en la configuración el control está apagado: `tenancy.features.has()` devuelve `true`
para todo, `requireFeature` deja pasar y no hay límites. Así puedes instalar 0.11 y activar los
planes cuando quieras. En ese modo, `features` y `limits` de `publicFields` se leen de
`tenant.data`, como antes.

## La web comercial

### Precios: `GET /tenancy/plans`

Con `http: { plans: true }` responde en **cualquier host** (también el dominio central), con CORS
abierto y ETag:

```json
{
  "defaultPlan": "basico",
  "features": [
    { "id": "agenda", "label": "Agenda de citas", "description": null },
    { "id": "reportes", "label": "Reportes", "description": "Reportes y PDF" }
  ],
  "plans": [
    {
      "id": "basico",
      "label": "Básico",
      "price": { "currency": "BOB", "monthly": 150, "yearly": 1500 },
      "features": ["agenda", "caja"],
      "limits": { "usuarios": 3 },
      "highlight": false,
      "public": true
    }
  ]
}
```

Con `features` (todo el catálogo) y `plans[].features` armas la tabla comparativa.

### "Solicitar demo": solicitudes en el panel

Activa la ruta pública en el panel (ver [Panel de administración](/guia/panel#dentro-de-tu-app)):

```ts
const admin = createAdminApi(tenancy, {
  sessionSecret: process.env.TENANCY_ADMIN_SECRET!,
  leads: {
    rateLimit: { max: 5, windowMs: 3_600_000 }, // por IP (por defecto)
    requireConsent: true, // casilla de consentimiento (por defecto)
    extraFields: ['origen'], // llaves extra aceptadas en `data`
  },
});
```

El formulario envía `POST /admin/api/leads` (desde el dominio central):

```ts
await fetch('/admin/api/leads', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Ana Pérez',
    company: 'Dental Sur',
    city: 'La Paz',
    phone: '+591 70000000',
    email: 'ana@example.com',
    plan: 'profesional',
    message: 'Quiero una demo',
    consent: true,
    website: '', // campo trampa: déjalo oculto y vacío
  }),
});
// 201 { ok: true } · 422 con los campos inválidos · 429 si superó el límite
```

- Pide email **o** teléfono, y el consentimiento (si `requireConsent`).
- `website` es un campo trampa: escóndelo con CSS. Si un bot lo llena, se responde 201 pero no se guarda.
- Un plan que no existe se guarda como "sin plan" (no rompe el formulario).

Para avisarte por correo, escucha el evento:

```ts
tenancy.events.on('lead.created', async ({ data }) => {
  await mailer.send({
    to: 'ventas@tuapp.com',
    subject: `Nueva solicitud: ${data.company ?? data.name}`,
    text: `${data.name} (${data.email ?? data.phone}) quiere el plan ${data.plan ?? '—'}`,
  });
}, { mode: 'queue' }); // en un worker, con reintentos
```

Si tu formulario lo atiende tu propio servidor (por ejemplo, con el panel en otro puerto), guarda la
solicitud con `admin.leads.create({...})`: también publica `lead.created`.

En el panel, **Solicitudes** lista los pedidos por estado (nueva, contactada, convertida, descartada).
"Crear tenant" abre el formulario de tenant nuevo con el plan elegido, y al crearlo la solicitud queda
como convertida y enlazada al tenant.

## Tipografías

```ts
theme: {
  defaults: { font: 'Inter' },
  fonts: [
    { family: 'Inter' }, // Google Fonts, grosores 400, 600 y 700
    { family: 'Poppins', weights: [400, 500, 700] },
    { family: 'Georgia', source: 'system', fallback: 'serif' }, // ya instalada
    { family: 'MiMarca', source: 'url', url: '/fonts/mimarca.css' }, // tu propio @font-face
  ],
},
```

Con lista, el tema de un tenant solo acepta esas fuentes (`TENANCY_INVALID_THEME` si no) y
`/tenancy/theme.css` ya trae su carga:

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
:root {
  --font-main: 'Inter', system-ui, sans-serif;
}
```

Tu app solo usa `font-family: var(--font-main)`. En el panel, la tipografía es una lista con la
vista previa de cada fuente.

## Autocompletado en TypeScript (opcional)

```ts
declare module '@tenancy-node/core' {
  interface TenancyFeatureMap {
    agenda: true;
    caja: true;
    reportes: true;
    finanzas: true;
  }
  interface TenancyLimitMap {
    usuarios: true;
  }
}

requireFeature(tenancy, 'reprotes'); // ❌ error de tipos: no existe
```

## Panel y CLI

| Dónde       | Qué hay                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| Panel       | **Planes** (editar precios, módulos y límites, crear y archivar planes), **Plataforma** (marca y contacto), **Solicitudes**, plan y módulos sueltos en cada tenant, tenants por plan en el dashboard |
| Admin API   | `GET /plans`, `GET /fonts`, `GET/PATCH/DELETE /leads`, `PATCH /tenants/:id { plan, features }`, `GET /tenants?plan=` |
| CLI         | `tenancy plans`, `tenancy tenant:plan <id> [plan] [--add] [--remove] [--limit] [--reset] [--no-plan]`, `tenancy list --plan=` |

## Referencia rápida

| API                                          | Qué hace                                                     |
| -------------------------------------------- | ------------------------------------------------------------ |
| `tenancy.features.has(f, tenant?)`           | ¿Incluye el módulo? (sin `tenant`, el del contexto)          |
| `tenancy.features.require(f \| f[], tenant?)` | Lanza `FeatureNotInPlanError` (403) si falta alguno          |
| `tenancy.features.list(tenant?)`             | Módulos efectivos, en el orden del catálogo                  |
| `tenancy.features.limit(name, tenant?)`      | Límite efectivo (`null` = sin límite)                        |
| `tenancy.features.remaining(name, n, t?)`    | Cuántos quedan                                               |
| `tenancy.features.assertLimit(name, n, t?)`  | Lanza `PlanLimitReachedError` (403) si `n` ya llegó          |
| `tenancy.features.of(tenant?)`               | `{ plan, planLabel, knownPlan, features, limits }`           |
| `tenancy.features.catalog()`                 | Catálogo de módulos                                          |
| `tenancy.features.enabled`                   | `false` sin `plans`                                          |
| `tenancy.plans.list({ publicOnly? })`        | Planes de la configuración                                   |
| `tenancy.plans.get(id)`                      | Un plan                                                      |
| `tenancy.plans.assign(ref, plan, overrides?)` | Cambia plan y módulos sueltos; publica `tenant.plan_changed` |
| `tenancy.theme.fonts()`                      | Fuentes permitidas con la URL de su CSS                      |
