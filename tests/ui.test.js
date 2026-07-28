import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

test('l’interface expose un picker APE sans bouton Ajouter', () => {
  for (const id of ['naf', 'nafOptions', 'selectedNaf', 'nafCount', 'clearNaf']) {
    assert.match(index, new RegExp(`id=["']${id}["']`));
  }
  assert.match(index, /Plusieurs codes APE/);
  assert.doesNotMatch(index, /id=["']addNaf["']/);
  assert.doesNotMatch(app, /if\(\$\('naf'\)\.value\.trim\(\)\)addNaf\(\)/);
});

test('l’interface expose zones lisibles, deux modes et chargement manager', () => {
  for (const id of ['zone', 'zoneOptions', 'selectedZones', 'modeNew', 'modeHistory', 'historyQuery', 'searchProgress']) {
    assert.match(index, new RegExp(`id=["']${id}["']`));
  }
  assert.doesNotMatch(index, /region:11/i);
  assert.doesNotMatch(index, /Prospection responsable/);
  assert.doesNotMatch(index, /Aucun chiffre d’affaires n’est demandé/);
  assert.match(app, /modeHistory/);
  assert.match(app, /setLoading/);
});

test('l’application gère les APE sélectionnés et démarre les secteurs désactivés', () => {
  assert.match(app, /selectedNafCodes/);
  assert.match(app, /chips\('sectors',\s*SECTORS,\s*false\)/);
  assert.match(app, /validateFilterInputs/);
});

test('l’application utilise le scan central et transmet le mode choisi', () => {
  assert.match(app, /isCentralConfigured/);
  assert.match(app, /scanCentral/);
  assert.match(app, /buildReferenceRows/);
  assert.match(app, /sans anti-doublon partagé/);
  assert.match(app, /scanCentral\(\{[\s\S]*?\bmode[,|:]/);
});

test('les options du picker restent activables par souris et clavier', () => {
  assert.match(app, /button\.addEventListener\('pointerdown',[\s\S]*?event\.preventDefault\(\)/);
  assert.match(app, /button\.addEventListener\('click',[\s\S]*?choose\(item\)/);
  assert.match(app, /button\.addEventListener\('keydown',[\s\S]*?ArrowDown[\s\S]*?ArrowUp[\s\S]*?Home[\s\S]*?End/);
  assert.match(app, /input\.addEventListener\('keydown',[\s\S]*?ArrowDown[\s\S]*?ArrowUp[\s\S]*?Home[\s\S]*?End/);
  assert.match(app, /event\.key === 'Escape'[\s\S]*?input\.focus\(\)[\s\S]*?return close\(\)/);
  assert.doesNotMatch(app, /button\.addEventListener\('mousedown',[\s\S]*?choose\(item\)/);
});

test('les cibles tactiles spécifiques gardent 44 px sur mobile', () => {
  assert.match(styles, /@media \(max-width: 800px\)[\s\S]*?\.picker-option, \.value-tag, \.technical-details summary \{ min-height: 44px; \}/);
});
