import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { postgres } from '@tenancy-node/db-postgres';
import { outboxSuite } from './outbox-suite.js';

outboxSuite({
  name: 'PostgreSQL 16',
  driver: () => postgres(),
  async start() {
    const c = await new PostgreSqlContainer('postgres:16-alpine')
      .withUsername('admin')
      .withPassword('secret')
      .withDatabase('app')
      .start();
    return {
      url: `postgres://admin:secret@${c.getHost()}:${c.getPort()}/app`,
      stop: async () => void (await c.stop()),
    };
  },
});
