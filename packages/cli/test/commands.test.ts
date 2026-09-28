import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '@tenancy-node/cli';
import { createTestTenancy } from '@tenancy-node/testing';
import { describe, expect, it } from 'vitest';
import type { CliTenancy } from '../src/config-loader.js';
import { memoryIO, tempProject } from './helpers.js';

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'tenancy-cli-'));
  const test = createTestTenancy({ centralDomains: ['app.test'] });
  const load = async () => test.tenancy as CliTenancy;
  const run = async (argv: string[], ioOptions: Parameters<typeof memoryIO>[1] = {}) => {
    const io = memoryIO(dir, ioOptions);
    const code = await main(argv, { io, load });
    return { code, io, text: io.all() };
  };
  return { dir, run, ...test };
}

describe('cli with an in-memory tenancy', () => {
  it('shows help, version and usage errors', async () => {
    const { run } = await setup();
    expect((await run([])).text).toContain('Comandos:');
    expect((await run(['help', 'create'])).text).toContain('Uso: tenancy create <id>');
    expect((await run(['create', '--help'])).text).toContain('--domain=<valor>');
    expect((await run(['--version'])).text).toMatch(/^\d+\.\d+\.\d+/);
    const unknown = await run(['nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.text).toContain('Comando desconocido');
    const badFlag = await run(['list', '--nope']);
    expect(badFlag.code).toBe(2);
    const missing = await run(['create']);
    expect(missing.code).toBe(2);
    expect(missing.text).toContain('Missing <id>');
  });

  it('creates, lists and deletes tenants', async () => {
    const { run, tenancy } = await setup();
    const created = await run([
      'create',
      'bolivar',
      '--name=Club Bolívar',
      '--domain=bolivar.com,clubbolivar.com',
      '--plan=pro',
      '--data={"pais":"BO"}',
    ]);
    expect(created.code).toBe(0);
    expect(created.text).toContain('tenant bolivar creado (active)');
    expect((await tenancy.domains.list('bolivar')).map((d) => d.domain.value)).toEqual([
      'bolivar.com',
      'clubbolivar.com',
    ]);
    expect((await tenancy.tenants.findOrFail('bolivar')).data).toEqual({ pais: 'BO' });

    const duplicate = await run(['create', 'bolivar']);
    expect(duplicate.code).toBe(1);
    expect(duplicate.text).toContain('TENANCY_TENANT_ALREADY_EXISTS');
    expect((await run(['create', 'x1', '--data=[1]'])).code).toBe(2);
    expect((await run(['create', 'Bad Id'])).text).toContain('TENANCY_INVALID_TENANT_ID');

    await run(['create', 'tigre']);
    const list = await run(['list']);
    expect(list.text).toMatch(/ID\s+NOMBRE\s+ESTADO/);
    expect(list.text).toContain('Club Bolívar');
    expect(list.text).toContain('2 tenants · página 1 de 1');
    const json = await run(['list', '--json', '--search=club']);
    expect(JSON.parse(json.io.out()).items.map((t: { id: string }) => t.id)).toEqual(['bolivar']);
    expect((await run(['list', '--status=gone'])).code).toBe(2);

    expect((await run(['delete', 'tigre'])).text).toContain('use --force');
    const cancelled = await run(['delete', 'tigre'], { isTTY: true, input: 'nope\n' });
    expect(cancelled.code).toBe(1);
    const confirmed = await run(['delete', 'tigre'], { isTTY: true, input: 'tigre\n' });
    expect(confirmed.code).toBe(0);
    expect((await run(['delete', 'bolivar', '--force'])).text).toContain(
      'tenant bolivar eliminado',
    );
    expect((await tenancy.tenants.list()).total).toBe(0);
    expect((await run(['delete', 'ghost', '--force'])).text).toContain('TENANCY_TENANT_NOT_FOUND');
  });

  it('creates tenants in bulk from a CSV, validating it first', async () => {
    const { run, tenancy, dir } = await setup();
    await writeFile(path.join(dir, 'bad.csv'), 'id,name\nbolivar,B\nbolivar,B2\n,none\n');
    const bad = await run(['create', '--from=bad.csv']);
    expect(bad.code).toBe(2);
    expect(bad.text).toContain('línea 3: id "bolivar" repetido (ya está en la línea 2)');
    expect(bad.text).toContain('línea 4: falta el id');

    await writeFile(
      path.join(dir, 'tenants.csv'),
      'id,name,domain,plan,data\nbolivar,"Club Bolívar",bolivar.com|clubbolivar.com,pro,"{""pais"":""BO""}"\ntigre,The Strongest,tigre.com,,\nMALO,Malo,,,\nroto,Roto,bolivar.com,,\n',
    );
    const dry = await run(['create', '--from=tenants.csv', '--dry-run']);
    expect(dry.text).toContain('4 filas válidas');
    expect((await tenancy.tenants.list()).total).toBe(0);

    const result = await run(['create', '--from=tenants.csv', '--concurrency=1']);
    expect(result.code).toBe(1);
    expect(result.text).toContain('línea 4 MALO  TENANCY_INVALID_TENANT_ID');
    expect(result.text).toContain('línea 5 roto  TENANCY_DOMAIN_TAKEN');
    expect(result.text).toContain('2 tenants creados, 2 con error: MALO, roto');
    expect((await tenancy.tenants.findOrFail('bolivar')).plan).toBe('pro');
    expect((await run(['create', '--from=missing.csv'])).code).toBe(1);
    await writeFile(path.join(dir, 'noid.csv'), 'name\nx\n');
    expect((await run(['create', '--from=noid.csv'])).text).toContain('needs an "id" column');
  });

  it('runs a command for every tenant with its environment', async () => {
    const { run, seed, tenancy } = await setup();
    await seed(['aa', 'bb', 'cc']);
    await tenancy.tenants.suspend('cc');
    const result = await run([
      'run',
      `node -e "console.log('hola ' + process.env.TENANCY_TENANT_ID); if (process.env.TENANCY_TENANT_ID === 'bb') process.exit(3)"`,
    ]);
    expect(result.text).toContain('[aa] hola aa');
    expect(result.text).toContain('[bb] hola bb');
    expect(result.text).not.toContain('[cc]');
    expect(result.text).toContain('bb  Error exit code 3');
    expect(result.code).toBe(1);
    expect(tenancy.observability.errors({ tenantId: 'bb' })[0]).toMatchObject({
      operation: 'cli.run',
    });
    const only = await run(['run', 'node -e "process.exit(0)"', '--tenants=cc']);
    expect(only.code).toBe(0);
    expect(only.text).toContain('1 tenant completado');
  });

  it('keeps the terminal clean and writes every structured log to --log-file', async () => {
    const dir = await tempProject();
    await writeFile(
      path.join(dir, 'tenancy.config.ts'),
      "import { defineConfig } from '@tenancy-node/core';\nexport default defineConfig({ centralDomains: ['app.test'] });\n",
    );
    const io = memoryIO(dir);
    const code = await main(['create', 'Bad Id', '--log-file=logs/tenancy.log'], {
      io,
    });
    expect(code).toBe(1);
    // En la terminal: solo la línea legible, sin JSON
    expect(io.err()).toContain('TENANCY_INVALID_TENANT_ID');
    expect(io.err()).not.toContain('{"level"');
    // En el archivo: el log completo con tenantId, operación y código
    const lines = (await readFile(path.join(dir, 'logs/tenancy.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        operation: 'tenants.create',
        tenantId: 'Bad Id',
        code: 'TENANCY_INVALID_TENANT_ID',
      }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ operation: 'cli.create', outcome: 'error', exitCode: 1 }),
    );

    const verbose = memoryIO(dir);
    await main(['create', 'Otro Malo', '--verbose'], { io: verbose });
    expect(verbose.err()).toContain('"operation":"tenants.create"');
    expect(verbose.err()).toContain('"stack":"InvalidTenantIdError: Invalid tenant id');
  });

  it('explains when the database plugin is missing', async () => {
    const { run } = await setup();
    for (const cmd of [
      ['install'],
      ['migrate'],
      ['servers:list'],
      ['key:rotate'],
      ['migrate:status', 'x'],
    ]) {
      const r = await run(cmd);
      expect(r.code).toBe(2);
      expect(r.text).toContain('needs the database plugin');
    }
    const key = await run(['key:generate']);
    expect(key.io.out().trim()).toMatch(/^base64:[A-Za-z0-9+/]{43}=$/);
  });
});

describe('config loading', () => {
  it('loads a TypeScript config exporting defineConfig, and reports a missing one', async () => {
    const dir = await tempProject();
    const io = memoryIO(dir);
    expect(await main(['list'], { io })).toBe(2);
    expect(io.all()).toContain('Run "tenancy init" first');

    await writeFile(
      path.join(dir, 'tenancy.config.ts'),
      `import { defineConfig, InMemoryTenantRepository } from '@tenancy-node/core';
const tenants: InMemoryTenantRepository = new InMemoryTenantRepository();
export default defineConfig({ centralDomains: ['app.test'], tenants });
`,
    );
    const io2 = memoryIO(dir);
    expect(await main(['create', 'bolivar', '--json'], { io: io2 })).toBe(0);
    expect(JSON.parse(io2.out())).toMatchObject({ id: 'bolivar', status: 'active' });

    await writeFile(
      path.join(dir, 'other.config.mjs'),
      'export const nothing = 1;\nexport default 42;\n',
    );
    const io3 = memoryIO(dir);
    expect(await main(['list', '--config=other.config.mjs'], { io: io3 })).toBe(2);
    expect(io3.all()).toContain('must export a tenancy config');
    expect(await readFile(path.join(dir, 'tenancy.config.ts'), 'utf8')).toContain('defineConfig');
  });
});

describe('worker and schema commands', () => {
  it('runs a worker until it is stopped, loading jobs from --entry', async () => {
    const dir = await tempProject();
    await writeFile(
      path.join(dir, 'jobs.mjs'),
      "export default (tenancy) => tenancy.jobs.define('saludo', async (data) => { globalThis.__seen = (globalThis.__seen ?? []).concat(`${tenancy.currentId()}:${data.n}`); });\n",
    );
    const test = createTestTenancy();
    await test.seed(['bolivar']);
    const controller = new AbortController();
    const io = memoryIO(dir);
    const running = main(['worker', '--entry=jobs.mjs', '--concurrency=2'], {
      io,
      load: async () => test.tenancy as CliTenancy,
      signal: controller.signal,
    });
    // Esperar a que el worker registre el trabajo y encolar uno
    while (!test.tenancy.jobs.names().includes('saludo'))
      await new Promise((r) => setTimeout(r, 10));
    await test.tenancy.run('bolivar', () => test.tenancy.jobs.dispatch('saludo', { n: 7 }));
    while (!(globalThis as { __seen?: string[] }).__seen)
      await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    expect(await running).toBe(0);
    expect((globalThis as { __seen?: string[] }).__seen).toEqual(['bolivar:7']);
    expect(io.all()).toContain('worker listo (concurrencia 2): saludo');
    expect(io.all()).toContain('worker detenido');
  });

  it('validates schema options', async () => {
    const test = createTestTenancy();
    const io = memoryIO(tmpdir());
    expect(
      await main(['schema', '--prisma', '--drizzle'], {
        io,
        load: async () => test.tenancy as CliTenancy,
      }),
    ).toBe(2);
    expect(io.all()).toContain('Choose exactly one');
    const io2 = memoryIO(tmpdir());
    expect(
      await main(['schema', '--prisma'], { io: io2, load: async () => test.tenancy as CliTenancy }),
    ).toBe(2);
    expect(io2.all()).toContain('needs the database plugin');
  });
});

describe('outbox commands', () => {
  const fakeOutbox = () => {
    const calls: string[] = [];
    const outbox = {
      startRelay: () => (calls.push('start'), { stop: async () => void calls.push('stop') }),
      stats: async () => ({ pending: 2, processing: 0, published: 10, failed: 1 }),
      failed: async () => [
        {
          id: 'row1',
          eventId: 'e1',
          type: 'pedido.creado',
          tenantId: 'bolivar',
          destination: 'rabbitmq',
          status: 'failed',
          attempts: 10,
          lastError: 'broker down',
          availableAt: new Date(),
          createdAt: new Date(),
        },
      ],
      retry: async (target: unknown) => (calls.push(`retry:${JSON.stringify(target)}`), 1),
    };
    const test = createTestTenancy();
    const tenancy = Object.assign(test.tenancy, {
      outbox,
      webhooks: {
        startDispatcher: () => (
          calls.push('dispatch'),
          { stop: async () => void calls.push('dispatch-stop') }
        ),
      },
    });
    return { calls, load: async () => tenancy as unknown as CliTenancy };
  };

  it('shows status with the dead-letter and retries events', async () => {
    const { calls, load } = fakeOutbox();
    const io = memoryIO(tmpdir());
    expect(await main(['outbox:status'], { io, load })).toBe(1);
    expect(io.all()).toMatch(/failed\s+1/);
    expect(io.all()).toMatch(/row1\s+pedido\.creado\s+bolivar\s+rabbitmq\s+10\s+broker down/);
    expect(await main(['outbox:retry', '--tenant=bolivar'], { io: memoryIO(tmpdir()), load })).toBe(
      0,
    );
    expect(await main(['outbox:retry'], { io: memoryIO(tmpdir()), load })).toBe(2);
    expect(calls).toContain('retry:{"tenantId":"bolivar"}');
  });

  it('runs the relay and the webhook dispatcher until stopped', async () => {
    const { calls, load } = fakeOutbox();
    const controller = new AbortController();
    const io = memoryIO(tmpdir());
    const running = main(['outbox:relay'], { io, load, signal: controller.signal });
    while (!calls.includes('dispatch')) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    expect(await running).toBe(0);
    expect(calls).toEqual(['start', 'dispatch', 'stop', 'dispatch-stop']);
    expect(io.all()).toContain('con despacho de webhooks');
    const missing = memoryIO(tmpdir());
    expect(
      await main(['outbox:status'], {
        io: missing,
        load: async () => createTestTenancy().tenancy as CliTenancy,
      }),
    ).toBe(2);
    expect(missing.all()).toContain('needs the outbox plugin');
  });
});
