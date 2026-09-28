import { MySqlContainer } from '@testcontainers/mysql';
import { mysql } from '@tenancy-node/db-mysql';
import { moveIntegrationSuite } from '../../db/test/move-suite.js';

moveIntegrationSuite({
  name: 'MySQL 8 → MySQL 8',
  kind: 'mysql',
  driver: () => mysql(),
  async start() {
    const c = await new MySqlContainer('mysql:8.0').withRootPassword('secret').withDatabase('app').start();
    return { host: c.getHost(), port: c.getPort(), user: 'root', password: 'secret', database: 'app', stop: async () => void (await c.stop()) };
  },
});
