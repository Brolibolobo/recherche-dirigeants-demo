import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BODY_BYTES,
  MAX_SCAN_PAGES,
  MAX_SCAN_TARGET,
  SCAN_DEADLINE_MS,
  publicErrorCode,
  readJsonWithLimit,
  sanitizeScanFilters,
  validateUpstreamPayload,
} from '../server/lib/scan-policy.js';
import { LEGALS, SECTORS, referenceRowMatchesFilters } from '../server/lib/filters.js';

test('la politique MVP borne coût, pages, deadline et corps HTTP', () => {
  assert.equal(MAX_SCAN_TARGET, 100);
  assert.equal(MAX_SCAN_PAGES, 50);
  assert.equal(SCAN_DEADLINE_MS, 25_000);
  assert.equal(MAX_BODY_BYTES, 16_384);
});

test('les filtres fournis sont stricts mais une liste juridique vide garde les défauts', () => {
  assert.deepEqual(sanitizeScanFilters({}).sectors, SECTORS.map(([value]) => value));
  assert.deepEqual(sanitizeScanFilters({}, { allowEmptyActivity: true }).sectors, []);
  assert.deepEqual(sanitizeScanFilters({ sectors: ['C'], legal: [] }).legal, LEGALS.map(([value]) => value));
  assert.throws(() => sanitizeScanFilters({ sectors: ['N'], legal: ['invalide'] }), /invalid_legal/);
  assert.throws(() => sanitizeScanFilters({ sectors: ['invalide'], legal: [] }), /invalid_sectors/);
  const filters = sanitizeScanFilters({ sectors: ['N'], legal: [] });
  assert.ok(filters.legal.length > 1);
});

test('les zones structurées sont validées puis converties en une liste de départements', () => {
  const filters = sanitizeScanFilters({
    sectors: ['N'],
    zones: [
      { type: 'departement', code: '75' },
      { type: 'region', code: '11' },
    ],
  });
  assert.deepEqual(filters.zones, [
    { type: 'departement', code: '75' },
    { type: 'region', code: '11' },
  ]);
  assert.deepEqual(filters.geoParams, { departement: '75,77,78,91,92,93,94,95' });
  assert.throws(() => sanitizeScanFilters({ sectors: ['N'], zones: [{ type: 'pays', code: 'FR' }] }), /invalid_zones/);
  assert.throws(() => sanitizeScanFilters({ sectors: ['N'], zones: [{ type: 'departement', code: '75', label: 'non autorisé' }] }), /invalid_zones/);
});

test('les zones structurées acceptent les codes postaux exacts', () => {
  const filters = sanitizeScanFilters({
    sectors: ['N'],
    zones: [
      { type: 'code_postal', code: '75016' },
      { type: 'code_postal', code: '75017' },
    ],
  });
  assert.deepEqual(filters.zones, [
    { type: 'code_postal', code: '75016' },
    { type: 'code_postal', code: '75017' },
  ]);
  assert.deepEqual(filters.geoParams, { code_postal: '75016,75017' });
});

test('les anciens filtres geo restent appliqués au stock et à l’historique', () => {
  const base = {
    code_ape: '81.21Z', secteur: 'N', tranche_effectif: '11', nature_juridique: '5710', dirigeant_age: 40,
    code_postal_etablissement_zone: '69001', code_postal_siege: '69001',
  };
  const department = sanitizeScanFilters({ sectors: ['N'], geo: '75' });
  const postal = sanitizeScanFilters({ sectors: ['N'], geo: '75001' });
  const region = sanitizeScanFilters({ sectors: ['N'], geo: 'region:11' });

  assert.equal(referenceRowMatchesFilters(base, department), false);
  assert.equal(referenceRowMatchesFilters({ ...base, code_postal_siege: '75001' }, department), true);
  assert.equal(referenceRowMatchesFilters({ ...base, code_postal_siege: '75002' }, postal), false);
  assert.equal(referenceRowMatchesFilters({ ...base, code_postal_siege: '75001' }, postal), true);
  assert.equal(referenceRowMatchesFilters({ ...base, code_postal_siege: '92000' }, region), true);
});

test('le contrat upstream rejette les structures non itérables et pages invalides', () => {
  assert.throws(() => validateUpstreamPayload({ total_pages: 'inconnu', results: [] }, 1), /upstream_invalid_payload/);
  for (const totalPages of [null, false, [], '1']) {
    assert.throws(() => validateUpstreamPayload({ total_pages: totalPages, results: [] }, 1), /upstream_invalid_payload/);
  }
  assert.throws(() => validateUpstreamPayload({ total_pages: 2, results: {} }, 1), /upstream_invalid_payload/);
  assert.throws(() => validateUpstreamPayload({ total_pages: 1, results: [null] }, 1), /upstream_invalid_payload/);
  assert.throws(() => validateUpstreamPayload({ total_pages: 1, results: [{ dirigeants: {} }] }, 1), /upstream_invalid_payload/);
  assert.throws(() => validateUpstreamPayload({ total_pages: 1, results: [{ matching_etablissements: [null] }] }, 1), /upstream_invalid_payload/);
  assert.deepEqual(validateUpstreamPayload({ total_pages: 2, results: [] }, 1), { totalPages: 2, results: [] });
});

test('le contrat upstream valide exhaustivement les scalaires consommés à chaque niveau', () => {
  const trapped = { toString: null, valueOf: null };
  const stringFields = {
    company: [
      'activite_principale', 'categorie_entreprise', 'etat_administratif', 'nature_juridique',
      'nom_complet', 'nom_raison_sociale', 'section_activite_principale', 'siren', 'tranche_effectif_salarie',
    ],
    siege: ['adresse', 'code_postal', 'commune', 'date_fermeture', 'etat_administratif', 'libelle_commune', 'siret'],
    director: [
      'annee_de_naissance', 'date_de_naissance', 'denomination', 'nationalite', 'nom',
      'nom_complet', 'prenoms', 'qualite', 'siren', 'type_dirigeant',
    ],
    establishment: ['adresse', 'code_postal', 'commune', 'date_fermeture', 'etat_administratif', 'libelle_commune', 'siret'],
  };
  const companyFor = (scope, field, value = trapped) => {
    if (scope === 'company') return { [field]: value };
    if (scope === 'siege') return { siege: { [field]: value } };
    if (scope === 'director') return { dirigeants: [{ [field]: value }] };
    return { matching_etablissements: [{ [field]: value }] };
  };

  for (const [scope, fields] of Object.entries(stringFields)) {
    for (const field of fields) {
      assert.throws(
        () => validateUpstreamPayload({ total_pages: 1, results: [companyFor(scope, field)] }, 1),
        /upstream_invalid_payload/,
        `${scope}.${field}`,
      );
    }
  }
  for (const value of [[], () => {}]) {
    assert.throws(() => validateUpstreamPayload({ total_pages: 1, results: [{ nature_juridique: value }] }, 1), /upstream_invalid_payload/);
  }
  for (const value of [trapped, '2', 1.5, -1]) {
    assert.throws(() => validateUpstreamPayload({ total_pages: 1, results: [{ nombre_etablissements_ouverts: value }] }, 1), /upstream_invalid_payload/);
  }
  assert.doesNotThrow(() => validateUpstreamPayload({
    total_pages: 1,
    results: [{ champ_non_consomme: { libre: ['de', 'rester', 'structuré'] } }],
  }, 1));
});

test('le lecteur JSON refuse le corps réel au-delà de 16 KiB', async () => {
  await assert.rejects(
    () => readJsonWithLimit(new Request('https://demo.test', { method: 'POST', body: JSON.stringify({ payload: 'x'.repeat(MAX_BODY_BYTES) }) })),
    /request_too_large/,
  );
  assert.deepEqual(
    await readJsonWithLimit(new Request('https://demo.test', { method: 'POST', body: '{"ok":true}' })),
    { ok: true },
  );
  await assert.rejects(
    () => readJsonWithLimit(new Request('https://demo.test', { method: 'POST', body: '{' })),
    /invalid_json/,
  );
});

test('les erreurs internes deviennent des codes publics stables', () => {
  assert.equal(publicErrorCode(new Error('reserve_leads:relation scans indisponible')), 'server_error');
  assert.equal(publicErrorCode(new Error('cache_read:SQL interne')), 'server_error');
  assert.equal(publicErrorCode(new Error('inconnu sensible')), 'server_error');
  assert.equal(publicErrorCode(new Error('invalid_target')), 'invalid_target');
  assert.equal(publicErrorCode(new Error('server_busy')), 'server_busy');
});