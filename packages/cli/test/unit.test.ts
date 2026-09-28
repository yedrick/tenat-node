import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { csvRecords, detectProject, parseCsv } from '@tenancy-node/cli';
import { describe, expect, it } from 'vitest';
import { installCommand as installCmd } from '../src/detect.js';
import { Output, formatCell, formatDuration } from '../src/output.js';
import {
  appTemplate,
  configFileName,
  configTemplate,
  envLines,
  exampleMigration,
  packagesFor,
} from '../src/templates.js';
import { memoryIO } from './helpers.js';

describe('csv', () => {
  it('parses quotes, escaped quotes, commas and newlines inside fields', () => {
    const text =
      '﻿id,name,domain\r\nbolivar,"Club ""Bolívar"", La Paz",bolivar.com|clubbolivar.com\n"tigre","The\nStrongest",\n\n';
    expect(parseCsv(text)).toEqual([
      ['id', 'name', 'domain'],
      ['bolivar', 'Club "Bolívar", La Paz', 'bolivar.com|clubbolivar.com'],
      ['tigre', 'The\nStrongest', ''],
    ]);
    const { headers, records } = csvRecords('ID , Name\n a , b \nc\n');
    expect(headers).toEqual(['id', 'name']);
    expect(records).toEqual([
      { line: 2, values: { id: 'a', name: 'b' } },
      { line: 3, values: { id: 'c', name: '' } },
    ]);
    expect(csvRecords('').records).toEqual([]);
    expect(() => parseCsv('a,"b')).toThrow(/unterminated/);
  });
});

describe('detectProject', () => {
  it('reads framework, ORM, language, module type, driver and package manager', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tenancy-detect-'));
    expect(detectProject(dir)).toMatchObject({
      hasPackageJson: false,
      framework: 'none',
      orm: 'none',
      language: 'js',
      moduleType: 'cjs',
      driver: undefined,
      packageManager: 'npm',
    });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: { fastify: '5', '@prisma/client': '6', pg: '8' },
        devDependencies: { typescript: '5' },
      }),
    );
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
    expect(detectProject(dir)).toEqual({
      hasPackageJson: true,
      framework: 'fastify',
      orm: 'prisma',
      language: 'ts',
      moduleType: 'esm',
      driver: 'postgres',
      packageManager: 'pnpm',
    });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { express: '5', mysql2: '3', knex: '3' } }),
    );
    expect(detectProject(dir)).toMatchObject({
      framework: 'express',
      orm: 'knex',
      driver: 'mysql',
      moduleType: 'cjs',
    });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { 'better-sqlite3': '11' } }),
    );
    expect(detectProject(dir).driver).toBe('sqlite');
    for (const dep of ['tedious', 'mssql']) {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ dependencies: { [dep]: '1' } }),
      );
      expect(detectProject(dir).driver).toBe('mssql');
    }
    expect(installCmd('npm', ['a', 'b'], true)).toBe('npm install --save-dev a b');
    expect(installCmd('yarn', ['a'])).toBe('yarn add a');
  });
});

describe('templates', () => {
  const base = detectProject(tmpdir());
  it('generates ESM/TS and CommonJS configs for each driver', () => {
    const ts = {
      ...base,
      language: 'ts' as const,
      moduleType: 'esm' as const,
      framework: 'fastify' as const,
    };
    const cjs = {
      ...base,
      language: 'js' as const,
      moduleType: 'cjs' as const,
      framework: 'express' as const,
    };
    expect(configFileName(ts)).toBe('tenancy.config.ts');
    expect(configFileName(cjs)).toBe('tenancy.config.cjs');
    expect(configFileName({ ...cjs, moduleType: 'esm' })).toBe('tenancy.config.js');
    expect(configTemplate(ts, 'postgres')).toContain(
      "import { postgres } from '@tenancy-node/db-postgres';",
    );
    expect(configTemplate(ts, 'postgres')).toContain(
      "fileURLToPath(new URL('./migrations/tenant', import.meta.url))",
    );
    expect(configTemplate(cjs, 'mysql')).toContain(
      "const { mysql } = require('@tenancy-node/db-mysql');",
    );
    expect(configTemplate(cjs, 'mysql')).toContain("path.join(__dirname, 'migrations/tenant')");
    expect(appTemplate(ts).content).toContain('tenancyPlugin');
    expect(appTemplate(cjs)).toMatchObject({ file: 'src/tenancy.cjs' });
    expect(appTemplate(cjs).content).toContain('tenancyMiddleware');
    expect(appTemplate({ ...base, framework: 'none' }).content).toContain('withTenancy');
    expect(exampleMigration('mysql')).toContain('AUTO_INCREMENT');
    expect(exampleMigration('postgres')).toContain('GENERATED ALWAYS AS IDENTITY');
    expect(packagesFor(ts, 'mysql').runtime).toContain('@tenancy-node/adapter-fastify');
  });

  it('generates sqlite and mssql configs and installs the ORM integration', () => {
    const ts = { ...base, language: 'ts' as const, moduleType: 'esm' as const };
    const sqliteConfig = configTemplate(ts, 'sqlite');
    expect(sqliteConfig).toContain("import { sqlite } from '@tenancy-node/db-sqlite';");
    expect(sqliteConfig).toContain('driver: sqlite(),');
    expect(sqliteConfig).toContain("'sqlite://local/central'");
    const mssqlConfig = configTemplate({ ...ts, language: 'js', moduleType: 'cjs' }, 'mssql');
    expect(mssqlConfig).toContain("const { mssql } = require('@tenancy-node/db-mssql');");
    expect(mssqlConfig).toContain('driver: mssql(),');
    expect(exampleMigration('sqlite')).toContain('INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(exampleMigration('mssql')).toContain('IDENTITY(1,1)');
    expect(envLines('sqlite', 'k')).toContain('DATABASE_URL=sqlite://local/central');
    expect(packagesFor(ts, 'sqlite').runtime).toContain('@tenancy-node/db-sqlite');
    expect(packagesFor({ ...ts, orm: 'drizzle' }, 'mssql').runtime).toEqual(
      expect.arrayContaining(['@tenancy-node/db-mssql', '@tenancy-node/orm-drizzle']),
    );
    expect(packagesFor(ts, 'mysql').runtime.some((p) => p.includes('orm-'))).toBe(false);
  });
});

describe('output', () => {
  it('renders aligned tables, colors only on TTY and JSON', () => {
    const io = memoryIO(tmpdir());
    const out = new Output(io);
    out.table(
      ['ID', 'ACTIVO'],
      [
        ['bolivar', true],
        ['tigre-largo', null],
      ],
    );
    out.table(['X'], []);
    expect(io.out()).toBe(
      'ID           ACTIVO\n───────────  ──────\nbolivar      sí\ntigre-largo  -\n(sin resultados)\n',
    );
    const tty = memoryIO(tmpdir(), { isTTY: true });
    new Output(tty).success('ok');
    expect(tty.out()).toContain('\u001b[32m✓');
    const json = memoryIO(tmpdir(), { isTTY: true });
    const jout = new Output(json, { json: true });
    jout.success('hidden');
    jout.data({ a: 1 });
    jout.error('to stderr');
    expect(json.out()).toBe('{\n  "a": 1\n}\n');
    expect(json.err()).toContain('to stderr');
    expect(formatCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02 03:04:05');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(12.4)).toBe('12ms');
  });
});
