# Base de datos

`@tenancy-node/db` es un plugin: guarda los tenants y dominios en tablas `tenancy_*` de una base central, crea la base de cada tenant, corre sus migraciones y te da una conexión aislada dentro de cada contexto. El motor lo pone un driver aparte.

```bash
npm install @tenancy-node/db @tenancy-node/db-mysql kysely
# o @tenancy-node/db-postgres, @tenancy-node/db-sqlite, @tenancy-node/db-mssql
```

```ts
import { createTenancy } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { mysql } from '@tenancy-node/db-mysql';

export const tenancy = createTenancy({
  centralDomains: ['tuapp.com'],
  plugins: [
    database({
      driver: mysql(),
      central: { url: process.env.DATABASE_URL! },
      encryptionKey: process.env.TENANCY_KEY,
      credentials: 'per-tenant',
      migrations: { tenant: './migrations/tenant' },
      seed: async (db, tenant) => {
        await db.insertInto('ajustes').values({ nombre: tenant.name }).execute();
      },
    }),
  ],
});

await tenancy.database.install(); // tablas tenancy_* (idempotente)
await tenancy.tenants.create({ id: 'bolivar', domain: 'bolivar.tuapp.com' }); // crea tenant_bolivar
```

`install()` crea o actualiza las tablas del paquete y registra el servidor por defecto. Corre con un candado, así varias instancias pueden llamarlo a la vez. Desde la terminal: `npx tenancy install`.

## Opciones

| Opción              | Por defecto                                     | Qué hace                                                                                                 |
| ------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `driver`            | (obligatoria)                                   | `mysql()`, `postgres()`, `sqlite()` o `mssql()`                                                          |
| `central`           | (obligatoria)                                   | `{ url }` u opciones sueltas (`host`, `port`, `user`, `password`, `database`). Admite `pool: { max }` (10) |
| `tablePrefix`       | `'tenancy_'`                                    | Prefijo de las tablas del paquete. Solo `a-z`, `0-9` y `_`                                               |
| `encryptionKey`     | sin llave                                       | Llave AES-256-GCM (`TENANCY_KEY`). Obligatoria con `credentials: 'per-tenant'`                           |
| `previousKeys`      | `[]`                                            | Llaves anteriores, para leer lo cifrado antes de una rotación                                            |
| `prefix` / `suffix` | `'tenant_'` / `''`                              | Nombre de la base: `prefix` + id + `suffix` (los guiones pasan a `_`)                                    |
| `isolation`         | `'database'`                                    | `'schema'`: un schema por tenant en una base compartida (solo PostgreSQL)                                |
| `schemaDatabase`    | la base de `central`                            | Modo schema: base física donde se crean los schemas                                                      |
| `credentials`       | `'shared'`                                      | `'per-tenant'`: usuario y contraseña propios por tenant                                                  |
| `tenantCredentials` | el administrador                                | Usuario compartido de los tenants en modo `shared`                                                       |
| `admin`             | el usuario de `central`                         | Usuario con permiso de `CREATE DATABASE`                                                                 |
| `placement`         | `'least-tenants'`                               | Dónde se crea cada tenant nuevo (ver [Varios servidores](#varios-servidores))                            |
| `pool`              | `{ max: 5, maxOpenPools: 100, idleTimeoutMs: 60_000 }` | Pool de cada tenant, pools abiertos por servidor y cierre por inactividad (`0` = nunca)           |
| `cleanupOnFailure`  | `false`                                         | Borrar la base recién creada si falla el aprovisionamiento                                               |
| `migrations`        | ninguna                                         | `{ tenant, central }`: carpeta, objeto de migraciones o un `TenancyMigrator`                             |
| `seed`              | ninguno                                         | `(db, tenant) => Promise<void>`: datos iniciales de cada tenant                                          |
| `pipeline`          | `['createDatabase', 'createUser', 'migrate', 'seed']` | Pasos del aprovisionamiento, con pasos propios                                                     |
| `lockTimeoutMs`     | `10_000`                                        | Espera máxima del candado por tenant                                                                     |
| `defaultServerId`   | `'default'`                                     | Id del servidor de la base central                                                                       |
| `ssl`               | ninguno                                         | Opciones SSL que se pasan al driver nativo                                                               |

La configuración se valida al arrancar: el modo schema con un driver sin schemas, `per-tenant` sin llave o `per-tenant` en SQLite lanzan `TENANCY_INVALID_DATABASE_CONFIG` al llamar a `database()`, no a mitad de un aprovisionamiento.

## Drivers

```ts
// MySQL 8+ o MariaDB 10.6+
database({
  driver: mysql({ variant: 'mariadb', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' }),
  central: { url: 'mysql://root:secret@localhost:3306/app' },
});

// PostgreSQL: el administrador se conecta a `postgres` para crear bases
database({
  driver: postgres({ adminDatabase: 'postgres' }),
  central: { url: 'postgres://admin:secret@localhost:5432/app' },
});

// SQLite: un archivo por tenant en ./data
database({
  driver: sqlite({ directory: './data', busyTimeoutMs: 5000 }),
  central: { url: 'sqlite://local/central' },
});

// SQL Server 2019+
database({
  driver: mssql({ encrypt: true, trustServerCertificate: false }),
  central: { url: 'mssql://sa:secret@localhost:1433/app' },
});
```

| Driver                           | Paquete nativo               | Opciones                                                                           |
| -------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| `mysql()` (`@tenancy-node/db-mysql`)       | `mysql2`           | `variant` (`'mysql'` o `'mariadb'`), `charset` (`utf8mb4`), `collation` (`utf8mb4_unicode_ci`) |
| `postgres()` (`@tenancy-node/db-postgres`) | `pg`               | `adminDatabase` (`'postgres'`)                                                     |
| `sqlite()` (`@tenancy-node/db-sqlite`)     | `better-sqlite3`   | `directory` (`./data`), `busyTimeoutMs` (5000)                                     |
| `mssql()` (`@tenancy-node/db-mssql`)       | `tedious` + `tarn` | `encrypt` (`true`), `trustServerCertificate` (`false`)                             |

SQLite guarda cada base en `<directory>/<nombre>.sqlite`, con WAL, `busy_timeout` y `foreign_keys = ON`. Es para desarrollo, tests y apps de un solo proceso. Detalles en el [ADR 0012](/adr/0012-mas-motores).

## Qué soporta cada motor

|                                         | MySQL / MariaDB     | PostgreSQL              | SQLite                        | SQL Server                  |
| --------------------------------------- | ------------------- | ----------------------- | ----------------------------- | --------------------------- |
| Una base por tenant                     | sí                  | sí                      | sí (un archivo)               | sí                          |
| `isolation: 'schema'`                   | no                  | sí                      | no                            | no                          |
| `credentials: 'per-tenant'`             | sí (usuario de 32 caracteres como máximo) | sí (rol)  | no (error al arrancar)        | sí (login + `db_owner`)     |
| Candado por tenant                      | `GET_LOCK`, entre procesos | `pg_try_advisory_lock`, entre procesos | solo dentro del proceso | `sp_getapplock`, entre procesos |
| `tenancy schema` (modelos de `tenancy_*`) | sí                | sí                      | no                            | no                          |
| `tenancy move`                          | sí                  | sí                      | no                            | no                          |
| `tenancy.pool()` devuelve               | `Pool` de mysql2    | `Pool` de pg            | `Database` de better-sqlite3  | el `MssqlDialect` de Kysely |

Los ORMs tienen su propia tabla en [ORMs](/guia/orm).

## Aislamiento: base o schema

Con `isolation: 'database'` (por defecto) cada tenant tiene su base: `tenant_bolivar`. Con `isolation: 'schema'`, solo en PostgreSQL, todos viven en una base física (`schemaDatabase`) y cada uno tiene su schema. Sirve para hostings que no permiten `CREATE DATABASE`.

```ts
database({
  driver: postgres(),
  central: { url: process.env.DATABASE_URL! },
  isolation: 'schema',
  schemaDatabase: 'app', // por defecto, la base de la URL central
  credentials: 'per-tenant', // un rol dueño solo de su schema
  encryptionKey: process.env.TENANCY_KEY,
});
```

- Con credenciales compartidas hay un pool por servidor y, por tenant, una instancia de Kysely que fija el `search_path` solo a su schema (sin `public`). Una tabla que no existe en el schema del tenant falla; nunca lee la de otro.
- Con `per-tenant`, cada tenant tiene un rol dueño solo de su schema. Aunque tu código se equivoque, PostgreSQL le impide leer otro schema o las tablas centrales.

::: warning
En modo schema con credenciales compartidas, el pool nativo (`tenancy.pool()`, `connection().native`) es el compartido y **no** tiene el `search_path` del tenant. Consulta con `tenancy.db()`, `tenancy.sql` o califica las tablas con `connection().schema`.
:::

## Credenciales y llave de cifrado

- `shared` (por defecto): todos los tenants usan `tenantCredentials` o, si no lo das, el usuario administrador.
- `per-tenant`: el aprovisionamiento crea un usuario por tenant con acceso solo a su base, y guarda su contraseña cifrada en `tenancy_tenants`. Si el nombre no cabe en el límite del motor, se recorta y se agrega un hash.

Los secretos (contraseñas de tenants y de servidores, secretos de webhooks y de 2FA del panel) se cifran con AES-256-GCM. Cada valor guarda el id de su llave (`tn1.<kid>.<iv>.<tag>.<datos>`), así una llave nueva convive con las anteriores. La llave es `base64:...` (32 bytes) o 64 caracteres hexadecimales.

```ts
console.log(generateEncryptionKey()); // base64:...  (o: npx tenancy key:generate)

const tenancy = createTenancy({
  plugins: [
    database({
      driver: postgres(),
      central: { url: process.env.DATABASE_URL! },
      credentials: 'per-tenant',
      encryptionKey: process.env.TENANCY_KEY, // la llave nueva
      previousKeys: [process.env.TENANCY_KEY_OLD!], // para leer lo cifrado con la anterior
    }),
  ],
});

const { updated } = await tenancy.database.rotateKey(); // o: npx tenancy key:rotate
console.log(`${updated} secretos cifrados de nuevo`);
```

Para rotar: pon la llave nueva en `encryptionKey`, la anterior en `previousKeys`, corre `rotateKey()` y, cuando todos los procesos usen la nueva, quita la anterior. Sin la llave con que se cifró un valor, leerlo lanza `TENANCY_DECRYPTION_FAILED`.

## Varios servidores

El servidor de la base central queda registrado como `default` al correr `install()`. Puedes agregar más:

```ts
await tenancy.database.servers.add({
  id: 'mysql-2',
  host: '10.0.0.5',
  port: 3306,
  adminUsername: 'provisioner',
  adminPassword: process.env.MYSQL2_PASSWORD!,
  maxTenants: 500,
  weight: 2,
});

for (const server of await tenancy.database.servers.list()) {
  console.log(server.id, server.tenantCount, server.maxTenants, server.isActive);
}
```

`servers.add` inserta o actualiza. `port` toma el de la base central si no lo das, `maxTenants` es `null` (sin límite), `weight` es 1 e `isActive` es `true`. La contraseña se guarda cifrada, así que necesitas `encryptionKey` aunque uses credenciales compartidas. Sin `adminUsername` se usa el administrador de la configuración. Desde la terminal: `tenancy servers:add` y `tenancy servers:list`.

### Estrategias de ubicación

Al crear un tenant se consideran los servidores activos, del mismo motor (MySQL y MariaDB se mezclan) y con lugar libre. El cupo se reserva de forma atómica respetando `maxTenants`.

| `placement`          | Elige                                                      |
| -------------------- | ---------------------------------------------------------- |
| `'least-tenants'`    | El servidor con menos tenants                              |
| `'weighted'`         | Reparte según `weight`: menos tenants por unidad de peso   |
| `{ fixed: 'id' }`    | Siempre ese servidor                                       |
| una función          | El id que devuelvas (por plan, por país...)                |

```ts
// Siempre el mismo servidor
const fijo: PlacementStrategy = { fixed: 'mysql-2' };

// Tu propia regla: por plan
const porPlan: PlacementStrategy = ({ tenant, servers }) =>
  tenant.plan === 'enterprise' ? 'mysql-dedicado' : (servers[0]?.id ?? 'default');
```

Si ningún servidor tiene lugar, `create` falla con `TENANCY_NO_DATABASE_SERVER_AVAILABLE`. Para mover un tenant existente a otro servidor, ve [Mover tenants](/guia/mover-tenants).

## Aprovisionamiento

`tenancy.tenants.create()` registra el tenant y corre el pipeline con un candado por tenant:

1. `placement` (solo la primera vez): elige servidor, nombre de base y credenciales, y lo guarda antes de crear nada. Si otro tenant ya usa ese nombre, falla con `TENANCY_DATABASE_NAME_TAKEN`.
2. `createDatabase`: crea la base (o el schema). Si ya existe, no hace nada.
3. `createUser`: solo con `per-tenant`; si no, queda como `skipped`.
4. `migrate`: tus migraciones de tenant (`skipped` si no hay).
5. `seed`: tu `seed` (`skipped` si no hay).

Cada paso queda en la tabla `tenancy_provisioning_steps` y en el log (`operation: provisioning.step`) con su intento, duración y error. Se publican `database.created`, `database.migrated`, `database.seeded` y, al final, `tenant.provisioned`. Si algo falla, el tenant queda en estado `failed`, se publica `tenant.provisioning_failed` y `create` lanza `TENANCY_PROVISIONING_FAILED`.

### Reintentos y pasos propios

```ts
// Debe ser idempotente: puede volver a correr en un reintento
const extensiones: ProvisioningStep = {
  name: 'extensiones',
  async run({ db }) {
    await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);
  },
};

const tenancy = createTenancy({
  plugins: [
    database({
      driver: postgres(),
      central: { url: process.env.DATABASE_URL! },
      migrations: { tenant: './migrations/tenant' },
      pipeline: ['createDatabase', 'createUser', 'migrate', extensiones, 'seed'],
      cleanupOnFailure: true,
    }),
  ],
});

try {
  await tenancy.tenants.create({ id: 'bolivar' });
} catch {
  // El tenant queda en estado `failed`: revisa qué paso falló
  for (const step of await tenancy.database.provisioningSteps('bolivar')) {
    console.log(step.step, step.status, step.attempt, step.error);
  }
  await tenancy.tenants.retryProvisioning('bolivar'); // salta los pasos ya completados
}
```

- Un `ProvisioningStep` recibe `{ tenant, db, admin, migration }`: la base del tenant, la conexión de administración de su servidor y los datos de conexión. Su `undo` opcional corre al borrar el tenant, en orden inverso, antes de borrar la base.
- `retryProvisioning` salta los pasos que terminaron bien en la ejecución anterior (quedan como `skipped` con `attempt: 2`), así el seed no se repite. No reintenta solo: lo llamas tú.
- Con `cleanupOnFailure: true`, si el intento falla y fue él quien creó la base, la borra y registra un paso `cleanup`. El siguiente reintento vuelve a correr todo.
- Si el seed falla a mitad, lo que alcanzó a insertar se queda. Hazlo transaccional o idempotente.

## Migraciones

`migrations.tenant` y `migrations.central` aceptan tres formas:

```ts
// 1. Carpeta: archivos .sql (001_x.sql y, opcional, 001_x.down.sql) o módulos que exportan up/down
database({
  driver: postgres(),
  central: { url: process.env.DATABASE_URL! },
  migrations: { tenant: './migrations/tenant', central: './migrations/central' },
});

// 2. Objeto de migraciones de Kysely
const migraciones: Record<string, Migration> = {
  '001_productos': {
    async up(db) {
      await db.schema
        .createTable('productos')
        .addColumn('id', 'serial', (c) => c.primaryKey())
        .addColumn('nombre', 'varchar(100)', (c) => c.notNull())
        .execute();
    },
    async down(db) {
      await db.schema.dropTable('productos').execute();
    },
  },
};
database({ driver: postgres(), central: { url: process.env.DATABASE_URL! }, migrations: { tenant: migraciones } });
```

- Si la carpeta tiene algún `.sql`, se aplican en orden alfabético. Cada sentencia termina con `;` al final de una línea y las líneas que empiezan con `--` se ignoran. Si no, se cargan módulos `.ts`/`.js` con el `FileMigrationProvider` de Kysely.
- La carpeta se lee una vez al arrancar. Si no existe, el error queda en el log (`database.migrations.load`) y aparece al migrar.
- Las migraciones de cada tenant se guardan en `tenancy_migrations` dentro de su base (en modo schema, dentro de su schema). Las centrales, en `tenancy_central_migrations`.

La tercera forma es un `TenancyMigrator` propio. Así funcionan los migradores de [Knex, Prisma, Drizzle, TypeORM, Sequelize y MikroORM](/guia/orm):

```ts
const miMigrador: TenancyMigrator = {
  async latest(db, context) {
    // context.url, context.connection, context.native y context.schema describen la base del tenant
    console.log('migrando', context?.tenant?.id.value);
    return { executed: [] };
  },
  async rollback(db, options, context) {
    return { executed: [] };
  },
  async status(db, context) {
    return [{ name: '001_inicial', executedAt: new Date() }];
  },
};
```

### Correr migraciones

```ts
await tenancy.database.migrateCentral(); // tus tablas centrales (tabla tenancy_central_migrations)

const result = await tenancy.database.migrate({
  concurrency: 5,
  onTenant: (r) => console.log(r.tenantId, r.ok ? 'ok' : r.error, Math.round(r.durationMs)),
});
console.log(result.succeeded, result.failed);

await tenancy.database.migrate({ tenants: ['bolivar', 'tigre'] });
await tenancy.database.rollback({ tenants: ['bolivar'], steps: 2 });
await tenancy.database.status('bolivar'); // [{ name, executedAt }]
```

- `migrate`, `rollback` y `seed` recorren los tenants `active`, `maintenance` y `suspended` (o solo los de `tenants`), con `concurrency` 5 por defecto. Un tenant que falla no detiene a los demás: queda en `failed` del resultado y en el log.
- `rollback` revierte 1 paso por defecto.
- `seed()` vuelve a correr tu `seed` en tenants existentes: no es idempotente por sí solo.
- `migrate` publica `database.migrated` en cada tenant donde corrió al menos una migración.
- `install()` no corre `migrateCentral()`; el comando `tenancy install` corre los dos.

Desde la terminal: `tenancy migrate`, `migrate:status`, `rollback` y `seed` (ver [CLI](/guia/cli)).

## Consultar

```ts
interface TenantDB {
  productos: { id: number; nombre: string; precio: number };
}

await tenancy.run('bolivar', async () => {
  // Kysely tipado sobre la base del tenant actual
  const caros = await tenancy
    .db<TenantDB>()
    .selectFrom('productos')
    .select(['id', 'nombre'])
    .where('precio', '>', 50)
    .execute();

  // SQL parametrizado: los valores nunca se concatenan
  const filas = await tenancy.sql<{ id: number }>`SELECT id FROM productos WHERE precio > ${50}`;

  // Base central, desde cualquier contexto
  const planes = await tenancy.centralDb().selectFrom('planes').selectAll().execute();

  // Pool nativo del tenant (pg.Pool con postgres(), mysql2 Pool con mysql())
  const pool = tenancy.pool<Pool>();
  await pool.query('SELECT 1');
});
```

`tenancy.db()` fuera de un tenant lanza `TenantNotIdentifiedError` (usa `centralDb()`), y en un tenant sin base todavía, `TENANCY_DATABASE_NOT_ASSIGNED`. La conexión se toma con el primer uso dentro del contexto y se libera al salir de él.

### Conexión, URL y base central

```ts
// URL con las credenciales del tenant (psql, pg_dump, Prisma...)
const url = await tenancy.database.connectionUrl('bolivar');

await tenancy.run('bolivar', async () => {
  const info = tenancy.database.connection(); // síncrono
  console.log(info.kind, info.options.database, info.schema, info.key);
  console.log(await tenancy.database.tables()); // tablas del tenant, sin las de migraciones
});

// Acceso de bajo nivel a la base central (para plugins)
const central = tenancy.database.central();
const servidores = await central.db.selectFrom('database_servers').select(['id', 'host']).execute();
console.log(central.kind, central.tablePrefix, servidores);
```

- `connection()` devuelve `key`, `kind`, `options`, `url`, `native`, `schema` y `tenant` del contexto actual. Lo usan las integraciones de ORM.
- En modo schema, la URL lleva `?options=-c search_path=<schema>`.
- `central()` devuelve `db` (tablas del paquete con nombres cortos, el prefijo se agrega solo), `raw` (sin prefijo), `kind`, `tablePrefix`, `encrypter` y `driver`. Es para plugins como la outbox o el panel.
- `tenancy.database.schema('prisma' | 'drizzle' | 'typeorm')` genera modelos de las tablas `tenancy_*` leyendo la base real (no disponible en SQLite ni SQL Server).

### Acceso entre tenants

```ts
await tenancy.run('bolivar', async () => {
  const propios = await tenancy.db().selectFrom('pedidos').selectAll().execute();

  // Otro tenant: abre su propio contexto y, al terminar, vuelves a bolivar
  const ajenos = await tenancy.run('tigre', () =>
    tenancy.db().selectFrom('pedidos').selectAll().execute(),
  );
});

// Todos los tenants activos, cinco a la vez
const { succeeded, failed } = await tenancy.runForEach(
  async () => {
    await tenancy.db().deleteFrom('sesiones').where('vence', '<', new Date()).execute();
  },
  { concurrency: 5 },
);
```

No hay consultas que crucen bases: cada `run` usa la conexión de su tenant. Para juntar datos, consulta cada uno y combina en tu código.

## Pools

Cada tenant tiene su pool, creado con la primera consulta. El registro:

- Nunca cierra un pool en uso (cuenta referencias).
- Limita los pools abiertos por servidor (`maxOpenPools`) y cierra los menos usados que estén libres. Si todos están ocupados, excede el límite un momento, lo avisa en el log (`db.pool.limit`) y vuelve al límite al liberarse.
- Cierra los pools sin uso después de `idleTimeoutMs`.
- Manda los errores de conexiones inactivas al log (`db.pool.error`) en vez de tumbar el proceso.

```ts
const tenancy = createTenancy({
  plugins: [
    database({
      driver: mysql(),
      central: { url: process.env.DATABASE_URL!, pool: { max: 10 } },
      pool: { max: 5, maxOpenPools: 100, idleTimeoutMs: 60_000 },
    }),
  ],
});

const stats = tenancy.database.pools();
// { servers: { default: { open, inUse, maxOpenPools } }, pools: [{ key, serverId, refs, idleMs, ageMs }] }
console.log(stats.servers.default?.open, stats.pools.length);
```

Calcula las conexiones máximas por servidor como `maxOpenPools × pool.max`, más las del pool central, y compáralas con el límite del motor. En modo schema con credenciales compartidas hay un solo pool por servidor.

## Límites

- En MySQL el DDL no es transaccional: si `install()` falla a mitad, revisa la base antes de reintentar.
- SQLite: el candado solo sirve dentro de un proceso. No corras dos procesos que aprovisionen o migren a la vez.
- Crear el tenant y sus dominios todavía no es atómico ([ADR 0006](/adr/0006-base-de-datos)).

Referencia completa: [`@tenancy-node/db`](/referencia/api/@tenancy-node/db/).
