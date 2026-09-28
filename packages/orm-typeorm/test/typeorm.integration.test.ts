import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTenancy } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { typeormIntegration, typeormMigrator } from '@tenancy-node/orm-typeorm';
import { MemoryLogger } from '@tenancy-node/testing';
import { EntitySchema, type MigrationInterface, type QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
class Email1767312000000 implements MigrationInterface {
  name = 'Email1767312000000';
  async up(q: QueryRunner) {
    await q.query('alter table clientes add column email varchar(200)');
  }
  async down(q: QueryRunner) {
    await q.query('alter table clientes drop column email');
  }
}

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('TypeORM integration (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let url = '';
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').withUsername('admin').withPassword('secret').withDatabase('app').start();
    url = `postgres://admin:secret@${container.getHost()}:${container.getPort()}/app`;
  }, 300_000);
  afterAll(async () => void (await container?.stop()));

  for (const isolation of ['database', 'schema'] as const) {
    it(`gives each tenant its own DataSource and migrates with TypeORM (${isolation})`, async () => {
      const tenancy = createTenancy({
        logger: new MemoryLogger(),
        plugins: [
          database({
            driver: postgres(),
            central: { url },
            isolation,
            ...(isolation === 'schema' ? { schemaDatabase: 'app' } : {}),
            migrations: { tenant: typeormMigrator({ migrations: [Clientes1767225600000, Email1767312000000] }) },
          }),
          typeormIntegration({ entities: [ClienteSchema], maxInstances: 2 }),
        ],
      });
      await tenancy.database.install();
      const ids = isolation === 'schema' ? ['s1', 's2', 's3'] : ['aa', 'bb', 'cc'];
      for (const id of ids) await tenancy.tenants.create({ id });

      await tenancy.run(ids[0]!, async () => (await tenancy.typeorm()).getRepository(ClienteSchema).save({ nombre: 'Ana' }));
      await tenancy.run(ids[1]!, async () =>
        (await tenancy.typeorm()).getRepository(ClienteSchema).save([{ nombre: 'Beto' }, { nombre: 'Bea' }]),
      );
      const names = await tenancy.run(ids[0]!, async () =>
        (await (await tenancy.typeorm()).getRepository(ClienteSchema).find()).map((c) => c.nombre),
      );
      expect(names).toEqual(['Ana']);
      expect(await tenancy.run(ids[1]!, async () => (await tenancy.typeorm()).getRepository(ClienteSchema).count())).toBe(2);
      expect(await tenancy.run(ids[0]!, async () => (await tenancy.typeorm()) === (await tenancy.typeorm()))).toBe(true);
      // Un tercero supera maxInstances: el más antiguo se cierra con gracia.
      expect(await tenancy.run(ids[2]!, async () => (await tenancy.typeorm()).getRepository(ClienteSchema).count())).toBe(0);

      expect(await tenancy.database.status(ids[0]!)).toEqual([
        { name: 'Clientes1767225600000', executedAt: expect.any(Date) },
        { name: 'Email1767312000000', executedAt: expect.any(Date) },
      ]);
      await tenancy.database.rollback({ tenants: [ids[2]!] });
      expect((await tenancy.database.status(ids[2]!)).map((m) => m.executedAt === null)).toEqual([false, true]);
      await tenancy.database.rollback({ tenants: [ids[2]!], steps: 5 });
      expect((await tenancy.database.status(ids[2]!)).every((m) => m.executedAt === null)).toBe(true);
      await tenancy.database.migrate({ tenants: [ids[2]!] });

      await expect(tenancy.typeorm()).rejects.toThrow(/tenant/i);
      if (isolation === 'schema') {
        const [row] = (await tenancy.run(ids[0]!, async () =>
          (await tenancy.typeorm()).query('select current_schema() as s'),
        )) as { s: string }[];
        expect(row?.s).toBe(await tenancy.run(ids[0]!, () => tenancy.database.connection().schema));
      }
      await tenancy.close();
    }, 120_000);
  }
});
