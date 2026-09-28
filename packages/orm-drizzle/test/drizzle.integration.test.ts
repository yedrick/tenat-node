import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTenancy } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { drizzleIntegration, drizzleMigrator } from '@tenancy-node/orm-drizzle';
import { MemoryLogger } from '@tenancy-node/testing';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const productos = pgTable('productos', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  precio: integer('precio').notNull(),
});
const schema = { productos };

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')(
  'Drizzle integration (PostgreSQL)',
  () => {
    let container: StartedPostgreSqlContainer;
    let url = '';
    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:16-alpine')
        .withUsername('admin')
        .withPassword('secret')
        .withDatabase('app')
        .start();
      url = `postgres://admin:secret@${container.getHost()}:${container.getPort()}/app`;
    }, 300_000);
    afterAll(async () => void (await container?.stop()));

    it('uses Drizzle over each tenant pool and applies drizzle-kit migrations', async () => {
      // Carpeta con el formato de drizzle-kit: meta/_journal.json + SQL
      const dir = await mkdtemp(path.join(tmpdir(), 'drizzle-'));
      await mkdir(path.join(dir, 'meta'));
      await writeFile(
        path.join(dir, 'meta/_journal.json'),
        JSON.stringify({
          version: '7',
          dialect: 'postgresql',
          entries: [
            { idx: 0, version: '7', when: 1767225600000, tag: '0000_init', breakpoints: true },
          ],
        }),
      );
      await writeFile(
        path.join(dir, '0000_init.sql'),
        'CREATE TABLE "productos" ("id" serial PRIMARY KEY, "nombre" text NOT NULL, "precio" integer NOT NULL);',
      );

      const tenancy = createTenancy({
        logger: new MemoryLogger(),
        plugins: [
          database({
            driver: postgres(),
            central: { url },
            migrations: { tenant: drizzleMigrator({ drizzle, migrate, migrationsFolder: dir }) },
          }),
          drizzleIntegration({ drizzle }),
        ],
      });
      await tenancy.database.install();
      await tenancy.tenants.create({ id: 'bolivar' });
      await tenancy.tenants.create({ id: 'tigre' });

      await tenancy.run('bolivar', async () => {
        const db = tenancy.drizzle<NodePgDatabase<typeof schema>>(schema);
        await db.insert(productos).values([
          { nombre: 'Camiseta', precio: 100 },
          { nombre: 'Gorra', precio: 30 },
        ]);
        expect(tenancy.drizzle(schema)).toBe(db);
        const caras = await db
          .select({ nombre: productos.nombre })
          .from(productos)
          .where(eq(productos.precio, 100));
        expect(caras).toEqual([{ nombre: 'Camiseta' }]);
        expect(await db.query.productos.findMany({ columns: { nombre: true } })).toHaveLength(2);
      });
      const tigre = await tenancy.run('tigre', () =>
        tenancy.drizzle<NodePgDatabase>().select().from(productos),
      );
      expect(tigre).toEqual([]);

      const status = await tenancy.database.status('tigre');
      expect(status).toHaveLength(1);
      expect(status[0]!.executedAt).toBeInstanceOf(Date);
      const again = await tenancy.database.migrate();
      expect(again.succeeded.sort()).toEqual(['bolivar', 'tigre']);
      await expect(tenancy.database.rollback({ tenants: ['tigre'] })).resolves.toMatchObject({
        failed: [{ tenantId: 'tigre' }],
      });
      await tenancy.close();
    });
  },
);
