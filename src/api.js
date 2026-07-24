export const API_URL = 'https://recherche-entreprises.api.gouv.fr/search';
export const RATE_LIMIT_PER_SECOND = 6;
const INTERVAL = Math.ceil(1000 / RATE_LIMIT_PER_SECOND);
let lastCall = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function retryAfterDelay(value, now = Date.now(), fallback = 1000) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : fallback;
}

export function buildSearchParams({ page = 1, filters = {} } = {}) {
  const params = new URLSearchParams({
    minimal: 'true', include: 'dirigeants,matching_etablissements,siege', etat_administratif: 'A',
    per_page: '25', page: String(page),
  });
  const geo = filters.geoParams || (filters.geo ? (/^\d{5}$/.test(filters.geo) ? { code_postal: filters.geo } : { departement: filters.geo }) : {});
  for (const [key, value] of Object.entries(geo)) if (value) params.set(key, value);
  if (filters.nafCode) params.set('activite_principale', filters.nafCode);
  if (filters.sectors?.length) params.set('section_activite_principale', filters.sectors.join(','));
  if (filters.staffCodes?.length) params.set('tranche_effectif_salarie', filters.staffCodes.join(','));
  if (filters.legalCode) params.set('nature_juridique', filters.legalCode);
  return params;
}

export function buildSearchUrl(options) {
  return `${API_URL}?${buildSearchParams(options)}`;
}

async function readApiError(response) {
  let body;
  try { body = await response.json(); } catch { return `API HTTP ${response.status}`; }
  return body?.erreur || body?.detail || body?.message || body?.error || `API HTTP ${response.status}`;
}

export async function fetchSearchPage(options, { signal, fetchImpl = fetch, maxRetries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(0, INTERVAL - (Date.now() - lastCall));
    if (wait) await sleep(wait);
    lastCall = Date.now();
    const response = await fetchImpl(buildSearchUrl(options), { signal, headers: { Accept: 'application/json' } });
    if (response.status === 429 && attempt < maxRetries) {
      const delay = retryAfterDelay(
        response.headers.get('Retry-After'),
        Date.now(),
        Math.max(INTERVAL, 1000 * (attempt + 1)),
      );
      await sleep(delay);
      continue;
    }
    if (!response.ok) throw new Error(await readApiError(response));
    return response.json();
  }
}
