import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTenancy } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { knexIntegration, knexMigrator } from '@tenancy-node/orm-knex';
import { MemoryLogger } from '@tenancy-node/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('Knex integration (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let url = '';
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withUsername('admin')
      .withPassword('secret')
      .withDatabase('app')
      .start();
    url = `postgres://admin:secret@${container.getHost()}:${container.getPort()}/app`;
  }, 300_000);
  afterAll(async () => void (await container?.stop()));

  it('gives each tenant its own Knex instance and migrates with Knex migrations', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'knex-migrations-'));
    await writeFile(
      path.join(dir, '20260101000000_clientes.cjs'),
      "exports.up = (k) => k.schema.createTable('clientes', (t) => { t.increments('id'); t.string('nombre').notNullable(); });\nexports.down = (k) => k.schema.dropTable('clientes');\n",
    );
    const tenancy = createTenancy({
      logger: new MemoryLogger(),
      http: { health: true },
      plugins: [
        database({
          driver: postgres(),
          central: { url },
          migrations: { tenant: knexMigrator({ directory: dir, loadExtensions: ['.cjs'] }) },
        }),
        knexIntegration({ maxInstances: 2 }),
      ],
    });
    await tenancy.database.install();
    for (const id of ['aa', 'bb', 'cc']) await tenancy.tenants.create({ id });

    await tenancy.run('aa', () => tenancy.knex()('clientes').insert({ nombre: 'Ana' }));
    await tenancy.run('bb', () =>
      tenancy
        .knex()('clientes')
        .insert([{ nombre: 'Beto' }, { nombre: 'Bea' }]),
    );
    expect(await tenancy.run('aa', () => tenancy.knex()('clientes').select('nombre'))).toEqual([
      { nombre: 'Ana' },
    ]);
    expect(
      await tenancy.run('bb', () => tenancy.knex()('clientes').count({ n: '*' }).first()),
    ).toEqual({ n: '2' });
    expect(await tenancy.run('aa', () => tenancy.knex() === tenancy.knex())).toBe(true);
    // Un tercer tenant supera maxInstances: la instancia más antigua se descarta (con gracia) sin romper nada
    expect(await tenancy.run('cc', () => tenancy.knex()('clientes').select())).toEqual([]);

    const status = await tenancy.database.status('aa');
    expect(status).toEqual([{ name: '20260101000000_clientes.cjs', executedAt: expect.any(Date) }]);
    await tenancy.database.rollback({ tenants: ['cc'] });
    expect((await tenancy.database.status('cc'))[0]?.executedAt).toBeNull();

    const conn = await tenancy.run('aa', () => tenancy.database.connection());
    expect(conn).toMatchObject({ kind: 'postgres', options: { database: 'tenant_aa' } });
    expect(conn.url).toMatch(/^postgres:\/\/admin:secret@.+\/tenant_aa$/);
    expect(() => tenancy.database.connection()).toThrow(/tenant/i);
    expect((await tenancy.health()).checks.database?.ok).toBe(true);
    await tenancy.close();
  });
});
