import { API_URL, buildSearchParams, buildSearchUrl, retryAfterDelay } from '../supabase/functions/_shared/api-core.js';

export { API_URL, buildSearchParams, buildSearchUrl, retryAfterDelay };
export const RATE_LIMIT_PER_SECOND = 6;
const INTERVAL = Math.ceil(1000 / RATE_LIMIT_PER_SECOND);
let lastCall = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
