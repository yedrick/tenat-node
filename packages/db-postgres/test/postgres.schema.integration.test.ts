import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { postgres } from '@tenancy-node/db-postgres';
import { databaseIntegrationSuite } from '../../db/test/integration-suite.js';

/** La misma suite completa, con todos los tenants como schemas de una sola base. */
databaseIntegrationSuite({
  name: 'PostgreSQL 16 (isolation: schema)',
  driver: () => postgres(),
  isolation: 'schema',
  async start() {
    const container = await new PostgreSqlContainer('postgres:16-alpine').withUsername('admin').withPassword('secret').withDatabase('app').start();
    return {
      url: `postgres://admin:secret@${container.getHost()}:${container.getPort()}/app`,
      stop: async () => void (await container.stop()),
    };
  },
});
