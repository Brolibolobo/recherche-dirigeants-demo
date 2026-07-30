import {
  SECTORS,
  LEGALS,
  geoParamsForZones,
  parseGeo,
  parseNafCodes,
  staffCodes,
  validateFilterInputs,
} from './filters.js';
import { DEPARTMENTS, REGIONS } from './geo-data.js';

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
  'invalid_mode',
  'invalid_naf_codes',
  'invalid_request',
  'invalid_sectors',
  'invalid_staff_max',
  'invalid_staff_min',
  'invalid_target',
  'invalid_zones',
  'method_not_allowed',
  'origin_not_allowed',
  'page_limit_reached',
  'rate_limited',
  'request_aborted',
  'request_too_large',
  'server_busy',
  'server_error',
  'scan_deadline_exceeded',
  'scan_finalize_failed',
  'unsupported_media_type',
  'upstream_failed',
  'upstream_invalid_payload',
]);


export function numberInRange(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid_${label}`);
  }
  return value;
}

function strictArray(input, key) {
  const value = input[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`invalid_${key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`);
  if (value.length > 100 || value.some(item => typeof item !== 'string')) {
    throw new Error(`invalid_${key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`);
  }
  return [...new Set(value.map(item => item.trim()).filter(Boolean))];
}

export function sanitizeScanFilters(input = {}, { allowEmptyActivity = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_request');
  const allowedKeys = new Set(['geo', 'zones', 'nafCodes', 'sectors', 'legal', 'staffMin', 'staffMax', 'ageMin', 'ageMax']);
  if (Object.keys(input).some(key => !allowedKeys.has(key))) throw new Error('invalid_request');

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
    : (rawSectors.length ? rawSectors : (allowEmptyActivity ? [] : SECTORS.map(pair => pair[0])));

  const allowedLegals = new Set(LEGALS.map(pair => pair[0]));
  const rawLegal = strictArray(input, 'legal');
  if (rawLegal.some(value => !allowedLegals.has(value))) throw new Error('invalid_legal');
  const legal = rawLegal.length ? rawLegal : LEGALS.map(pair => pair[0]);

  const staffMin = numberInRange(input.staffMin ?? 0, 0, 1_000_000, 'staff_min');
  const staffMax = numberInRange(input.staffMax ?? 1_000_000, 0, 1_000_000, 'staff_max');
  const ageMin = numberInRange(input.ageMin ?? 18, 18, 100, 'age_min');
  const ageMax = numberInRange(input.ageMax ?? 100, 18, 100, 'age_max');
  if (input.geo !== undefined && typeof input.geo !== 'string') throw new Error('invalid_geo');
  const geo = (input.geo || '').trim();
  if (geo.length > 50) throw new Error('invalid_geo');

  let geoParams;
  let zones = [];
  try {
    if (input.zones !== undefined) {
      if (!Array.isArray(input.zones) || input.zones.length > 30) throw new Error('invalid_zones');
      const departmentCodes = new Set(DEPARTMENTS.map(([code]) => code));
      const regionCodes = new Set(REGIONS.map(([code]) => code));
      zones = input.zones.map(zone => {
        if (!zone || typeof zone !== 'object' || Array.isArray(zone)) throw new Error('invalid_zones');
        if (Object.keys(zone).some(key => !['type', 'code'].includes(key)) || typeof zone.type !== 'string' || typeof zone.code !== 'string') throw new Error('invalid_zones');
        const type = zone.type;
        const code = zone.code.toUpperCase();
        if (type === 'departement' && departmentCodes.has(code)) return { type, code };
        if (type === 'region' && regionCodes.has(code)) return { type, code };
        if (type === 'code_postal' && /^\d{5}$/.test(code)) return { type, code };
        throw new Error('invalid_zones');
      });
      zones = zones.filter((zone, index) => zones.findIndex(item => item.type === zone.type && item.code === zone.code) === index);
      geoParams = geoParamsForZones(zones);
    } else {
      geoParams = parseGeo(geo);
    }
    validateFilterInputs({ nafCodes, sectors, staffMin, staffMax, ageMin, ageMax }, { allowEmptyActivity });
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_zones') throw error;
    throw new Error('invalid_request');
  }

  return {
    geo,
    zones,
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
  const totalPages = payload.total_pages;
  if (!Number.isSafeInteger(totalPages) || totalPages < 0 || !Array.isArray(payload.results)) {
    throw new Error('upstream_invalid_payload');
  }
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const assertOptionalStrings = (object, keys) => {
    if (keys.some(key => object[key] != null && typeof object[key] !== 'string')) {
      throw new Error('upstream_invalid_payload');
    }
  };
  for (const company of payload.results) {
    if (!isObject(company)) throw new Error('upstream_invalid_payload');
    assertOptionalStrings(company, [
      'activite_principale',
      'categorie_entreprise',
      'etat_administratif',
      'nature_juridique',
      'nom_complet',
      'nom_raison_sociale',
      'section_activite_principale',
      'siren',
      'tranche_effectif_salarie',
    ]);
    if (company.nombre_etablissements_ouverts != null
        && (!Number.isSafeInteger(company.nombre_etablissements_ouverts)
            || company.nombre_etablissements_ouverts < 0)) {
      throw new Error('upstream_invalid_payload');
    }
    if (company.siege != null && !isObject(company.siege)) throw new Error('upstream_invalid_payload');
    if (company.siege) {
      assertOptionalStrings(company.siege, [
        'adresse',
        'code_postal',
        'commune',
        'date_fermeture',
        'etat_administratif',
        'libelle_commune',
        'siret',
      ]);
    }
    for (const key of ['dirigeants', 'matching_etablissements']) {
      if (company[key] !== undefined
          && (!Array.isArray(company[key]) || company[key].some(item => !isObject(item)))) {
        throw new Error('upstream_invalid_payload');
      }
    }
    for (const director of company.dirigeants || []) {
      assertOptionalStrings(director, [
        'annee_de_naissance',
        'date_de_naissance',
        'denomination',
        'nationalite',
        'nom',
        'nom_complet',
        'prenoms',
        'qualite',
        'siren',
        'type_dirigeant',
      ]);
    }
    for (const establishment of company.matching_etablissements || []) {
      assertOptionalStrings(establishment, [
        'adresse',
        'code_postal',
        'commune',
        'date_fermeture',
        'etat_administratif',
        'libelle_commune',
        'siret',
      ]);
    }
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
  if (message.startsWith('government_api_')) return 'upstream_failed';
  if (message.startsWith('scan_finalize:') || message.startsWith('scan_finish:')) return 'scan_finalize_failed';
  return 'server_error';
}

export function remainingDeadlineMillis(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('scan_deadline_exceeded');
  return remaining;
}
