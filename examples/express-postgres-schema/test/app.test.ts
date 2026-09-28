import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { generateEncryptionKey } from '@tenancy-node/db';
import { MemoryLogger } from '@tenancy-node/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('example express-postgres-schema', () => {
  let container: StartedPostgreSqlContainer;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').withUsername('admin').withPassword('secret').withDatabase('app').start();
  }, 300_000);
  afterAll(async () => void (await container?.stop()));

  it('keeps each tenant in its own schema with its own role, with metrics per route', async () => {
    const { app, tenancy } = await buildApp({
      databaseUrl: `postgres://admin:secret@${container.getHost()}:${container.getPort()}/app`,
      encryptionKey: generateEncryptionKey(),
      logger: new MemoryLogger(),
    });
    for (const id of ['bolivar', 'tigre'])
      expect((await request(app).post('/tenants').send({ id, name: id, domain: `${id}.test` })).status).toBe(201);

    await request(app).post('/tareas').set('host', 'bolivar.test').send({ titulo: 'Vender entradas' }).expect(201);
    await request(app).post('/tareas').set('host', 'bolivar.test').send({ titulo: 'Pintar la tribuna' }).expect(201);
    await request(app).post('/tareas').set('host', 'tigre.test').send({ titulo: 'Fichar al 9' }).expect(201);
    const bolivar = await request(app).get('/tareas').set('host', 'bolivar.test').expect(200);
    expect(bolivar.body.map((t: { titulo: string }) => t.titulo)).toEqual(['Vender entradas', 'Pintar la tribuna']);
    expect((await request(app).get('/tareas').set('host', 'tigre.test')).body).toHaveLength(1);
    expect((await request(app).get('/tareas').set('host', 'nadie.test')).status).toBe(404);

    // El rol de bolivar no puede leer el schema de tigre: lo impide PostgreSQL, no el código.
    const tigreSchema = (await tenancy.tenants.findOrFail('tigre')).database!.schema!;
    await expect(
      tenancy.run('bolivar', async () => (await tenancy.typeorm()).query(`select * from "${tigreSchema}".tareas`)),
    ).rejects.toThrow(/permission denied/);

    const text = (await request(app).get('/metrics')).text;
    expect(text).toMatch(/tenancy_http_request_duration_seconds_count\{method="POST",route="\/tareas",status_class="2xx"\} 3/);
    expect(text).toContain('tenancy_operation_duration_seconds_count{operation="tenants.create",outcome="success"} 2');
    await tenancy.close();
  }, 120_000);
});
