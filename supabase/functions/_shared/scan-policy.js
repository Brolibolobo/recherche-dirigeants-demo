import {
  SECTORS,
  LEGALS,
  parseGeo,
  parseNafCodes,
  staffCodes,
  validateFilterInputs,
} from './filters.js';

export const MAX_BODY_BYTES = 16_384;
export const MAX_SCAN_TARGET = 100;
export const MAX_SCAN_PAGES = 50;
export const SCAN_DEADLINE_MS = 25_000;
export const GLOBAL_UPSTREAM_REQUESTS_PER_MINUTE = 120;

const PUBLIC_ERROR_CODES = new Set([
  'global_upstream_budget_exhausted',
  'invalid_age_max',
  'invalid_age_min',
  'invalid_geo',
  'invalid_json',
  'invalid_legal',
  'invalid_naf_codes',
  'invalid_request',
  'invalid_sectors',
  'invalid_staff_max',
  'invalid_staff_min',
  'invalid_target',
  'method_not_allowed',
  'origin_not_allowed',
  'page_limit_reached',
  'rate_limited',
  'request_too_large',
  'scan_deadline_exceeded',
  'scan_finalize_failed',
  'upstream_invalid_payload',
]);

const INTERNAL_ERROR_CODES = [
  ['reserve_leads:', 'reservation_failed'],
  ['cache_read:', 'cache_read_failed'],
  ['cache_write:', 'cache_write_failed'],
  ['cache_claim:', 'cache_claim_failed'],
  ['cache_page_busy', 'cache_page_busy'],
  ['cache_lease_lost', 'cache_lease_lost'],
  ['upstream_slot:', 'upstream_limiter_failed'],
  ['global_budget:', 'global_budget_failed'],
  ['government_api_', 'upstream_failed'],
  ['scan_insert:', 'scan_create_failed'],
  ['scan_finalize:', 'scan_finalize_failed'],
  ['scan_finish:', 'scan_finish_failed'],
  ['rate_limit:', 'rate_limit_failed'],
];

export function numberInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`invalid_${label}`);
  }
  return number;
}

function strictArray(input, key) {
  const value = input[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`invalid_${key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`);
  return [...new Set(value.map(item => String(item).trim()).filter(Boolean))];
}

export function sanitizeScanFilters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_request');

  const rawNafCodes = strictArray(input, 'nafCodes');
  let nafCodes;
  try {
    nafCodes = parseNafCodes(rawNafCodes);
  } catch {
    throw new Error('invalid_naf_codes');
  }

  const allowedSectors = new Set(SECTORS.map(pair => pair[0]));
  const rawSectors = strictArray(input, 'sectors');
  if (rawSectors.some(value => !allowedSectors.has(value))) throw new Error('invalid_sectors');
  const sectors = nafCodes.length
    ? []
    : (rawSectors.length ? rawSectors : SECTORS.map(pair => pair[0]));

  const allowedLegals = new Set(LEGALS.map(pair => pair[0]));
  const rawLegal = strictArray(input, 'legal');
  if (rawLegal.some(value => !allowedLegals.has(value))) throw new Error('invalid_legal');
  const legal = rawLegal.length ? rawLegal : LEGALS.map(pair => pair[0]);

  const staffMin = numberInRange(input.staffMin ?? 0, 0, 1_000_000, 'staff_min');
  const staffMax = numberInRange(input.staffMax ?? 1_000_000, 0, 1_000_000, 'staff_max');
  const ageMin = numberInRange(input.ageMin ?? 18, 18, 100, 'age_min');
  const ageMax = numberInRange(input.ageMax ?? 100, 18, 100, 'age_max');
  const geo = String(input.geo || '').trim();
  if (geo.length > 50) throw new Error('invalid_geo');

  let geoParams;
  try {
    geoParams = parseGeo(geo);
    validateFilterInputs({ nafCodes, sectors, staffMin, staffMax, ageMin, ageMax });
  } catch {
    throw new Error('invalid_request');
  }

  return {
    geo,
    geoParams,
    nafCodes,
    sectors,
    legal,
    staffMin,
    staffMax,
    staffCodes: staffCodes(staffMin, staffMax),
    ageMin,
    ageMax,
  };
}

export async function readJsonWithLimit(request, maximumBytes = MAX_BODY_BYTES) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error('request_too_large');

  if (!request.body) throw new SyntaxError('invalid_json');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error('request_too_large');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text);
  } catch {
    throw new SyntaxError('invalid_json');
  }
}

export function validateUpstreamPayload(payload, currentPage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('upstream_invalid_payload');
  const totalPages = Number(payload.total_pages);
  if (!Number.isInteger(totalPages) || totalPages < 0 || !Array.isArray(payload.results)) {
    throw new Error('upstream_invalid_payload');
  }
  return { totalPages: Math.max(Number(currentPage) || 1, totalPages), results: payload.results };
}

export function publicErrorCode(error) {
  if (error instanceof SyntaxError) return 'invalid_json';
  const message = error instanceof Error ? error.message : String(error);
  if (PUBLIC_ERROR_CODES.has(message)) return message;
  if (message.startsWith('Choisissez au moins un code APE ou un secteur.')
      || message.startsWith('L’effectif minimum doit être inférieur ou égal au maximum.')
      || message.startsWith('L’âge minimum doit être inférieur ou égal au maximum.')
      || message.startsWith('Zone invalide :')
      || message.startsWith('Code APE invalide :')) return 'invalid_request';
  for (const [prefix, code] of INTERNAL_ERROR_CODES) {
    if (message.startsWith(prefix)) return code;
  }
  return 'internal_error';
}

export function remainingDeadlineMillis(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('scan_deadline_exceeded');
  return remaining;
}
