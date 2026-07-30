import { createHash, randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import {
  GLOBAL_UPSTREAM_REQUESTS_PER_MINUTE,
  MAX_SCAN_PAGES,
  MAX_SCAN_TARGET,
  SCAN_DEADLINE_MS,
  numberInRange,
  publicErrorCode,
  readJsonWithLimit,
  sanitizeScanFilters,
  validateUpstreamPayload,
} from './lib/scan-policy.js';
import { edgeErrorStatus } from './lib/http-errors.js';
import { buildSearchUrl, retryAfterDelay } from './lib/api-core.js';
import { canonicalApiFilterKey, directorIdentity, directorIdentityKeys } from './lib/cache.js';
import { buildReferenceRows, companyIsEligible, findActiveMatchingEstablishment, referenceRowMatchesFilters } from './lib/filters.js';
import nafLabels from './lib/naf-rev2.json' with { type: 'json' };

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const PAGE_SIZE = 500;
const LEASE_SECONDS = 30;
const POLL_MS = 100;
const MAX_UPSTREAM_ATTEMPTS = 4;
const MAX_RETRY_WAIT_MS = 60_000;
const UPSTREAM_INTERVAL_MS = 170;
const UPSTREAM_LIMITER_KEY = 'recherche-entreprises-api';
const CACHE_SHARED_LEGAL_FILTER = ['sas', 'sarl', 'sa'];
const VERCEL_MAX_DURATION_MS = 30_000;
const VERCEL_EXIT_MARGIN_MS = 1_000;
const CLEANUP_DB_BUDGET_MS = 1_000;
const BODY_FIELDS = new Set(['mode', 'query', 'filters', 'target']);
const hash = value => createHash('sha256').update(value).digest('hex');

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { ...JSON_HEADERS, ...headers } });
}

function assertActive(signal, deadline, now) {
  if (signal?.aborted) throw new Error('request_aborted');
  if (now() >= deadline) throw new Error('scan_deadline_exceeded');
}

function warningFor(error, signal, deadline, now) {
  if (signal?.aborted) return 'request_aborted';
  if (now() >= deadline) return 'scan_deadline_exceeded';
  return publicErrorCode(error);
}

function cleanupDbContext(context) {
  const current = context.now();
  const hardDeadline = Number.isFinite(context.hardDeadline)
    ? context.hardDeadline
    : current + CLEANUP_DB_BUDGET_MS;
  return {
    ...context,
    signal: undefined,
    deadline: Math.min(hardDeadline, current + CLEANUP_DB_BUDGET_MS),
  };
}

function validateOrigin(request) {
  const value = request.headers.get('origin');
  if (!value) throw new Error('origin_not_allowed');
  try {
    if (new URL(value).origin !== new URL(request.url).origin) throw new Error('origin_not_allowed');
  } catch {
    throw new Error('origin_not_allowed');
  }
}

function validateContentType(request) {
  const value = request.headers.get('content-type') || '';
  if (value.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new Error('unsupported_media_type');
}

function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_request');
  if (Object.keys(body).some(key => !BODY_FIELDS.has(key))) throw new Error('invalid_request');
  const mode = body.mode === undefined ? 'new' : body.mode;
  if (mode !== 'new' && mode !== 'history') throw new Error('invalid_mode');
  if (body.query !== undefined && typeof body.query !== 'string') throw new Error('invalid_request');
  const query = (body.query || '').trim();
  if (query.length > 100) throw new Error('invalid_request');
  const filters = sanitizeScanFilters(body.filters === undefined ? {} : body.filters, { allowEmptyActivity: mode === 'history' });
  const target = numberInRange(body.target, 1, MAX_SCAN_TARGET, 'target');
  return { mode, query, filters, target };
}

function candidateFromStored(item) {
  return {
    lead_key: item.lead_key,
    director_fingerprint: item.director_fingerprint,
    person_name_fingerprint: item.person_name_fingerprint,
    fingerprint_version: item.fingerprint_version,
    identity_quality: item.identity_quality,
    birth_year: item.birth_year,
    company_siren: item.company_siren,
    payload: item.payload,
  };
}

async function candidateFromIdentity(row, identity, salt) {
  const { leadKey: key, personNameKey: nameKey } = await directorIdentityKeys(identity, salt);
  return {
    lead_key: key,
    director_fingerprint: key,
    person_name_fingerprint: nameKey,
    fingerprint_version: identity.version,
    identity_quality: identity.quality,
    birth_year: identity.birthYear,
    company_siren: row.siren,
    payload: row,
  };
}

function processableRows(upstream, currentPage, filters, { legal, ageMin, ageMax }, context) {
  const processable = [];
  const hasGeo = Object.keys(filters.geoParams).length > 0;
  const sourceUrl = buildSearchUrl({ page: currentPage, filters });
  for (const company of upstream.results) {
    if (context) assertActive(context.signal, context.deadline, context.now);
    if (!companyIsEligible(company, legal)) continue;
    const matchedEstablishment = hasGeo ? findActiveMatchingEstablishment(company) : null;
    if (hasGeo && !matchedEstablishment) continue;
    const code = company.activite_principale;
    const apeLabel = Object.hasOwn(nafLabels, code) ? nafLabels[code] : '';
    for (const row of buildReferenceRows(company, { apeLabel, sourceUrl, ageMin, ageMax, matchedEstablishment })) {
      processable.push({ row, identity: directorIdentity(row) });
    }
  }
  return processable;
}

async function candidatesFromRows(processable, fingerprintSalt, context) {
  const candidates = [];
  for (const { row, identity } of processable) {
    if (context) assertActive(context.signal, context.deadline, context.now);
    candidates.push(await candidateFromIdentity(row, identity, fingerprintSalt));
  }
  return candidates;
}

export async function prepareUpstreamPage(payload, currentPage, filters, fingerprintSalt, context) {
  let upstream;
  let processable;
  try {
    upstream = validateUpstreamPayload(payload, currentPage);

    // legal and age are deliberately absent from the shared cache key. Validate
    // every physical director that any supported legal/age scan could consume,
    // using the same row, identity and fingerprint helpers as reservation.
    const cacheable = processableRows(upstream, currentPage, filters, {
      legal: CACHE_SHARED_LEGAL_FILTER,
      ageMin: 18,
      ageMax: 100,
    }, context);
    await candidatesFromRows(cacheable, fingerprintSalt, context);

    // Only after cache-wide validation, prepare this scan's filtered candidates.
    processable = processableRows(upstream, currentPage, filters, filters, context);
  } catch (error) {
    if (error instanceof Error && ['request_aborted', 'scan_deadline_exceeded'].includes(error.message)) throw error;
    throw new Error('upstream_invalid_payload');
  }

  const candidates = await candidatesFromRows(processable, fingerprintSalt, context);
  return { totalPages: upstream.totalPages, candidates };
}

function defaultSleep(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('request_aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function sleepBounded(milliseconds, context) {
  assertActive(context.signal, context.deadline, context.now);
  const remaining = context.deadline - context.now();
  await context.sleep(Math.min(Math.max(0, milliseconds), remaining), context.signal);
  assertActive(context.signal, context.deadline, context.now);
}

async function readHistory(database, filters, query, target, context) {
  const rows = [];
  const snapshotTime = new Date(context.now()).toISOString();
  let cursorTime = '';
  let cursorKey = '';
  let warning = '';
  while (rows.length < target) {
    try {
      assertActive(context.signal, context.deadline, context.now);
      const page = await database.historyPage({ snapshotTime, cursorTime, cursorKey, limit: PAGE_SIZE }, context);
      assertActive(context.signal, context.deadline, context.now);
      for (const item of page) {
        if (referenceRowMatchesFilters(item.payload_snapshot, filters, query)) rows.push(item.payload_snapshot);
        if (rows.length >= target) break;
      }
      if (page.length < PAGE_SIZE) break;
      const last = page.at(-1);
      cursorTime = last.delivered_at;
      cursorKey = last.lead_key;
    } catch (error) {
      if (!rows.length) throw error;
      warning = warningFor(error, context.signal, context.deadline, context.now);
      break;
    }
  }
  return { rows, warning };
}

async function reserveStored(database, scanId, filters, target, context) {
  const rows = [];
  const snapshotTime = new Date(context.now()).toISOString();
  let cursorTime = '';
  let cursorKey = '';
  let warning = '';
  while (rows.length < target) {
    try {
      assertActive(context.signal, context.deadline, context.now);
      const page = await database.storedLeadsPage({ snapshotTime, cursorTime, cursorKey, limit: PAGE_SIZE }, context);
      assertActive(context.signal, context.deadline, context.now);
      const matching = page.filter(item => referenceRowMatchesFilters(item.payload, filters));
      if (matching.length) {
        assertActive(context.signal, context.deadline, context.now);
        // Cancellation bounds this atomic transaction. If it already committed,
        // Postgres.js resolves and the committed ledger rows are returned.
        const reserved = await database.reserve(scanId, matching.map(candidateFromStored), target - rows.length, context);
        rows.push(...reserved.map(item => item.payload));
        if (context.signal?.aborted) { warning = 'request_aborted'; break; }
        if (context.now() >= context.deadline) { warning = 'scan_deadline_exceeded'; break; }
      }
      if (page.length < PAGE_SIZE) break;
      const last = page.at(-1);
      cursorTime = last.first_seen_at;
      cursorKey = last.lead_key;
    } catch (error) {
      if (!rows.length) throw error;
      warning = warningFor(error, context.signal, context.deadline, context.now);
      break;
    }
  }
  return { rows, warning };
}

async function renewLease(database, queryHash, page, owner, context) {
  assertActive(context.signal, context.deadline, context.now);
  if (!(await database.claimPage(queryHash, page, owner, LEASE_SECONDS, context))) throw new Error('cache_lease_lost');
}

async function sleepWithLease(milliseconds, renew, context) {
  let remaining = Math.max(0, milliseconds);
  while (remaining > 0) {
    const duration = Math.min(10_000, remaining);
    await sleepBounded(duration, context);
    remaining -= duration;
    await renew();
  }
}

async function governmentPage(database, page, filters, ownerLease, globalBudgetHash, context) {
  let cumulativeRetryWait = 0;
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    assertActive(context.signal, context.deadline, context.now);
    await ownerLease();
    assertActive(context.signal, context.deadline, context.now);
    if (!(await database.rateLimit(globalBudgetHash, GLOBAL_UPSTREAM_REQUESTS_PER_MINUTE, 60, context))) {
      throw new Error('global_upstream_budget_exhausted');
    }
    assertActive(context.signal, context.deadline, context.now);
    const wait = Number(await database.reserveUpstreamSlot(UPSTREAM_LIMITER_KEY, UPSTREAM_INTERVAL_MS, context));
    if (!Number.isFinite(wait) || wait < 0) throw new Error('upstream_slot:invalid_wait');
    if (wait > 0) await sleepWithLease(wait, ownerLease, context);
    await ownerLease();

    const requestTimeout = Math.max(1, Math.min(20_000, context.deadline - context.now()));
    const timeout = AbortSignal.timeout(requestTimeout);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    let response;
    try {
      response = await context.fetchImpl(buildSearchUrl({ page, filters }), { signal });
    } catch (error) {
      if (context.signal?.aborted) throw new Error('request_aborted');
      if (context.now() >= context.deadline) throw new Error('scan_deadline_exceeded');
      throw new Error('government_api_network');
    }
    if (response.status === 429 && attempt < MAX_UPSTREAM_ATTEMPTS) {
      const delay = Math.min(MAX_RETRY_WAIT_MS, retryAfterDelay(response.headers.get('Retry-After'), context.now(), 1_200 * attempt * attempt));
      if (cumulativeRetryWait + delay > MAX_RETRY_WAIT_MS) throw new Error('government_api_retry_after_too_long');
      cumulativeRetryWait += delay;
      await sleepWithLease(delay, ownerLease, context);
      continue;
    }
    if (!response.ok) throw new Error(`government_api_http_${response.status}`);
    await ownerLease();
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('upstream_invalid_payload');
      throw error;
    }
    await ownerLease();
    return payload;
  }
  throw new Error('government_api_rate_limited');
}

async function getPage(database, queryHash, page, filters, fingerprintSalt, owner, globalBudgetHash, context) {
  assertActive(context.signal, context.deadline, context.now);
  const cached = await database.cachedPage(queryHash, page, context);
  if (cached) {
    const prepared = await prepareUpstreamPage(cached.response, page, filters, fingerprintSalt, context);
    return { ...cached, prepared, source: 'cache' };
  }

  while (true) {
    assertActive(context.signal, context.deadline, context.now);
    const claimed = await database.claimPage(queryHash, page, owner, LEASE_SECONDS, context);
    if (!claimed) {
      await sleepBounded(POLL_MS, context);
      const available = await database.cachedPage(queryHash, page, context);
      if (available) {
        const prepared = await prepareUpstreamPage(available.response, page, filters, fingerprintSalt, context);
        return { ...available, prepared, source: 'cache' };
      }
      continue;
    }

    const renew = () => renewLease(database, queryHash, page, owner, context);
    try {
      const available = await database.cachedPage(queryHash, page, context);
      if (available) {
        const prepared = await prepareUpstreamPage(available.response, page, filters, fingerprintSalt, context);
        return { ...available, prepared, source: 'cache' };
      }
      const response = await governmentPage(database, page, filters, renew, globalBudgetHash, context);
      assertActive(context.signal, context.deadline, context.now);
      const prepared = await prepareUpstreamPage(response, page, filters, fingerprintSalt, context);
      assertActive(context.signal, context.deadline, context.now);
      const fetchedAt = new Date(context.now()).toISOString();
      await database.storePage(queryHash, page, {
        canonical: canonicalApiFilterKey(filters),
        url: buildSearchUrl({ page, filters }),
      }, response, fetchedAt, context);
      return { response, prepared, fetched_at: fetchedAt, source: 'government' };
    } finally {
      try {
        await database.releasePage(queryHash, page, owner, cleanupDbContext(context));
      } catch { /* short best-effort cleanup, bounded before Vercel termination */ }
    }
  }
}

async function finalize(database, scanId, rows, warning, context) {
  // A committed reservation must be made visible even after disconnect/deadline.
  // Otherwise finalization follows the normal pre-mutation cancellation guard.
  let effectiveWarning = warning;
  let dbContext = context;
  try {
    assertActive(context.signal, context.deadline, context.now);
  } catch (error) {
    if (!rows.length) throw error;
    effectiveWarning ||= warningFor(error, context.signal, context.deadline, context.now);
    dbContext = cleanupDbContext(context);
  }
  await database.finishScan(scanId, rows.length, effectiveWarning, dbContext);
  return effectiveWarning;
}

export function createHandler({
  db,
  dbFactory = getDb,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  return async request => {
    const startedAt = now();
    let activeDatabase = null;
    let scanId = '';
    let rows = [];
    let target = 0;
    let mode = 'new';
    let warning = '';
    let finalized = false;
    let cache = { stored_rows: 0, hit_pages: 0, fetched_pages: 0, oldest_collected_at: null, newest_collected_at: null };
    let context;

    try {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
      validateOrigin(request);
      validateContentType(request);
      const parsed = validateBody(await readJsonWithLimit(request));
      ({ mode, target } = parsed);
      const { filters, query } = parsed;
      const deadline = startedAt + SCAN_DEADLINE_MS;
      const hardDeadline = startedAt + VERCEL_MAX_DURATION_MS - VERCEL_EXIT_MARGIN_MS;
      context = { signal: request.signal, deadline, hardDeadline, now, sleep, fetchImpl };

      activeDatabase = db || dbFactory(env.DATABASE_URL);
      const rateSalt = typeof env.RATE_LIMIT_SALT === 'string' ? env.RATE_LIMIT_SALT.trim() : '';
      if (!rateSalt) throw new Error('missing_server_env');
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
      const requestLimit = mode === 'history' ? 20 : 5;
      assertActive(context.signal, context.deadline, context.now);
      if (!(await activeDatabase.rateLimit(hash(`${rateSalt}|${mode}|${ip}`), requestLimit, 60, context))) {
        return json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
      }

      if (mode === 'history') {
        const history = await readHistory(activeDatabase, filters, query, target, context);
        rows = history.rows;
        warning = history.warning;
        return json({
          mode,
          rows,
          partial: Boolean(warning),
          warning,
          cache: { ...cache, stored_rows: rows.length },
        });
      }

      const fingerprintSalt = typeof env.DIRECTOR_FINGERPRINT_SALT === 'string' ? env.DIRECTOR_FINGERPRINT_SALT.trim() : '';
      if (!fingerprintSalt) throw new Error('missing_server_env');
      const queryHash = hash(canonicalApiFilterKey(filters));
      assertActive(context.signal, context.deadline, context.now);
      scanId = await activeDatabase.createScan(queryHash, filters, target, context);

      const stored = await reserveStored(activeDatabase, scanId, filters, target, context);
      rows = stored.rows;
      cache.stored_rows = rows.length;
      warning = stored.warning;

      let page = 1;
      let totalPages = Number.POSITIVE_INFINITY;
      const collectedAt = [];
      const globalBudgetHash = hash(`${rateSalt}|global-upstream-budget`);
      while (!warning && rows.length < target && page <= totalPages && page <= MAX_SCAN_PAGES) {
        try {
          assertActive(context.signal, context.deadline, context.now);
          const pageResult = await getPage(activeDatabase, queryHash, page, filters, fingerprintSalt, scanId || randomUUID(), globalBudgetHash, context);
          if (pageResult.source === 'cache') cache.hit_pages += 1;
          else cache.fetched_pages += 1;
          if (pageResult.fetched_at) collectedAt.push(pageResult.fetched_at);
          totalPages = pageResult.prepared.totalPages;
          const candidates = pageResult.prepared.candidates;
          if (candidates.length) {
            assertActive(context.signal, context.deadline, context.now);
            const reserved = await activeDatabase.reserve(scanId, candidates, target - rows.length, context);
            rows.push(...reserved.map(item => item.payload));
            if (context.signal?.aborted) { warning = 'request_aborted'; break; }
            if (context.now() >= context.deadline) { warning = 'scan_deadline_exceeded'; break; }
          }
          page += 1;
        } catch (error) {
          if (!rows.length) throw error;
          warning = warningFor(error, context.signal, context.deadline, context.now);
          break;
        }
      }
      if (!warning && rows.length < target && page > MAX_SCAN_PAGES && totalPages >= page) warning = 'page_limit_reached';
      if (collectedAt.length) {
        collectedAt.sort();
        cache.oldest_collected_at = collectedAt[0];
        cache.newest_collected_at = collectedAt.at(-1);
      }

      warning = await finalize(activeDatabase, scanId, rows, warning, context);
      finalized = true;
      return json({ mode, scan_id: scanId, rows, partial: rows.length < target || Boolean(warning), warning, cache });
    } catch (error) {
      const code = warningFor(error, request.signal, context?.deadline ?? Number.POSITIVE_INFINITY, now);
      if (activeDatabase && scanId && rows.length && !finalized) {
        let partialWarning = code;
        try {
          partialWarning = await finalize(activeDatabase, scanId, rows, partialWarning, context);
          finalized = true;
        } catch {
          partialWarning = 'scan_finalize_failed';
        }
        return json({ mode, scan_id: scanId, rows, partial: true, warning: partialWarning, cache });
      }
      if (activeDatabase && scanId && !finalized) {
        try {
          await activeDatabase.failScan(scanId, code, cleanupDbContext(context));
        } catch { /* short best-effort cleanup; never expose database details */ }
      }
      const status = edgeErrorStatus(new Error(code));
      return json({ error: code }, status, status === 429 ? { 'Retry-After': '60' } : {});
    }
  };
}
