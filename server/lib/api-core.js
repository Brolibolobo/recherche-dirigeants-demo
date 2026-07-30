export const API_URL = 'https://recherche-entreprises.api.gouv.fr/search';

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
  const nafCodes = filters.nafCodes?.length ? filters.nafCodes : (filters.nafCode ? [filters.nafCode] : []);
  if (nafCodes.length) params.set('activite_principale', nafCodes.join(','));
  else if (filters.sectors?.length) params.set('section_activite_principale', filters.sectors.join(','));
  if (filters.staffCodes?.length) params.set('tranche_effectif_salarie', filters.staffCodes.join(','));
  if (filters.legalCode) params.set('nature_juridique', filters.legalCode);
  return params;
}

export function buildSearchUrl(options) {
  return `${API_URL}?${buildSearchParams(options)}`;
}
