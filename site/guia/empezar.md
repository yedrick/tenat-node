# Primeros pasos

En esta guía montas una app Fastify con una base de datos por tenant, creas tu primer tenant y lo pruebas por subdominio. Al final hay una variante sin base de datos, todo en memoria, para probar en dos minutos.

## Requisitos

- **Node.js 20 o superior** (todos los paquetes declaran `"engines": { "node": ">=20" }`).
- Un framework: Fastify 5, Express 4/5 o `node:http` sin framework.
- Para la base de datos: MySQL/MariaDB o PostgreSQL. También hay drivers para SQLite y SQL Server (ver [Base de datos](/guia/base-de-datos)).
- Un usuario de base con permiso de `CREATE DATABASE`: cada tenant nuevo crea su propia base.

::: tip Sin Docker a mano
Si solo quieres ver cómo funciona, salta a [Sin base de datos](#sin-base-de-datos).
:::

## Instalación

```bash
npm install @tenancy-node/core @tenancy-node/db @tenancy-node/db-mysql @tenancy-node/adapter-fastify
npm install -D @tenancy-node/cli
```

Cambia `db-mysql` por `db-postgres` si usas PostgreSQL, y `adapter-fastify` por `adapter-express` o `adapter-node` según tu framework. Los drivers ya traen `mysql2` o `pg`; no los instales aparte.

## Con el CLI

Desde la raíz de tu proyecto:

```bash
npx tenancy init          # detecta framework, ORM, lenguaje y motor; genera los archivos
cp .env.example .env      # ajusta DATABASE_URL
npx tenancy install       # crea las tablas tenancy_* en la base central
npx tenancy create bolivar --domain=bolivar.localhost
```

`init` detecta el motor por las dependencias de tu `package.json` (`mysql2`/`mariadb` → MySQL, `pg` → PostgreSQL, `tedious`/`mssql` → SQL Server, `better-sqlite3` → SQLite; si no encuentra ninguno, usa MySQL) y genera:

| Archivo                               | Contenido                                                               |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `tenancy.config.ts` (o `.js`/`.cjs`)  | La configuración que usan tu app y el CLI                               |
| `src/tenancy.ts`                      | La instancia `tenancy` y un comentario con cómo conectarla a tu framework |
| `migrations/tenant/001_productos.sql` | Migración de ejemplo para la base de cada tenant                        |
| `migrations/central/`                 | Carpeta para tus migraciones de la base central                         |
| `.env.example`                        | `DATABASE_URL` y `TENANCY_KEY` (con una llave nueva)                    |

Si un archivo ya existe, `init` no lo toca; usa `--force` para sobrescribirlo. `--driver=mysql|postgres|sqlite|mssql` elige el motor a mano. Con SQLite la configuración usa `sqlite()` de `@tenancy-node/db-sqlite` y la URL central `sqlite://local/central` (las bases quedan en `./data`); con SQL Server, `mssql()` de `@tenancy-node/db-mssql`.

Si detecta un ORM (Prisma, TypeORM, Drizzle, Knex, Sequelize o MikroORM), agrega su paquete de integración (`@tenancy-node/orm-prisma`, `@tenancy-node/orm-drizzle`...) al comando de instalación que muestra. Ver [ORMs](/guia/orm).

Referencia completa en [CLI](/guia/cli).

## La configuración

Esto es lo que genera `init` para un proyecto TypeScript con MySQL:

```ts
// tenancy.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { mysql } from '@tenancy-node/db-mysql';

export default defineConfig({
  // Dominios de la app central: nunca resuelven a un tenant.
  centralDomains: ['localhost'],
  plugins: [
    database({
      driver: mysql(),
      central: { url: process.env.DATABASE_URL ?? 'mysql://root:secret@127.0.0.1:3306/app' },
      encryptionKey: process.env.TENANCY_KEY,
      credentials: 'shared',
      migrations: {
        tenant: fileURLToPath(new URL('./migrations/tenant', import.meta.url)),
        central: fileURLToPath(new URL('./migrations/central', import.meta.url)),
      },
    }),
  ],
});
```

```ts
// src/tenancy.ts
import { createTenancy } from '@tenancy-node/core';
import config from '../tenancy.config.js';

export const tenancy = createTenancy(config);
```

`defineConfig` no hace nada en tiempo de ejecución: conserva el tipo de los plugins para que `createTenancy(config)` sepa que existen `tenancy.db()`, `tenancy.sql` y `tenancy.database`. `credentials: 'shared'` usa el mismo usuario de base para todos los tenants; con `'per-tenant'` cada uno tiene el suyo y `encryptionKey` pasa a ser obligatoria.

## Una app mínima con Fastify

```ts
// src/server.ts
import Fastify from 'fastify';
import { tenancyPlugin } from '@tenancy-node/adapter-fastify';
import { tenancy } from './tenancy.js';

const app = Fastify();
await app.register(tenancyPlugin, { tenancy });

// Corre en el contexto del tenant de la petición: consulta su propia base.
app.get('/productos', async () =>
  tenancy.db().selectFrom('productos').selectAll().orderBy('id').execute(),
);

app.post<{ Body: { nombre: string; precio: number } }>('/productos', async (req) => {
  await tenancy.db().insertInto('productos').values(req.body).execute();
  return tenancy.sql`SELECT COUNT(*) AS total FROM productos`;
});

// En el dominio central (localhost) no hay tenant: usa la base central.
app.get('/estado', async () => ({
  central: tenancy.isCentral(),
  tenants: (await tenancy.tenants.list()).items.map((t) => ({ id: t.id.value, status: t.status })),
}));

await app.listen({ port: 3000, host: '127.0.0.1' });
```

`tenancy.db()` devuelve un `Kysely` conectado a la base del tenant actual. `tenancy.sql` es SQL parametrizado: los valores nunca se concatenan. En el contexto central `tenancy.db()` lanza `TenantNotIdentifiedError`; ahí usa `tenancy.centralDb()`.

Para Express o `node:http`, ver [Frameworks](/guia/frameworks).

## Tu primer tenant

Con el CLI:

```bash
npx tenancy create bolivar --name="Club Bolívar" --domain=bolivar.localhost
```

O desde tu código, que es lo mismo que hace el CLI:

```ts
import { tenancy } from './tenancy.js';

await tenancy.database.install(); // tablas tenancy_* (idempotente)

const tenant = await tenancy.tenants.create({
  id: 'bolivar',
  name: 'Club Bolívar',
  domain: 'bolivar.localhost',
});
console.log(tenant.status, tenant.database?.name); // 'active' 'tenant_bolivar'

await tenancy.close();
```

`create` registra el tenant en estado `provisioning`, guarda sus dominios y corre el aprovisionamiento: crea la base `tenant_bolivar`, el usuario (con `per-tenant`), las migraciones de `migrations/tenant` y el seed. Si todo sale bien, el tenant pasa a `active`.

Si un paso falla, el tenant queda en `failed` y `create` lanza `TenantProvisioningError`. Corrige la causa y vuelve a intentar:

```ts
import { tenancy } from './tenancy.js';

await tenancy.tenants.retryProvisioning('bolivar');
```

::: warning El id es para siempre
El id no se puede cambiar y tampoco se puede reusar: un tenant eliminado sigue ocupando su id. Usa de 2 a 40 caracteres entre `a-z`, `0-9`, `_` y `-`, empezando con letra o dígito. Si vas a resolver por subdominio, evita `_`: no es válido en un nombre de dominio.
:::

## Probarlo por subdominio o dominio

```bash
npx tsx src/server.ts

curl -H 'Host: bolivar.localhost' http://127.0.0.1:3000/productos   # base tenant_bolivar
curl -H 'Host: localhost'         http://127.0.0.1:3000/estado      # contexto central
curl -H 'Host: nadie.com'         http://127.0.0.1:3000/productos   # 404 TENANCY_TENANT_NOT_IDENTIFIED
```

Por defecto el tenant se busca primero por **dominio** (el host completo en la tabla de dominios) y después por **subdominio** de un dominio central. Con `centralDomains: ['localhost']`:

- `bolivar.localhost` resuelve a `bolivar` por dominio (lo registraste con `--domain`) y, aunque no lo hubieras registrado, también por subdominio.
- `localhost` es central: la petición se atiende sin tenant.
- Un host que no es central ni de ningún tenant responde 404.
- El puerto del header `Host` se ignora: `bolivar.localhost:3000` funciona igual.

Para un dominio propio, agrégalo al tenant (`tenancy.domains.add('bolivar', 'clubbolivar.com')`) y apunta su DNS a tu servidor. Chrome y Firefox resuelven `*.localhost` a `127.0.0.1`, así que en desarrollo también puedes abrir `http://bolivar.localhost:3000/productos` en el navegador.

## Sin base de datos

Sin plugins, `createTenancy()` guarda tenants, dominios, caché y cola en memoria. Sirve para probar, para tests y para prototipos. Todo se pierde al reiniciar.

```ts
import Fastify from 'fastify';
import { createTenancy } from '@tenancy-node/core';
import { tenancyPlugin } from '@tenancy-node/adapter-fastify';

// Sin plugins: tenants, dominios y caché viven en memoria (se pierden al reiniciar).
const tenancy = createTenancy({ centralDomains: ['localhost'] });

await tenancy.tenants.create({ id: 'bolivar', name: 'Club Bolívar' });
await tenancy.tenants.create({ id: 'tigre', name: 'The Strongest', domain: 'tigre.test' });

const app = Fastify();
await app.register(tenancyPlugin, { tenancy });

app.get('/whoami', async (req) => ({
  tenant: tenancy.currentId() ?? null,
  name: req.tenant?.name ?? 'central',
}));

app.get('/visitas', async () => {
  // Caché aislada por tenant: cada uno tiene su propio contador.
  const visitas = ((await tenancy.cache().get<number>('visitas')) ?? 0) + 1;
  await tenancy.cache().set('visitas', visitas, 3600);
  return { tenant: tenancy.currentId(), visitas };
});

await app.listen({ port: 3000, host: '127.0.0.1' });
```

```bash
npm install @tenancy-node/core @tenancy-node/adapter-fastify fastify

curl -H 'Host: bolivar.localhost' http://127.0.0.1:3000/whoami   # por subdominio
curl -H 'Host: tigre.test'        http://127.0.0.1:3000/whoami   # por dominio
curl -H 'Host: localhost'         http://127.0.0.1:3000/whoami   # central
```

Sin base de datos el aprovisionamiento no hace nada y el tenant queda `active` al instante. Los archivos (`tenancy.storage()`) sí van a disco, en `./storage/<id>/`.

Si clonaste el repositorio, este ejemplo existe completo en `examples/fastify-memory`: `pnpm --filter example-fastify-memory start`.

## Siguientes pasos

- [Conceptos](/guia/conceptos): estados del tenant, `tenancy.run`, resolvers y plugins.
- [Base de datos](/guia/base-de-datos): migraciones, servidores, credenciales por tenant y modo schema.
- [Frameworks](/guia/frameworks): Express, `node:http`, errores HTTP y rutas opcionales.
- [Tests](/guia/testing): `createTestTenancy()` para probar tu código sin infraestructura.
