import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, prepareUpstreamPage } from '../server/scan-handler.js';

const env = { DIRECTOR_FINGERPRINT_SALT: 'test-fingerprint-salt', RATE_LIMIT_SALT: 'test-rate-salt' };
const filters = { sectors: ['N'], legal: ['sas'], staffMin: 0, staffMax: 1_000_000, ageMin: 18, ageMax: 100 };

function request(body = {}, options = {}) {
  return new Request('https://example.test/api/scan', {
    method: options.method || 'POST',
    headers: {
      origin: options.origin === undefined ? 'https://example.test' : options.origin,
      'content-type': options.contentType || 'application/json; charset=utf-8',
      ...(options.headers || {}),
    },
    body: options.method === 'GET' ? undefined : (options.rawBody ?? JSON.stringify({ mode: 'new', filters, target: 1, ...body })),
    signal: options.signal,
  });
}

function row(id, overrides = {}) {
  return {
    nom_entreprise: `Entreprise ${id}`,
    siren: String(id).padStart(9, '0'),
    code_ape: '81.21Z', secteur: 'N', nature_juridique: '5710', tranche_effectif: '11',
    dirigeant_prenoms: `Prenom${id}`, dirigeant_nom_famille: `Nom${id}`, dirigeant_nom: `Prenom${id} Nom${id}`,
    dirigeant_date_naissance: '1980-01-01', dirigeant_annee_naissance: '1980', dirigeant_age: 46,
    code_postal_siege: '75001', ...overrides,
  };
}

function stored(id, overrides = {}) {
  const key = String(id).padStart(64, 'a').slice(-64);
  return {
    lead_key: key,
    director_fingerprint: key,
    person_name_fingerprint: String(id).padStart(64, 'b').slice(-64),
    fingerprint_version: 2,
    identity_quality: 'strong',
    birth_year: '1980',
    company_siren: String(id).padStart(9, '0'),
    payload: row(id, overrides),
    first_seen_at: new Date(1_000 + id).toISOString(),
  };
}

function company(id) {
  return {
    nom_complet: `Entreprise ${id}`,
    siren: String(id).padStart(9, '0'),
    activite_principale: '81.21Z',
    section_activite_principale: 'N',
    nature_juridique: '5710',
    tranche_effectif_salarie: '11',
    etat_administratif: 'A',
    siege: { siret: `${String(id).padStart(9, '0')}00001`, code_postal: '75001', etat_administratif: 'A' },
    dirigeants: [{ type_dirigeant: 'personne physique', prenoms: `Api${id}`, nom: `Nom${id}`, qualite: 'Président', date_de_naissance: '1980-01-01' }],
  };
}

function fakeDb(overrides = {}) {
  let scan = 0;
  return {
    rateLimit: async () => true,
    historyPage: async () => [],
    createScan: async () => `00000000-0000-0000-0000-${String(++scan).padStart(12, '0')}`,
    storedLeadsPage: async () => [],
    cachedPage: async () => null,
    claimPage: async () => true,
    reserveUpstreamSlot: async () => 0,
    storePage: async () => {},
    releasePage: async () => {},
    reserve: async (_scanId, candidates, limit) => candidates.slice(0, limit).map((item, index) => ({ ...item, ordinal: index + 1 })),
    finishScan: async () => {},
    failScan: async () => {},
    ...overrides,
  };
}

async function json(response) {
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('validation HTTP stricte: media type, objet, champs, types et origine complète', async () => {
  const handler = createHandler({ db: fakeDb(), env });
  assert.equal((await handler(request({}, { method: 'GET' }))).status, 405);
  assert.equal((await handler(request({}, { contentType: 'text/plain' }))).status, 415);
  assert.equal((await handler(request({}, { rawBody: '[]' }))).status, 400);
  assert.equal((await handler(request({ extra: true }))).status, 400);
  assert.equal((await handler(request({ target: '1' }))).status, 400);
  assert.equal((await handler(request({ query: 42, mode: 'history' }))).status, 400);
  assert.equal((await handler(request({}, { origin: 'http://example.test' }))).status, 403);
  assert.equal((await handler(request({}, { origin: undefined, headers: { origin: '' } }))).status, 403);
  const oversized = request({}, { rawBody: JSON.stringify({ value: 'x'.repeat(16_384) }) });
  assert.equal((await handler(oversized)).status, 413);
});

test('les erreurs DB inconnues sont cloisonnées et un scan créé via factory est marqué failed', async () => {
  const calls = [];
  const db = fakeDb({
    storedLeadsPage: async () => { throw new Error('relation_interne_avec_detail'); },
    failScan: async (id, code) => calls.push([id, code]),
  });
  const handler = createHandler({ dbFactory: () => db, env });
  const result = await json(await handler(request()));
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: 'server_error' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'server_error');
});

test('historique keyset trouve un résultat pertinent en 501e position', async () => {
  const calls = [];
  const irrelevant = Array.from({ length: 500 }, (_, index) => ({ lead_key: `k${index}`, delivered_at: new Date(10_000 - index).toISOString(), payload_snapshot: row(index, { secteur: 'C' }) }));
  const wanted = { lead_key: 'wanted', delivered_at: new Date(1).toISOString(), payload_snapshot: row(501) };
  const db = fakeDb({
    historyPage: async cursor => {
      calls.push(cursor);
      return calls.length === 1 ? irrelevant : [wanted];
    },
  });
  const handler = createHandler({ db, env });
  const result = await json(await handler(request({ mode: 'history', query: '', target: 1 })));
  assert.equal(result.status, 200);
  assert.equal(result.body.rows[0].siren, row(501).siren);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursorKey, 'k499');
});

test('stock keyset trouve et réserve un résultat pertinent en 501e position', async () => {
  const calls = [];
  const irrelevant = Array.from({ length: 500 }, (_, index) => stored(index, { secteur: 'C' }));
  const wanted = stored(501);
  const db = fakeDb({
    storedLeadsPage: async cursor => {
      calls.push(cursor);
      return calls.length === 1 ? irrelevant : [wanted];
    },
  });
  const result = await json(await createHandler({ db, env })(request()));
  assert.equal(result.body.rows[0].siren, wanted.payload.siren);
  assert.equal(result.body.cache.stored_rows, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursorKey, irrelevant.at(-1).lead_key);
});

test('compteurs exacts pour stock seul, stock + cache et stock + API', async t => {
  await t.test('stock seul', async () => {
    const db = fakeDb({ storedLeadsPage: async () => [stored(1)] });
    const result = await json(await createHandler({ db, env })(request()));
    assert.deepEqual(result.body.cache, { stored_rows: 1, hit_pages: 0, fetched_pages: 0, oldest_collected_at: null, newest_collected_at: null });
  });
  await t.test('stock + cache', async () => {
    const db = fakeDb({
      storedLeadsPage: async () => [stored(1)],
      cachedPage: async () => ({ response: { total_pages: 1, results: [company(2)] }, fetched_at: '2026-01-01T00:00:00.000Z' }),
    });
    const result = await json(await createHandler({ db, env })(request({ target: 2 })));
    assert.equal(result.body.rows.length, 2);
    assert.equal(result.body.cache.stored_rows, 1);
    assert.equal(result.body.cache.hit_pages, 1);
    assert.equal(result.body.cache.fetched_pages, 0);
  });
  await t.test('stock + API', async () => {
    const db = fakeDb({ storedLeadsPage: async () => [stored(1)] });
    const fetchImpl = async () => new Response(JSON.stringify({ total_pages: 1, results: [company(2)] }), { status: 200 });
    const result = await json(await createHandler({ db, env, fetchImpl })(request({ target: 2 })));
    assert.equal(result.body.rows.length, 2);
    assert.equal(result.body.cache.stored_rows, 1);
    assert.equal(result.body.cache.hit_pages, 0);
    assert.equal(result.body.cache.fetched_pages, 1);
  });
});

test('une erreur page 2 après réservation retourne les lignes en partial et finalise', async () => {
  const finishes = [];
  let fetches = 0;
  const db = fakeDb({ finishScan: async (...args) => finishes.push(args) });
  const fetchImpl = async () => {
    fetches += 1;
    if (fetches === 1) return new Response(JSON.stringify({ total_pages: 2, results: [company(1)] }), { status: 200 });
    return new Response('indisponible', { status: 500 });
  };
  const result = await json(await createHandler({ db, env, fetchImpl })(request({ target: 2 })));
  assert.equal(result.status, 200);
  assert.equal(result.body.rows.length, 1);
  assert.equal(result.body.partial, true);
  assert.equal(result.body.warning, 'upstream_failed');
  assert.equal(finishes.length, 1);
  assert.deepEqual(finishes[0].slice(1, 3), [1, 'upstream_failed']);
});

test('429 réserve cadence/quota à chaque tentative, respecte Retry-After et renouvelle le lease', async () => {
  const rateCalls = [], slots = [], sleeps = [], claims = [];
  let fetches = 0;
  const db = fakeDb({
    rateLimit: async (...args) => { rateCalls.push(args); return true; },
    reserveUpstreamSlot: async (...args) => { slots.push(args); return 3; },
    claimPage: async (...args) => { claims.push(args); return true; },
  });
  const fetchImpl = async () => {
    fetches += 1;
    if (fetches === 1) return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
    return new Response(JSON.stringify({ total_pages: 1, results: [company(1)] }), { status: 200 });
  };
  const result = await json(await createHandler({ db, env, fetchImpl, sleep: async ms => { sleeps.push(ms); } })(request()));
  assert.equal(result.status, 200);
  assert.equal(fetches, 2);
  assert.equal(slots.length, 2);
  assert.deepEqual(slots.map(call => call.slice(0, 2)), [['recherche-entreprises-api', 170], ['recherche-entreprises-api', 170]]);
  assert.equal(rateCalls.filter(call => call[1] === 120).length, 2);
  assert.ok(claims.length >= 5);
  assert.ok(sleeps.includes(3));
});

test('quota global épuisé répond 429 avec Retry-After et ne laisse pas le scan running', async () => {
  let failed = 0;
  const db = fakeDb({
    rateLimit: async (_key, maximum) => maximum !== 120,
    failScan: async () => { failed += 1; },
  });
  const result = await json(await createHandler({ db, env, fetchImpl: async () => { throw new Error('fetch_should_not_run'); } })(request()));
  assert.equal(result.status, 429);
  assert.equal(result.headers.get('Retry-After'), '60');
  assert.deepEqual(result.body, { error: 'global_upstream_budget_exhausted' });
  assert.equal(failed, 1);
});

test('deux scans concurrents sur la même cache miss font un seul fetch et le second relit le cache', async () => {
  const pages = new Map(), locks = new Map();
  let scans = 0, fetches = 0;
  const db = fakeDb({
    createScan: async () => `00000000-0000-0000-0000-${String(++scans).padStart(12, '0')}`,
    cachedPage: async (hash, page) => pages.get(`${hash}:${page}`) || null,
    claimPage: async (hash, page, owner) => {
      const key = `${hash}:${page}`;
      if (!locks.has(key) || locks.get(key) === owner) { locks.set(key, owner); return true; }
      return false;
    },
    storePage: async (hash, page, _request, response) => pages.set(`${hash}:${page}`, { response, fetched_at: '2026-01-01T00:00:00.000Z' }),
    releasePage: async (hash, page, owner) => { if (locks.get(`${hash}:${page}`) === owner) locks.delete(`${hash}:${page}`); },
  });
  let releaseFetch;
  const gate = new Promise(resolve => { releaseFetch = resolve; });
  const fetchImpl = async () => {
    fetches += 1;
    await gate;
    return new Response(JSON.stringify({ total_pages: 1, results: [company(1)] }), { status: 200 });
  };
  const handler = createHandler({ db, env, fetchImpl, sleep: () => new Promise(resolve => setTimeout(resolve, 1)) });
  const first = handler(request());
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = handler(request());
  await new Promise(resolve => setTimeout(resolve, 5));
  releaseFetch();
  const [a, b] = await Promise.all([first, second].map(async promise => json(await promise)));
  assert.equal(fetches, 1);
  assert.equal(a.body.cache.fetched_pages + b.body.cache.fetched_pages, 1);
  assert.equal(a.body.cache.hit_pages + b.body.cache.hit_pages, 1);
});

test('relit le cache après avoir acquis un lease sur un snapshot initial vide', async () => {
  const cached = { response: { total_pages: 1, results: [company(1)] }, fetched_at: '2026-01-01T00:00:00.000Z' };
  let cacheReads = 0, fetches = 0, stores = 0, releases = 0;
  const db = fakeDb({
    cachedPage: async () => (++cacheReads === 1 ? null : cached),
    claimPage: async () => true,
    storePage: async () => { stores += 1; },
    releasePage: async () => { releases += 1; },
  });
  const result = await json(await createHandler({
    db,
    env,
    fetchImpl: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ total_pages: 1, results: [company(2)] }), { status: 200 });
    },
  })(request()));
  assert.equal(result.status, 200);
  assert.equal(cacheReads, 2);
  assert.equal(fetches, 0);
  assert.equal(stores, 0);
  assert.equal(releases, 1);
  assert.equal(result.body.cache.hit_pages, 1);
  assert.equal(result.body.cache.fetched_pages, 0);
});

test('un 200 upstream malformé ne pollue pas le cache et le scan suivant peut retenter', async t => {
  const trapped = { toString: null, valueOf: null };
  const malformedPayloads = [
    ['résultat null', { total_pages: 1, results: [null] }],
    ['dirigeants non tableau', { total_pages: 1, results: [{ ...company(1), dirigeants: {} }] }],
    ['nature juridique objet', { total_pages: 1, results: [{ ...company(1), nature_juridique: trapped }] }],
    ['siège scalaire objet', { total_pages: 1, results: [{ ...company(1), siege: { ...company(1).siege, adresse: trapped } }] }],
    ['dirigeant scalaire objet', { total_pages: 1, results: [{ ...company(1), dirigeants: [{ ...company(1).dirigeants[0], qualite: trapped }] }] }],
    ['établissement scalaire objet', { total_pages: 1, results: [{ ...company(1), matching_etablissements: [{ etat_administratif: 'A', code_postal: trapped }] }] }],
    ...[null, false, [], '1'].map(value => [`total_pages ${JSON.stringify(value)}`, { total_pages: value, results: [] }]),
  ];

  for (const [name, malformedPayload] of malformedPayloads) {
    await t.test(name, async () => {
      let cached = null, fetches = 0, stores = 0;
      const db = fakeDb({
        cachedPage: async () => cached,
        storePage: async (_hash, _page, _request, response) => {
          stores += 1;
          cached = { response, fetched_at: '2026-01-01T00:00:00.000Z' };
        },
      });
      const fetchImpl = async () => {
        fetches += 1;
        const payload = fetches === 1 ? malformedPayload : { total_pages: 1, results: [company(1)] };
        return new Response(JSON.stringify(payload), { status: 200 });
      };
      const handler = createHandler({ db, env, fetchImpl });

      const malformed = await json(await handler(request()));
      assert.equal(malformed.status, 502);
      assert.deepEqual(malformed.body, { error: 'upstream_invalid_payload' });
      assert.equal(stores, 0);
      assert.equal(cached, null);

      const retry = await json(await handler(request()));
      assert.equal(retry.status, 200);
      assert.equal(retry.body.rows.length, 1);
      assert.equal(fetches, 2);
      assert.equal(stores, 1);
    });
  }
});

test('une identité uniquement ponctuée répond 502 sans cache et le scan suivant refetch', async () => {
  let cached = null, fetches = 0, stores = 0, releases = 0;
  const invalid = company(1);
  invalid.dirigeants[0] = { ...invalid.dirigeants[0], prenoms: '---', nom: '...', date_de_naissance: '1980-01-01' };
  const db = fakeDb({
    cachedPage: async () => cached,
    storePage: async (_hash, _page, _request, response) => {
      stores += 1;
      cached = { response, fetched_at: '2026-01-01T00:00:00.000Z' };
    },
    releasePage: async () => { releases += 1; },
  });
  const fetchImpl = async () => {
    fetches += 1;
    const payload = fetches === 1
      ? { total_pages: 1, results: [invalid] }
      : { total_pages: 1, results: [company(2)] };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const handler = createHandler({ db, env, fetchImpl });

  const malformed = await json(await handler(request()));
  assert.equal(malformed.status, 502);
  assert.deepEqual(malformed.body, { error: 'upstream_invalid_payload' });
  assert.equal(stores, 0);
  assert.equal(cached, null);
  assert.equal(releases, 1);

  const retry = await json(await handler(request()));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.rows.length, 1);
  assert.equal(fetches, 2);
  assert.equal(stores, 1);
  assert.equal(releases, 2);
});

test('la validation cacheable couvre legal/âge avant store et évite un cache SAS→SA empoisonné', async () => {
  const invalidSa = company(2);
  invalidSa.nature_juridique = '5505';
  invalidSa.dirigeants[0] = { ...invalidSa.dirigeants[0], prenoms: '---', nom: '...' };
  const validSa = company(3);
  validSa.nature_juridique = '5505';
  let cached = null, fetches = 0, stores = 0;
  const db = fakeDb({
    cachedPage: async () => cached,
    storePage: async (_hash, _page, _request, response) => {
      stores += 1;
      cached = { response, fetched_at: '2026-01-01T00:00:00.000Z' };
    },
  });
  const fetchImpl = async () => {
    fetches += 1;
    const results = fetches === 1 ? [company(1), invalidSa] : [company(1), validSa];
    return new Response(JSON.stringify({ total_pages: 1, results }), { status: 200 });
  };
  const handler = createHandler({ db, env, fetchImpl });

  const sas = await json(await handler(request({ filters: { ...filters, legal: ['sas'] } })));
  assert.equal(sas.status, 502);
  assert.deepEqual(sas.body, { error: 'upstream_invalid_payload' });
  assert.equal(stores, 0);
  assert.equal(cached, null);

  const sa = await json(await handler(request({ filters: { ...filters, legal: ['sa'] } })));
  assert.equal(sa.status, 200);
  assert.equal(sa.body.rows[0].siren, validSa.siren);
  assert.equal(fetches, 2);
  assert.equal(stores, 1);
});

test('une société sans dirigeant physique ne rejette pas le cache si la personne morale n’a pas de nom/prénoms', async () => {
  const legalEntityOnly = company(1);
  legalEntityOnly.dirigeants = [{ type_dirigeant: 'personne morale', denomination: 'Holding Exemple', qualite: 'Président' }];
  let stores = 0;
  const result = await json(await createHandler({
    db: fakeDb({ storePage: async () => { stores += 1; } }),
    env,
    fetchImpl: async () => new Response(JSON.stringify({ total_pages: 1, results: [legalEntityOnly] }), { status: 200 }),
  })(request()));

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.rows, []);
  assert.equal(stores, 1);
});

test('un dirigeant non latin valide est accepté sans TypeError', async () => {
  const valid = company(1);
  valid.dirigeants[0] = { ...valid.dirigeants[0], prenoms: 'Мария', nom: 'Иванова' };
  const fetchImpl = async () => new Response(JSON.stringify({ total_pages: 1, results: [valid] }), { status: 200 });

  const result = await json(await createHandler({ db: fakeDb(), env, fetchImpl })(request()));
  assert.equal(result.status, 200);
  assert.equal(result.body.rows[0].dirigeant_prenoms, 'Мария');
  assert.equal(result.body.rows[0].dirigeant_nom_famille, 'Иванова');
});

test('le helper partagé prépare avant store tout ce que le traitement consomme', async () => {
  const consumed = company(1);
  consumed.activite_principale = 'toString';
  const ignored = company(2);
  ignored.nature_juridique = '9999';
  ignored.dirigeants[0] = { ...ignored.dirigeants[0], prenoms: '---', nom: '...' };
  const upstream = { total_pages: 1, results: [consumed, ignored] };
  const sanitized = {
    ...filters,
    geoParams: {},
    staffCodes: [],
    nafCodes: [],
  };
  const prepared = await prepareUpstreamPage(upstream, 1, sanitized, env.DIRECTOR_FINGERPRINT_SALT);

  assert.equal(prepared.totalPages, 1);
  assert.equal(prepared.candidates.length, 1);
  assert.equal(prepared.candidates[0].payload.libelle_ape, '');
  assert.equal(typeof prepared.candidates[0].payload.libelle_ape, 'string');
  assert.equal(prepared.candidates[0].identity_quality, 'strong');
});

test('le traitement réutilise les candidats validés même si la réponse change pendant store', async () => {
  const payload = { total_pages: 1, results: [company(1)] };
  const db = fakeDb({
    storePage: async () => {
      payload.results[0].dirigeants[0].prenoms = '---';
      payload.results[0].dirigeants[0].nom = '...';
    },
  });
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => payload,
  });

  const result = await json(await createHandler({ db, env, fetchImpl })(request()));
  assert.equal(result.status, 200);
  assert.equal(result.body.rows.length, 1);
  assert.equal(result.body.rows[0].dirigeant_prenoms, 'Api1');
});

test('un 200 upstream non JSON répond 502 sans cache et le scan suivant peut retenter', async () => {
  let cached = null, fetches = 0, stores = 0;
  const db = fakeDb({
    cachedPage: async () => cached,
    storePage: async (_hash, _page, _request, response) => {
      stores += 1;
      cached = { response, fetched_at: '2026-01-01T00:00:00.000Z' };
    },
  });
  const fetchImpl = async () => {
    fetches += 1;
    const body = fetches === 1 ? '{' : JSON.stringify({ total_pages: 1, results: [company(1)] });
    return new Response(body, { status: 200 });
  };
  const handler = createHandler({ db, env, fetchImpl });

  const malformed = await json(await handler(request()));
  assert.equal(malformed.status, 502);
  assert.deepEqual(malformed.body, { error: 'upstream_invalid_payload' });
  assert.equal(stores, 0);
  assert.equal(cached, null);

  const retry = await json(await handler(request()));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.rows.length, 1);
  assert.equal(fetches, 2);
  assert.equal(stores, 1);
});

test('annulation avant store empêche la mutation; annulation pendant reserve conserve et finalise le commit', async t => {
  await t.test('avant store', async () => {
    const controller = new AbortController();
    let stores = 0, failed = 0;
    const db = fakeDb({ storePage: async () => { stores += 1; }, failScan: async () => { failed += 1; } });
    const fetchImpl = async () => {
      controller.abort();
      return new Response(JSON.stringify({ total_pages: 1, results: [] }), { status: 200 });
    };
    const result = await json(await createHandler({ db, env, fetchImpl })(request({}, { signal: controller.signal })));
    assert.equal(result.body.error, 'request_aborted');
    assert.equal(stores, 0);
    assert.equal(failed, 1);
  });
  await t.test('reserve non annulée', async () => {
    const controller = new AbortController();
    const finishes = [];
    const db = fakeDb({
      storedLeadsPage: async () => [stored(1)],
      reserve: async (_scan, candidates) => { controller.abort(); return [{ ...candidates[0], ordinal: 1 }]; },
      finishScan: async (...args) => finishes.push(args),
    });
    const result = await json(await createHandler({ db, env })(request({}, { signal: controller.signal })));
    assert.equal(result.status, 200);
    assert.equal(result.body.rows.length, 1);
    assert.equal(result.body.partial, true);
    assert.equal(result.body.warning, 'request_aborted');
    assert.equal(finishes.length, 1);
    assert.deepEqual(finishes[0].slice(1, 3), [1, 'request_aborted']);
  });
});
