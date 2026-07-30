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
} from '../supabase/functions/_shared/scan-policy.js';
import { LEGALS, SECTORS, referenceRowMatchesFilters } from '../supabase/functions/_shared/filters.js';

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
      { type: 'departement', code: '75', label: 'texte navigateur ignoré' },
      { type: 'region', code: '11', label: 'texte navigateur ignoré' },
    ],
  });
  assert.deepEqual(filters.zones, [
    { type: 'departement', code: '75' },
    { type: 'region', code: '11' },
  ]);
  assert.deepEqual(filters.geoParams, { departement: '75,77,78,91,92,93,94,95' });
  assert.throws(() => sanitizeScanFilters({ sectors: ['N'], zones: [{ type: 'pays', code: 'FR' }] }), /invalid_zones/);
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
  assert.throws(() => validateUpstreamPayload({ total_pages: 2, results: {} }, 1), /upstream_invalid_payload/);
  assert.deepEqual(validateUpstreamPayload({ total_pages: 2, results: [] }, 1), { totalPages: 2, results: [] });
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
  assert.equal(publicErrorCode(new Error('reserve_leads:relation scans indisponible')), 'reservation_failed');
  assert.equal(publicErrorCode(new Error('cache_read:SQL interne')), 'cache_read_failed');
  assert.equal(publicErrorCode(new Error('inconnu sensible')), 'internal_error');
  assert.equal(publicErrorCode(new Error('invalid_target')), 'invalid_target');
});