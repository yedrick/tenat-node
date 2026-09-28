import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateEncryptionKeyValue } from '../keys.js';
import { EXIT, UsageError, stringOption, type Command } from '../command.js';
import { DRIVERS, detectProject, installCommand, type Driver } from '../detect.js';
import {
  appTemplate,
  configFileName,
  configTemplate,
  envLines,
  exampleMigration,
  ORM_PACKAGE,
  packagesFor,
} from '../templates.js';

const ORM_NOTE: Record<string, string> = {
  prisma: 'Prisma',
  typeorm: 'TypeORM',
  drizzle: 'Drizzle',
  knex: 'Knex',
  sequelize: 'Sequelize',
  'mikro-orm': 'MikroORM',
};

export const initCommand: Command = {
  name: 'init',
  summary: 'Genera tenancy.config, las carpetas de migraciones y un ejemplo de integración',
  usage: 'tenancy init [--driver=mysql|postgres|sqlite|mssql] [--force]',
  options: { driver: { type: 'string' }, force: { type: 'boolean' } },
  help: {
    driver:
      'Motor de base de datos (por defecto se detecta por mysql2/pg/better-sqlite3/tedious en package.json, o mysql)',
    force: 'Sobrescribir archivos existentes',
  },
  async run({ args, out, io }) {
    const project = detectProject(io.cwd);
    const requested = stringOption(args, 'driver');
    if (requested && !DRIVERS.includes(requested as Driver)) {
      throw new UsageError('--driver must be one of: mysql, postgres, sqlite, mssql');
    }
    const driver: Driver = (requested as Driver | undefined) ?? project.driver ?? 'mysql';
    const force = args.values.force === true;

    out.line(out.paint('bold', 'Proyecto detectado'));
    out.pairs([
      ['Framework', project.framework === 'none' ? 'ninguno (node:http)' : project.framework],
      ['ORM', project.orm === 'none' ? 'ninguno (SQL puro / Kysely)' : ORM_NOTE[project.orm]],
      ['Lenguaje', project.language === 'ts' ? 'TypeScript' : 'JavaScript'],
      ['Módulos', project.moduleType === 'esm' ? 'ESM' : 'CommonJS'],
      ['Motor', driver + (requested ? '' : project.driver ? ' (detectado)' : ' (por defecto)')],
      ['Gestor', project.packageManager],
    ]);
    out.line();
    if (!project.hasPackageJson)
      out.warn('No hay package.json en este directorio; se generan los archivos igual.');

    const created: string[] = [];
    const skipped: string[] = [];
    const write = async (relative: string, content: string) => {
      const file = path.join(io.cwd, relative);
      if (existsSync(file) && !force) {
        skipped.push(relative);
        return;
      }
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      created.push(relative);
    };

    await write(configFileName(project), configTemplate(project, driver));
    const app = appTemplate(project);
    await write(app.file, app.content);
    await write('migrations/tenant/001_productos.sql', exampleMigration(driver));
    await write('migrations/central/.gitkeep', '');

    // .env.example: solo agrega las variables que faltan
    const envFile = path.join(io.cwd, '.env.example');
    const current = existsSync(envFile) ? await readFile(envFile, 'utf8') : '';
    const missing = envLines(driver, generateEncryptionKeyValue()).filter(
      (line) => !current.split('\n').some((l) => l.startsWith(`${line.split('=')[0]}=`)),
    );
    if (missing.length > 0) {
      await appendFile(
        envFile,
        `${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`,
      );
      created.push('.env.example');
    }

    for (const file of created) out.success(`creado ${file}`);
    for (const file of skipped) out.warn(`ya existe ${file} (usa --force para sobrescribir)`);
    out.data({ project, driver, created, skipped });

    const pkgs = packagesFor(project, driver);
    out.line();
    out.line(out.paint('bold', 'Siguientes pasos'));
    out.line(`  1. ${installCommand(project.packageManager, pkgs.runtime)}`);
    out.line(`     ${installCommand(project.packageManager, pkgs.dev, true)}`);
    out.line(
      driver === 'sqlite'
        ? '  2. Copia .env.example a .env (SQLite guarda las bases en ./data)'
        : '  2. Copia .env.example a .env y ajusta DATABASE_URL',
    );
    out.line('  3. npx tenancy install');
    out.line('  4. npx tenancy create bolivar --domain=bolivar.localhost');
    if (project.orm !== 'none') {
      out.line();
      out.info(
        out.paint(
          'gray',
          `Detectamos ${ORM_NOTE[project.orm]}: su integración es ${ORM_PACKAGE[project.orm]} ` +
            '(ya incluida en el paso 1). Guía: https://yedrick.github.io/tenat-node/guia/orm',
        ),
      );
    }
    return EXIT.ok;
  },
};
