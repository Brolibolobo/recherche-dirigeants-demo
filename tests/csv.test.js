import test from 'node:test';
import assert from 'node:assert/strict';
import { CSV_HEADERS, toCsv } from '../src/csv.js';

const row = {
  nom_entreprise: 'NETTOYAGE, EXEMPLE',
  siren: '123456789',
  code_ape: '81.21Z',
  libelle_ape: 'Nettoyage courant des bâtiments',
  dirigeant_pm_nom: 'GROUPE "EXEMPLE"',
};

test('le CSV de référence contient APE et dirigeant personne morale prudent, jamais le CA', () => {
  assert.ok(CSV_HEADERS.includes('code_ape'));
  assert.ok(CSV_HEADERS.includes('libelle_ape'));
  assert.ok(CSV_HEADERS.includes('dirigeant_type'));
  assert.ok(CSV_HEADERS.includes('dirigeant_nationalite'));
  assert.ok(CSV_HEADERS.includes('dirigeant_date_naissance'));
  assert.ok(CSV_HEADERS.includes('categorie_entreprise'));
  assert.ok(CSV_HEADERS.includes('siret_etablissement_zone'));
  assert.ok(CSV_HEADERS.includes('adresse_etablissement_zone'));
  assert.ok(CSV_HEADERS.includes('data_quality_score'));
  assert.ok(CSV_HEADERS.includes('dirigeant_pm_nom'));
  assert.ok(CSV_HEADERS.includes('groupement_capitalistique_indice'));
  assert.equal(CSV_HEADERS.includes('entreprise_liee_nom'), false);
  assert.equal(CSV_HEADERS.includes('ca'), false);
  assert.equal(CSV_HEADERS.includes('resultat_net'), false);

  const csv = toCsv([row]);
  assert.ok(csv.startsWith('\ufeff'));
  assert.match(csv, /"NETTOYAGE, EXEMPLE"/);
  assert.match(csv, /"GROUPE ""EXEMPLE"""/);
});
