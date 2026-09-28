import { GenericContainer, Wait } from 'testcontainers';
import { mssql } from '@tenancy-node/db-mssql';
import { sql } from 'kysely';
import { databaseIntegrationSuite } from '../../db/test/integration-suite.js';

const PASSWORD = 'Tenancy!Str0ng#Pass';
const driver = () => mssql({ trustServerCertificate: true });

/** La misma suite de integración, contra SQL Server 2022. */
databaseIntegrationSuite({
  name: 'SQL Server 2022',
  driver,
  capabilities: { schemaGeneration: false },
  async start() {
    const container = await new GenericContainer('mcr.microsoft.com/mssql/server:2022-latest')
      .withEnvironment({ ACCEPT_EULA: 'Y', MSSQL_SA_PASSWORD: PASSWORD })
      .withExposedPorts(1433)
      .withWaitStrategy(Wait.forLogMessage(/Recovery is complete/).withStartupTimeout(180_000))
      .start();
    const host = container.getHost();
    const port = container.getMappedPort(1433);
    // La base central de la app
    const admin = driver().connect({ host, port, user: 'sa', password: PASSWORD, database: 'master' }, { max: 1 });
    for (let i = 0; ; i++) {
      try {
        await sql.raw('CREATE DATABASE app').execute(admin.db);
        break;
      } catch (error) {
        if (i > 30) throw error;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    await admin.destroy();
    return {
      url: `mssql://sa:${encodeURIComponent(PASSWORD)}@${host}:${port}/app`,
      stop: async () => void (await container.stop()),
    };
  },
});
