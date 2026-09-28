import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTenancy } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { sequelizeIntegration, sequelizeMigrator, type SequelizeMigrationContext } from '@tenancy-node/orm-sequelize';
import { MemoryLogger } from '@tenancy-node/testing';
import { DataTypes, Model, type Sequelize } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

class Cliente extends Model {
  declare id: number;
  declare nombre: string;
}
const models = (sequelize: Sequelize) => {
  // Una clase por instancia: `init` ata el modelo a su Sequelize.
  class TenantCliente extends Cliente {}
  TenantCliente.init(
    { id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true }, nombre: { type: DataTypes.STRING, allowNull: false } },
    { sequelize, modelName: 'Cliente', tableName: 'clientes', timestamps: false },
  );
};
const migrations = [
  {
    name: '0001-clientes',
    up: async ({ context }: { context: SequelizeMigrationContext }) =>
      context.queryInterface.createTable('clientes', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        nombre: { type: DataTypes.STRING, allowNull: false },
      }),
    down: async ({ context }: { context: SequelizeMigrationContext }) => context.queryInterface.dropTable('clientes'),
  },
  {
    name: '0002-email',
    up: async ({ context }: { context: SequelizeMigrationContext }) =>
      context.queryInterface.addColumn('clientes', 'email', { type: DataTypes.STRING }),
    down: async ({ context }: { context: SequelizeMigrationContext }) => context.queryInterface.removeColumn('clientes', 'email'),
  },
];

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('Sequelize integration (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let url = '';
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').withUsername('admin').withPassword('secret').withDatabase('app').start();
    url = `postgres://admin:secret@${container.getHost()}:${container.getPort()}/app`;
  }, 300_000);
  afterAll(async () => void (await container?.stop()));

  for (const isolation of ['database', 'schema'] as const) {
    it(`gives each tenant its own Sequelize and migrates with Umzug (${isolation})`, async () => {
      const tenancy = createTenancy({
        logger: new MemoryLogger(),
        plugins: [
          database({
            driver: postgres(),
            central: { url },
            isolation,
            migrations: { tenant: sequelizeMigrator({ migrations }) },
          }),
          sequelizeIntegration({ models, maxInstances: 2 }),
        ],
      });
      await tenancy.database.install();
      const ids = isolation === 'schema' ? ['s1', 's2', 's3'] : ['aa', 'bb', 'cc'];
      for (const id of ids) await tenancy.tenants.create({ id });
      const Clientes = () => tenancy.sequelize().models.Cliente!;

      await tenancy.run(ids[0]!, () => Clientes().create({ nombre: 'Ana' }));
      await tenancy.run(ids[1]!, () => Clientes().bulkCreate([{ nombre: 'Beto' }, { nombre: 'Bea' }]));
      const names = await tenancy.run(ids[0]!, async () => (await Clientes().findAll()).map((c) => c.get('nombre')));
      expect(names).toEqual(['Ana']);
      expect(await tenancy.run(ids[1]!, () => Clientes().count())).toBe(2);
      expect(await tenancy.run(ids[2]!, () => Clientes().count())).toBe(0);

      const status = await tenancy.database.status(ids[0]!);
      expect(status).toEqual([
        { name: '0001-clientes', executedAt: expect.any(Date) },
        { name: '0002-email', executedAt: expect.any(Date) },
      ]);
      await tenancy.database.rollback({ tenants: [ids[2]!] });
      expect((await tenancy.database.status(ids[2]!)).map((m) => m.executedAt === null)).toEqual([false, true]);

      if (isolation === 'schema') {
        const [[row]] = (await tenancy.run(ids[0]!, () => tenancy.sequelize().query('select current_schema() as s'))) as [
          { s: string }[],
          unknown,
        ];
        expect(row?.s).toBe(await tenancy.run(ids[0]!, () => tenancy.database.connection().schema));
      }
      expect(() => tenancy.sequelize()).toThrow(/tenant/i);
      await tenancy.close();
    }, 120_000);
  }
});
