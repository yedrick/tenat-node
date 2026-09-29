#!/usr/bin/env node
// Empaqueta los paquetes para un GitHub Release (mientras no estén en npm):
//
// 1. `pnpm pack` de cada paquete público (con las dependencias `workspace:` ya resueltas).
// 2. Las dependencias `@tenancy-node/*` pasan a la URL del tarball en el mismo Release, así
//    `npm install <url de db-postgres>` trae también db y core, sin listarlos a mano.
//    Las peerDependencies se quedan como rango: el paquete instalado desde su URL las cumple.
// 3. `SHA256SUMS` y `NOTES.md` (notas del Release con el comando de instalación).
//
//   pnpm build && node scripts/pack-release.mjs [--out=release] [--base-url=http://localhost:8080]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const packages = readdirSync(path.join(root, 'packages'))
  .map((dir) => ({
    dir,
    pkg: JSON.parse(readFileSync(path.join(root, 'packages', dir, 'package.json'), 'utf8')),
  }))
  .filter(({ pkg }) => !pkg.private);

const versions = new Set(packages.map(({ pkg }) => pkg.version));
if (versions.size !== 1) {
  console.error(
    `Los paquetes tienen versiones distintas (${[...versions].join(', ')}): un Release es una sola versión.`,
  );
  process.exit(1);
}
const [version] = versions;
const tag = `v${version}`;

const repo = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  .repository.url.replace(/^git\+/, '')
  .replace(/\.git$/, '');
const baseUrl = (arg('base-url') ?? `${repo}/releases/download/${tag}`).replace(/\/$/, '');
const out = path.resolve(root, arg('out') ?? 'release');
const fileOf = (name) => `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
const urlOf = (name) => `${baseUrl}/${fileOf(name)}`;
const internal = new Set(packages.map(({ pkg }) => pkg.name));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'tenancy-release-'));
const sums = [];

try {
  for (const { dir, pkg } of packages) {
    run('pnpm', ['pack', '--pack-destination', work], path.join(root, 'packages', dir));
    const file = fileOf(pkg.name);
    const unpacked = path.join(work, dir);
    mkdirSync(unpacked);
    run('tar', ['xzf', path.join(work, file), '-C', unpacked]);

    const manifestPath = path.join(unpacked, 'package', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (internal.has(name)) manifest.dependencies[name] = urlOf(name);
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    // Mismo formato que npm: todo bajo `package/`.
    run('tar', ['czf', path.join(out, file), '-C', unpacked, 'package']);
    const hash = createHash('sha256')
      .update(readFileSync(path.join(out, file)))
      .digest('hex');
    sums.push(`${hash}  ${file}`);
    console.log(`✓ ${file}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

writeFileSync(path.join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);

const url = (name) => `  ${urlOf(name)}`;
writeFileSync(
  path.join(out, 'NOTES.md'),
  `Paquetes de tenancy-node ${version} para instalar desde este Release (todavía no están en npm).

Instala solo los que uses; cada uno trae sus dependencias \`@tenancy-node/*\` desde este mismo Release.

\`\`\`bash
# Núcleo + base de datos (cambia db-postgres por db-mysql, db-sqlite o db-mssql) + tu framework
npm install \\
${url('@tenancy-node/core')} \\
${url('@tenancy-node/db')} \\
${url('@tenancy-node/db-postgres')} \\
${url('@tenancy-node/adapter-express')}

# CLI (npx tenancy)
npm install -D \\
${url('@tenancy-node/cli')}
\`\`\`

Cualquier otro paquete: \`${baseUrl}/tenancy-node-<nombre>-${version}.tgz\` (la lista está abajo, en Assets).
Verifica las descargas con \`sha256sum -c SHA256SUMS\`.
`,
);

console.log(`\n${packages.length} paquetes en ${path.relative(root, out) || out} (${tag})`);
