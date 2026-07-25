import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalApiFilterKey, directorFingerprintMaterial, directorIdentity, leadKey, personNameKey } from '../src/cache.js';

const baseFilters = {
  geoParams: { departement: '75' },
  nafCodes: ['81.22Z', '81.21Z'],
  sectors: ['N'],
  staffCodes: ['12', '11'],
  legal: ['sas'],
  ageMin: 25,
  ageMax: 75,
  maxRows: 1000,
};

test('la clé du cache dépend seulement des filtres envoyés à l’API et reste canonique', () => {
  const first = canonicalApiFilterKey(baseFilters);
  const second = canonicalApiFilterKey({
    ...baseFilters,
    nafCodes: ['81.21Z', '81.22Z'],
    staffCodes: ['11', '12'],
    legal: ['sarl'],
    ageMin: 40,
    maxRows: 12,
  });
  assert.equal(first, second);
  assert.notEqual(first, canonicalApiFilterKey({ ...baseFilters, geoParams: { departement: '92' } }));
  assert.match(first, /81\.21Z,81\.22Z/);
  assert.match(first, /recherche-entreprises:v1/);
  assert.match(first, /dirigeants,matching_etablissements,siege/);
  assert.equal(JSON.parse(first).legal, undefined);
  assert.equal(JSON.parse(first).ageMin, undefined);
  assert.equal(JSON.parse(first).maxRows, undefined);
});

test('l’empreinte dirigeant résiste aux accents et à la casse', async () => {
  const first = {
    dirigeant_prenoms: 'Élodie Marie',
    dirigeant_nom_famille: 'DUPONT',
    dirigeant_date_naissance: '1985-04-12',
    dirigeant_nationalite: 'Française',
    siren: '111111111',
  };
  const second = {
    ...first,
    dirigeant_prenoms: 'elodie   marie',
    dirigeant_nom_famille: 'dupont',
    dirigeant_nationalite: 'francaise',
    siren: '222222222',
  };
  assert.equal(directorFingerprintMaterial(first), directorFingerprintMaterial(second));
  assert.equal(await leadKey(first, 'test-salt'), await leadKey(second, 'test-salt'));
});

test('sans naissance, la même personne reste dédupliquée entre deux sociétés', () => {
  const first = { dirigeant_prenoms: 'Jean', dirigeant_nom_famille: 'Martin', siren: '111111111' };
  const second = { ...first, siren: '222222222' };
  assert.equal(directorFingerprintMaterial(first), directorFingerprintMaterial(second));
  assert.deepEqual(directorIdentity(first), {
    version: 2,
    quality: 'weak',
    birthYear: '',
    nameMaterial: 'person-name:v1|JEAN|MARTIN',
    material: 'person:v2|JEAN|MARTIN|',
  });
});

test('la nationalité ne change pas l’identité et deux dates distinctes restent distinctes', () => {
  const first = { dirigeant_prenoms: 'Jean', dirigeant_nom_famille: 'Martin', dirigeant_date_naissance: '1980-02-03', dirigeant_nationalite: 'Française' };
  const same = { ...first, dirigeant_nationalite: 'Belge' };
  const other = { ...first, dirigeant_date_naissance: '1981-02-03' };
  assert.equal(directorFingerprintMaterial(first), directorFingerprintMaterial(same));
  assert.notEqual(directorFingerprintMaterial(first), directorFingerprintMaterial(other));
  assert.equal(directorIdentity(first).quality, 'strong');
});

test('une date complète, un mois et une année gardent la même identité', async () => {
  const base = { dirigeant_prenoms: 'Alice', dirigeant_nom_famille: 'Dupont' };
  const full = { ...base, dirigeant_date_naissance: '1980-06-12' };
  const month = { ...base, dirigeant_date_naissance: '1980-06' };
  const year = { ...base, dirigeant_annee_naissance: '1980' };
  assert.equal(directorFingerprintMaterial(full), 'person:v2|ALICE|DUPONT|1980');
  assert.equal(directorFingerprintMaterial(full), directorFingerprintMaterial(month));
  assert.equal(directorFingerprintMaterial(month), directorFingerprintMaterial(year));
  assert.equal(await leadKey(full, 'salt'), await leadKey(year, 'salt'));
  assert.equal(await personNameKey(full, 'salt'), await personNameKey({ ...base }, 'salt'));
  assert.equal(directorIdentity(month).quality, 'medium');
});
