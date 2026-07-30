// @ts-ignore Deno resolves npm: specifiers at bundle time.
import { createClient } from 'npm:@supabase/supabase-js@2.110.8';
// Shared pure modules are also exercised by the browser/Node test suite.
// @ts-ignore JavaScript module bundled by the Supabase CLI.
import { findActiveMatchingEstablishment, buildReferenceRows, companyIsEligible, referenceRowMatchesFilters } from '../_shared/filters.js';
// @ts-ignore JavaScript module bundled by the Supabase CLI.
import {
  GLOBAL_UPSTREAM_REQUESTS_PER_MINUTE,
  MAX_SCAN_PAGES,
  MAX_SCAN_TARGET,
  SCAN_DEADLINE_MS,
  numberInRange,
  publicErrorCode,
  readJsonWithLimit,
  remainingDeadlineMillis,
  sanitizeScanFilters,
  validateUpstreamPayload,
} from '../_shared/scan-policy.js';
// @ts-ignore JavaScript module bundled by the Supabase CLI.
import { buildSearchUrl, retryAfterDelay } from '../_shared/api-core.js';
// @ts-ignore JavaScript module bundled by the Supabase CLI.
import { canonicalApiFilterKey, directorIdentity, leadKey, personNameKey, sha256Hex } from '../_shared/cache.js';
// @ts-ignore JavaScript module bundled by the Supabase CLI.
import { edgeErrorStatus } from '../_shared/http-errors.js';
import nafLabels from '../_shared/naf-rev2.json' with { type: 'json' };

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const MAX_RETRY_WAIT_MS = 60_000;
const HISTORY_REQUESTS_PER_MINUTE = 20;
const historyRateLimits = new Map<string, { window: number; count: number }>();

function boundedSignal(parent: AbortSignal | null, deadline: number) {
  const timeout = AbortSignal.timeout(remainingDeadlineMillis(deadline));
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function traversalWarning(error: unknown, signal: AbortSignal, deadline: number) {
  if (signal.aborted) return 'request_aborted';
  if (Date.now() >= deadline) return 'scan_deadline_exceeded';
  return publicErrorCode(error);
}

function allowHistoryRequest(request: Request) {
  const key = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const window = Math.floor(Date.now() / 60_000);
  const current = historyRateLimits.get(key);
  if (!current || current.window !== window) {
    historyRateLimits.set(key, { window, count: 1 });
    if (historyRateLimits.size > 1_000) {
      for (const [entry, value] of historyRateLimits) if (value.window !== window) historyRateLimits.delete(entry);
    }
    return true;
  }
  current.count++;
  return current.count <= HISTORY_REQUESTS_PER_MINUTE;
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`missing_env:${name}`);
  return value;
}

function corsHeaders(request: Request) {
  const origin = request.headers.get('origin') || '';
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') || 'http://127.0.0.1:8765,https://brolibolobo.github.io')
    .split(',').map((value: string) => value.trim()).filter(Boolean);
  if (origin && !allowed.includes(origin)) throw new Error('origin_not_allowed');
  return {
    'Access-Control-Allow-Origin': origin || allowed[0],
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(request: Request, body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request), ...extraHeaders },
  });
}

async function sleepBounded(milliseconds: number, signal: AbortSignal, deadline: number) {
  const duration = Math.min(Math.max(0, milliseconds), remainingDeadlineMillis(deadline));
  if (signal.aborted) throw new Error('request_aborted');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('request_aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, duration);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function sleepWithLease(
  milliseconds: number,
  renewCacheLease: () => Promise<void>,
  scanDeadline: number,
  signal: AbortSignal,
) {
  const sleepDeadline = Date.now() + Math.max(0, milliseconds);
  while (Date.now() < sleepDeadline) {
    await sleepBounded(Math.min(10_000, sleepDeadline - Date.now()), signal, scanDeadline);
    await renewCacheLease();
  }
}

async function governmentPage(
  supabase: ReturnType<typeof createClient>,
  page: number,
  filters: ReturnType<typeof sanitizeScanFilters>,
  renewCacheLease: () => Promise<void>,
  globalBudgetHash: string,
  scanDeadline: number,
  signal: AbortSignal,
) {
  let cumulativeRetryWait = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (signal.aborted) throw new Error('request_aborted');
    remainingDeadlineMillis(scanDeadline);
    await renewCacheLease();
    const { data: globalAllowed, error: budgetError } = await supabase.rpc('consume_scan_rate_limit', {
      p_identifier_hash: globalBudgetHash,
      p_max_requests: GLOBAL_UPSTREAM_REQUESTS_PER_MINUTE,
      p_window_seconds: 60,
    }).abortSignal(boundedSignal(signal, scanDeadline));
    if (budgetError) throw new Error(`global_budget:${budgetError.message}`);
    if (!globalAllowed) throw new Error('global_upstream_budget_exhausted');

    const { data: wait, error: slotError } = await supabase.rpc('reserve_upstream_slot', {
      p_limiter_key: 'recherche-entreprises-api',
      p_interval_ms: 170,
    }).abortSignal(boundedSignal(signal, scanDeadline));
    if (slotError) throw new Error(`upstream_slot:${slotError.message}`);
    if (Number(wait) > 0) await sleepWithLease(Number(wait), renewCacheLease, scanDeadline, signal);

    await renewCacheLease();
    const requestDeadline = Math.min(scanDeadline, Date.now() + 20_000);
    const response = await fetch(buildSearchUrl({ page, filters }), { signal: boundedSignal(signal, requestDeadline) });
    if (response.status === 429 && attempt < 4) {
      const retryDelay = retryAfterDelay(response.headers.get('Retry-After'), Date.now(), 1200 * attempt * attempt);
      if (cumulativeRetryWait + retryDelay > MAX_RETRY_WAIT_MS) {
        throw new Error('government_api_retry_after_too_long');
      }
      cumulativeRetryWait += retryDelay;
      await sleepWithLease(retryDelay, renewCacheLease, scanDeadline, signal);
      continue;
    }
    if (!response.ok) {
      throw new Error(`government_api_http_${response.status}`);
    }
    await renewCacheLease();
    const payload = await response.json();
    await renewCacheLease();
    return payload;
  }
  throw new Error('government_api_rate_limited');
}

async function readCachedPage(
  supabase: ReturnType<typeof createClient>,
  queryHash: string,
  page: number,
  scanDeadline: number,
  signal: AbortSignal,
) {
  const query = supabase.from('api_cache_pages')
    .select('response,fetched_at')
    .eq('query_hash', queryHash)
    .eq('page', page)
    .maybeSingle();
  const { data, error } = await query.abortSignal(boundedSignal(signal, scanDeadline));
  if (error) throw new Error(`cache_read:${error.message}`);
  return data ? { response: data.response, fetchedAt: data.fetched_at } : null;
}

async function getPage(
  supabase: ReturnType<typeof createClient>,
  queryHash: string,
  page: number,
  filters: ReturnType<typeof sanitizeScanFilters>,
  owner: string,
  globalBudgetHash: string,
  scanDeadline: number,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new Error('request_aborted');
  remainingDeadlineMillis(scanDeadline);
  const cached = await readCachedPage(supabase, queryHash, page, scanDeadline, signal);
  if (cached) return { ...cached, source: 'cache' };

  const claimOrRenew = async () => {
    if (signal.aborted) throw new Error('request_aborted');
    const claim = supabase.rpc('claim_cache_page', {
      p_query_hash: queryHash,
      p_page: page,
      p_owner: owner,
      p_lease_seconds: 30,
    });
    const { data: claimed, error: claimError } = await claim.abortSignal(boundedSignal(signal, scanDeadline));
    if (claimError) throw new Error(`cache_claim:${claimError.message}`);
    return Boolean(claimed);
  };

  for (let claimAttempt = 0; claimAttempt < 2; claimAttempt++) {
    const claimed = await claimOrRenew();
    if (claimed) {
      try {
        const renewCacheLease = async () => {
          if (!(await claimOrRenew())) throw new Error('cache_lease_lost');
        };
        const response = await governmentPage(
          supabase,
          page,
          filters,
          renewCacheLease,
          globalBudgetHash,
          scanDeadline,
          signal,
        );
        await renewCacheLease();
        const fetchedAt = new Date().toISOString();
        const cacheWrite = supabase.from('api_cache_pages').upsert({
          query_hash: queryHash,
          page,
          request: { canonical: canonicalApiFilterKey(filters), url: buildSearchUrl({ page, filters }) },
          response,
          source_status: 200,
          schema_version: 1,
          fetched_at: fetchedAt,
        }, { onConflict: 'query_hash,page', ignoreDuplicates: true });
        const { error } = await cacheWrite.abortSignal(boundedSignal(signal, scanDeadline));
        if (error) throw new Error(`cache_write:${error.message}`);
        return { response, fetchedAt, source: 'government' };
      } finally {
        await supabase.rpc('release_cache_page', {
          p_query_hash: queryHash,
          p_page: page,
          p_owner: owner,
        }).abortSignal(AbortSignal.timeout(2_000));
      }
    }
    for (let poll = 0; poll < 40; poll++) {
      await sleepBounded(250, signal, scanDeadline);
      const available = await readCachedPage(supabase, queryHash, page, scanDeadline, signal);
      if (available) return { ...available, source: 'cache' };
    }
  }
  throw new Error('cache_page_busy');
}

const STORED_BATCH_SIZE = 500;

function leadCandidate(item: Record<string, unknown>) {
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

async function reserveStoredLeads(
  supabase: ReturnType<typeof createClient>,
  workspaceId: string,
  scanId: string,
  filters: ReturnType<typeof sanitizeScanFilters>,
  target: number,
  scanDeadline: number,
  signal: AbortSignal,
) {
  const rows: Record<string, unknown>[] = [];
  // Current request traverses rows timestamped before it started. Transactions that
  // commit later behind the cursor are intentionally eligible again on the next scan.
  const snapshotTime = new Date().toISOString();
  let cursorTime = '';
  let cursorKey = '';
  let warning = '';
  while (rows.length < target) {
    try {
      if (signal.aborted) { warning = 'request_aborted'; break; }
      remainingDeadlineMillis(scanDeadline);
      let pageQuery = supabase.from('leads')
        .select('lead_key,director_fingerprint,person_name_fingerprint,fingerprint_version,identity_quality,birth_year,company_siren,payload,first_seen_at')
        .lte('first_seen_at', snapshotTime)
        .order('first_seen_at', { ascending: true })
        .order('lead_key', { ascending: true })
        .limit(STORED_BATCH_SIZE);
      if (cursorTime) {
        pageQuery = pageQuery.or(`first_seen_at.gt.${cursorTime},and(first_seen_at.eq.${cursorTime},lead_key.gt.${cursorKey})`);
      }
      const { data, error } = await pageQuery.abortSignal(boundedSignal(signal, scanDeadline));
      if (error) throw new Error(`stored_leads:${error.message}`);
      remainingDeadlineMillis(scanDeadline);
      const matching = (data || []).filter((item: Record<string, unknown>) => referenceRowMatchesFilters(item.payload, filters));
      if (matching.length) {
        // Do not interrupt an in-flight reservation on a client disconnect: once the
        // RPC answers, committed rows are retained in the partial scan result.
        const { data: reserved, error: reserveError } = await supabase.rpc('reserve_scan_leads', {
          p_workspace_id: workspaceId,
          p_scan_id: scanId,
          p_candidates: matching.map(leadCandidate),
          p_limit: target - rows.length,
        }).abortSignal(boundedSignal(null, scanDeadline));
        if (reserveError) throw new Error(`reserve_leads:${reserveError.message}`);
        rows.push(...(reserved || []).map((item: { payload: Record<string, unknown> }) => item.payload));
        remainingDeadlineMillis(scanDeadline);
      }
      if (!data || data.length < STORED_BATCH_SIZE) break;
      const last = data.at(-1) as { first_seen_at: string; lead_key: string };
      cursorTime = last.first_seen_at;
      cursorKey = last.lead_key;
    } catch (error) {
      warning = traversalWarning(error, signal, scanDeadline);
      break;
    }
  }
  return { rows, warning };
}

async function readHistory(
  supabase: ReturnType<typeof createClient>,
  workspaceId: string,
  filters: ReturnType<typeof sanitizeScanFilters>,
  query: string,
  target: number,
  scanDeadline: number,
  signal: AbortSignal,
) {
  const rows: Record<string, unknown>[] = [];
  const snapshotTime = new Date().toISOString();
  let cursorTime = '';
  let cursorKey = '';
  let warning = '';
  while (rows.length < target) {
    try {
      if (signal.aborted) { warning = 'request_aborted'; break; }
      remainingDeadlineMillis(scanDeadline);
      let pageQuery = supabase.from('workspace_lead_deliveries')
        .select('lead_key,payload_snapshot,delivered_at')
        .eq('workspace_id', workspaceId)
        .lte('delivered_at', snapshotTime)
        .order('delivered_at', { ascending: false })
        .order('lead_key', { ascending: false })
        .limit(STORED_BATCH_SIZE);
      if (cursorTime) {
        pageQuery = pageQuery.or(`delivered_at.lt.${cursorTime},and(delivered_at.eq.${cursorTime},lead_key.lt.${cursorKey})`);
      }
      const { data, error } = await pageQuery.abortSignal(boundedSignal(signal, scanDeadline));
      if (error) throw new Error(`history_read:${error.message}`);
      remainingDeadlineMillis(scanDeadline);
      for (const item of data || []) {
        if (referenceRowMatchesFilters(item.payload_snapshot, filters, query)) rows.push(item.payload_snapshot);
        if (rows.length >= target) break;
      }
      if (!data || data.length < STORED_BATCH_SIZE) break;
      const last = data.at(-1) as { delivered_at: string; lead_key: string };
      cursorTime = last.delivered_at;
      cursorKey = last.lead_key;
    } catch (error) {
      warning = traversalWarning(error, signal, scanDeadline);
      break;
    }
  }
  return { rows, warning };
}

Deno.serve(async (request: Request) => {
  let activeSupabase: ReturnType<typeof createClient> | null = null;
  let activeScanId = '';
  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (request.method !== 'POST') return json(request, { error: 'method_not_allowed' }, 405);

    const supabaseUrl = requiredEnv('SUPABASE_URL');
    const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
    const workspaceId = requiredEnv('PUBLIC_WORKSPACE_ID');
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    activeSupabase = supabase;

    const body = await readJsonWithLimit(request);
    const mode = body?.mode === undefined || body?.mode === 'new' ? 'new' : body?.mode;
    if (mode !== 'new' && mode !== 'history') throw new Error('invalid_mode');
    const filters = sanitizeScanFilters(body?.filters || {}, { allowEmptyActivity: mode === 'history' });
    const target = numberInRange(body?.target, 1, MAX_SCAN_TARGET, 'target');
    const query = String(body?.query || '').trim().slice(0, 100);
    const scanDeadline = Date.now() + SCAN_DEADLINE_MS;

    if (mode === 'history') {
      if (!request.headers.get('origin')) throw new Error('origin_not_allowed');
      if (!allowHistoryRequest(request)) {
        return json(request, { error: 'rate_limited' }, 429, { 'Retry-After': '60' });
      }
      const history = await readHistory(supabase, workspaceId, filters, query, target, scanDeadline, request.signal);
      return json(request, {
        mode,
        rows: history.rows,
        partial: Boolean(history.warning),
        warning: history.warning,
        cache: { hit_pages: 0, fetched_pages: 0, stored_rows: history.rows.length },
      });
    }

    const fingerprintSalt = requiredEnv('DIRECTOR_FINGERPRINT_SALT');
    const rateLimitSalt = requiredEnv('RATE_LIMIT_SALT');
    const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const identifierHash = await sha256Hex(`${rateLimitSalt}|${forwardedFor}`);
    const { data: allowed, error: rateError } = await supabase.rpc('consume_scan_rate_limit', {
      p_identifier_hash: identifierHash,
      p_max_requests: 5,
      p_window_seconds: 60,
    });
    if (rateError) throw new Error(`rate_limit:${rateError.message}`);
    if (!allowed) {
      const retryAfterSeconds = Math.max(1, 60 - (Math.floor(Date.now() / 1000) % 60));
      return json(request, { error: 'rate_limited' }, 429, { 'Retry-After': String(retryAfterSeconds) });
    }

    const globalBudgetHash = await sha256Hex(`${rateLimitSalt}|global-upstream-budget`);
    const queryHash = await sha256Hex(canonicalApiFilterKey(filters));
    const { data: scan, error: scanError } = await supabase.from('scans').insert({
      workspace_id: workspaceId,
      query_hash: queryHash,
      filters,
      target_count: target,
    }).select('id').single();
    if (scanError) throw new Error(`scan_create:${scanError.message}`);
    activeScanId = scan.id;

    const stored = await reserveStoredLeads(supabase, workspaceId, scan.id, filters, target, scanDeadline, request.signal);
    const rows: Record<string, unknown>[] = stored.rows;
    const storedRows = rows.length;
    let page = 1;
    let totalPages = Number.POSITIVE_INFINITY;
    let hitPages = 0;
    let fetchedPages = 0;
    let warning = stored.warning;
    const collectedAt: string[] = [];

    while (!warning && rows.length < target && page <= totalPages && page <= MAX_SCAN_PAGES) {
      try {
        if (request.signal.aborted) throw new Error('request_aborted');
        remainingDeadlineMillis(scanDeadline);
        const pageResult = await getPage(
          supabase,
          queryHash,
          page,
          filters,
          scan.id,
          globalBudgetHash,
          scanDeadline,
          request.signal,
        );
        if (pageResult.source === 'cache') hitPages++; else fetchedPages++;
        if (pageResult.fetchedAt) collectedAt.push(pageResult.fetchedAt);
        const upstream = validateUpstreamPayload(pageResult.response, page);
        totalPages = Math.min(upstream.totalPages, MAX_SCAN_PAGES);
        const candidates = [];
        const hasGeo = Object.keys(filters.geoParams).length > 0;
        for (const company of upstream.results) {
          if (request.signal.aborted) throw new Error('request_aborted');
          remainingDeadlineMillis(scanDeadline);
          if (!companyIsEligible(company, filters.legal)) continue;
          const matchedEstablishment = hasGeo ? findActiveMatchingEstablishment(company) : null;
          if (hasGeo && !matchedEstablishment) continue;
          const sourceUrl = buildSearchUrl({ page, filters });
          for (const row of buildReferenceRows(company, {
            apeLabel: (nafLabels as Record<string, string>)[company.activite_principale] || '',
            sourceUrl,
            ageMin: filters.ageMin,
            ageMax: filters.ageMax,
            matchedEstablishment,
          })) {
            const identity = directorIdentity(row);
            const fingerprint = await leadKey(row, fingerprintSalt);
            const nameFingerprint = await personNameKey(row, fingerprintSalt);
            candidates.push({
              lead_key: fingerprint,
              director_fingerprint: fingerprint,
              person_name_fingerprint: nameFingerprint,
              fingerprint_version: identity.version,
              identity_quality: identity.quality,
              birth_year: identity.birthYear,
              company_siren: row.siren,
              payload: row,
            });
          }
        }

        if (candidates.length) {
          if (request.signal.aborted) throw new Error('request_aborted');
          remainingDeadlineMillis(scanDeadline);
          const { data: reserved, error: reserveError } = await supabase.rpc('reserve_scan_leads', {
            p_workspace_id: workspaceId,
            p_scan_id: scan.id,
            p_candidates: candidates,
            p_limit: target - rows.length,
          }).abortSignal(boundedSignal(null, scanDeadline));
          if (reserveError) throw new Error(`reserve_leads:${reserveError.message}`);
          rows.push(...(reserved || []).map((item: { payload: Record<string, unknown> }) => item.payload));
          remainingDeadlineMillis(scanDeadline);
        }
        page++;
      } catch (error) {
        if (!rows.length) throw error;
        warning = traversalWarning(error, request.signal, scanDeadline);
        break;
      }
    }

    if (!warning && rows.length < target && page > MAX_SCAN_PAGES) warning = 'page_limit_reached';

    let partial = rows.length < target;
    const { error: finishError } = await supabase.from('scans').update({
      status: partial ? 'partial' : 'completed',
      result_count: rows.length,
      warning,
      completed_at: new Date().toISOString(),
    }).eq('id', scan.id);
    if (finishError) {
      if (!rows.length) throw new Error(`scan_finish:${finishError.message}`);
      warning ||= 'scan_finalize_failed';
      partial = true;
    }
    activeScanId = '';

    return json(request, {
      mode,
      scan_id: scan.id,
      rows,
      partial,
      warning,
      cache: {
        stored_rows: storedRows,
        hit_pages: hitPages,
        fetched_pages: fetchedPages,
        oldest_collected_at: collectedAt.sort()[0] || null,
        newest_collected_at: collectedAt.sort().at(-1) || null,
      },
    });
  } catch (error) {
    const code = publicErrorCode(error);
    if (activeSupabase && activeScanId) {
      await activeSupabase.from('scans').update({
        status: 'failed',
        warning: code,
        completed_at: new Date().toISOString(),
      }).eq('id', activeScanId).eq('status', 'running');
    }
    const status = edgeErrorStatus(error);
    const extraHeaders: Record<string, string> = status === 429 ? { 'Retry-After': '60' } : {};
    try { return json(request, { error: code }, status, extraHeaders); }
    catch { return new Response(JSON.stringify({ error: code }), { status, headers: { ...JSON_HEADERS, ...extraHeaders } }); }
  }
});
