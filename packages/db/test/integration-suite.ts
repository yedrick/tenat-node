import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createTenancy,
  TenantAlreadyExistsError,
  TenantId,
  TenantNotIdentifiedError,
  TenantProvisioningError,
  Tenant,
  type EventEnvelope,
} from '@tenancy-node/core';
import {
  database,
  Encrypter,
  generateEncryptionKey,
  KyselyDomainRepository,
  KyselyTenantRepository,
  NoDatabaseServerAvailableError,
  TablePrefixPlugin,
  type AnyKysely,
  type CentralDb,
  type DatabaseDriver,
  type DatabasePluginOptions,
} from '@tenancy-node/db';
import {
  domainRepositoryContract,
  MemoryLogger,
  tenantRepositoryContract,
} from '@tenancy-node/testing';
import type { Migration } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

export interface IntegrationTarget {
  name: string;
  driver: () => DatabaseDriver;
  /** Correr la suite en modo schema (PostgreSQL). */
  isolation?: 'database' | 'schema';
  /** Lo que el motor no tiene se saltea (SQLite: sin usuarios por tenant ni information_schema). */
  capabilities?: { perTenantCredentials?: boolean; schemaGeneration?: boolean };
  /** Levanta el motor y devuelve la URL de un usuario con permiso de CREATE DATABASE. */
  start(): Promise<{ url: string; stop(): Promise<void> }>;
}

const productos: Migration = {
  up: (db) =>
    db.schema
      .createTable('productos')
      .addColumn('id', 'integer', (c) => c.primaryKey())
      .addColumn('nombre', 'varchar(100)', (c) => c.notNull())
      .addColumn('precio', 'integer', (c) => c.notNull())
      .execute(),
  down: (db) => db.schema.dropTable('productos').execute(),
};
const ventas: Migration = {
  up: (db) =>
    db.schema
      .createTable('ventas')
      .addColumn('id', 'integer', (c) => c.primaryKey())
      .execute(),
  down: (db) => db.schema.dropTable('ventas').execute(),
};

const seedProductos = async (db: AnyKysely, tenant: Tenant) => {
  await db
    .insertInto('productos')
    .values({ id: 1, nombre: `Camiseta ${tenant.id.value}`, precio: 100 })
    .execute();
};

async function tableNames(db: AnyKysely): Promise<string[]> {
  return (await db.introspection.getTables()).map((t) => t.name);
}

/** Tablas del tenant del contexto (en modo schema, solo las de su schema). */
async function tenantTables(tenancy: { database: { tables(): Promise<{ name: string }[]> } }): Promise<string[]> {
  return (await tenancy.database.tables()).map((t) => t.name);
}

/** Suite de integración que todo driver de base debe pasar contra un motor real. */
export function databaseIntegrationSuite(target: IntegrationTarget): void {
  describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')(
    `database integration: ${target.name}`,
    () => {
      let url = '';
      let stop: (() => Promise<void>) | undefined;
      let counter = 0;
      const open: { close(): Promise<void> }[] = [];

      beforeAll(async () => {
        ({ url, stop } = await target.start());
      }, 300_000);
      afterEach(async () => {
        for (const t of open.splice(0)) await t.close();
      });
      afterAll(async () => {
        await stop?.();
      });

      const make = async (options: Partial<DatabasePluginOptions> = {}, n = ++counter) => {
        const logger = new MemoryLogger();
        const tenancy = createTenancy({
          centralDomains: ['app.test'],
          logger,
          plugins: [
            database({
              driver: target.driver(),
              central: { url },
              tablePrefix: `t${n}_`,
              prefix: `tn${n}_`,
              migrations: { tenant: { '001_productos': productos } },
              seed: seedProductos,
                          pool: { idleTimeoutMs: 0 },
            ...(target.isolation ? { isolation: target.isolation } : {}),
            ...options,}),
          ],
        });
        open.push(tenancy);
        await tenancy.database.install();
        return { tenancy, logger, n };
      };

      const centralOf = (
        tenancy: Awaited<ReturnType<typeof make>>['tenancy'],
        n: number,
      ): CentralDb => {
        const driver = target.driver();
        return {
          db: tenancy
            .centralDb()
            .withPlugin(new TablePrefixPlugin(`t${n}_`)) as unknown as CentralDb['db'],
          kind: driver.kind,
          driver,
        };
      };

          const schemaMode = target.isolation === 'schema';
    const perTenant = target.capabilities?.perTenantCredentials ?? true;
    const schemaGeneration = target.capabilities?.schemaGeneration ?? true;
    const adminDb = (database?: string) => {
      const driver = target.driver();
      const u = new URL(url);
      const connection = driver.connect(
        {
          host: u.hostname,
          port: Number(u.port),
          user: decodeURIComponent(u.username),
          password: decodeURIComponent(u.password),
          database: database ?? driver.adminDatabase,
        },
        { max: 1 },
      );
      open.push({ close: () => connection.destroy() });
      return { driver, db: connection.db, host: u.hostname, port: Number(u.port), central: u.pathname.slice(1) };
    };

      tenantRepositoryContract(`KyselyTenantRepository (${target.name})`, async () => {
        const { tenancy, n } = await make();
        return new KyselyTenantRepository(centralOf(tenancy, n));
      });

      domainRepositoryContract(`KyselyDomainRepository (${target.name})`, async () => {
        const { tenancy, n } = await make();
        const central = centralOf(tenancy, n);
        const tenants = new KyselyTenantRepository(central);
        for (const id of ['bolivar', 'tigre']) {
          await tenants.insert(
            Tenant.create({ id: TenantId.create(id), name: id, now: new Date() }),
          );
        }
        return new KyselyDomainRepository(central);
      });

      it('installs every central table, idempotently', async () => {
        const { tenancy, n } = await make();
        expect((await tenancy.database.install()).executed).toEqual([]);
        const tables = await tableNames(tenancy.centralDb());
        for (const name of [
          'database_servers',
          'tenants',
          'domains',
          'provisioning_steps',
          'event_outbox',
          'webhook_endpoints',
          'webhook_deliveries',
          'admin_users',
          'admin_sessions',
          'impersonation_tokens',
          'audit_log',
          'migrations',
        ]) {
          expect(tables).toContain(`t${n}_${name}`);
        }
        expect((await tenancy.database.servers.list()).map((s) => s.id)).toEqual(['default']);
      });

      it.skipIf(!schemaGeneration)('generates Prisma, Drizzle and TypeORM models from the real central tables', async () => {
        const { tenancy, n } = await make();
        const prisma = await tenancy.database.schema('prisma');
        expect(prisma).toContain('model TenancyTenants {');
        expect(prisma).toContain(`@@map("t${n}_tenants")`);
        expect(prisma).toMatch(/ {2}id String @id @db\.VarChar\(40\)/);
        expect(prisma).toMatch(
          / {2}databaseName String\? @map\("database_name"\) @db\.VarChar\(64\)/,
        );
        expect(prisma).toMatch(/ {2}id BigInt @id @default\(autoincrement\(\)\)/);
        expect(prisma).toMatch(/ {2}data Json\n/);
        expect(prisma).not.toContain('_migrations');
        const drizzle = await tenancy.database.schema('drizzle');
        expect(drizzle).toContain(
          `export const tenancyTenants = ${target.driver().kind === 'mysql' ? 'mysqlTable' : 'pgTable'}('t${n}_tenants', {`,
        );
        expect(drizzle).toContain("id: varchar('id', { length: 40 }).primaryKey(),");
        const typeorm = await tenancy.database.schema('typeorm');
        expect(typeorm).toContain(`@Entity('t${n}_domains')`);
        expect(typeorm).toContain('@PrimaryGeneratedColumn');
        if (target.driver().kind === 'mysql') {
          // La columna generada (un solo dominio principal) no se escribe desde el ORM
          expect(prisma).toMatch(/primaryTenantId String\? @map\("primary_tenant_id"\) @ignore/);
        }
      });

      it('provisions tenants with their own isolated database', async () => {
        const { tenancy, logger, n } = await make();
        const events: string[] = [];
        tenancy.events.on('database.*', (e) => void events.push(`${e.type}:${e.tenantId}`), {
          mode: 'sync',
        });

        const bolivar = await tenancy.tenants.create({ id: 'bolivar', domain: 'bolivar.com' });
        await tenancy.tenants.create({ id: 'tigre', domain: 'tigre.com' });
        expect(bolivar.status).toBe('active');
        expect(bolivar.database).toMatchObject({
          serverId: 'default',
          name: `tn${n}_bolivar`,
          username: null,
        });
        expect(events).toEqual([
          'database.created:bolivar',
          'database.migrated:bolivar',
          'database.seeded:bolivar',
          'database.created:tigre',
          'database.migrated:tigre',
          'database.seeded:tigre',
        ]);
        const steps = await tenancy.database.provisioningSteps('bolivar');
        expect(steps.map((s) => [s.step, s.status])).toEqual([
          ['placement', 'completed'],
          ['createDatabase', 'completed'],
          ['createUser', 'skipped'],
          ['migrate', 'completed'],
          ['seed', 'completed'],
        ]);
        expect(
          logger.find(
            (e) => e.fields.operation === 'provisioning.step' && e.fields.tenantId === 'bolivar',
          ),
        ).toHaveLength(5);

        await tenancy.run('bolivar', async () => {
          await tenancy
            .db()
            .insertInto('productos')
            .values({ id: 2, nombre: 'Gorra', precio: 30 })
            .execute();
          const rows = await tenancy.sql<{
            nombre: string;
          }>`SELECT nombre FROM productos WHERE precio > ${50} ORDER BY id`;
          expect(rows.map((r) => r.nombre)).toEqual(['Camiseta bolivar']);
          const central = await tenancy
            .centralDb()
            .selectFrom(`t${n}_tenants`)
            .select('id')
            .orderBy('id')
            .execute();
          expect(central.map((r: { id: string }) => r.id)).toEqual(['bolivar', 'tigre']);
          expect(tenancy.pool()).toBeTruthy();
        });
        const tigre = await tenancy.run('tigre', () =>
          tenancy.db().selectFrom('productos').select('nombre').execute(),
        );
        expect(tigre).toEqual([{ nombre: 'Camiseta tigre' }]);
        expect(() => tenancy.db()).toThrow(TenantNotIdentifiedError);

        // Otro proceso (otra instancia) ve el mismo estado desde la base central
        const other = await make({}, n);
        const resolution = await other.tenancy.resolve({ host: 'bolivar.com', headers: {} });
        expect(resolution.kind === 'tenant' && resolution.tenant.database?.name).toBe(
          `tn${n}_bolivar`,
        );
        const count = await other.tenancy.run('bolivar', () =>
          other.tenancy
            .db()
            .selectFrom('productos')
            .select((eb) => eb.fn.countAll().as('n'))
            .executeTakeFirstOrThrow(),
        );
        expect(Number(count.n)).toBe(2);
      });

      it.skipIf(!perTenant)('creates a database user per tenant with an encrypted password', async () => {
        const key = generateEncryptionKey();
        const { tenancy, n } = await make({ credentials: 'per-tenant', encryptionKey: key });
        const bolivar = await tenancy.tenants.create({ id: 'bolivar' });
        const tigre = await tenancy.tenants.create({ id: 'tigre' });
        expect(bolivar.database?.username).toBe(`tn${n}_bolivar`);
        expect(bolivar.database?.passwordEncrypted).toMatch(/^tn1\./);
        const tenantUrl = new URL(await tenancy.database.connectionUrl('bolivar'));
        expect(decodeURIComponent(tenantUrl.username)).toBe(`tn${n}_bolivar`);
        if (schemaMode) {
        expect(tenantUrl.searchParams.get('options')).toBe(`-c search_path=tn${n}_bolivar`);
      } else {
        expect(tenantUrl.pathname).toBe(`/tn${n}_bolivar`);
      }

        // La app usa el usuario propio del tenant
        const rows = await tenancy.run('bolivar', () =>
          tenancy.db().selectFrom('productos').selectAll().execute(),
        );
        expect(rows).toHaveLength(1);

        // Con la contraseña real, el usuario de bolivar entra a su base pero no a la de tigre
        const { driver, host, port } = adminDb();
        const password = new Encrypter(key).decrypt(bolivar.database!.passwordEncrypted!);
        const central = new URL(url).pathname.slice(1);
      const own = driver.connect(
        { host, port, user: bolivar.database!.username!, password, database: schemaMode ? central : bolivar.database!.name },
        { max: 1, ...(schemaMode ? { schema: bolivar.database!.schema! } : {}) },
      );
      const intruder = driver.connect(
        { host, port, user: bolivar.database!.username!, password, database: schemaMode ? central : tigre.database!.name },
        { max: 1 },
      );
      try {
        expect(await own.db.selectFrom('productos').selectAll().execute()).toHaveLength(1);
        // Modo base: no puede conectarse a la base de tigre. Modo schema: no puede leer el schema de tigre.
        await expect(
          (schemaMode ? intruder.db.withSchema(tigre.database!.schema!) : intruder.db).selectFrom('productos').selectAll().execute(),
        ).rejects.toThrow();
        if (schemaMode) {
          // Ni las tablas centrales (contraseñas cifradas, secretos) de la base compartida
          await expect(intruder.db.selectFrom(`t${n}_tenants`).selectAll().execute()).rejects.toThrow();
        }
      } finally {
          await own.destroy();
          await intruder.destroy();
        }
      });

      it('retries a failed provisioning without repeating completed steps', async () => {
        let calls = 0;
        const { tenancy } = await make({
          seed: async (db, tenant) => {
            calls++;
            await seedProductos(db, tenant);
            if (calls === 1) throw new Error('mail server down');
          },
        });
        await expect(tenancy.tenants.create({ id: 'bolivar' })).rejects.toThrow(
          TenantProvisioningError,
        );
        expect((await tenancy.tenants.find('bolivar'))?.status).toBe('failed');
        expect(
          tenancy.observability.errors({ tenantId: 'bolivar' }).map((e) => e.operation),
        ).toContain('provisioning.step');

        // El seed del primer intento insertó una fila antes de fallar: se borra para simular un seed transaccional.
        await tenancy.run('bolivar', () => tenancy.db().deleteFrom('productos').execute());
        const retried = await tenancy.tenants.retryProvisioning('bolivar');
        expect(retried.status).toBe('active');
        const last = (await tenancy.database.provisioningSteps('bolivar')).slice(-4);
        expect(last.map((s) => [s.step, s.status, s.attempt])).toEqual([
          ['createDatabase', 'skipped', 2],
          ['createUser', 'skipped', 2],
          ['migrate', 'skipped', 2],
          ['seed', 'completed', 2],
        ]);
        const rows = await tenancy.run('bolivar', () =>
          tenancy.db().selectFrom('productos').selectAll().execute(),
        );
        expect(rows).toHaveLength(1);
      });

      it('drops the new database when provisioning fails and cleanupOnFailure is on', async () => {
        const { tenancy, n } = await make({
          cleanupOnFailure: true,
          migrations: {
            tenant: {
              '001_bad': {
                up: async (db: AnyKysely) => {
                  await db.selectFrom('no_such_table').selectAll().execute();
                },
              },
            },
          },
        });
        await expect(tenancy.tenants.create({ id: 'bolivar' })).rejects.toThrow(
          TenantProvisioningError,
        );
        const { driver, db } = adminDb();
        expect(await driver.databaseExists(db, `tn${n}_bolivar`)).toBe(false);
        const steps = await tenancy.database.provisioningSteps('bolivar');
        expect(steps.map((s) => [s.step, s.status])).toContainEqual(['cleanup', 'completed']);
        expect(steps.find((s) => s.step === 'migrate')?.error).toBeTruthy();
      });

      it('never creates the same tenant twice', async () => {
        const { tenancy } = await make();
        const results = await Promise.allSettled([
          tenancy.tenants.create({ id: 'bolivar' }),
          tenancy.tenants.create({ id: 'bolivar' }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(
          (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
        ).toBeInstanceOf(TenantAlreadyExistsError);
      });

      it('spreads tenants across servers and respects their limits', async () => {
        const { tenancy } = await make();
        const { host, port } = adminDb();
        await tenancy.database.servers.add({ id: 'default', host, port, maxTenants: 2 });
        await tenancy.database.servers.add({ id: 'second', host, port, maxTenants: 1 });

        const placed = [];
        for (const id of ['aa', 'bb', 'cc'])
          placed.push((await tenancy.tenants.create({ id })).database?.serverId);
        expect(placed).toEqual(['default', 'second', 'default']);
        await expect(tenancy.tenants.create({ id: 'dd' })).rejects.toThrow(TenantProvisioningError);
        expect(tenancy.observability.errors({ tenantId: 'dd' })[0]?.message).toContain(
          'No active database server',
        );
        expect((await tenancy.tenants.find('dd'))?.status).toBe('failed');
        expect(NoDatabaseServerAvailableError).toBeDefined();

        await tenancy.tenants.delete('bb');
        const servers = await tenancy.database.servers.list();
        expect(servers.map((s) => [s.id, s.tenantCount])).toEqual([
          ['default', 2],
          ['second', 0],
        ]);
        const ee = await tenancy.tenants.create({ id: 'ee' });
        expect(ee.database?.serverId).toBe('second');
      });

      it('deletes the tenant database and user', async () => {
        const { tenancy, n } = await make({
          ...(perTenant ? { credentials: 'per-tenant' as const } : {}),
          encryptionKey: generateEncryptionKey(),
        });
        await tenancy.tenants.create({ id: 'bolivar', domain: 'bolivar.com' });
        await tenancy.run('bolivar', () =>
          tenancy.db().selectFrom('productos').selectAll().execute(),
        );
        const deleted: EventEnvelope[] = [];
        tenancy.events.on('database.deleted', (e) => void deleted.push(e), { mode: 'sync' });

        await tenancy.tenants.delete('bolivar');
        const { driver, db } = adminDb();
        expect(await driver.databaseExists(db, `tn${n}_bolivar`)).toBe(false);
        expect(deleted).toHaveLength(1);
        expect(await tenancy.tenants.find('bolivar')).toBeUndefined();
        expect(await tenancy.domains.add('nobody', 'x.com').catch((e: Error) => e.name)).toBe(
          'TenantNotFoundError',
        );
      });

      it('migrates, reports and rolls back every tenant', async () => {
        const first = await make();
        await first.tenancy.tenants.create({ id: 'bolivar' });
        await first.tenancy.tenants.create({ id: 'tigre' });

        const { tenancy } = await make(
          { migrations: { tenant: { '001_productos': productos, '002_ventas': ventas } } },
          first.n,
        );
        const progress: string[] = [];
        const result = await tenancy.database.migrate({
          concurrency: 2,
          onTenant: (r) => void progress.push(`${r.tenantId}:${r.ok}`),
        });
        expect(progress.sort()).toEqual(['bolivar:true', 'tigre:true']);
        expect(result.succeeded.sort()).toEqual(['bolivar', 'tigre']);
        expect(result.failed).toEqual([]);
        const status = await tenancy.database.status('tigre');
        expect(status.map((s) => [s.name, s.executedAt !== null])).toEqual([
          ['001_productos', true],
          ['002_ventas', true],
        ]);

        await tenancy.database.rollback({ tenants: ['bolivar'] });
        expect(await tenancy.run('bolivar', () => tenantTables(tenancy))).not.toContain(
          'ventas',
        );
        expect(await tenancy.run('tigre', () => tenantTables(tenancy))).toContain('ventas');
        expect((await tenancy.database.seed({ tenants: ['tigre'] })).failed).toHaveLength(1);
        expect(tenancy.observability.errors({ tenantId: 'tigre' })[0]?.operation).toBe(
          'database.seed',
        );
      });

      it('applies folders of .sql migrations', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'tenancy-sql-'));
        await writeFile(
          path.join(dir, '001_init.sql'),
          "-- tabla inicial\nCREATE TABLE notas (id integer primary key, texto varchar(50));\nINSERT INTO notas VALUES (1, 'hola; mundo');\n",
        );
        await writeFile(path.join(dir, '001_init.down.sql'), 'DROP TABLE notas;\n');
        const { tenancy } = await make({ migrations: { tenant: dir }, seed: undefined });
        await tenancy.tenants.create({ id: 'bolivar' });
        const rows = await tenancy.run(
          'bolivar',
          () => tenancy.sql<{ texto: string }>`SELECT texto FROM notas`,
        );
        expect(rows).toEqual([{ texto: 'hola; mundo' }]);
      });

      it.skipIf(!perTenant)('rotates the encryption key without losing access', async () => {
        const oldKey = generateEncryptionKey();
        const newKey = generateEncryptionKey();
        const first = await make({ credentials: 'per-tenant', encryptionKey: oldKey });
        await first.tenancy.tenants.create({ id: 'bolivar' });

        const rotating = await make(
          { credentials: 'per-tenant', encryptionKey: newKey, previousKeys: [oldKey] },
          first.n,
        );
        expect((await rotating.tenancy.database.rotateKey()).updated).toBe(1);
        expect((await rotating.tenancy.database.rotateKey()).updated).toBe(0);

        const fresh = await make({ credentials: 'per-tenant', encryptionKey: newKey }, first.n);
        const rows = await fresh.tenancy.run('bolivar', () =>
          fresh.tenancy.db().selectFrom('productos').selectAll().execute(),
        );
        expect(rows).toHaveLength(1);
      });

      it('keeps concurrent requests isolated on real databases and bounds open pools', async () => {
        const { tenancy } = await make({ pool: { max: 3, maxOpenPools: 3, idleTimeoutMs: 0 } });
        const ids = ['aa', 'bb', 'cc', 'dd'];
        for (const id of ids) await tenancy.tenants.create({ id });

        const leaks: string[] = [];
        await Promise.all(
          Array.from({ length: 160 }, (_, i) => {
            const id = ids[i % ids.length]!;
            return tenancy.run(id, async () => {
              await tenancy
                .db()
                .insertInto('productos')
                .values({ id: 100 + i, nombre: `${id}-${i}`, precio: i })
                .execute();
              await new Promise((r) => setTimeout(r, Math.random() * 5));
              const rows = await tenancy
                .db()
                .selectFrom('productos')
                .select('nombre')
                .where('id', '>=', 100)
                .execute();
              for (const row of rows as { nombre: string }[]) {
                if (!row.nombre.startsWith(`${id}-`)) leaks.push(`${id} saw ${row.nombre}`);
              }
            });
          }),
        );
        expect(leaks).toEqual([]);
        for (const id of ids) {
          const rows = await tenancy.run(id, () =>
            tenancy.db().selectFrom('productos').selectAll().where('id', '>=', 100).execute(),
          );
          expect(rows).toHaveLength(40);
        }
        const stats = tenancy.database.pools();
        expect(stats.servers.default!.open).toBeLessThanOrEqual(3);
      });
    },
  );
}
