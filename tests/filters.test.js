import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGeo,
  parseNafCode,
  parseNafCodes,
  validateFilterInputs,
  clampMaxRows,
  findActiveMatchingEstablishment,
  buildReferenceRow,
  buildReferenceRows,
} from '../src/filters.js';

const company = {
  siren: '123456789',
  nom_complet: 'NETTOYAGE EXEMPLE',
  etat_administratif: 'A',
  nature_juridique: '5710',
  activite_principale: '81.21Z',
  section_activite_principale: 'N',
  tranche_effectif_salarie: '11',
  nombre_etablissements_ouverts: 2,
  siege: {
    siret: '12345678900012',
    etat_administratif: 'A',
    adresse: '1 RUE PROPRE',
    code_postal: '75001',
    libelle_commune: 'PARIS',
  },
  dirigeants: [
    { type_dirigeant: 'personne physique', prenoms: 'ALICE', nom: 'DUPONT', qualite: 'Présidente', date_de_naissance: '1985-04' },
    { type_dirigeant: 'personne morale', denomination: 'CABINET AUDIT', siren: '111111111', qualite: 'Commissaire aux comptes titulaire' },
    { type_dirigeant: 'personne morale', denomination: 'GROUPE EXEMPLE', siren: '987654321', qualite: 'Président' },
  ],
  matching_etablissements: [
    { siret: '12345678900020', etat_administratif: 'F', date_fermeture: '2020-01-01', adresse: 'ANCIENNE ADRESSE', code_postal: '75001', libelle_commune: 'PARIS' },
    { siret: '12345678900038', etat_administratif: 'A', adresse: '2 RUE ACTIVE', code_postal: '75001', libelle_commune: 'PARIS' },
  ],
};

test('parseGeo distingue département, code postal et région', () => {
  assert.deepEqual(parseGeo('75'), { departement: '75' });
  assert.deepEqual(parseGeo('75,92'), { departement: '75,92' });
  assert.deepEqual(parseGeo('75001'), { code_postal: '75001' });
  assert.deepEqual(parseGeo('region:11'), { region: '11' });
  assert.throws(() => parseGeo('Paris'), /Zone invalide/);
});

test('parseNafCode extrait un code APE depuis la liste dédiée', () => {
  assert.equal(parseNafCode('81.21Z — Nettoyage courant des bâtiments'), '81.21Z');
  assert.equal(parseNafCode(''), '');
  assert.throws(() => parseNafCode('ménage'), /Code APE invalide/);
});

test('parseNafCodes accepte plusieurs APE et supprime les doublons', () => {
  assert.deepEqual(parseNafCodes([
    '81.21Z — Nettoyage courant des bâtiments',
    '81.22Z — Autres activités de nettoyage des bâtiments',
    '81.21Z',
  ]), ['81.21Z', '81.22Z']);
});

test('validateFilterInputs refuse les sélections et plages incohérentes', () => {
  assert.throws(
    () => validateFilterInputs({ nafCodes: [], sectors: [], staffMin: 3, staffMax: 500, ageMin: 25, ageMax: 75 }),
    /code APE ou un secteur/,
  );
  assert.throws(
    () => validateFilterInputs({ nafCodes: ['81.21Z'], sectors: [], staffMin: 500, staffMax: 3, ageMin: 25, ageMax: 75 }),
    /effectif minimum/,
  );
  assert.throws(
    () => validateFilterInputs({ nafCodes: ['81.21Z'], sectors: [], staffMin: 3, staffMax: 500, ageMin: 75, ageMax: 25 }),
    /âge minimum/,
  );
});

test('clampMaxRows borne la taille du résultat', () => {
  assert.equal(clampMaxRows('25'), 25);
  assert.equal(clampMaxRows('99999'), 100);
  assert.equal(clampMaxRows('0'), 1);
});

test('la zone conserve uniquement un établissement correspondant actif', () => {
  const match = findActiveMatchingEstablishment(company);
  assert.equal(match.siret, '12345678900038');
  assert.equal(findActiveMatchingEstablishment({ matching_etablissements: [{ etat_administratif: 'F' }] }), null);
});

test('buildReferenceRow expose APE et indice de personne morale sans chiffre d’affaires', () => {
  const matchedEstablishment = findActiveMatchingEstablishment(company);
  const row = buildReferenceRow(company, {
    matchedEstablishment,
    apeLabel: 'Nettoyage courant des bâtiments',
    exportedAt: '2026-07-23T00:00:00.000Z',
    sourceUrl: 'https://example.test/search',
    ageMin: 18,
    ageMax: 100,
  });

  assert.equal(row.code_ape, '81.21Z');
  assert.equal(row.libelle_ape, 'Nettoyage courant des bâtiments');
  assert.equal(row.siret_etablissement_zone, '12345678900038');
  assert.match(row.adresse_etablissement_zone, /2 RUE ACTIVE/);
  assert.equal(row.dirigeant_pm_nom, 'GROUPE EXEMPLE');
  assert.equal(row.dirigeant_pm_siren, '987654321');
  assert.equal(row.dirigeant_pm_qualite, 'Président');
  assert.match(row.groupement_capitalistique_indice, /indice/i);
  assert.match(row.groupement_capitalistique_indice, /pas une preuve d'actionnariat/i);
  assert.equal('ca' in row, false);
  assert.equal('chiffre_affaires' in row, false);
});

test('buildReferenceRows produit un lead par dirigeant physique éligible', () => {
  const rows = buildReferenceRows({
    ...company,
    dirigeants: [
      ...company.dirigeants,
      { type_dirigeant: 'personne physique', prenoms: 'BOB', nom: 'MARTIN', qualite: 'Gérant', date_de_naissance: '1988-09-12' },
      { type_dirigeant: 'personne physique', prenoms: 'CAMILLE', nom: 'AUDIT', qualite: 'Commissaire aux comptes', date_de_naissance: '1980-01-01' },
    ],
  }, { ageMin: 18, ageMax: 100 });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.dirigeant_nom), ['ALICE DUPONT', 'BOB MARTIN']);
});
