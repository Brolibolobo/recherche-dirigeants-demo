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
import { LEGALS, SECTORS } from '../supabase/functions/_shared/filters.js';

test('la politique MVP borne coût, pages, deadline et corps HTTP', () => {
  assert.equal(MAX_SCAN_TARGET, 100);
  assert.equal(MAX_SCAN_PAGES, 50);
  assert.equal(SCAN_DEADLINE_MS, 25_000);
  assert.equal(MAX_BODY_BYTES, 16_384);
});

test('les filtres fournis sont stricts mais une liste juridique vide garde les défauts', () => {
  assert.deepEqual(sanitizeScanFilters({}).sectors, SECTORS.map(([value]) => value));
  assert.deepEqual(sanitizeScanFilters({ sectors: ['C'], legal: [] }).legal, LEGALS.map(([value]) => value));
  assert.throws(() => sanitizeScanFilters({ sectors: ['N'], legal: ['invalide'] }), /invalid_legal/);
  assert.throws(() => sanitizeScanFilters({ sectors: ['invalide'], legal: [] }), /invalid_sectors/);
  const filters = sanitizeScanFilters({ sectors: ['N'], legal: [] });
  assert.ok(filters.legal.length > 1);
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