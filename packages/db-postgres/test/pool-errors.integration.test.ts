import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTenancy } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { MemoryLogger } from '@tenancy-node/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('PostgreSQL pool errors', () => {
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

  it('survives the server killing idle connections, logs it and reconnects', async () => {
    const tenancy = createTenancy({
      logger: new MemoryLogger(),
      plugins: [database({ driver: postgres(), central: { url } })],
    });
    await tenancy.database.install();
    await tenancy.tenants.create({ id: 'bolivar' });
    await tenancy.run('bolivar', () => sql`SELECT 1`.execute(tenancy.db()));

    // Como si la base se reiniciara: se matan las conexiones inactivas del tenant.
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'tenant_bolivar' AND pid <> pg_backend_pid()`.execute(
      tenancy.centralDb(),
    );
    await new Promise((r) => setTimeout(r, 300));

    expect(tenancy.observability.errors().map((e) => e.operation)).toContain('db.pool.error');
    const rows = await tenancy.run('bolivar', () =>
      sql<{ ok: number }>`SELECT 1 AS ok`.execute(tenancy.db()),
    );
    expect(rows.rows).toEqual([{ ok: 1 }]);
    await tenancy.close();
  });
});
