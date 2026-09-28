import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { generateEncryptionKey } from '@tenancy-node/db';
import { MemoryLogger } from '@tenancy-node/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('example fastify-mysql', () => {
  let container: StartedMySqlContainer;
  beforeAll(async () => {
    container = await new MySqlContainer('mysql:8.0').withRootPassword('secret').withDatabase('tenancy').start();
  }, 300_000);
  afterAll(async () => void (await container?.stop()));

  it('gives each tenant its own database, seeded and isolated', async () => {
    const { app } = await buildApp({
      databaseUrl: `mysql://root:secret@${container.getHost()}:${container.getPort()}/tenancy`,
      encryptionKey: generateEncryptionKey(),
      logger: new MemoryLogger(),
    });
    const productos = (host: string) => app.inject({ url: '/productos', headers: { host } }).then((r) => r.json());
    expect(await productos('bolivar.localhost')).toMatchObject([{ nombre: 'Camiseta Club Bolívar', precio: 100 }]);

    const created = await app.inject({
      method: 'POST',
      url: '/productos',
      headers: { host: 'bolivar.localhost' },
      payload: { nombre: 'Gorra', precio: 50 },
    });
    expect(created.json()).toMatchObject([{ total: 2 }]);
    expect(await productos('tigre.localhost')).toHaveLength(1);

    const estado = (await app.inject({ url: '/admin/estado', headers: { host: 'localhost' } })).json();
    expect(estado.tenants.map((t: { id: string; status: string }) => [t.id, t.status])).toEqual([
      ['bolivar', 'active'],
      ['tigre', 'active'],
    ]);
    await app.close();
  }, 120_000);
});
