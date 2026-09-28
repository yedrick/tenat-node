import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { postgres } from '@tenancy-node/db-postgres';
import { moveIntegrationSuite } from '../../db/test/move-suite.js';

moveIntegrationSuite({
  name: 'PostgreSQL 16 → PostgreSQL 16',
  kind: 'postgres',
  driver: () => postgres(),
  async start() {
    const c = await new PostgreSqlContainer('postgres:16-alpine').withUsername('admin').withPassword('secret').withDatabase('app').start();
    return { host: c.getHost(), port: c.getPort(), user: 'admin', password: 'secret', database: 'app', stop: async () => void (await c.stop()) };
  },
});
