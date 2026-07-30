const sortedUnique = values => [...new Set((values || []).filter(Boolean).map(value => String(value).trim()))].sort();

export function canonicalApiFilterKey(filters = {}) {
  const nafCodes = sortedUnique(filters.nafCodes || (filters.nafCode ? [filters.nafCode] : []));
  const geo = Object.fromEntries(Object.entries(filters.geoParams || {}).sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify({
    cache_contract: 'recherche-entreprises:v1',
    endpoint: 'https://recherche-entreprises.api.gouv.fr/search',
    minimal: true,
    include: 'dirigeants,matching_etablissements,siege',
    etat_administratif: 'A',
    per_page: 25,
    activite_principale: nafCodes.join(','),
    section_activite_principale: nafCodes.length ? '' : sortedUnique(filters.sectors).join(','),
    geo,
    tranche_effectif_salarie: sortedUnique(filters.staffCodes).join(','),
  });
}

function normalizeIdentityPart(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function directorIdentity(row = {}) {
  const firstNames = normalizeIdentityPart(row.dirigeant_prenoms);
  const familyName = normalizeIdentityPart(row.dirigeant_nom_famille);
  if (!firstNames || !familyName) throw new Error('Dirigeant sans identité exploitable.');
  const rawBirth = String(row.dirigeant_date_naissance || row.dirigeant_annee_naissance || '').trim();
  const fullBirth = /^\d{4}-\d{2}-\d{2}$/.test(rawBirth) ? rawBirth : '';
  const birthYear = rawBirth.match(/^(\d{4})(?:-\d{2})?(?:-\d{2})?$/)?.[1] || '';
  const quality = fullBirth ? 'strong' : birthYear ? 'medium' : 'weak';
  const nameMaterial = ['person-name:v1', firstNames, familyName].join('|');
  return {
    version: 2,
    quality,
    birthYear,
    nameMaterial,
    material: ['person:v2', firstNames, familyName, birthYear].join('|'),
  };
}

export function directorFingerprintMaterial(row = {}) {
  return directorIdentity(row).material;
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function directorIdentityKeys(identity, salt) {
  if (!String(salt || '').trim()) throw new Error('Sel d’empreinte manquant.');
  const [leadKey, personNameKey] = await Promise.all([
    sha256Hex(`${salt}|${identity.material}`),
    sha256Hex(`${salt}|${identity.nameMaterial}`),
  ]);
  return { leadKey, personNameKey };
}

export async function leadKey(row, salt) {
  return (await directorIdentityKeys(directorIdentity(row), salt)).leadKey;
}

export async function personNameKey(row, salt) {
  return (await directorIdentityKeys(directorIdentity(row), salt)).personNameKey;
}
