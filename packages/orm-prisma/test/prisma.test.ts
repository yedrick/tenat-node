import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTenancy, type TenancyPlugin } from '@tenancy-node/core';
import type { DatabaseExtension, MigrationContext } from '@tenancy-node/db';
import { prismaIntegration, prismaMigrator } from '@tenancy-node/orm-prisma';
import { MemoryLogger } from '@tenancy-node/testing';
import { describe, expect, it } from 'vitest';

/** Reemplazo del PrismaClient generado (el real necesita `prisma generate`). */
class FakePrismaClient {
  static created: FakePrismaClient[] = [];
  disconnected = false;
  constructor(readonly options: { datasourceUrl: string }) {
    FakePrismaClient.created.push(this);
  }
  async $disconnect() {
    this.disconnected = true;
  }
}

/** Plugin mínimo que imita a @tenancy-node/db: una "base" por tenant. */
const fakeDatabase: TenancyPlugin<Pick<DatabaseExtension, 'database'>> = {
  name: 'fake-db',
  setup: () => ({}),
  extend: (tenancy) => ({
    database: {
      connection: () => {
        const tenant = tenancy.currentOrFail();
        return {
          key: `default/tenant_${tenant.id.value}/~shared`,
          kind: 'postgres' as const,
          options: { host: 'h', port: 5432, user: 'u', database: `tenant_${tenant.id.value}` },
          url: `postgres://u@h:5432/tenant_${tenant.id.value}`,
          native: {},
          tenant,
        };
      },
    } as unknown as DatabaseExtension['database'],
  }),
};

describe('Prisma integration', () => {
  it('creates one PrismaClient per tenant with its datasourceUrl, bounded by an LRU', async () => {
    const tenancy = createTenancy({
      logger: new MemoryLogger(),
      plugins: [
        fakeDatabase,
        prismaIntegration({ client: FakePrismaClient, maxClients: 2, graceMs: 0 }),
      ],
    });
    for (const id of ['aa', 'bb', 'cc']) await tenancy.tenants.create({ id });
    const aa = await tenancy.run('aa', () => tenancy.prisma());
    expect(aa.options.datasourceUrl).toBe('postgres://u@h:5432/tenant_aa');
    expect(await tenancy.run('aa', () => tenancy.prisma())).toBe(aa);
    await tenancy.run('bb', () => tenancy.prisma());
    await tenancy.run('cc', () => tenancy.prisma());
    await new Promise((r) => setTimeout(r, 10));
    expect(aa.disconnected).toBe(true);

    const bb = FakePrismaClient.created.find((c) => c.options.datasourceUrl.endsWith('tenant_bb'))!;
    await tenancy.tenants.delete('bb');
    await new Promise((r) => setTimeout(r, 10));
    expect(bb.disconnected).toBe(true);
    await tenancy.close();
    expect(FakePrismaClient.created.every((c) => c.disconnected)).toBe(true);
  });

  it('runs prisma migrate deploy with the tenant DATABASE_URL', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'prisma-'));
    const fake = path.join(dir, 'fake-prisma.cjs');
    await writeFile(
      fake,
      `require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'url.txt'))}, process.env.DATABASE_URL + ' ' + process.argv.slice(2).join(' '));
if (process.env.DATABASE_URL.includes('broken')) { console.error('P1001: cannot reach database'); process.exit(1); }
console.log('Applying migration \`20260101_init\`');
console.log('Applying migration \`20260102_ventas\`');`,
    );
    const migrator = prismaMigrator({
      command: `node ${JSON.stringify(fake)}`,
      schema: 'prisma/schema.prisma',
    });
    const context = (url: string): MigrationContext => ({
      tenant: null,
      kind: 'postgres',
      connection: { host: 'h', port: 1, user: 'u' },
      url,
      native: {
        query: async () => ({
          rows: [{ migration_name: '20260101_init', finished_at: '2026-01-01T00:00:00Z' }],
        }),
      },
    });
    const run = await migrator.latest({} as never, context('postgres://u:p@h/tenant_aa'));
    expect(run.executed).toEqual(['20260101_init', '20260102_ventas']);
    expect(await readFile(path.join(dir, 'url.txt'), 'utf8')).toBe(
      'postgres://u:p@h/tenant_aa migrate deploy --schema prisma/schema.prisma',
    );
    await expect(migrator.latest({} as never, context('postgres://broken'))).rejects.toThrow(
      /P1001/,
    );
    // status lee _prisma_migrations con la conexión Kysely del tenant.
    const rows = [{ migration_name: '20260101_init', finished_at: '2026-01-01T00:00:00Z' }];
    const chain = { select: () => chain, where: () => chain, orderBy: () => chain, execute: async () => rows };
    const tenantDb = { selectFrom: (table: string) => (expect(table).toBe('_prisma_migrations'), chain) };
    expect(await migrator.status(tenantDb as never, context('x'))).toEqual([
      { name: '20260101_init', executedAt: new Date('2026-01-01T00:00:00Z') },
    ]);
    await expect(migrator.rollback({} as never)).rejects.toThrow(/forward-only/);
    await expect(migrator.latest({} as never)).rejects.toThrow(/context/);
    await expect(migrator.latest({} as never, { ...context('mssql://x'), kind: 'mssql' })).rejects.toThrow(
      /does not support the mssql driver/,
    );
  });
});
