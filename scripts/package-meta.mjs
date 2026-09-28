#!/usr/bin/env node
// Deja iguales los metadatos de publicación de todos los paquetes y genera su README y LICENSE.
//
//   node scripts/package-meta.mjs          escribe los cambios
//   node scripts/package-meta.mjs --check  falla si algo no está al día (lo usa el CI)
//
// La URL del repositorio se toma de `repository` en el package.json raíz: al agregarla
// ahí, este script la propaga a todos los paquetes (repository, homepage y bugs).
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const repoUrl = typeof rootPkg.repository === 'string' ? rootPkg.repository : rootPkg.repository?.url;
const httpRepo = repoUrl?.replace(/^git\+/, '').replace(/\.git$/, '');
const docsUrl = rootPkg.homepage;

const BASE_KEYWORDS = ['multi-tenancy', 'multitenancy', 'multi-tenant', 'saas', 'tenancy', 'tenant'];
const KEYWORDS = {
  'adapter-': ['middleware'],
  'admin-': ['admin', 'dashboard'],
  'cache-': ['cache'],
  cli: ['cli'],
  db: ['database', 'kysely', 'migrations'],
  'orm-': ['orm', 'database'],
  otel: ['opentelemetry', 'tracing', 'observability'],
  prometheus: ['prometheus', 'metrics', 'observability'],
  'queue-': ['queue', 'jobs'],
  'storage-': ['storage', 's3'],
  outbox: ['outbox', 'events'],
  'transport-': ['events', 'cloudevents'],
  testing: ['testing'],
};

/** Qué más hay que instalar junto al paquete (se muestra en su README). */
const COMPANIONS = {
  'adapter-express': ['express'],
  'adapter-fastify': ['fastify'],
  db: ['@tenancy-node/db-postgres', 'kysely', 'pg'],
  'db-mysql': ['@tenancy-node/db', 'kysely', 'mysql2'],
  'db-postgres': ['@tenancy-node/db', 'kysely', 'pg'],
  'db-sqlite': ['@tenancy-node/db', 'kysely'],
  'db-mssql': ['@tenancy-node/db', 'kysely'],
  'orm-drizzle': ['@tenancy-node/db', 'drizzle-orm'],
  'orm-knex': ['@tenancy-node/db', 'knex'],
  'orm-prisma': ['@tenancy-node/db', '@prisma/client'],
  'orm-typeorm': ['@tenancy-node/db', 'typeorm'],
  'orm-sequelize': ['@tenancy-node/db', 'sequelize'],
  'orm-mikro-orm': ['@tenancy-node/db', '@mikro-orm/core', '@mikro-orm/postgresql'],
  'admin-api': ['@tenancy-node/db', '@tenancy-node/admin-ui'],
  cli: ['@tenancy-node/db'],
  otel: ['@opentelemetry/api'],
  testing: ['vitest'],
};

const problems = [];
const write = (file, content) => {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (current === content) return;
  if (check) problems.push(path.relative(root, file));
  else writeFileSync(file, content);
};

function readme(dir, pkg) {
  const extra = COMPANIONS[dir] ?? [];
  const needsCore = pkg.name !== '@tenancy-node/core' && pkg.name !== '@tenancy-node/admin-ui';
  const install = [pkg.name, ...(needsCore ? ['@tenancy-node/core'] : []), ...extra];
  const lines = [
    `# ${pkg.name}`,
    '',
    pkg.description,
    '',
    'Parte de [tenancy-node](' + (httpRepo ?? 'https://www.npmjs.com/org/tenancy-node') + '): multi-tenancy para Node.js con arquitectura hexagonal y observabilidad por tenant.',
    '',
    '## Instalación',
    '',
    '```sh',
    `npm install ${[...new Set(install)].join(' ')}`,
    '```',
    '',
    'Requiere Node.js 20 o superior. Funciona con ESM y CommonJS, e incluye los tipos de TypeScript.',
    '',
    '## Documentación',
    '',
    docsUrl
      ? `Guías y referencia en ${docsUrl}.`
      : 'Guías y referencia en el sitio de documentación del proyecto.',
    '',
    '## Licencia',
    '',
    'MIT',
    '',
  ];
  return lines.join('\n');
}

for (const dir of readdirSync(path.join(root, 'packages')).sort()) {
  const pkgFile = path.join(root, 'packages', dir, 'package.json');
  if (!existsSync(pkgFile)) continue;
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const keywords = [
    ...BASE_KEYWORDS,
    ...Object.entries(KEYWORDS).flatMap(([prefix, words]) =>
      dir === prefix || (prefix.endsWith('-') && dir.startsWith(prefix)) ? words : [],
    ),
    ...dir.split('-').filter((w) => !['adapter', 'orm', 'db', 'cache', 'transport', 'queue', 'storage', 'admin'].includes(w)),
  ];
  const next = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    keywords: [...new Set(keywords)],
    license: 'MIT',
    ...(httpRepo
      ? {
          homepage: docsUrl ?? `${httpRepo}#readme`,
          bugs: { url: `${httpRepo}/issues` },
          repository: { type: 'git', url: `git+${httpRepo}.git`, directory: `packages/${dir}` },
        }
      : {}),
    ...pkg,
  };
  // Estos campos siempre salen del script, aunque el paquete tenga otro valor.
  next.license = 'MIT';
  next.keywords = [...new Set(keywords)];
  next.engines = { node: '>=20' };
  next.publishConfig = { access: 'public' };
  if (next.sideEffects === undefined) next.sideEffects = false;
  if (httpRepo) {
    next.homepage = docsUrl ?? `${httpRepo}#readme`;
    next.bugs = { url: `${httpRepo}/issues` };
    next.repository = { type: 'git', url: `git+${httpRepo}.git`, directory: `packages/${dir}` };
  }
  write(pkgFile, JSON.stringify(next, null, 2) + '\n');
  write(path.join(root, 'packages', dir, 'README.md'), readme(dir, next));
  const license = path.join(root, 'packages', dir, 'LICENSE');
  if (!existsSync(license) || readFileSync(license, 'utf8') !== readFileSync(path.join(root, 'LICENSE'), 'utf8')) {
    if (check) problems.push(path.relative(root, license));
    else copyFileSync(path.join(root, 'LICENSE'), license);
  }
}

if (check && problems.length > 0) {
  console.error(`Package metadata is out of date (run node scripts/package-meta.mjs):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(check ? 'Package metadata is up to date' : 'Package metadata updated');
