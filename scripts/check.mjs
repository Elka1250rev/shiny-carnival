import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('..', import.meta.url));
const files = (await readdir(join(root, 'dist'))).filter(file => file.endsWith('.js'));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, 'dist', file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const vendorPath = join(root, 'dist/vendor/pdf-lib.esm.min.js');
const vendor = await readFile(vendorPath);
if (createHash('sha256').update(vendor).digest('hex') !== '72c052d97b4d5d9fa6cdbdcb7ad709f03d4ddb1122390cb3afeba4d88651d969') throw new Error('La copia locale di pdf-lib non corrisponde alla versione verificata.');
await readFile(join(root, 'dist/vendor/pdf-lib.LICENSE.md'));
const vendorSyntax = spawnSync(process.execPath, ['--check', vendorPath], { stdio: 'inherit' });
if (vendorSyntax.status !== 0) process.exit(vendorSyntax.status ?? 1);
const html = await readFile(join(root, 'dist/index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)) await readFile(resolve(root, 'dist', match[1]));
const source = await Promise.all(files.map(file => readFile(join(root, 'dist', file), 'utf8')));
if (source.some(text => /\b(?:localStorage|sessionStorage|indexedDB|XMLHttpRequest|WebSocket)\b|\bfetch\s*\(/.test(text))) throw new Error('Sono presenti API di archiviazione o rete nei moduli applicativi.');
if (!html.includes("connect-src 'none'")) throw new Error('La pagina deve impedire connessioni di rete applicative.');
console.log(`Controlli completati: ${files.length} moduli validi, pdf-lib locale verificata, asset disponibili, nessuna API di archiviazione o rete nei moduli applicativi.`);
