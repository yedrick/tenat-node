#!/usr/bin/env node
// Verifica los paquetes tal como se publicarían, antes de `npm publish`:
//
// 1. `pnpm pack` de cada paquete (con las dependencias `workspace:` ya resueltas).
// 2. publint y arethetypeswrong sobre cada tarball: exports, tipos, ESM y CJS.
// 3. Proyecto nuevo, fuera del monorepo, con `npm install` de los tarballs: la app de humo
//    corre desde ESM y desde CommonJS, y el binario `tenancy` responde.
//
//   pnpm build && node scripts/check-packages.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (name) => path.join(root, 'node_modules', '.bin', name);
const work = mkdtempSync(path.join(tmpdir(), 'tenancy-pack-'));
const packs = path.join(work, 'packs');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const failures = [];
const packages = readdirSync(path.join(root, 'packages'))
  .map((dir) => ({ dir, pkg: JSON.parse(readFileSync(path.join(root, 'packages', dir, 'package.json'), 'utf8')) }))
  .filter(({ pkg }) => !pkg.private);

try {
  const tarballs = new Map();
  for (const { dir, pkg } of packages) {
    const cwd = path.join(root, 'packages', dir);
    run('pnpm', ['pack', '--pack-destination', packs], cwd);
    const file = path.join(packs, `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`);
    tarballs.set(pkg.name, file);

    try {
      run(bin('publint'), ['--strict'], cwd);
    } catch (error) {
      failures.push(`${pkg.name}: publint\n${error.stdout}${error.stderr}`);
    }
    try {
      run(bin('attw'), [file, '--profile', 'node16', '--format', 'ascii']);
    } catch (error) {
      failures.push(`${pkg.name}: arethetypeswrong\n${error.stdout}${error.stderr}`);
    }
    process.stdout.write(`checked ${pkg.name}\n`);
  }

  // Instalación real con npm (no pnpm): así la usará la gente.
  const app = path.join(work, 'app');
  execFileSync('mkdir', ['-p', app]);
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
  const wanted = [
    '@tenancy-node/core',
    '@tenancy-node/db',
    '@tenancy-node/db-sqlite',
    '@tenancy-node/adapter-node',
    '@tenancy-node/prometheus',
    '@tenancy-node/cli',
  ];
  run('npm', ['install', '--no-audit', '--no-fund', ...wanted.map((n) => tarballs.get(n)), 'kysely'], app);
  copyFileSync(path.join(root, 'scripts', 'smoke', 'app.mjs'), path.join(app, 'app.mjs'));
  copyFileSync(path.join(root, 'scripts', 'smoke', 'app.cjs'), path.join(app, 'app.cjs'));
  for (const file of ['app.mjs', 'app.cjs']) {
    try {
      process.stdout.write(run('node', [file], app));
    } catch (error) {
      failures.push(`smoke ${file}\n${error.stdout}${error.stderr}`);
    }
  }
  const version = run(path.join(app, 'node_modules', '.bin', 'tenancy'), ['--version'], app).trim();
  const expected = packages.find((p) => p.pkg.name === '@tenancy-node/cli').pkg.version;
  if (version !== expected) failures.push(`tenancy --version printed "${version}", expected ${expected}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log(`\n${packages.length} packages ready to publish`);
