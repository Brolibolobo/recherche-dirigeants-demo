import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGeo,
  geoParamsForZones,
  parseNafCode,
  parseNafCodes,
  validateFilterInputs,
  clampMaxRows,
  findActiveMatchingEstablishment,
  buildReferenceRow,
  buildReferenceRows,
  referenceRowMatchesFilters,
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

test('les zones lisibles développent les régions en départements et restent en OU', () => {
  assert.deepEqual(geoParamsForZones([
    { type: 'departement', code: '75', label: 'Paris (75)' },
    { type: 'region', code: '11', label: 'Île-de-France' },
    { type: 'departement', code: '75', label: 'Paris (75)' },
  ]), {
    departement: '75,77,78,91,92,93,94,95',
  });
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

test('l’historique applique activité, zone, effectif, forme, âge et recherche rapide', () => {
  const row = buildReferenceRow(company, {
    matchedEstablishment: findActiveMatchingEstablishment(company),
    apeLabel: 'Nettoyage courant des bâtiments',
    ageMin: 18,
    ageMax: 100,
  });
  const filters = {
    nafCodes: ['81.21Z'], sectors: [], staffCodes: ['11'], legal: ['sas'],
    ageMin: 18, ageMax: 100,
    zones: [{ type: 'region', code: '11', label: 'Île-de-France' }],
  };
  assert.equal(referenceRowMatchesFilters(row, filters, 'Alice nettoyage'), true);
  assert.equal(referenceRowMatchesFilters(row, filters, 'Martin'), false);
  assert.equal(referenceRowMatchesFilters(row, { ...filters, zones: [{ type: 'departement', code: '69' }] }, ''), false);
  assert.equal(referenceRowMatchesFilters(row, { ...filters, nafCodes: ['62.01Z'] }, ''), false);
});

test('les codes postaux corses distinguent Corse-du-Sud et Haute-Corse', () => {
  const base = {
    code_ape: '81.21Z', secteur: 'N', tranche_effectif: '11', nature_juridique: '5710', dirigeant_age: 40,
  };
  const filters = { nafCodes: ['81.21Z'], staffCodes: ['11'], legal: ['sas'], ageMin: 18, ageMax: 100 };
  const south = { ...base, code_postal_siege: '20000' };
  const north = { ...base, code_postal_siege: '20200' };
  assert.equal(referenceRowMatchesFilters(south, { ...filters, zones: [{ type: 'departement', code: '2A' }] }), true);
  assert.equal(referenceRowMatchesFilters(south, { ...filters, zones: [{ type: 'departement', code: '2B' }] }), false);
  assert.equal(referenceRowMatchesFilters(north, { ...filters, zones: [{ type: 'departement', code: '2A' }] }), false);
  assert.equal(referenceRowMatchesFilters(north, { ...filters, zones: [{ type: 'departement', code: '2B' }] }), true);
});

test('le filtre géographique accepte le siège même si un établissement de zone différent est stocké', () => {
  const row = {
    code_ape: '81.21Z', secteur: 'N', tranche_effectif: '11', nature_juridique: '5710', dirigeant_age: 40,
    code_postal_etablissement_zone: '69001', code_postal_siege: '75001',
  };
  const filters = {
    nafCodes: ['81.21Z'], staffCodes: ['11'], legal: ['sas'], ageMin: 25, ageMax: 75,
    zones: [{ type: 'departement', code: '75', label: 'Paris (75)' }],
  };
  assert.equal(referenceRowMatchesFilters(row, filters), true);
});
