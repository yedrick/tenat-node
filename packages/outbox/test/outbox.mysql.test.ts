import { MySqlContainer } from '@testcontainers/mysql';
import { mysql } from '@tenancy-node/db-mysql';
import { outboxSuite } from './outbox-suite.js';

outboxSuite({
  name: 'MySQL 8',
  driver: () => mysql(),
  async start() {
    const c = await new MySqlContainer('mysql:8.0')
      .withRootPassword('secret')
      .withDatabase('app')
      .start();
    return {
      url: `mysql://root:secret@${c.getHost()}:${c.getPort()}/app`,
      stop: async () => void (await c.stop()),
    };
  },
});
