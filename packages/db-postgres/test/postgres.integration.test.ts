import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { postgres } from '@tenancy-node/db-postgres';
import { databaseIntegrationSuite } from '../../db/test/integration-suite.js';

databaseIntegrationSuite({
  name: 'PostgreSQL 16',
  driver: () => postgres(),
  async start() {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withUsername('admin')
      .withPassword('secret')
      .withDatabase('app')
      .start();
    return {
      url: `postgres://admin:secret@${container.getHost()}:${container.getPort()}/app`,
      stop: async () => void (await container.stop()),
    };
  },
});
