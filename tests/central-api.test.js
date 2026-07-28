import test from 'node:test';
import assert from 'node:assert/strict';
import { isCentralConfigured, scanCentral } from '../src/central-api.js';

test('le cache central reste désactivé sans URL et clé publique', () => {
  assert.equal(isCentralConfigured({ url: '', publicKey: '' }), false);
  assert.equal(isCentralConfigured({ url: 'https://demo.supabase.co', publicKey: 'public' }), true);
});

test('scanCentral appelle uniquement l’Edge Function et transmet la clé publique', async () => {
  let request;
  const result = await scanCentral({ mode: 'history', query: 'Alice', filters: { nafCodes: ['81.21Z'] }, target: 25 }, {
    config: { url: 'https://demo.supabase.co', publicKey: 'public-key' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ rows: [{ siren: '123456789' }], cache: { hit_pages: 1 } }), { status: 200 });
    },
  });

  assert.equal(request.url, 'https://demo.supabase.co/functions/v1/scan');
  assert.equal(request.options.headers.Authorization, 'Bearer public-key');
  assert.equal(JSON.parse(request.options.body).target, 25);
  assert.equal(JSON.parse(request.options.body).mode, 'history');
  assert.equal(JSON.parse(request.options.body).query, 'Alice');
  assert.equal(result.rows.length, 1);
});

test('scanCentral expose une erreur serveur lisible', async () => {
  await assert.rejects(
    () => scanCentral({ filters: {}, target: 1 }, {
      config: { url: 'https://demo.supabase.co', publicKey: 'public-key' },
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