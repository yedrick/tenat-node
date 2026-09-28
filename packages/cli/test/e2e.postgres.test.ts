import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { main } from '@tenancy-node/cli';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryIO, packagesDir, tempProject } from './helpers.js';

const exec = promisify(execFile);
const bin = path.join(packagesDir, 'cli/dist/bin.js');

/**
 * Flujo real de un proyecto nuevo: init → install → create → create --from → list → migrate
 * → migrate:status → rollback → run → servers → key:rotate → delete, contra PostgreSQL.
 */
describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('cli end to end (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let dir: string;
  const env = () => ({
    DATABASE_URL: `postgres://admin:secret@${container.getHost()}:${container.getPort()}/app`,
    TENANCY_KEY: 'base64:' + Buffer.alloc(32, 7).toString('base64'),
  });
  const cli = async (argv: string[]) => {
    Object.assign(process.env, env());
    const io = memoryIO(dir);
    const code = await main(argv, { io });
    return { code, text: io.all(), out: io.out() };
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withUsername('admin')
      .withPassword('secret')
      .withDatabase('app')
      .start();
    dir = await tempProject();
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: { fastify: '^5', pg: '^8' },
        devDependencies: { typescript: '^5' },
      }),
    );
  }, 300_000);
  afterAll(async () => {
    await container?.stop();
  });

  it('runs the whole workflow', async () => {
    const init = await cli(['init']);
    expect(init.code).toBe(0);
    expect(init.text).toMatch(/Framework\s+fastify/);
    expect(init.text).toMatch(/Motor\s+postgres \(detectado\)/);
    for (const file of [
      'tenancy.config.ts',
      'src/tenancy.ts',
      'migrations/tenant/001_productos.sql',
      'migrations/central/.gitkeep',
      '.env.example',
    ]) {
      expect(init.text).toContain(`creado ${file}`);
    }
    expect(await readFile(path.join(dir, 'tenancy.config.ts'), 'utf8')).toContain(
      "from '@tenancy-node/db-postgres'",
    );
    expect((await cli(['init'])).text).toContain('ya existe tenancy.config.ts');

    const install = await cli(['install']);
    expect(install.code).toBe(0);
    expect(install.text).toContain(
      'migración del paquete: 2026_09_25_000001_create_tenancy_tables',
    );
    expect((await cli(['install'])).text).toContain('Tablas del paquete al día');

    const created = await cli([
      'create',
      'bolivar',
      '--name=Club Bolívar',
      '--domain=bolivar.localhost',
    ]);
    expect(created.code).toBe(0);
    expect(created.text).toContain('base tenant_bolivar en default');

    await writeFile(
      path.join(dir, 'tenants.csv'),
      'id,name,domain\ntigre,The Strongest,tigre.localhost\nwilster,Wilstermann,\n',
    );
    const bulk = await cli(['create', '--from=tenants.csv', '--concurrency=2']);
    expect(bulk.code).toBe(0);
    expect(bulk.text).toContain('2 tenants creados');

    const list = JSON.parse((await cli(['list', '--json'])).out) as {
      total: number;
      items: { id: string; status: string; database: { name: string } }[];
    };
    expect(list.total).toBe(3);
    expect(list.items.map((t) => [t.id, t.status, t.database.name])).toEqual([
      ['bolivar', 'active', 'tenant_bolivar'],
      expect.arrayContaining([]),
      expect.arrayContaining([]),
    ]);

    await writeFile(
      path.join(dir, 'migrations/tenant/002_ventas.sql'),
      'CREATE TABLE ventas (id integer primary key, total integer);\n',
    );
    await writeFile(
      path.join(dir, 'migrations/tenant/002_ventas.down.sql'),
      'DROP TABLE ventas;\n',
    );
    const migrate = await cli(['migrate', '--concurrency=3']);
    expect(migrate.code).toBe(0);
    expect(migrate.text).toContain('✓ bolivar');
    expect(migrate.text).toContain('3 tenants migrados');

    const status = await cli(['migrate:status', 'bolivar']);
    expect(status.text).toMatch(/001_productos\s+\d{4}-/);
    expect(status.text).toMatch(/002_ventas\s+\d{4}-/);

    expect((await cli(['rollback', '--tenants=bolivar'])).text).toContain('1 tenant revertido');
    expect((await cli(['migrate:status', 'bolivar'])).text).toMatch(/002_ventas\s+pendiente/);

    const run = await cli([
      'run',
      'node -e "console.log(process.env.TENANCY_DATABASE_NAME, new URL(process.env.DATABASE_URL).pathname)"',
    ]);
    expect(run.code).toBe(0);
    expect(run.text).toContain('[bolivar] tenant_bolivar /tenant_bolivar');
    expect(run.text).toContain('[tigre] tenant_tigre /tenant_tigre');

    const add = await cli([
      'servers:add',
      'pg-2',
      `--host=${container.getHost()}`,
      `--port=${container.getPort()}`,
      '--max-tenants=10',
      '--weight=2',
    ]);
    expect(add.code).toBe(0);
    const servers = await cli(['servers:list']);
    expect(servers.text).toMatch(/default\s+postgres\s+\S+\s+\d+\s+3\s+∞/);
    expect(servers.text).toMatch(/pg-2\s+postgres\s+\S+\s+\d+\s+0\s+10\s+2\s+sí/);

    // `pg-2` es el mismo motor: la base del tenant ya existe ahí y move se niega a pisarla.
    const move = await cli(['move', 'bolivar', '--to=pg-2', '--drain-ms=0']);
    expect(move.code).toBe(1);
    expect(move.text).toContain('Moviendo bolivar a pg-2');
    expect(move.text).toContain('TENANCY_TENANT_MOVE_FAILED');
    expect(move.text).toContain('already exists on server "pg-2"');
    expect((await cli(['move', 'bolivar'])).code).toBe(2);
    expect((await cli(['list'])).text).toMatch(/bolivar\s+\S.*active/);

    expect((await cli(['key:rotate'])).text).toContain('Todo ya estaba cifrado');

    const schema = await cli(['schema', '--prisma', '--out=prisma/tenancy.prisma']);
    expect(schema.code).toBe(1);
    await (await import('node:fs/promises')).mkdir(path.join(dir, 'prisma'));
    expect((await cli(['schema', '--prisma', '--out=prisma/tenancy.prisma'])).text).toContain(
      'modelos prisma escritos en prisma/tenancy.prisma',
    );
    expect(await readFile(path.join(dir, 'prisma/tenancy.prisma'), 'utf8')).toContain(
      '@@map("tenancy_tenants")',
    );
    expect((await cli(['schema', '--drizzle'])).out).toContain("pgTable('tenancy_domains'");

    // Panel: crear el primer owner y levantar la Admin API en otro puerto
    const owner = await cli(['admin:user', 'owner@tuapp.com', '--role=owner', '--json']);
    expect(owner.code).toBe(0);
    const password = JSON.parse(owner.out).password as string;
    expect(password).toHaveLength(24);
    expect((await cli(['admin:user', 'owner@tuapp.com'])).text).toContain('ADMIN_USER_EXISTS');
    process.env.TENANCY_ADMIN_SECRET = 's'.repeat(40);
    const controller = new AbortController();
    const io = memoryIO(dir);
    const serving = main(['admin:serve', '--port=0', '--insecure-cookies'], {
      io,
      signal: controller.signal,
    });
    let url = '';
    for (let i = 0; i < 100 && !url; i++) {
      url = /Admin API en (\S+) /.exec(io.out())?.[1] ?? '';
      await new Promise((r) => setTimeout(r, 50));
    }
    const login = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@tuapp.com', password, mode: 'token' }),
    });
    const { token } = (await login.json()) as { token: string };
    const tenants = (await (
      await fetch(`${url}/tenants`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { total: number };
    expect(tenants.total).toBe(3);
    controller.abort();
    expect(await serving).toBe(0);

    const del = await cli(['delete', 'wilster', '--force']);
    expect(del.code).toBe(0);
    expect(JSON.parse((await cli(['list', '--json'])).out).total).toBe(2);

    const failed = await cli(['migrate:status', 'ghost']);
    expect(failed.code).toBe(1);
    expect(failed.text).toContain('TENANCY_TENANT_NOT_FOUND');
  });

  it.skipIf(!existsSync(bin))('works as a real binary (npx tenancy)', async () => {
    const { stdout } = await exec(process.execPath, [bin, 'list', '--json'], {
      cwd: dir,
      env: { ...process.env, ...env() },
    });
    expect((JSON.parse(stdout) as { total: number }).total).toBe(2);
    const failure = await exec(process.execPath, [bin, 'create', 'bolivar'], {
      cwd: dir,
      env: { ...process.env, ...env() },
    }).catch((e: { code: number; stderr: string }) => e);
    expect((failure as { code: number }).code).toBe(1);
    expect((failure as { stderr: string }).stderr).toContain('TENANCY_TENANT_ALREADY_EXISTS');
  });
});
