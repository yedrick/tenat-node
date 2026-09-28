import { MemoryLogger } from '@tenancy-node/testing';
import { Tenant, TenantId } from '@tenancy-node/core';
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import {
  ConnectionPoolRegistry,
  DecryptionError,
  EncryptionKeyMissingError,
  Encrypter,
  InvalidDatabaseConfigError,
  InvalidEncryptionKeyError,
  TablePrefixPlugin,
  centralMigrations,
  databaseNameFor,
  generateEncryptionKey,
  generatePassword,
  parseConnectionUrl,
  rankServers,
  splitSqlStatements,
  usernameFor,
  type AnyDB,
  type DatabaseServer,
  type OpenedConnection,
} from '@tenancy-node/db';

describe('Encrypter', () => {
  it('encrypts with AES-256-GCM and never stores plain text', () => {
    const e = new Encrypter(generateEncryptionKey());
    const value = e.encrypt('s3cret-password');
    expect(value).toMatch(/^tn1\.[0-9a-f]{8}\./);
    expect(value).not.toContain('s3cret');
    expect(e.encrypt('same')).not.toBe(e.encrypt('same'));
    expect(e.decrypt(value)).toBe('s3cret-password');
  });

  it('rotates keys keeping old values readable', () => {
    const oldKey = generateEncryptionKey();
    const newKey = generateEncryptionKey();
    const before = new Encrypter(oldKey).encrypt('pw');
    const after = new Encrypter(newKey, [oldKey]);
    expect(after.decrypt(before)).toBe('pw');
    expect(after.needsRotation(before)).toBe(true);
    const rotated = after.rotate(before);
    expect(after.needsRotation(rotated)).toBe(false);
    expect(new Encrypter(newKey).decrypt(rotated)).toBe('pw');
    expect(() => new Encrypter(newKey).decrypt(before)).toThrow(/no key/);
  });

  it('detects tampering, bad formats and bad keys', () => {
    const e = new Encrypter(generateEncryptionKey());
    const value = e.encrypt('pw');
    const parts = value.split('.');
    parts[4] = Buffer.from('other').toString('base64url');
    expect(() => e.decrypt(parts.join('.'))).toThrow(DecryptionError);
    expect(() => e.decrypt('plain')).toThrow(DecryptionError);
    expect(() => new Encrypter('base64:c2hvcnQ=')).toThrow(InvalidEncryptionKeyError);
    expect(() => new Encrypter().encrypt('x')).toThrow(EncryptionKeyMissingError);
    expect(new Encrypter('a'.repeat(64)).hasKey).toBe(true);
    expect(new Encrypter().currentKeyId).toBeUndefined();
  });
});

describe('naming', () => {
  it('builds safe database and user names', () => {
    const naming = { prefix: 'tenant_', suffix: '', tablePrefix: 'tenancy_' };
    expect(databaseNameFor('club-bolivar', naming, 64)).toBe('tenant_club_bolivar');
    expect(() =>
      databaseNameFor('a'.repeat(40), { ...naming, suffix: '_' + 'x'.repeat(30) }, 64),
    ).toThrow(InvalidDatabaseConfigError);
    expect(() => databaseNameFor('ok', { ...naming, prefix: 'bad-' }, 64)).toThrow(
      InvalidDatabaseConfigError,
    );
    expect(usernameFor('bolivar', 'tenant_', 32)).toBe('tenant_bolivar');
    const long = usernameFor('a'.repeat(40), 'tenant_', 32);
    expect(long).toHaveLength(32);
    expect(long).not.toBe(usernameFor(`${'a'.repeat(39)}b`, 'tenant_', 32));
    expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('parses connection URLs', () => {
    expect(parseConnectionUrl('mysql://root:p%40ss@db.local:3307/miapp', 3306)).toEqual({
      host: 'db.local',
      port: 3307,
      user: 'root',
      password: 'p@ss',
      database: 'miapp',
    });
    expect(parseConnectionUrl('postgres://u@h', 5432)).toMatchObject({
      port: 5432,
      password: undefined,
      database: undefined,
    });
    expect(() => parseConnectionUrl('not a url', 1)).toThrow(InvalidDatabaseConfigError);
  });
});

describe('placement', () => {
  const server = (id: string, tenantCount: number, weight = 1): DatabaseServer => ({
    id,
    driver: 'mysql',
    host: 'h',
    port: 1,
    adminUsername: null,
    adminPasswordEncrypted: null,
    maxTenants: null,
    tenantCount,
    weight,
    isActive: true,
  });
  const tenant = Tenant.create({ id: TenantId.create('bolivar'), name: 'B', now: new Date() });

  it('ranks servers by strategy', async () => {
    const servers = [server('a', 5), server('b', 1), server('c', 1, 1), server('d', 4, 4)];
    expect(await rankServers('least-tenants', { tenant, servers })).toEqual(['b', 'c', 'd', 'a']);
    expect(await rankServers('weighted', { tenant, servers })).toEqual(['d', 'b', 'c', 'a']);
    expect(await rankServers({ fixed: 'x' }, { tenant, servers })).toEqual(['x']);
    expect(
      await rankServers(async ({ tenant: t }) => `by-${t.id.value}`, { tenant, servers }),
    ).toEqual(['by-bolivar']);
  });
});

describe('splitSqlStatements', () => {
  it('splits on semicolons at end of line and drops comments', () => {
    expect(
      splitSqlStatements(`-- crear tabla; con punto y coma
CREATE TABLE a (x text DEFAULT 'a;b');
INSERT INTO a VALUES ('1');  
  
-- fin`),
    ).toEqual(["CREATE TABLE a (x text DEFAULT 'a;b')", "INSERT INTO a VALUES ('1')"]);
  });
});

describe('ConnectionPoolRegistry', () => {
  const fakeConnection = () => {
    const destroy = vi.fn(async () => {});
    const connection = { db: {} as never, native: {}, destroy } satisfies OpenedConnection;
    return { connection, destroy };
  };

  it('reuses pools, evicts the least recently used idle pool per server and never closes one in use', async () => {
    let now = 0;
    const logger = new MemoryLogger();
    const registry = new ConnectionPoolRegistry({
      maxOpenPools: 2,
      idleTimeoutMs: 0,
      logger,
      now: () => now,
    });
    const opened = new Map<string, ReturnType<typeof fakeConnection>>();
    const open = (key: string) => () => {
      const c = fakeConnection();
      opened.set(key, c);
      return c.connection;
    };

    const a = registry.acquire('s1', 'a', open('a'));
    a.release();
    const a2 = registry.acquire('s1', 'a', open('a-again'));
    expect(opened.has('a-again')).toBe(false);
    const b = registry.acquire('s1', 'b', open('b'));
    b.release();
    now = 10;
    registry.acquire('s2', 'other', open('other')).release();
    const c = registry.acquire('s1', 'c', open('c'));
    // 'a' está en uso y 'b' está libre: se cierra 'b'
    expect(opened.get('b')!.destroy).toHaveBeenCalledOnce();
    expect(opened.get('a')!.destroy).not.toHaveBeenCalled();
    expect(registry.stats().servers).toEqual({
      s1: { open: 2, inUse: 2, maxOpenPools: 2 },
      s2: { open: 1, inUse: 0, maxOpenPools: 2 },
    });

    // Todos en uso: se excede temporalmente y se avisa
    registry.acquire('s1', 'd', open('d'));
    expect(logger.find((e) => e.fields.operation === 'db.pool.limit')).toHaveLength(1);

    // Cerrar mientras está en uso: se cierra al liberar
    await registry.closeWhere((key) => key === 'a');
    expect(opened.get('a')!.destroy).not.toHaveBeenCalled();
    a2.release();
    a2.release();
    await Promise.resolve();
    expect(opened.get('a')!.destroy).toHaveBeenCalledOnce();
    c.release();
    // Al liberar, el registro vuelve al límite (2 pools en s1)
    expect(registry.stats().servers.s1!.open).toBe(2);
    await registry.closeAll();
    expect(opened.get('c')!.destroy).toHaveBeenCalledOnce();
    expect(registry.stats().pools).toEqual([]);
  });

  it('closes idle pools after the timeout and logs close failures', async () => {
    let now = 0;
    const logger = new MemoryLogger();
    const registry = new ConnectionPoolRegistry({ idleTimeoutMs: 1000, logger, now: () => now });
    const broken = {
      db: {} as never,
      native: {},
      destroy: async () => Promise.reject(new Error('nope')),
    };
    registry.acquire('s', 'x', () => broken).release();
    now = 500;
    registry.sweepIdle();
    expect(registry.stats().pools).toHaveLength(1);
    now = 1000;
    registry.sweepIdle();
    await registry.closeAll();
    expect(registry.stats().pools).toHaveLength(0);
    expect(
      logger.find((e) => e.fields.operation === 'db.pool.close' && e.level === 'error'),
    ).toHaveLength(1);
  });
});

describe('central schema', () => {
  const capture = async (kind: 'mysql' | 'postgres') => {
    const queries: CompiledQuery[] = [];
    const db = new Kysely<AnyDB>({
      dialect: {
        createAdapter: () => (kind === 'mysql' ? new MysqlAdapter() : new PostgresAdapter()),
        createDriver: () => new DummyDriver(),
        createIntrospector: (d) =>
          kind === 'mysql' ? new MysqlIntrospector(d) : new PostgresIntrospector(d),
        createQueryCompiler: () =>
          kind === 'mysql' ? new MysqlQueryCompiler() : new PostgresQueryCompiler(),
      },
      log: (event) => void queries.push(event.query),
    });
    const migrations = centralMigrations('tenancy_', kind);
    await Object.values(migrations)[0]!.up(db);
    return queries.map((q) => q.sql).join(';\n');
  };

  it('generates MySQL DDL with InnoDB, utf8mb4 and the single-primary trick', async () => {
    const ddl = await capture('mysql');
    expect(ddl).toContain('create table `tenancy_tenants`');
    expect(ddl).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
    expect(ddl).toContain('generated always as (IF(is_primary, tenant_id, NULL)) stored');
    expect(ddl).toContain('ON UPDATE CURRENT_TIMESTAMP(3)');
    expect(ddl).toContain('references `tenancy_database_servers` (`id`) on delete restrict');
    expect(ddl).toMatch(
      /constraint `tenancy_chk_tenants_status` check \(`status` IN \('provisioning',/,
    );
    expect(ddl.match(/create table/g)).toHaveLength(11);
  });

  it('generates PostgreSQL DDL with JSONB, identities and partial indexes', async () => {
    const ddl = await capture('postgres');
    expect(ddl).toContain('"data" jsonb not null');
    expect(ddl).toContain('generated always as identity primary key');
    expect(ddl).toContain(
      'create unique index "tenancy_uq_domains_one_primary" on "tenancy_domains" ("tenant_id") where "is_primary" = true',
    );
    expect(ddl).toContain('"created_at" timestamptz default now() not null');
    expect(ddl.match(/create table/g)).toHaveLength(11);
  });

  it('prefixes table names in queries', () => {
    const db = new Kysely<{ tenants: { id: string } }>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (d) => new PostgresIntrospector(d),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    }).withPlugin(new TablePrefixPlugin('app_'));
    expect(db.selectFrom('tenants').select('tenants.id').compile().sql).toBe(
      'select "app_tenants"."id" from "app_tenants"',
    );
  });
});

describe('database plugin setup', () => {
  it('reports a bad migrations path instead of crashing the process', async () => {
    const { createTenancy } = await import('@tenancy-node/core');
    const { database } = await import('@tenancy-node/db');
    const destroy = vi.fn(async () => {});
    const driver = {
      name: 'mysql',
      kind: 'mysql',
      defaultPort: 3306,
      maxIdentifierLength: 64,
      maxUserLength: 32,
      adminDatabase: undefined,
      connect: () => ({
        db: new Kysely<AnyDB>({
          dialect: {
            createAdapter: () => new MysqlAdapter(),
            createDriver: () => new DummyDriver(),
            createIntrospector: (d) => new MysqlIntrospector(d),
            createQueryCompiler: () => new MysqlQueryCompiler(),
          },
        }),
        native: {},
        destroy,
      }),
    } as never;
    const logger = new MemoryLogger();
    const tenancy = createTenancy({
      logger,
      plugins: [
        database({
          driver,
          central: { url: 'mysql://root@localhost/app' },
          migrations: { tenant: '/no/such/dir' },
        }),
      ],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(tenancy.observability.errors()[0]).toMatchObject({
      operation: 'database.migrations.load',
      code: 'ENOENT',
    });
    await expect(tenancy.database.migrate()).rejects.toThrow(/ENOENT/);
    await tenancy.close();
    expect(destroy).toHaveBeenCalled();
  });
});

describe('withTransientRetry', () => {
  it('retries deadlocks and gives up on other errors', async () => {
    const { withTransientRetry } = await import('@tenancy-node/db');
    const driver = {
      isTransientError: (e: unknown) => (e as { errno?: number }).errno === 1213,
    } as never;
    let calls = 0;
    const result = await withTransientRetry(driver, async () => {
      if (++calls < 3) throw Object.assign(new Error('Deadlock found'), { errno: 1213 });
      return 'ok';
    });
    expect([result, calls]).toEqual(['ok', 3]);
    calls = 0;
    await expect(
      withTransientRetry(driver, async () => {
        calls++;
        throw Object.assign(new Error('Deadlock found'), { errno: 1213 });
      }),
    ).rejects.toThrow('Deadlock');
    expect(calls).toBe(3);
    await expect(
      withTransientRetry(driver, async () => Promise.reject(new Error('syntax error'))),
    ).rejects.toThrow('syntax');
  });
});
