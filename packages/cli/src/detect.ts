import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type Framework = 'fastify' | 'express' | 'none';
export type Orm = 'prisma' | 'typeorm' | 'drizzle' | 'knex' | 'sequelize' | 'mikro-orm' | 'none';
export type Driver = 'mysql' | 'postgres' | 'sqlite' | 'mssql';
export const DRIVERS: readonly Driver[] = ['mysql', 'postgres', 'sqlite', 'mssql'];
export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

export interface ProjectInfo {
  hasPackageJson: boolean;
  framework: Framework;
  orm: Orm;
  moduleType: 'esm' | 'cjs';
  language: 'ts' | 'js';
  /** Motor deducido de las dependencias (mysql2 / pg / better-sqlite3 / tedious o mssql). */
  driver: Driver | undefined;
  packageManager: PackageManager;
}

const ORMS: [string, Orm][] = [
  ['@prisma/client', 'prisma'],
  ['prisma', 'prisma'],
  ['typeorm', 'typeorm'],
  ['drizzle-orm', 'drizzle'],
  ['knex', 'knex'],
  ['sequelize', 'sequelize'],
  ['@mikro-orm/core', 'mikro-orm'],
];

/** Lee `package.json` y los archivos del proyecto para adaptar lo que genera `tenancy init`. */
export function detectProject(cwd: string): ProjectInfo {
  const file = path.join(cwd, 'package.json');
  const pkg = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as {
        type?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      })
    : {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (name: string) => name in deps;

  const framework: Framework = has('fastify') ? 'fastify' : has('express') ? 'express' : 'none';
  const orm = ORMS.find(([name]) => has(name))?.[1] ?? 'none';
  const driver: Driver | undefined =
    has('mysql2') || has('mysql') || has('mariadb')
      ? 'mysql'
      : has('pg') || has('postgres')
        ? 'postgres'
        : has('tedious') || has('mssql')
          ? 'mssql'
          : has('better-sqlite3')
            ? 'sqlite'
            : undefined;
  const language = has('typescript') || existsSync(path.join(cwd, 'tsconfig.json')) ? 'ts' : 'js';

  const lock = (name: string) => existsSync(path.join(cwd, name));
  const packageManager: PackageManager = lock('pnpm-lock.yaml')
    ? 'pnpm'
    : lock('yarn.lock')
      ? 'yarn'
      : lock('bun.lockb') || lock('bun.lock')
        ? 'bun'
        : 'npm';

  return {
    hasPackageJson: existsSync(file),
    framework,
    orm,
    moduleType: pkg.type === 'module' ? 'esm' : 'cjs',
    language,
    driver,
    packageManager,
  };
}

export function installCommand(pm: PackageManager, packages: string[], dev = false): string {
  const verb = pm === 'npm' ? 'install' : 'add';
  const flag = dev ? (pm === 'npm' ? ' --save-dev' : ' -D') : '';
  return `${pm} ${verb}${flag} ${packages.join(' ')}`;
}
