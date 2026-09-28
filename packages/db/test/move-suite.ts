import { createTenancy, type EventEnvelope } from '@tenancy-node/core';
import {
  database,
  DatabaseServerNotFoundError,
  generateEncryptionKey,
  TenantMoveError,
  type AnyKysely,
  type DatabaseDriver,
  type DatabasePluginOptions,
} from '@tenancy-node/db';
import { MemoryLogger } from '@tenancy-node/testing';
import { sql, type Migration } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

export interface MoveTarget {
  name: string;
  kind: 'postgres' | 'mysql';
  driver: () => DatabaseDriver;
  /** Levanta un servidor y devuelve host, puerto y un usuario con permiso de CREATE DATABASE. */
  start(): Promise<{ host: string; port: number; user: string; password: string; database: string; stop(): Promise<void> }>;
}

/** Esquema de prueba: claves foráneas, autorreferencia, tabla sin PK, JSON y filas sembradas por la migración. */
function migrations(kind: 'postgres' | 'mysql'): Record<string, Migration> {
  const id = kind === 'postgres' ? 'serial primary key' : 'integer primary key auto_increment';
  const json = kind === 'postgres' ? 'jsonb' : 'json';
  return {
    '001_base': {
      async up(db) {
        await sql.raw(`create table clientes (id ${id}, nombre varchar(100) not null)`).execute(db);
        await sql
          .raw(
            `create table pedidos (id ${id}, cliente_id integer not null references clientes(id) on delete restrict, total numeric(10,2) not null, meta ${json}, creado timestamp not null)`,
          )
          .execute(db);
        await sql.raw(`create table categorias (id ${id}, nombre varchar(50) not null, padre_id integer null references categorias(id))`).execute(db);
        await sql.raw('create table etiquetas (nombre varchar(50) not null, peso integer not null)').execute(db);
        await sql.raw(`create table config (id ${id}, llave varchar(50) not null unique, valor varchar(100))`).execute(db);
        // Filas sembradas por la migración: en el destino se reemplazan por las del origen.
        await sql.raw(`insert into config (llave, valor) values ('moneda', 'USD')`).execute(db);
      },
      async down(db) {
        for (const t of ['config', 'etiquetas', 'categorias', 'pedidos', 'clientes']) await db.schema.dropTable(t).execute();
      },
    },
  };
}

async function fill(db: AnyKysely) {
  const clientes = Array.from({ length: 250 }, (_, i) => ({ nombre: `Cliente ${i + 1}` }));
  await db.insertInto('clientes').values(clientes).execute();
  const pedidos = Array.from({ length: 1200 }, (_, i) => ({
    cliente_id: (i % 250) + 1,
    total: (i * 1.5).toFixed(2),
    meta: JSON.stringify({ canal: i % 2 ? 'web' : 'tienda', items: [i, i + 1] }),
    creado: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60)),
  }));
  await db.insertInto('pedidos').values(pedidos).execute();
  await db.insertInto('categorias').values({ nombre: 'Ropa', padre_id: null }).execute();
  await db.insertInto('categorias').values([{ nombre: 'Camisas', padre_id: 1 }, { nombre: 'Pantalones', padre_id: 1 }]).execute();
  await db.insertInto('etiquetas').values([{ nombre: 'oferta', peso: 1 }, { nombre: 'oferta', peso: 1 }, { nombre: 'nuevo', peso: 2 }]).execute();
  await db.updateTable('config').set({ valor: 'BOB' }).where('llave', '=', 'moneda').execute();
  await db.insertInto('config').values({ llave: 'idioma', valor: 'es' }).execute();
}

export function moveIntegrationSuite(target: MoveTarget): void {
  describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')(`tenancy move: ${target.name}`, () => {
    let one: Awaited<ReturnType<MoveTarget['start']>>;
    let two: Awaited<ReturnType<MoveTarget['start']>>;
    let n = 0;
    const open: { close(): Promise<void> }[] = [];
    beforeAll(async () => {
      [one, two] = await Promise.all([target.start(), target.start()]);
    }, 300_000);
    afterEach(async () => {
      for (const t of open.splice(0)) await t.close();
    });
    afterAll(async () => {
      await Promise.all([one?.stop(), two?.stop()]);
    });

    const make = async (options: Partial<DatabasePluginOptions> = {}) => {
      const k = ++n;
      const logger = new MemoryLogger();
      const url = `${target.kind === 'postgres' ? 'postgres' : 'mysql'}://${one.user}:${one.password}@${one.host}:${one.port}/${one.database}`;
      const tenancy = createTenancy({
        logger,
        plugins: [
          database({
            driver: target.driver(),
            central: { url },
            tablePrefix: `m${k}_`,
            prefix: `mv${k}_`,
            migrations: { tenant: migrations(target.kind) },
            pool: { idleTimeoutMs: 0 },
            // La clave de admin del segundo servidor se guarda cifrada.
            encryptionKey: generateEncryptionKey(),
            ...options,
          }),
        ],
      });
      open.push(tenancy);
      await tenancy.database.install();
      await tenancy.database.servers.add({ id: 'default', host: one.host, port: one.port });
      await tenancy.database.servers.add({
        id: 'second',
        host: two.host,
        port: two.port,
        adminUsername: two.user,
        adminPassword: two.password,
      });
      const events: EventEnvelope[] = [];
      tenancy.events.on('database.moved', async (e) => void events.push(e), { mode: 'sync' });
      return { tenancy, logger, events, k };
    };

    const exists = async (server: typeof one, name: string) => {
      const driver = target.driver();
      const conn = driver.connect(
        { host: server.host, port: server.port, user: server.user, password: server.password, database: driver.adminDatabase },
        { max: 1 },
      );
      try {
        return await driver.databaseExists(conn.db, name);
      } finally {
        await conn.destroy();
      }
    };

    it('moves data, foreign keys, sequences and credentials to another server', async () => {
      const { tenancy, logger, events, k } = await make({ credentials: 'per-tenant' });
      await tenancy.tenants.create({ id: 'bolivar' });
      await tenancy.tenants.create({ id: 'tigre' });
      await tenancy.run('bolivar', () => fill(tenancy.db()));
      await tenancy.run('tigre', () => tenancy.db().insertInto('clientes').values({ nombre: 'Solo tigre' }).execute());
      const before = await tenancy.run('bolivar', () =>
        tenancy.db().selectFrom('pedidos').selectAll().orderBy('id').execute(),
      );

      const progress: string[] = [];
      const result = await tenancy.database.move('bolivar', {
        to: 'second',
        drainMs: 0,
        batchSize: 100,
        onProgress: (p) => progress.push(`${p.table}:${p.copied}/${p.total}`),
      });
      expect(result).toMatchObject({
        from: 'default',
        to: 'second',
        sourceDropped: false,
        rows: { clientes: 250, pedidos: 1200, categorias: 3, etiquetas: 3, config: 2 },
      });
      // Padres antes que hijos.
      const order = Object.keys(result.rows);
      expect(order.indexOf('clientes')).toBeLessThan(order.indexOf('pedidos'));
      expect(progress).toContain('pedidos:1200/1200');
      if (target.kind === 'postgres') expect(result.sequencesReset).toBeGreaterThanOrEqual(4);

      const tenant = await tenancy.tenants.findOrFail('bolivar');
      expect(tenant.status).toBe('active');
      expect(tenant.database?.serverId).toBe('second');
      expect(await exists(two, `mv${k}_bolivar`)).toBe(true);
      expect(await exists(one, `mv${k}_bolivar`)).toBe(true); // el origen se conserva

      // tenancy.db() ya va al servidor nuevo, con el usuario propio del tenant.
      const after = await tenancy.run('bolivar', () => tenancy.db().selectFrom('pedidos').selectAll().orderBy('id').execute());
      expect(after).toEqual(before);
      const config = await tenancy.run('bolivar', () => tenancy.db().selectFrom('config').select(['llave', 'valor']).orderBy('id').execute());
      expect(config).toEqual([{ llave: 'moneda', valor: 'BOB' }, { llave: 'idioma', valor: 'es' }]);
      // Las secuencias siguen donde quedaron: el próximo id no choca.
      await tenancy.run('bolivar', () => tenancy.db().insertInto('clientes').values({ nombre: 'Nuevo' }).execute());
      const last = await tenancy.run('bolivar', () =>
        tenancy.db().selectFrom('clientes').select('id').where('nombre', '=', 'Nuevo').executeTakeFirstOrThrow(),
      );
      expect(Number(last.id)).toBe(251);
      // El historial de migraciones viaja con los datos.
      expect((await tenancy.database.status('bolivar')).every((m) => m.executedAt !== null)).toBe(true);
      // Otros tenants no se tocan.
      expect(await tenancy.run('tigre', () => tenancy.db().selectFrom('clientes').select('nombre').execute())).toEqual([{ nombre: 'Solo tigre' }]);

      // tigre ya estaba en `second` (least-tenants); ahora bolivar también.
      expect((await tenancy.tenants.findOrFail('tigre')).database?.serverId).toBe('second');
      const servers = Object.fromEntries((await tenancy.database.servers.list()).map((s) => [s.id, s.tenantCount]));
      expect(servers).toEqual({ default: 0, second: 2 });
      expect(events[0]).toMatchObject({ type: 'database.moved', tenantId: 'bolivar', data: { from: 'default', to: 'second' } });
      const logs = logger.entries.filter((e) => e.fields.tenantId === 'bolivar');
      expect(logs.find((e) => e.fields.operation === 'database.move')?.fields.outcome).toBe('success');
      expect(logs.filter((e) => e.fields.operation === 'database.move.step').map((e) => e.fields.step)).toEqual([
        'createDatabase',
        'createUser',
        'migrate',
        'copy',
        'switch',
      ]);
      expect(logs.some((e) => e.fields.operation === 'database.move.table' && e.fields.table === 'pedidos' && e.fields.rows === 1200)).toBe(true);
      expect(logs.some((e) => e.fields.operation === 'tenants.maintenance')).toBe(true);

      // Volver al origen: la base vieja sigue ahí y nunca se pisa.
      await expect(tenancy.database.move('bolivar', { to: 'default', drainMs: 0 })).rejects.toThrow(/already exists/);
      expect((await tenancy.tenants.findOrFail('bolivar')).database?.serverId).toBe('second');
      const driver = target.driver();
      const admin = driver.connect(
        { host: one.host, port: one.port, user: one.user, password: one.password, database: driver.adminDatabase },
        { max: 1 },
      );
      await driver.dropDatabase(admin.db, `mv${k}_bolivar`);
      await admin.destroy();
      // Y de vuelta, borrando el origen (el usuario del tenant ya existía en `default`).
      const back = await tenancy.database.move('bolivar', { to: 'default', drainMs: 0, dropSource: true });
      expect(back.sourceDropped).toBe(true);
      expect(await exists(two, `mv${k}_bolivar`)).toBe(false);
      expect(await tenancy.run('bolivar', () => tenancy.db().selectFrom('pedidos').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow())).toMatchObject({
        n: target.kind === 'postgres' ? '1200' : 1200,
      });
    }, 180_000);

    it('never undoes a finished move when a later step fails', async () => {
      const { tenancy, events, k } = await make();
      await tenancy.tenants.create({ id: 'bolivar' });
      await tenancy.run('bolivar', () => tenancy.db().insertInto('clientes').values({ nombre: 'Ana' }).execute());
      // Falla la vuelta a `active` (después del cambio de servidor).
      const activate = tenancy.tenants.activate;
      (tenancy.tenants as { activate: typeof activate }).activate = async () => {
        throw new Error('activate caído');
      };
      const result = await tenancy.database.move('bolivar', { to: 'second', drainMs: 0 });
      (tenancy.tenants as { activate: typeof activate }).activate = activate;

      expect(result).toMatchObject({ to: 'second', rows: { clientes: 1 } });
      const tenant = await tenancy.tenants.findOrFail('bolivar');
      expect(tenant.database?.serverId).toBe('second');
      expect(tenant.status).toBe('maintenance'); // queda para activarlo a mano
      expect(await exists(two, `mv${k}_bolivar`)).toBe(true); // la base nueva no se borra
      expect(tenancy.observability.errors({ tenantId: 'bolivar' })[0]).toMatchObject({ operation: 'database.move.restore' });
      expect(events).toHaveLength(1);
      await tenancy.tenants.activate('bolivar');
      expect(await tenancy.run('bolivar', () => tenancy.db().selectFrom('clientes').select('nombre').execute())).toEqual([{ nombre: 'Ana' }]);
    }, 180_000);

    it('rolls back when the target is not usable and keeps the tenant working', async () => {
      const { tenancy, logger, k } = await make();
      await tenancy.tenants.create({ id: 'bolivar' });
      await tenancy.run('bolivar', () => tenancy.db().insertInto('clientes').values({ nombre: 'Ana' }).execute());
      // Ya existe una base con ese nombre en el destino (de otro sistema): nunca se pisa.
      const driver = target.driver();
      const conn = driver.connect(
        { host: two.host, port: two.port, user: two.user, password: two.password, database: driver.adminDatabase },
        { max: 1 },
      );
      await driver.createDatabase(conn.db, `mv${k}_bolivar`);
      await conn.destroy();

      const error = await tenancy.database.move('bolivar', { to: 'second', drainMs: 0 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TenantMoveError);
      expect((error as TenantMoveError).code).toBe('TENANCY_TENANT_MOVE_FAILED');
      expect((error as Error).message).toContain('already exists');
      const tenant = await tenancy.tenants.findOrFail('bolivar');
      expect(tenant.status).toBe('active');
      expect(tenant.database?.serverId).toBe('default');
      expect(await tenancy.run('bolivar', () => tenancy.db().selectFrom('clientes').select('nombre').execute())).toEqual([{ nombre: 'Ana' }]);
      expect(await exists(two, `mv${k}_bolivar`)).toBe(true); // la base ajena sigue ahí
      expect(Object.fromEntries((await tenancy.database.servers.list()).map((s) => [s.id, s.tenantCount]))).toEqual({ default: 1, second: 0 });
      // El error queda en el log y en el registro del tenant.
      expect(tenancy.observability.errors({ tenantId: 'bolivar' })[0]).toMatchObject({ operation: 'database.move', code: 'TENANCY_TENANT_MOVE_FAILED' });
      expect(logger.entries.some((e) => e.level === 'error' && e.fields.operation === 'database.move' && e.fields.tenantId === 'bolivar')).toBe(true);

      await expect(tenancy.database.move('bolivar', { to: 'default' })).rejects.toThrow(/already on server/);
      await expect(tenancy.database.move('bolivar', { to: 'nope' })).rejects.toThrow(DatabaseServerNotFoundError);
      await expect(tenancy.database.move('nadie', { to: 'second' })).rejects.toThrow(/not found/i);
    }, 180_000);
  });
}
