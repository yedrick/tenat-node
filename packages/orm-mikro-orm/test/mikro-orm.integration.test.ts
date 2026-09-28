import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTenancy } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { mikroOrmIntegration, mikroOrmMigrator } from '@tenancy-node/orm-mikro-orm';
import { MemoryLogger } from '@tenancy-node/testing';
import { EntitySchema } from '@mikro-orm/core';
import { Migration, Migrator } from '@mikro-orm/migrations';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
class Migration20260102000000 extends Migration {
  override async up() {
    this.addSql('alter table clientes add column email varchar(200)');
  }
  override async down() {
    this.addSql('alter table clientes drop column email');
  }
}

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('MikroORM integration (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let url = '';
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').withUsername('admin').withPassword('secret').withDatabase('app').start();
    url = `postgres://admin:secret@${container.getHost()}:${container.getPort()}/app`;
  }, 300_000);
  afterAll(async () => void (await container?.stop()));

  for (const isolation of ['database', 'schema'] as const) {
    it(`gives each tenant its own MikroORM and migrates with its Migrator (${isolation})`, async () => {
      const tenancy = createTenancy({
        logger: new MemoryLogger(),
        plugins: [
          database({
            driver: postgres(),
            central: { url },
            isolation,
            migrations: {
              tenant: mikroOrmMigrator({
                driver: PostgreSqlDriver,
                migrator: Migrator,
                migrations: [
                  { name: 'Migration20260101000000', class: Migration20260101000000 },
                  { name: 'Migration20260102000000', class: Migration20260102000000 },
                ],
              }),
            },
          }),
          mikroOrmIntegration({ driver: PostgreSqlDriver, entities: [ClienteSchema], maxInstances: 2 }),
        ],
      });
      await tenancy.database.install();
      const ids = isolation === 'schema' ? ['s1', 's2', 's3'] : ['aa', 'bb', 'cc'];
      for (const id of ids) await tenancy.tenants.create({ id });

      await tenancy.run(ids[0]!, async () => {
        const em = await tenancy.em();
        em.create(ClienteSchema, { nombre: 'Ana' });
        await em.flush();
      });
      await tenancy.run(ids[1]!, async () => {
        const em = await tenancy.em();
        em.create(ClienteSchema, { nombre: 'Beto' });
        em.create(ClienteSchema, { nombre: 'Bea' });
        await em.flush();
      });
      const names = await tenancy.run(ids[0]!, async () => (await (await tenancy.em()).find(ClienteSchema, {})).map((c) => c.nombre));
      expect(names).toEqual(['Ana']);
      expect(await tenancy.run(ids[1]!, async () => (await tenancy.em()).count(ClienteSchema))).toBe(2);
      expect(await tenancy.run(ids[2]!, async () => (await tenancy.em()).count(ClienteSchema))).toBe(0);
      // Cada em() es un fork: identity maps separados.
      expect(await tenancy.run(ids[0]!, async () => (await tenancy.em()) !== (await tenancy.em()))).toBe(true);

      expect(await tenancy.database.status(ids[0]!)).toEqual([
        { name: 'Migration20260101000000', executedAt: expect.any(Date) },
        { name: 'Migration20260102000000', executedAt: expect.any(Date) },
      ]);
      await tenancy.database.rollback({ tenants: [ids[2]!] });
      expect((await tenancy.database.status(ids[2]!)).map((m) => m.executedAt === null)).toEqual([false, true]);

      if (isolation === 'schema') {
        const [row] = (await tenancy.run(ids[0]!, async () =>
          (await tenancy.em()).getConnection().execute('select current_schema() as s'),
        )) as { s: string }[];
        expect(row?.s).toBe(await tenancy.run(ids[0]!, () => tenancy.database.connection().schema));
      }
      await expect(tenancy.em()).rejects.toThrow(/tenant/i);
      await tenancy.close();
    }, 120_000);
  }
});
