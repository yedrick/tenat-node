import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sqlite } from '@tenancy-node/db-sqlite';
import { databaseIntegrationSuite } from '../../db/test/integration-suite.js';
import type { Database } from 'better-sqlite3';

let directory = '';

/** La misma suite de integración, con un archivo SQLite por tenant. */
databaseIntegrationSuite({
  name: 'SQLite 3',
  driver: () => sqlite({ directory }),
  nativeQuery: async (db) => (db as Database).prepare('SELECT 1').get(),
  capabilities: { perTenantCredentials: false, schemaGeneration: false },
  async start() {
    directory = await mkdtemp(path.join(tmpdir(), 'tenancy-sqlite-'));
    return { url: 'sqlite://local/central', stop: () => rm(directory, { recursive: true, force: true }) };
  },
});
