# Tema por tenant

Cada tenant puede tener colores, logo, fuente y variables propias. El núcleo valida el tema, lo convierte en variables CSS y lo sirve en `/tenancy/theme.css`. Tu frontend solo usa `var(--color-primary)`.

## Propiedades

| Propiedad    | Tipo                                  | Por defecto | Validación                                                                     |
| ------------ | ------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| `primary`    | color                                 | `#2563EB`   | Hex de 3, 4, 6 u 8 dígitos. Se guarda en mayúsculas                            |
| `secondary`  | color                                 | `#64748B`   | Igual que `primary`                                                            |
| `accent`     | color                                 | —           | Igual que `primary`                                                            |
| `background` | color                                 | —           | Igual que `primary`                                                            |
| `text`       | color                                 | —           | Igual que `primary`                                                            |
| `logo`       | ruta o URL                            | —           | Hasta 500 caracteres, sin espacios, comillas, paréntesis, `<`, `>` ni `\`      |
| `favicon`    | ruta o URL                            | —           | Igual que `logo`                                                               |
| `font`       | nombre de familia                     | —           | Letras, dígitos, espacios, `_` y `-`; hasta 64 caracteres                      |
| `radius`     | `'none' \| 'sm' \| 'md' \| 'lg'`      | —           |                                                                                |
| `mode`       | `'light' \| 'dark' \| 'auto'`         | —           |                                                                                |
| `custom`     | `Record<string, string>`              | —           | Hasta 50 variables. Nombres `a-z`, `0-9` y `-`; valores sin `;`, `{}`, `<>`, comillas, `\`, saltos de línea, `/*`, `url(` ni `expression(` |

Un valor inválido lanza `InvalidColorError` (`TENANCY_INVALID_COLOR`) o `InvalidThemeError` (`TENANCY_INVALID_THEME`), las dos con HTTP 422. La validación existe para que un tema no pueda inyectar CSS en `theme.css`.

Los valores por defecto del proyecto se cambian con `theme.defaults`, y un tenant puede empezar con tema propio al crearlo:

```ts
import { createTenancy } from '@tenancy-node/core';

const tenancy = createTenancy({
  centralDomains: ['tuapp.com'],
  theme: { defaults: { primary: '#0F766E', font: 'Inter' } }, // se mezcla con DEFAULT_THEME
});

await tenancy.tenants.create({
  id: 'bolivar',
  domain: 'bolivar.tuapp.com',
  theme: { primary: '#00AEEF', logo: 'logos/logo.png', radius: 'md' },
});
```

Un tenant sin tema propio usa siempre los valores por defecto actuales. Un tenant con tema propio guarda el tema completo (sus cambios mezclados con los valores por defecto de ese momento): si después cambias `theme.defaults`, su tema no cambia.

## Leer el tema: `tenancy.theme()`

```ts
await tenancy.run('bolivar', async () => {
  const theme = tenancy.theme();
  theme.toCss(); // ':root {\n  --color-primary: #2563EB;\n  ... }\n'
  theme.toJson(); // { primary: '#2563EB', secondary: '#64748B' }
  theme.etag(); // '"<sha1 base64url del CSS>"'
  await theme.logoUrl(); // URL del logo, o undefined si el tema no tiene
  theme.theme.primary.value; // la entidad Theme, ya validada
});

tenancy.theme.defaults; // el tema por defecto (también en el contexto central)
```

En el contexto central, `tenancy.theme()` devuelve el tema por defecto. El CSS se genera una vez por versión del tema (la clave incluye el `updatedAt` del tenant) y se guarda en un LRU de 5000 entradas.

`logoUrl()` pasa `logo` por `tenancy.storage().url()`: una ruta como `logos/logo.png` se convierte en la URL del archivo del tenant (`/tenancy/assets/logos/logo.png` con el driver local, la URL pública o firmada con S3), y una URL absoluta se devuelve igual. `favicon` no se transforma: úsalo tal cual está guardado. Ver [Archivos](/guia/cache-archivos-colas#archivos).

### Variables CSS

| Propiedad    | Variable                                         |
| ------------ | ------------------------------------------------ |
| `primary`    | `--color-primary`                                |
| `secondary`  | `--color-secondary`                              |
| `accent`     | `--color-accent`                                 |
| `background` | `--color-background`                             |
| `text`       | `--color-text`                                   |
| `font`       | `--font-main: 'Inter', system-ui, sans-serif`    |
| `radius`     | `--radius`: `0`, `0.25rem`, `0.5rem` o `1rem`    |
| `custom`     | `--<nombre>` por cada variable                   |
| `mode`       | `color-scheme: light`, `dark` o `light dark` (`auto`) |

Las propiedades que no están definidas no aparecen en el CSS. `logo` y `favicon` no generan variables. `font` solo nombra la familia: cargar el archivo de la fuente es trabajo de tu frontend.

## Cambiar el tema

```ts
// Cambio parcial: lo que no mandas se conserva; null quita un campo opcional
await tenancy.theme.update('bolivar', {
  primary: '#E4002B',
  mode: 'dark',
  logo: null,
  custom: { 'header-height': '64px' }, // --header-height: 64px;
});

// Vuelve al tema por defecto (el tenant queda sin tema propio)
await tenancy.theme.reset('bolivar');

tenancy.events.on('theme.updated', (event) => {
  event.data.theme; // ThemeProps | null
});
```

- `update` y `reset` devuelven el `Theme` resultante.
- `primary` y `secondary` no aceptan `null`: siempre hay un valor.
- `custom` se reemplaza entero, no se mezcla variable por variable.
- Si el resultado es igual al tema actual, no se guarda nada ni se publica `theme.updated`.
- Cada cambio queda en el log como `theme.update` o `theme.reset`. El panel de administración usa estas mismas funciones ([Panel](/guia/panel)).

## Rutas HTTP

Las rutas están apagadas por defecto. Se activan con `http`, y los adaptadores (Fastify, Express, `node:http`) las responden antes de llegar a tu código:

```ts
import { createServer } from 'node:http';
import { createTenancy } from '@tenancy-node/core';
import { withTenancy } from '@tenancy-node/adapter-node';

const tenancy = createTenancy({
  centralDomains: ['tuapp.com'],
  http: { me: true, theme: true, assets: true, cacheControl: 'public, max-age=60' },
  publicFields: ['name', 'plan', 'locale'], // locale se lee de tenant.data
});

// El adaptador responde /tenancy/* antes de llamar a tu handler
createServer(
  withTenancy(tenancy, (req, res) => {
    res.end(`Hola ${req.tenant?.name ?? 'central'}`);
  }),
).listen(3000);
```

| Opción de `http` | Por defecto            | Qué hace                                                                 |
| ---------------- | ---------------------- | ------------------------------------------------------------------------ |
| `theme`          | `false`                | `GET /tenancy/theme.css`                                                 |
| `me`             | `false`                | `GET /tenancy/me`                                                        |
| `assets`         | `false`                | `GET /tenancy/assets/*`: archivos del tenant (solo drivers `local` y `memory`) |
| `health`         | `false`                | `GET /tenancy/health`: responde en cualquier host ([Producción](/guia/produccion)) |
| `prefix`         | `/tenancy`             | Prefijo de las rutas                                                     |
| `cacheControl`   | `public, max-age=300`  | `Cache-Control` de `theme.css`, `me` y `assets`                          |

Todas responden `GET` y `HEAD`. Las rutas de tenant (`theme.css`, `me`, `assets`) responden 404 con `TENANCY_TENANT_NOT_IDENTIFIED` en el contexto central: nunca muestran datos de un tenant por error.

### `/tenancy/theme.css`

Devuelve `toCss()` con `content-type: text/css`, un `ETag` fuerte, el `Cache-Control` configurado y `Vary: Host`. Si el navegador manda `If-None-Match` con el mismo ETag (o `*`), responde `304` sin cuerpo.

Ten en cuenta el `Cache-Control`: con el valor por defecto, un navegador puede usar el CSS anterior hasta 5 minutos después de un cambio antes de volver a preguntar. Con varias réplicas, cada una ve el cambio cuando su caché de búsqueda de tenants se entera (al instante con `invalidation`, o al vencer el TTL).

### `/tenancy/me` y `publicFields`

Devuelve un JSON con el `id`, el `theme` (con `logo` ya convertido en URL) y solo los campos de `publicFields`. Por defecto `publicFields` es `['name']`.

- `name`, `plan` y `status` se leen del tenant.
- Cualquier otro nombre se lee de `tenant.data`. Los que no existen se omiten.
- `id` y `theme` siempre están; ponerlos en la lista no cambia nada.

Con la configuración de arriba y un tenant creado con `name: 'Club Bolívar'`, `plan: 'pro'`, `data: { locale: 'es-BO', apiKey: '...' }` y `theme: { primary: '#00AEEF', logo: 'logos/logo.png', radius: 'md' }`:

```json
{
  "id": "bolivar",
  "theme": { "primary": "#00AEEF", "secondary": "#64748B", "logo": "/tenancy/assets/logos/logo.png", "radius": "md" },
  "name": "Club Bolívar",
  "plan": "pro",
  "locale": "es-BO"
}
```

`apiKey` no aparece porque no está en `publicFields`. Esta respuesta también lleva `ETag` y acepta `If-None-Match`.

## Usarlo desde el frontend

Carga el CSS del tenant y usa sus variables con un valor de respaldo:

```html
<link rel="stylesheet" href="/tenancy/theme.css" />
<style>
  body {
    background: var(--color-background, #ffffff);
    color: var(--color-text, #0f172a);
    font-family: var(--font-main, system-ui, sans-serif);
  }
  .boton {
    background: var(--color-primary);
    border-radius: var(--radius, 0.5rem);
  }
</style>
<img id="logo" alt="" />
<script type="module">
  const me = await fetch('/tenancy/me').then((r) => r.json());
  document.title = me.name;
  if (me.theme.logo) document.getElementById('logo').src = me.theme.logo;
</script>
```

Las rutas son relativas: el tenant sale del host de la petición. Si el frontend está en otro dominio que la API, `theme.css` y `me` identificarían al tenant de ese otro host; en ese caso sírvelas desde el mismo dominio del tenant (o pon un proxy delante).

Referencia: [`@tenancy-node/core`](/referencia/api/@tenancy-node/core/).
