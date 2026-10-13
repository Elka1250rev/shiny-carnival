import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const files = (await readdir(join(root, 'dist'))).filter(file => file.endsWith('.js'));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, 'dist', file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const html = await readFile(join(root, 'dist/index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)) await readFile(resolve(root, 'dist', match[1]));
const source = await Promise.all(files.map(file => readFile(join(root, 'dist', file), 'utf8')));
if (source.some(text => /\b(?:localStorage|sessionStorage|indexedDB|XMLHttpRequest|WebSocket)\b|\bfetch\s*\(/.test(text))) throw new Error('Sono presenti API di archiviazione o rete nei moduli applicativi.');
if (!html.includes("connect-src 'none'")) throw new Error('La pagina deve impedire connessioni di rete applicative.');
console.log(`Controlli completati: ${files.length} moduli validi, asset disponibili, nessuna API di archiviazione o rete.`);
