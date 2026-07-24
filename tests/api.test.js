import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchParams, buildSearchUrl, fetchSearchPage, retryAfterDelay, RATE_LIMIT_PER_SECOND } from '../src/api.js';

test('la requête utilise le code APE précis et exclut les finances/CA', () => {
  const params = buildSearchParams({
    page: 1,
    filters: {
      geo: '75001',
      nafCode: '81.21Z',
      sectors: ['N'],
      staffMin: 3,
      staffMax: 49,
    },
  });

  assert.equal(params.get('activite_principale'), '81.21Z');
  assert.equal(params.get('code_postal'), '75001');
  assert.equal(params.has('ca_min'), false);
  assert.equal(params.get('include'), 'dirigeants,matching_etablissements,siege');
  assert.equal(buildSearchUrl({ page: 1, filters: { nafCode: '81.21Z' } }).includes('activite_principale=81.21Z'), true);
});

test('le client reste sous la limite officielle de 7 appels/s', () => {
  assert.equal(RATE_LIMIT_PER_SECOND, 6);
});

test('une erreur API 400 expose le champ erreur exact', async () => {
  const fetchImpl = async () => ({
    status: 400,
    ok: false,
    headers: { get: () => null },
    json: async () => ({ erreur: 'Au moins un paramètre departement est non valide.' }),
  });

  await assert.rejects(
    fetchSearchPage({ page: 1, filters: {} }, { fetchImpl, maxRetries: 0 }),
    /Au moins un paramètre departement est non valide/,
  );
});

test('Retry-After accepte les secondes et la date HTTP', () => {
  assert.equal(retryAfterDelay('2', 0, 999), 2000);
  assert.equal(retryAfterDelay(new Date(5000).toUTCString(), 0, 999), 5000);
  assert.equal(retryAfterDelay('invalide', 0, 999), 999);
});

test('le client retente après 429', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { status: 429, ok: false, headers: { get: () => '0' } };
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ results: [] }) };
  };

  const data = await fetchSearchPage({ page: 1, filters: {} }, { fetchImpl, maxRetries: 1 });
  assert.deepEqual(data, { results: [] });
  assert.equal(calls, 2);
});
