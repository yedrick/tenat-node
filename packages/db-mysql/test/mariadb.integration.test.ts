import { MariaDbContainer } from '@testcontainers/mariadb';
import { mysql } from '@tenancy-node/db-mysql';
import { databaseIntegrationSuite } from '../../db/test/integration-suite.js';

databaseIntegrationSuite({
  name: 'MariaDB 11',
  driver: () => mysql({ variant: 'mariadb' }),
  async start() {
    const container = await new MariaDbContainer('mariadb:11')
      .withRootPassword('secret')
      .withDatabase('app')
      .start();
    return {
      url: `mysql://root:secret@${container.getHost()}:${container.getPort()}/app`,
      stop: async () => void (await container.stop()),
    };
  },
});
