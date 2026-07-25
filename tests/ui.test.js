import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');

test('l’interface expose la sélection multiple APE', () => {
  for (const id of ['naf', 'addNaf', 'selectedNaf', 'nafCount', 'clearNaf']) {
    assert.match(index, new RegExp(`id=["']${id}["']`));
  }
  assert.match(index, /Plusieurs codes APE/);
});

test('l’application gère les APE sélectionnés et démarre les secteurs désactivés', () => {
  assert.match(app, /selectedNafCodes/);
  assert.match(app, /chips\('sectors',SECTORS,false\)/);
  assert.match(app, /validateFilterInputs/);
});

test('l’application utilise le scan central quand Supabase est configuré', () => {
  assert.match(app, /isCentralConfigured/);
  assert.match(app, /scanCentral/);
  assert.match(app, /buildReferenceRows/);
  assert.match(app, /sans anti-doublon partagé/);
});
