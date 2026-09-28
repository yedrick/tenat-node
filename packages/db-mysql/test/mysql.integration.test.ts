import { MySqlContainer } from '@testcontainers/mysql';
import { mysql } from '@tenancy-node/db-mysql';
import { databaseIntegrationSuite } from '../../db/test/integration-suite.js';

databaseIntegrationSuite({
  name: 'MySQL 8',
  driver: () => mysql(),
  async start() {
    const container = await new MySqlContainer('mysql:8.0')
      .withRootPassword('secret')
      .withDatabase('app')
      .start();
    return {
      url: `mysql://root:secret@${container.getHost()}:${container.getPort()}/app`,
      stop: async () => void (await container.stop()),
    };
  },
});
