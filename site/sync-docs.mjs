// Copia al sitio lo que vive en docs/ (ADRs, CLI y hoja de ruta), así hay una sola fuente.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(site, '..', 'docs');
const fixLinks = (text) =>
  text
    .replace(/\]\((?:\.\.\/)?adr\/([^)]+)\.md\)/g, '](/adr/$1)')
    .replace(/\]\(cli\.md\)/g, '](/guia/cli)')
    .replace(/\]\(\.\.\/\.\.\/packages\/[^)]*\)/g, ']()');

rmSync(path.join(site, 'adr'), { recursive: true, force: true });
mkdirSync(path.join(site, 'adr'), { recursive: true });
const adrs = readdirSync(path.join(docs, 'adr')).filter((f) => f.endsWith('.md')).sort();
for (const file of adrs)
  writeFileSync(path.join(site, 'adr', file), fixLinks(readFileSync(path.join(docs, 'adr', file), 'utf8')));
const list = adrs.map((f) => {
  const title = readFileSync(path.join(docs, 'adr', f), 'utf8').split('\n')[0].replace(/^#\s*/, '');
  return `- [${title}](./${f.replace(/\.md$/, '')})`;
});
writeFileSync(
  path.join(site, 'adr', 'index.md'),
  `# Decisiones de arquitectura\n\nCada decisión importante queda escrita como un ADR: el contexto, lo que se decidió y sus consecuencias.\n\n${list.join('\n')}\n`,
);
writeFileSync(path.join(site, 'guia', 'cli.md'), fixLinks(readFileSync(path.join(docs, 'cli.md'), 'utf8')));
writeFileSync(path.join(site, 'hoja-de-ruta.md'), fixLinks(readFileSync(path.join(docs, 'ROADMAP.md'), 'utf8')));
cpSync(path.join(site, '..', 'LICENSE'), path.join(site, 'public', 'LICENSE.txt'));
console.log(`synced ${adrs.length} ADRs, cli and roadmap`);
