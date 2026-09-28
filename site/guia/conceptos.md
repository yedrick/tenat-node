# Conceptos

Esta página explica las piezas del núcleo (`@tenancy-node/core`): qué es un tenant, cómo se abre su contexto, cómo se identifica en una petición y cómo se extiende el facade `tenancy`.

## Tenants

Un tenant es un cliente de tu aplicación con sus propios recursos aislados. Se crea con `tenancy.tenants.create()`:

```ts
import { createTenancy } from '@tenancy-node/core';

const tenancy = createTenancy({ centralDomains: ['tuapp.com'] });

const tenant = await tenancy.tenants.create({
  id: 'bolivar', // obligatorio, no se puede cambiar después
  name: 'Club Bolívar', // por defecto, el mismo id
  plan: 'pro',
  data: { locale: 'es-BO', features: ['reservas'] },
  domain: ['clubbolivar.com', 'bolivar.tuapp.com'], // el primero queda como principal
});

tenant.id.value; // 'bolivar'
tenant.status; // 'active' (sin base de datos, el aprovisionamiento no hace nada)

await tenancy.tenants.update('bolivar', { plan: 'enterprise', data: { locale: undefined } });
await tenancy.tenants.find('bolivar'); // Tenant | undefined
await tenancy.tenants.findOrFail('bolivar'); // o TenantNotFoundError
await tenancy.tenants.list({ status: 'active', search: 'bol', page: 1, perPage: 20 });
```

### Campos

| Campo                          | Tipo                     | Notas                                                                   |
| ------------------------------ | ------------------------ | ----------------------------------------------------------------------- |
| `id`                           | `TenantId`               | Inmutable. `tenant.id.value` es el texto                                |
| `name`                         | `string`                 | De 1 a 150 caracteres (se recortan los espacios)                        |
| `status`                       | `TenantStatus`           | Ver [Estados](#estados)                                                 |
| `plan`                         | `string \| null`         | De 1 a 50 caracteres, o `null`                                          |
| `data`                         | `Record<string, unknown>` | Tus datos. Debe ser un objeto serializable con `structuredClone`       |
| `theme`                        | `Theme \| null`          | Colores y logo. Ver [Tema](/guia/tema)                                  |
| `database`                     | `TenantDatabase \| null` | Servidor, base, schema y usuario. Lo asigna el aprovisionamiento        |
| `maintenanceMessage`           | `string \| null`         | Mensaje del modo mantenimiento                                          |
| `createdAt`, `updatedAt`       | `Date`                   |                                                                         |
| `provisionedAt`, `suspendedAt`, `deletedAt` | `Date \| null` |                                                                     |

`isActive` es `true` si el estado es `active` y no está eliminado. En `update`, `data` se combina con los datos actuales (merge superficial) y una llave con `undefined` se elimina.

### Estados

| Estado         | Significado                                   | Puede pasar a                             |
| -------------- | --------------------------------------------- | ----------------------------------------- |
| `provisioning` | Recién creado, creando sus recursos           | `active`, `failed`, `deleting`            |
| `active`       | Atiende peticiones                            | `maintenance`, `suspended`, `deleting`    |
| `maintenance`  | Temporalmente fuera de servicio, con mensaje  | `active`, `suspended`, `deleting`         |
| `suspended`    | Bloqueado (por ejemplo, falta de pago)        | `active`, `deleting`                      |
| `failed`       | Falló el aprovisionamiento                    | `provisioning` (con `retryProvisioning`), `deleting` |
| `deleting`     | Borrándose                                    | ninguno                                   |

Cualquier otra transición lanza `InvalidTenantStatusTransitionError` (409 en HTTP).

```ts
import { createTenancy } from '@tenancy-node/core';

const tenancy = createTenancy({ centralDomains: ['tuapp.com'] });
await tenancy.tenants.create({ id: 'bolivar' });

await tenancy.tenants.maintenance('bolivar', 'Volvemos a las 18:00'); // 503 en HTTP
await tenancy.tenants.activate('bolivar');
await tenancy.tenants.suspend('bolivar'); // 423 en HTTP
await tenancy.tenants.activate('bolivar');
await tenancy.tenants.delete('bolivar'); // borrado suave: deletedAt, libera base y dominios
```

`delete` es un borrado suave: pasa a `deleting`, libera los recursos físicos (la base, con `@tenancy-node/db`) y los dominios, y marca `deletedAt`. Después `find` ya no lo devuelve, pero el id queda ocupado: no puedes crear otro tenant con el mismo id.

### Reglas del id

El id termina en nombres de base de datos, subdominios y prefijos de caché, por eso se valida con una lista blanca: de 2 a 40 caracteres entre `a-z`, `0-9`, `_` y `-`, empezando con letra o dígito (`/^[a-z0-9][a-z0-9_-]{1,39}$/`).

```ts
import { TenantId } from '@tenancy-node/core';

TenantId.isValid('bolivar'); // true
TenantId.isValid('club-2024'); // true
TenantId.isValid('Bolivar'); // false: solo minúsculas
TenantId.isValid('b'); // false: mínimo 2 caracteres
TenantId.tryCreate('-bolivar'); // undefined: debe empezar con letra o dígito
```

Un id inválido en `create` lanza `InvalidTenantIdError` (422). En `find`, `run` o una petición, un id inválido se trata como inexistente.

::: tip
Un id con `_` es válido, pero no es un label de dominio válido: `mi_club.tuapp.com` nunca resuelve por subdominio. Si usas subdominios, quédate con letras, dígitos y `-`.
:::

## Contexto central y contexto de tenant

Todo el código corre en uno de dos contextos:

- **Tenant:** hay un tenant actual. `tenancy.db()`, `tenancy.cache()` y `tenancy.storage()` apuntan a sus recursos.
- **Central:** no hay tenant. Es el caso de los dominios centrales, el panel de administración y los scripts. La caché usa el prefijo central y los archivos van a `central/`.

El contexto vive en `AsyncLocalStorage`: lo hereda todo el código asíncrono que se ejecuta dentro, y al salir vuelve el anterior solo.

```ts
import { createTenancy } from '@tenancy-node/core';

const tenancy = createTenancy({ centralDomains: ['tuapp.com'] });
await tenancy.tenants.create({ id: 'bolivar' });
await tenancy.tenants.create({ id: 'tigre' });

tenancy.current(); // undefined: fuera de run() estás en el contexto central
tenancy.isCentral(); // true

await tenancy.run('bolivar', async () => {
  tenancy.currentId(); // 'bolivar'
  tenancy.currentOrFail(); // Tenant; fuera de un tenant lanza TenantNotIdentifiedError

  await tenancy.run('tigre', async () => {
    tenancy.currentId(); // 'tigre'
  });
  tenancy.currentId(); // 'bolivar' otra vez

  await tenancy.central(async () => {
    tenancy.isCentral(); // true, aunque estés dentro de bolivar
  });
});
```

| Método                   | Devuelve                                                            |
| ------------------------ | ------------------------------------------------------------------- |
| `current()`              | `Tenant \| undefined`                                               |
| `currentOrFail()`        | `Tenant`, o lanza `TenantNotIdentifiedError`                        |
| `currentId()`            | `string \| undefined`                                               |
| `isCentral()`            | `true` si no hay tenant                                             |
| `run(tenant, fn)`        | El resultado de `fn`. Acepta un id, un `TenantId` o un `Tenant`     |
| `central(fn)`            | El resultado de `fn`, en el contexto central                        |

`run` con un id que no existe lanza `TenantNotFoundError`. Ojo: `run` **no** revisa el estado. Puedes entrar a un tenant suspendido o en mantenimiento (útil para scripts de soporte); el bloqueo por estado solo se aplica al resolver peticiones HTTP.

Los recursos que pides fuera de cualquier `run` (por ejemplo, `tenancy.cache()` en un script) usan un contexto central raíz que se libera en `tenancy.close()`.

## Recorrer todos los tenants

`runForEach` recorre los tenants página por página (de 100 en 100) y ejecuta `fn` en el contexto de cada uno, con concurrencia limitada:

```ts
import { createTenancy } from '@tenancy-node/core';

const tenancy = createTenancy({ centralDomains: ['tuapp.com'] });

const result = await tenancy.runForEach(
  async (tenant) => {
    await tenancy.cache().delete('productos'); // corre en el contexto de cada tenant
  },
  { concurrency: 10, status: ['active', 'maintenance'] },
);

result.succeeded; // ['bolivar', 'tigre', ...]
result.failed; // [{ tenantId, error }]
```

| Opción        | Por defecto | Qué hace                                                            |
| ------------- | ----------- | ------------------------------------------------------------------- |
| `concurrency` | `5`         | Tenants en paralelo (entero mayor o igual a 1)                      |
| `status`      | `'active'`  | Estado o lista de estados a recorrer                                |
| `stopOnError` | `false`     | Con `true`, no toma más tenants tras el primer error y `runForEach` lo lanza |

Cada error queda registrado con su tenant (`operation: tenancy.runForEach.item`), aunque sigas adelante.

## Resolvers: cómo se identifica el tenant

En cada petición, el adaptador HTTP arma un `RequestLike` (`host`, `path` sin query string y `headers` en minúsculas) y el núcleo decide así:

1. Si el host (sin puerto, en minúsculas) es uno de los `centralDomains`, la petición es **central**. El resolver ni se llama.
2. Se prueba el resolver configurado. Si no encuentra un id, la petición es **no identificada**: 404, o central si el adaptador usa `onUnidentified: 'central'`.
3. Se carga el tenant. Si no existe, 404 (`TENANCY_TENANT_NOT_FOUND`). Si no está `active`: 503 en mantenimiento, 423 suspendido, 503 si está en `provisioning`, `failed` o `deleting`.

El resolver por defecto es `chain([byDomain(), bySubdomain()])`: primero el dominio completo y después el subdominio.

| Resolver                     | Nombre        | Qué hace                                                                                 |
| ---------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `byDomain()`                 | `'domain'`    | Busca el host completo en la tabla de dominios: `clubbolivar.com` → bolivar              |
| `bySubdomain({ baseDomains })` | `'subdomain'` | Primer label bajo un dominio base: `bolivar.tuapp.com` → bolivar. Por defecto, los `centralDomains`. Solo un nivel: `a.b.tuapp.com` no resuelve |
| `byPath({ segment })`        | `'path'`      | Segmento de la ruta, por defecto el 0: `/bolivar/productos` → bolivar                    |
| `byHeader(header)`           | `'header'`    | Lee un header, por defecto `x-tenant`                                                    |
| `chain(resolvers)`           | —             | Prueba varios en orden y se queda con el primero que encuentre un id                     |

```ts
import { byHeader, byPath, bySubdomain, byDomain, chain, createTenancy } from '@tenancy-node/core';

// Por nombre: 'domain', 'subdomain', 'path' o 'header'
createTenancy({ centralDomains: ['tuapp.com'], resolver: 'subdomain' });

// Con opciones
createTenancy({ resolver: bySubdomain({ baseDomains: ['tuapp.com', 'tuapp.bo'] }) });
createTenancy({ resolver: byPath({ segment: 1 }) }); // '/api/bolivar/pedidos' → bolivar
createTenancy({ resolver: byHeader('x-club') });

// Varios en orden: el primero que encuentre un tenant gana
createTenancy({ resolver: chain([byDomain(), bySubdomain(), byHeader()]) });
```

Algunos detalles que conviene saber:

- `byPath` no quita el segmento de la ruta: tus rutas siguen siendo `/:tenant/productos`.
- `byHeader` deja que el cliente elija el tenant. Úsalo solo si además autenticas que ese usuario pertenece a ese tenant.
- Un subdominio que no es de nadie (`www.tuapp.com`) intenta el tenant `www` y responde 404. Si `www` es tu app central, agrégalo a `centralDomains`.

### Un resolver propio

Implementa `TenantResolver`: un `name` y un `resolve(request, context)` que devuelve un `TenantId` o `undefined`. `context` trae el repositorio de dominios y los dominios centrales.

```ts
import { createTenancy, DomainName, TenantId, type TenantResolver } from '@tenancy-node/core';

const apiKeys = new Map([['llave-de-bolivar', 'bolivar']]); // en la práctica, tu tabla de llaves

// El tenant sale de la llave de API de la petición
const byApiKey: TenantResolver = {
  name: 'api-key',
  async resolve(request) {
    const key = request.headers['x-api-key'];
    return TenantId.tryCreate(typeof key === 'string' ? apiKeys.get(key) : undefined);
  },
};

// 'api.clubbolivar.com' → se busca 'clubbolivar.com' en la tabla de dominios
const byApiDomain: TenantResolver = {
  name: 'api-domain',
  async resolve(request, context) {
    const host = DomainName.tryCreate(request.host?.split(':')[0]);
    if (!host?.value.startsWith('api.')) return undefined;
    const name = DomainName.tryCreate(host.value.slice(4));
    return name ? (await context.domains.findByName(name))?.tenantId : undefined;
  },
};

createTenancy({ centralDomains: ['tuapp.com'], resolver: byApiKey });
createTenancy({ centralDomains: ['tuapp.com'], resolver: byApiDomain });
```

El resolver se llama en cada petición que no es central. Si consulta una base, cachea el resultado.

### `centralDomains`

Los dominios de tu app central (`tuapp.com`, `admin.tuapp.com`, `localhost`). Se normalizan a minúsculas y sin punto final; un dominio inválido hace fallar `createTenancy` con `InvalidConfigError`. Cumplen dos papeles: nunca resuelven a un tenant, y son los dominios base de `bySubdomain()` si no le pasas `baseDomains`. La comparación es exacta: `tuapp.com` no vuelve central a `www.tuapp.com`.

Como el paso 1 va antes del resolver, una petición a un dominio central es central aunque traiga `X-Tenant`.

## Bootstrappers

Un bootstrapper entrega un recurso aislado para el tenant del contexto: una conexión, un cliente, un prefijo. El núcleo trae dos (`cache` y `storage`) y `@tenancy-node/db` agrega `db`. Puedes registrar los tuyos:

```ts
import { createTenancy, type Bootstrapper, type Tenant } from '@tenancy-node/core';

interface ErpClient {
  baseUrl: string;
  close(): void;
}

// Un cliente del ERP de cada tenant, creado la primera vez que se pide en un contexto
const erp: Bootstrapper<ErpClient> = {
  name: 'erp',
  bootstrap(tenant: Tenant | null) {
    const baseUrl = String(tenant?.data.erpUrl ?? 'https://erp.tuapp.com');
    return { baseUrl, close: () => {} };
  },
  revert(client) {
    client.close(); // al cerrar el contexto
  },
};

const tenancy = createTenancy({ centralDomains: ['tuapp.com'], bootstrappers: [erp] });
await tenancy.tenants.create({ id: 'bolivar', data: { erpUrl: 'https://erp.clubbolivar.com' } });

await tenancy.run('bolivar', () => {
  tenancy.resource<ErpClient>('erp').baseUrl; // 'https://erp.clubbolivar.com'
});
```

El ciclo de vida:

| Método                 | Cuándo se llama                                                                   |
| ---------------------- | --------------------------------------------------------------------------------- |
| `prepare(tenant)`      | Opcional y asíncrono. Al abrir **cada** contexto, antes de entrar. Debe ser rápido |
| `bootstrap(tenant)`    | Síncrono. La primera vez que se pide `tenancy.resource(name)` en ese contexto; después se reusa |
| `revert(resource, tenant)` | Opcional. Al cerrar el contexto, en orden inverso. Si lanza, se registra y se sigue |

`tenant` es `null` en el contexto central. Los nombres no se pueden repetir: `cache`, `storage` y `db` ya están tomados.

### `tenancy.initialized` y `tenancy.ended`

Si quieres enterarte cada vez que se abre o se cierra el contexto de un tenant, escucha estos eventos. Solo se publican si hay algún listener, así que no cuestan nada si no los usas.

```ts
import { createTenancy } from '@tenancy-node/core';

const tenancy = createTenancy({ centralDomains: ['tuapp.com'] });

tenancy.events.on('tenancy.initialized', (event) => {
  tenancy.observability.logger.debug({ tenantId: event.tenantId }, 'contexto abierto');
});
tenancy.events.on('tenancy.ended', (event) => {
  tenancy.observability.logger.debug({ tenantId: event.tenantId }, 'contexto cerrado');
});
```

`tenancy.initialized` se publica dentro del contexto recién abierto; `tenancy.ended`, después de revertir los recursos. No se emiten en el contexto central. Hay uno por petición, por eso `tenancy.events.forward('*')` no los incluye. Más en [Eventos](/guia/eventos).

## Plugins

Un plugin extiende `tenancy` sin tocar el núcleo. Así está hecho `@tenancy-node/db`: aporta repositorios SQL, el aprovisionamiento, el bootstrapper `db` y los métodos `db()`, `centralDb()`, `sql` y `database`.

```ts
import { createTenancy, type TenancyPlugin } from '@tenancy-node/core';

interface Saludo {
  saludo(): string;
}

export function saludos(): TenancyPlugin<Saludo> {
  return {
    name: 'saludos',
    setup(ctx) {
      ctx.logger.info({}, 'plugin saludos listo');
      return {
        bootstrappers: [{ name: 'saludo', bootstrap: (t) => `Hola, ${t?.name ?? 'central'}` }],
        healthChecks: [{ name: 'saludos', check: async () => {} }],
        close: async () => {}, // en tenancy.close()
      };
    },
    extend: (tenancy) => ({
      saludo: () => tenancy.resource<string>('saludo'),
    }),
  };
}

const tenancy = createTenancy({ centralDomains: ['tuapp.com'], plugins: [saludos()] });
await tenancy.tenants.create({ id: 'bolivar', name: 'Club Bolívar' });
await tenancy.run('bolivar', () => tenancy.saludo()); // 'Hola, Club Bolívar'
```

`setup(ctx)` recibe `logger` (con `tenantId` automático), `observer`, `clock`, `ids`, `events`, `centralDomains` y `currentTenant()`. Devuelve lo que aporta:

| Campo            | Qué es                                                                               |
| ---------------- | ------------------------------------------------------------------------------------ |
| `tenants`, `domains`, `provisioning` | Repositorios y aprovisionamiento. Solo un plugin puede aportar cada uno; lo que pases directo en la configuración tiene prioridad |
| `bootstrappers`  | Se suman a los de la configuración                                                   |
| `transports`     | Transportes para `tenancy.events.forward`                                            |
| `eventSink`      | Destino durable de los eventos reenviados (outbox). Solo uno                         |
| `healthChecks`   | Chequeos para `tenancy.health()` y la ruta `/tenancy/health`                         |
| `close`          | Se llama en `tenancy.close()`                                                        |

`extend(tenancy)` devuelve los métodos que se agregan al objeto. Un plugin no puede redefinir un método que ya existe: `createTenancy` lanza `InvalidConfigError`. Para que TypeScript vea los métodos nuevos, pasa los plugins directo a `createTenancy` o usa `defineConfig`.

## Siguientes pasos

- [Frameworks](/guia/frameworks): cómo cada adaptador abre el contexto por petición.
- [Base de datos](/guia/base-de-datos): el plugin `database()` en detalle.
- [Referencia de la API de core](/referencia/api/@tenancy-node/core/).
