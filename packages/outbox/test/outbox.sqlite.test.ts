import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sqlite } from '@tenancy-node/db-sqlite';
import { outboxSuite } from './outbox-suite.js';

let directory = '';
outboxSuite({
  name: 'SQLite 3',
  driver: () => sqlite({ directory }),
  async start() {
    directory = await mkdtemp(path.join(tmpdir(), 'tenancy-outbox-sqlite-'));
    return { url: 'sqlite://local/central', stop: () => rm(directory, { recursive: true, force: true }) };
  },
});
