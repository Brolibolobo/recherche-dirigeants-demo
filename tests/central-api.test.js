import test from 'node:test';
import assert from 'node:assert/strict';
import { isCentralConfigured, scanCentral } from '../src/central-api.js';

test('le mode central same-origin est toujours actif', () => {
  assert.equal(isCentralConfigured(), true);
});

test('scanCentral appelle uniquement la Function same-origin sans secret', async () => {
  let request;
  const result = await scanCentral({ mode: 'history', query: 'Alice', filters: { nafCodes: ['81.21Z'] }, target: 25 }, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ rows: [{ siren: '123456789' }], cache: { hit_pages: 1 } }), { status: 200 });
    },
  });

  assert.equal(request.url, '/api/scan');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(JSON.parse(request.options.body).target, 25);
  assert.equal(JSON.parse(request.options.body).mode, 'history');
  assert.equal(JSON.parse(request.options.body).query, 'Alice');
  assert.equal(result.rows.length, 1);
});

test('scanCentral expose une erreur serveur lisible', async () => {
  await assert.rejects(
    () => scanCentral({ filters: {}, target: 1 }, {
      fetchImpl: async () => new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '30' },
      }),
    }),
    error => {
      assert.equal(error.message, 'rate_limited');
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, 30);
      return true;
    },
  );
});