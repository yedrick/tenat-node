# ORMs

Si ya usas un ORM, no tienes que cambiarlo. Cada integración es un plugin que agrega un método a `tenancy` (`tenancy.knex()`, `tenancy.prisma()`...) y devuelve una instancia conectada a la base del tenant actual. Casi todas traen además un migrador para `migrations.tenant`.

Todas necesitan el plugin de [base de datos](/guia/base-de-datos): leen la conexión del tenant con `tenancy.database.connection()`, así que solo funcionan dentro de un contexto de tenant.

## Cómo funcionan

- **Una instancia por tenant**, creada con el primer uso y guardada en un LRU (`maxInstances` o `maxClients`). La llave es la conexión (servidor, base, usuario) más el id del tenant.
- Las instancias que salen del LRU se cierran después de 30 s, para no cortar consultas en curso.
- Al borrar un tenant (`tenant.deleted`) su instancia se cierra. `tenancy.close()` cierra todas.
- Cada instancia abre su propio pool, salvo Drizzle, que reutiliza el pool de `tenancy.db()`. Cuenta esas conexiones al dimensionar tu servidor.
- Los migradores abren una conexión temporal con las credenciales del tenant y la cierran al terminar. Los corre el aprovisionamiento y también `tenancy migrate`, `rollback` y `migrate:status`.

| Integración | Método                         | MySQL / MariaDB | PostgreSQL | Modo schema | SQL Server | SQLite | Migrador                    | Rollback |
| ----------- | ------------------------------ | --------------- | ---------- | ----------- | ---------- | ------ | --------------------------- | -------- |
| Knex        | `tenancy.knex()`               | sí              | sí         | sí          | no         | no     | `knexMigrator`              | sí       |
| Drizzle     | `tenancy.drizzle(schema)`      | sí              | sí         | **no**      | no         | no     | `drizzleMigrator`           | no       |
| Prisma      | `tenancy.prisma()`             | sí              | sí         | sí          | no         | no     | `prismaMigrator`            | no       |
| TypeORM     | `await tenancy.typeorm()`      | sí              | sí         | sí          | sí         | no     | `typeormMigrator`           | sí       |
| Sequelize   | `tenancy.sequelize()`          | sí              | sí         | sí          | sí         | no     | `sequelizeMigrator` (Umzug) | sí       |
| MikroORM 6  | `await tenancy.em()`           | sí              | sí         | sí          | sí         | no     | `mikroOrmMigrator`          | sí       |

Con un motor no soportado, las seis integraciones lanzan un error claro al pedir la instancia (y sus migradores al migrar). Las pruebas de integración de los ORMs corren solo sobre PostgreSQL: TypeORM, Sequelize y MikroORM en modo base y modo schema; Knex y Drizzle en modo base. Prisma tiene pruebas unitarias. MySQL y SQL Server los acepta el código, pero no tienen test propio por ORM. En SQL Server, TypeORM y Sequelize usan la configuración TLS que pases en sus opciones (por ejemplo `options: { options: { trustServerCertificate: true } }` en TypeORM para un servidor de desarrollo con certificado propio); el paquete no la cambia.

En modo schema, Knex, TypeORM, Sequelize y MikroORM fijan el `search_path` del tenant en cada conexión, y Prisma usa el parámetro `schema` de la URL. Drizzle no puede hacerlo de forma segura y lo rechaza ([ADR 0012](/adr/0012-mas-motores)).

## Knex

```bash
npm install @tenancy-node/orm-knex knex
```

```ts
import { createTenancy } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { knexIntegration, knexMigrator } from '@tenancy-node/orm-knex';

export const tenancy = createTenancy({
  plugins: [
    database({
      driver: postgres(),
      central: { url: process.env.DATABASE_URL! },
      migrations: { tenant: knexMigrator({ directory: './migrations/tenant' }) },
    }),
    knexIntegration({ maxInstances: 50, pool: { min: 0, max: 5 } }),
  ],
});

await tenancy.run('bolivar', async () => {
  const caros = await tenancy.knex()('productos').where('precio', '>', 50).select('id', 'nombre');
  await tenancy.knex().transaction(async (trx) => {
    await trx('productos').insert({ nombre: 'Camiseta', precio: 80 });
  });
});
```

| Opción                      | Por defecto         | Qué hace                                        |
| --------------------------- | ------------------- | ----------------------------------------------- |
| `maxInstances`              | 50                  | Instancias de Knex vivas como máximo            |
| `pool`                      | `{ min: 0, max: 5 }` | Pool de cada instancia                         |
| `config`                    | ninguna             | Opciones extra de `knex()` (sin `client` ni `connection`) |

`knexMigrator` recibe `directory` (una carpeta o varias), `tableName` (`knex_migrations`) y `loadExtensions`. Usa el cliente `mysql2` o `pg` según el driver.

## Drizzle

```bash
npm install @tenancy-node/orm-drizzle drizzle-orm
npm install -D drizzle-kit
```

```ts
import { drizzleIntegration, drizzleMigrator } from '@tenancy-node/orm-drizzle';
import { gt } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { integer, pgTable, serial, varchar } from 'drizzle-orm/pg-core';

export const productos = pgTable('productos', {
  id: serial('id').primaryKey(),
  nombre: varchar('nombre', { length: 100 }).notNull(),
  precio: integer('precio').notNull(),
});
const schema = { productos };

export const tenancy = createTenancy({
  plugins: [
    database({
      driver: postgres(),
      central: { url: process.env.DATABASE_URL! },
      migrations: { tenant: drizzleMigrator({ drizzle, migrate, migrationsFolder: './drizzle' }) },
    }),
    drizzleIntegration({ drizzle }),
  ],
});

await tenancy.run('bolivar', async () => {
  const db = tenancy.drizzle<NodePgDatabase<typeof schema>>(schema);
  const caros = await db.select().from(productos).where(gt(productos.precio, 50));
  const todos = await db.query.productos.findMany(); // API relacional: requiere pasar el schema
});
```

- Con MySQL, importa `drizzle` de `drizzle-orm/mysql2` y `migrate` de `drizzle-orm/mysql2/migrator`.
- Drizzle no abre conexiones: usa el pool nativo del tenant. La instancia se guarda por pool y por `schema`.
- `drizzleMigrator` aplica la carpeta que genera drizzle-kit (con `meta/_journal.json`). La tabla de control es `__drizzle_migrations` (`migrationsTable`); en PostgreSQL vive en el schema `drizzle`.
- Las migraciones de Drizzle solo avanzan: `rollback` lanza un error. Para revertir, escribe una migración nueva.

::: warning
`tenancy.drizzle()` y `drizzleMigrator` lanzan un error con `isolation: 'schema'`: Drizzle usa el pool nativo, que en ese modo no tiene el `search_path` del tenant.
:::

## Prisma

```bash
npm install @tenancy-node/orm-prisma @prisma/client
npm install -D prisma
```

```ts
import { prismaIntegration, prismaMigrator } from '@tenancy-node/orm-prisma';
import { PrismaClient } from '@prisma/client';

export const tenancy = createTenancy({
  plugins: [
    database({
      driver: postgres(),
      central: { url: process.env.DATABASE_URL! },
      // Corre `npx prisma migrate deploy` con la DATABASE_URL de cada tenant
      migrations: { tenant: prismaMigrator({ schema: 'prisma/schema.prisma' }) },
    }),
    prismaIntegration({ client: PrismaClient, maxClients: 10 }),
  ],
});

await tenancy.run('bolivar', async () => {
  const productos = await tenancy.prisma().producto.findMany({ where: { activo: true } });
});
```

Tu `schema.prisma` debe leer la URL de `env("DATABASE_URL")`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

- `prismaIntegration` crea cada cliente con `new PrismaClient({ datasourceUrl })`. Tu versión de Prisma debe aceptar esa opción.
- Opciones: `client` (tu clase generada), `maxClients` (10; cada cliente abre su propio pool, por eso el LRU es chico) y `graceMs` (30 s antes de desconectar un cliente descartado).
- `prismaMigrator` acepta `schema` (ruta del `schema.prisma`), `command` (`npx prisma`) y `cwd`. `status` lee la tabla `_prisma_migrations` con la conexión del tenant (en modo schema, la de su schema). Las migraciones de Prisma solo avanzan: `rollback` lanza un error.
- Solo MySQL y PostgreSQL: la URL que arma el paquete para SQLite y SQL Server no tiene el formato que espera Prisma.

## TypeORM

```bash
npm install @tenancy-node/orm-typeorm typeorm
```

```ts
import { typeormIntegration, typeormMigrator } from '@tenancy-node/orm-typeorm';
import { EntitySchema, type MigrationInterface, type QueryRunner } from 'typeorm';

interface Cliente {
  id: number;
  nombre: string;
}
const ClienteSchema = new EntitySchema<Cliente>({
  name: 'Cliente',
  tableName: 'clientes',
  columns: { id: { type: Number, primary: true, generated: true }, nombre: { type: String } },
});

class Clientes1767225600000 implements MigrationInterface {
  name = 'Clientes1767225600000';
  async up(q: QueryRunner) {
    await q.query('create table clientes (id serial primary key, nombre varchar(100) not null)');
  }
  async down(q: QueryRunner) {
    await q.query('drop table clientes');
  }
}

export const tenancy = createTenancy({
  plugins: [
    database({
      driver: postgres(),
      central: { url: process.env.DATABASE_URL! },
      migrations: { tenant: typeormMigrator({ migrations: [Clientes1767225600000] }) },
    }),
    typeormIntegration({ entities: [ClienteSchema], maxInstances: 50, poolSize: 5 }),
  ],
});

await tenancy.run('bolivar', async () => {
  const clientes = (await tenancy.typeorm()).getRepository(ClienteSchema);
  await clientes.save({ nombre: 'Ana' });
  const todos = await clientes.find();
});
```

- `tenancy.typeorm()` es asíncrono: devuelve el `DataSource` ya inicializado. Si no logra conectar, no queda en caché y el siguiente intento vuelve a probar.
- Opciones: `entities` (obligatoria), `maxInstances` (50), `poolSize` (5) y `options` (logging, naming strategy...). Nunca uses `synchronize` en producción.
- `typeormMigrator` recibe `migrations` (clases o globs), `entities` (si tus migraciones usan repositorios), `tableName` (`migrations`) y `transaction` (`'each'`, `'all'` o `'none'`).
- TypeORM no guarda cuándo corrió cada migración: `migrate:status` muestra el timestamp de su nombre.

## Sequelize

```bash
npm install @tenancy-node/orm-sequelize sequelize pg pg-hstore
# MySQL: mysql2. SQL Server: tedious
```

```ts
import { sequelizeIntegration, sequelizeMigrator } from '@tenancy-node/orm-sequelize';
import { DataTypes, Model } from 'sequelize';

class Cliente extends Model {
  declare id: number;
  declare nombre: string;
}

export const tenancy = createTenancy({
  plugins: [
    database({
      driver: postgres(),
      central: { url: process.env.DATABASE_URL! },
      migrations: {
        tenant: sequelizeMigrator({
          migrations: [
            {
              name: '001_clientes',
              up: ({ context }) =>
                context.queryInterface.createTable('clientes', {
                  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
                  nombre: { type: DataTypes.STRING(100), allowNull: false },
                }),
              down: ({ context }) => context.queryInterface.dropTable('clientes'),
            },
          ],
        }),
      },
    }),
    sequelizeIntegration({
      // Se llama una vez por cada instancia nueva (una por tenant)
      models: (sequelize) => {
        // Una clase por instancia: `init` ata el modelo a su Sequelize
        class TenantCliente extends Cliente {}
        TenantCliente.init(
          { id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true }, nombre: DataTypes.STRING },
          { sequelize, modelName: 'Cliente', tableName: 'clientes', timestamps: false },
        );
      },
    }),
  ],
});

await tenancy.run('bolivar', async () => {
  const { Cliente } = tenancy.sequelize().models;
  await Cliente!.create({ nombre: 'Ana' });
  const total = await Cliente!.count();
});
```

::: warning
Un modelo de Sequelize queda atado a la instancia donde llamaste `init`. Si llamas `Cliente.init` con la misma clase para cada tenant, la clase apunta al último. Crea una subclase por instancia, como arriba, y usa siempre `tenancy.sequelize().models.Cliente`.
:::

- Opciones: `models` (obligatoria), `maxInstances` (50), `pool` (`{ min: 0, max: 5 }`) y `options` (por defecto `logging: false`).
- `sequelizeMigrator` usa Umzug. `migrations` acepta `{ glob: 'migrations/*.js' }` o una lista `{ name, up, down }`; cada migración recibe `{ context: { queryInterface, sequelize } }`. La tabla de control es `SequelizeMeta` (la misma de sequelize-cli), con fecha de ejecución.

## MikroORM

```bash
npm install @tenancy-node/orm-mikro-orm @mikro-orm/core@6 @mikro-orm/postgresql@6 @mikro-orm/migrations@6
```

```ts
import { mikroOrmIntegration, mikroOrmMigrator } from '@tenancy-node/orm-mikro-orm';
import { EntitySchema } from '@mikro-orm/core';
import { Migration, Migrator } from '@mikro-orm/migrations';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

interface Cliente {
  id: number;
  nombre: string;
}
const ClienteSchema = new EntitySchema<Cliente>({
  name: 'Cliente',
  tableName: 'clientes',
  properties: { id: { type: 'number', primary: true, autoincrement: true }, nombre: { type: 'string' } },
});

class Migration20260101000000 extends Migration {
  override async up() {
    this.addSql('create table clientes (id serial primary key, nombre varchar(100) not null)');
  }
  override async down() {
    this.addSql('drop table clientes');
  }
}

export const tenancy = createTenancy({
  plugins: [
    database({
      driver: postgres(),
      central: { url: process.env.DATABASE_URL! },
      migrations: {
        tenant: mikroOrmMigrator({
          driver: PostgreSqlDriver,
          migrator: Migrator,
          migrations: [{ name: 'Migration20260101000000', class: Migration20260101000000 }],
        }),
      },
    }),
    mikroOrmIntegration({ driver: PostgreSqlDriver, entities: [ClienteSchema] }),
  ],
});

await tenancy.run('bolivar', async () => {
  const em = await tenancy.em(); // un fork() nuevo: uno por petición
  em.create(ClienteSchema, { nombre: 'Ana' });
  await em.flush();
  const clientes = await em.find(ClienteSchema, {});
});
```

- Se fija en MikroORM 6 (`>=6.4`): la v7 exige Node 22.
- `tenancy.em()` devuelve un `EntityManager` nuevo (`fork()`) con su propio identity map; pide uno por petición o unidad de trabajo. `tenancy.mikroOrm()` devuelve la instancia completa. `allowGlobalContext` queda en `false`.
- Opciones: `driver` y `entities` (obligatorias), `maxInstances` (50), `pool` (`{ min: 0, max: 5 }`) y `options`.
- `mikroOrmMigrator` recibe `driver`, `migrator` (la extensión `Migrator` de `@mikro-orm/migrations`), `migrations` (lista `{ name, class }`), `entities` y `tableName` (`mikro_orm_migrations`). Cada migración corre en una transacción.

## Modelos de las tablas centrales

Si tu ORM también lee las tablas `tenancy_*` (por ejemplo, para un panel propio), genera sus modelos desde la base real:

```bash
npx tenancy schema --prisma --out=prisma/tenancy.prisma
npx tenancy schema --drizzle --out=src/db/tenancy.ts
npx tenancy schema --typeorm --out=src/entities/tenancy.ts
```

Lo mismo desde código: `await tenancy.database.schema('prisma')`. Funciona con MySQL/MariaDB y PostgreSQL; no está disponible para SQLite ni SQL Server.

Referencia de cada paquete: [orm-knex](/referencia/api/@tenancy-node/orm-knex/), [orm-drizzle](/referencia/api/@tenancy-node/orm-drizzle/), [orm-prisma](/referencia/api/@tenancy-node/orm-prisma/), [orm-typeorm](/referencia/api/@tenancy-node/orm-typeorm/), [orm-sequelize](/referencia/api/@tenancy-node/orm-sequelize/), [orm-mikro-orm](/referencia/api/@tenancy-node/orm-mikro-orm/).
