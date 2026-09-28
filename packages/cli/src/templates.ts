import type { Driver, Orm, ProjectInfo } from './detect.js';

const DRIVER_PACKAGE: Record<Driver, string> = {
  mysql: '@tenancy-node/db-mysql',
  postgres: '@tenancy-node/db-postgres',
  sqlite: '@tenancy-node/db-sqlite',
  mssql: '@tenancy-node/db-mssql',
};
const DRIVER_FN: Record<Driver, string> = {
  mysql: 'mysql',
  postgres: 'postgres',
  sqlite: 'sqlite',
  mssql: 'mssql',
};
const DEFAULT_URL: Record<Driver, string> = {
  mysql: 'mysql://root:secret@127.0.0.1:3306/app',
  postgres: 'postgres://postgres:secret@127.0.0.1:5432/app',
  // SQLite: un archivo por base en ./data; el host no se usa.
  sqlite: 'sqlite://local/central',
  mssql: 'mssql://sa:secret@127.0.0.1:1433/app',
};

/** Paquete de integración para cada ORM detectado. */
export const ORM_PACKAGE: Record<Exclude<Orm, 'none'>, string> = {
  prisma: '@tenancy-node/orm-prisma',
  typeorm: '@tenancy-node/orm-typeorm',
  drizzle: '@tenancy-node/orm-drizzle',
  knex: '@tenancy-node/orm-knex',
  sequelize: '@tenancy-node/orm-sequelize',
  'mikro-orm': '@tenancy-node/orm-mikro-orm',
};

export function configFileName(project: ProjectInfo): string {
  if (project.language === 'ts') return 'tenancy.config.ts';
  return project.moduleType === 'esm' ? 'tenancy.config.js' : 'tenancy.config.cjs';
}

/** `tenancy.config.*`: la configuración que usan tu app y el CLI. */
export function configTemplate(project: ProjectInfo, driver: Driver): string {
  const esm = project.language === 'ts' || project.moduleType === 'esm';
  const pkg = DRIVER_PACKAGE[driver];
  const fn = DRIVER_FN[driver];
  const body = `  // Dominios de la app central: nunca resuelven a un tenant.
  centralDomains: ['localhost'],
  plugins: [
    database({
      driver: ${fn}(),
      central: { url: process.env.DATABASE_URL ?? '${DEFAULT_URL[driver]}' },
      // Llave AES-256-GCM para las contraseñas de las bases (genera una con: npx tenancy key:generate)
      encryptionKey: process.env.TENANCY_KEY,
      // 'shared': un usuario de base para todos. 'per-tenant': usuario y contraseña propios por tenant.
      credentials: 'shared',
      migrations: {
        tenant: ${esm ? "fileURLToPath(new URL('./migrations/tenant', import.meta.url))" : "path.join(__dirname, 'migrations/tenant')"},
        central: ${esm ? "fileURLToPath(new URL('./migrations/central', import.meta.url))" : "path.join(__dirname, 'migrations/central')"},
      },
    }),
  ],`;

  if (esm) {
    return `import { fileURLToPath } from 'node:url';
import { defineConfig } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { ${fn} } from '${pkg}';

export default defineConfig({
${body}
});
`;
  }
  return `const path = require('node:path');
const { defineConfig } = require('@tenancy-node/core');
const { database } = require('@tenancy-node/db');
const { ${fn} } = require('${pkg}');

module.exports = defineConfig({
${body}
});
`;
}

/** Archivo de la app que crea la instancia `tenancy` y muestra cómo conectarla al framework. */
export function appTemplate(project: ProjectInfo): { file: string; content: string } {
  const ts = project.language === 'ts';
  const esm = ts || project.moduleType === 'esm';
  const ext = ts ? 'ts' : esm ? 'js' : 'cjs';
  const configImport = ts
    ? '../tenancy.config.js'
    : esm
      ? '../tenancy.config.js'
      : '../tenancy.config.cjs';
  const usage: Record<ProjectInfo['framework'], string> = {
    fastify: `// Fastify:
//   import { tenancyPlugin } from '@tenancy-node/adapter-fastify';
//   await app.register(tenancyPlugin, { tenancy });
//   app.get('/productos', () => tenancy.db().selectFrom('productos').selectAll().execute());`,
    express: `// Express (después de express.json()):
//   import { tenancyMiddleware, tenancyErrorHandler } from '@tenancy-node/adapter-express';
//   app.use(tenancyMiddleware(tenancy));
//   app.get('/productos', async (req, res) => res.json(await tenancy.db().selectFrom('productos').selectAll().execute()));
//   app.use(tenancyErrorHandler(tenancy));`,
    none: `// node:http:
//   import { withTenancy } from '@tenancy-node/adapter-node';
//   createServer(withTenancy(tenancy, async (req, res) => res.end(JSON.stringify(await tenancy.sql\`SELECT 1\`))));`,
  };
  const header = `// Instancia de tenancy para tu aplicación.\n${usage[project.framework]}\n`;
  const content = esm
    ? `${header}import { createTenancy } from '@tenancy-node/core';
import config from '${configImport}';

export const tenancy = createTenancy(config);
`
    : `${header}const { createTenancy } = require('@tenancy-node/core');
const config = require('${configImport}');

module.exports = { tenancy: createTenancy(config) };
`;
  return { file: `src/tenancy.${ext}`, content };
}

/** Migración de ejemplo para la base de cada tenant. */
export function exampleMigration(driver: Driver): string {
  const ids: Record<Driver, string> = {
    mysql: 'INT AUTO_INCREMENT PRIMARY KEY',
    postgres: 'INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
    sqlite: 'INTEGER PRIMARY KEY AUTOINCREMENT',
    mssql: 'INT IDENTITY(1,1) PRIMARY KEY',
  };
  const id = ids[driver];
  return `-- Se aplica en la base de cada tenant (npx tenancy migrate).
-- Cada sentencia termina con ";" al final de la línea.
CREATE TABLE productos (
  id ${id},
  nombre VARCHAR(150) NOT NULL,
  precio INTEGER NOT NULL DEFAULT 0
);
`;
}

export function envLines(driver: Driver, key: string): string[] {
  return [`DATABASE_URL=${DEFAULT_URL[driver]}`, `TENANCY_KEY=${key}`];
}

export function packagesFor(
  project: ProjectInfo,
  driver: Driver,
): { runtime: string[]; dev: string[] } {
  const adapter =
    project.framework === 'fastify'
      ? '@tenancy-node/adapter-fastify'
      : project.framework === 'express'
        ? '@tenancy-node/adapter-express'
        : '@tenancy-node/adapter-node';
  return {
    runtime: [
      '@tenancy-node/core',
      '@tenancy-node/db',
      DRIVER_PACKAGE[driver],
      adapter,
      ...(project.orm !== 'none' ? [ORM_PACKAGE[project.orm]] : []),
    ],
    dev: ['@tenancy-node/cli'],
  };
}
