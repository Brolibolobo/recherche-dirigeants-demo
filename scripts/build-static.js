import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');

async function copy(source, destination = source) {
  const target = resolve(output, destination);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(root, source), target);
}

await rm(output, { recursive: true, force: true });
for (const file of [
  '.nojekyll',
  'index.html',
  'styles.css',
  'data/naf-rev2.json',
  'src/app.js',
  'src/central-api.js',
  'src/csv.js',
  'src/storage.js',
]) await copy(file);

await copy('server/lib/filters.js', 'src/filters.js');
await copy('server/lib/geo-data.js', 'src/geo-data.js');
