import { REGION_DEPARTMENTS } from './geo-data.js';

export const SECTORS = [['C','Industrie'],['F','Construction'],['G','Commerce'],['H','Transport'],['J','Information / communication'],['K','Finance'],['M','Conseil'],['N','Services'],['Q','Santé']];
export const LEGALS = [['sas','SAS'],['sarl','SARL'],['sa','SA']];
export const LEGAL_CODES = { sas: ['5710','5720'], sarl: ['5498','5499'], sa: ['5505','5510','5520','5599'] };
const STAFF = [['00',0,0],['01',1,2],['02',3,5],['03',6,9],['11',10,19],['12',20,49],['21',50,99],['22',100,199],['31',200,249],['32',250,499],['41',500,999],['42',1000,1999],['51',2000,4999],['52',5000,Infinity]];
const FRENCH_LABELS = new Intl.Collator('fr', { sensitivity: 'base' });

export function sortNamedEntries(entries = []) {
  return [...entries].sort((left, right) => FRENCH_LABELS.compare(String(left?.[1] || ''), String(right?.[1] || '')));
}

export function postalZoneFromQuery(value) {
  const code = String(value || '').trim();
  return /^\d{5}$/.test(code)
    ? { key: `code_postal:${code}`, type: 'code_postal', code, label: `${code} · Code postal` }
    : null;
}

export function appendCompatibleZone(zones = [], zone) {
  if (!zone?.key) return [...zones];
  const exactPostal = zone.type === 'code_postal';
  const compatible = zones.filter(item => (item.type === 'code_postal') === exactPostal);
  return compatible.some(item => item.key === zone.key) ? compatible : [...compatible, zone];
}

export function parseGeo(value) {
  const raw = String(value || '').trim();
  if (!raw) return {};
  if (/^region:\s*[0-9]{1,2}$/i.test(raw)) return { region: raw.split(':')[1].trim() };
  const clean = raw.replace(/\s/g, '').toUpperCase();
  if (/^\d{5}$/.test(clean)) return { code_postal: clean };
  if (/^(?:\d{2}|2[AB])(?:,(?:\d{2}|2[AB]))*$/.test(clean)) return { departement: clean };
  throw new Error('Zone invalide : utilisez un département (75), un code postal (75001) ou region:11.');
}

export function geoParamsForZones(zones = []) {
  const departments = [];
  const postals = [];
  for (const zone of Array.isArray(zones) ? zones : []) {
    const type = String(zone?.type || '');
    const code = String(zone?.code || '').toUpperCase();
    if (type === 'departement' && /^(?:\d{2,3}|2[AB])$/.test(code)) departments.push(code);
    if (type === 'region') departments.push(...(REGION_DEPARTMENTS[code] || []));
    if (type === 'code_postal' && /^\d{5}$/.test(code)) postals.push(code);
  }
  const uniqueDepartments = [...new Set(departments)];
  const uniquePostals = [...new Set(postals)];
  if (uniqueDepartments.length && uniquePostals.length) {
    throw new Error('Choisissez des zones du même niveau géographique.');
  }
  if (uniquePostals.length) return { code_postal: uniquePostals.join(',') };
  return uniqueDepartments.length ? { departement: uniqueDepartments.join(',') } : {};
}

export function parseNafCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/^(\d{2}\.\d{2}[A-Z])/i);
  if (!match) throw new Error('Code APE invalide : choisissez une entrée de la liste.');
  return match[1].toUpperCase();
}

export function parseNafCodes(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(parseNafCode).filter(Boolean))];
}

export function validateFilterInputs({ nafCodes = [], sectors = [], staffMin, staffMax, ageMin, ageMax }, { allowEmptyActivity = false } = {}) {
  if (!allowEmptyActivity && !nafCodes.length && !sectors.length) throw new Error('Choisissez au moins un code APE ou un secteur.');
  if (Number(staffMin) > Number(staffMax)) throw new Error("L’effectif minimum doit être inférieur ou égal au maximum.");
  if (Number(ageMin) > Number(ageMax)) throw new Error("L’âge minimum doit être inférieur ou égal au maximum.");
}

export function clampMaxRows(value) { return Math.min(100, Math.max(1, Number.parseInt(value, 10) || 1)); }
export function findActiveMatchingEstablishment(company) {
  return (company?.matching_etablissements || []).find(establishment => establishment?.etat_administratif === 'A' && !establishment?.date_fermeture) || null;
}
export function staffCodes(min = 0, max = Infinity) { return STAFF.filter(([,a,b]) => b >= Number(min || 0) && a <= Number(max || Infinity)).map(([code]) => code); }
export function leaderAge(d, now = new Date()) { const y = Number(String(d?.date_de_naissance || d?.annee_de_naissance || '').slice(0,4)); return y ? now.getFullYear() - y : null; }
function physical(d) { const type = String(d?.type_dirigeant || '').toLowerCase(); return type.includes('physique') || (!!d?.nom && !!d?.prenoms && !type.includes('morale')); }
function auditor(d) { return String(d?.qualite || '').toLowerCase().includes('commissaire aux comptes'); }
function rank(d) { const q = String(d?.qualite || '').toLowerCase(); return q.includes('président') || q.includes('president') ? 1 : q.includes('directeur général') || q.includes('directeur general') ? 2 : q.includes('gérant') || q.includes('gerant') ? 3 : 10; }

export function buildReferenceRows(company, { apeLabel = '', exportedAt = new Date().toISOString(), sourceUrl = '', ageMin = 18, ageMax = 100, matchedEstablishment = null } = {}) {
  const siege = company.siege || {};
  const directors = company.dirigeants || [];
  const leaders = directors
    .filter(d => physical(d) && d.nom && d.prenoms && !auditor(d))
    .filter(d => { const age = leaderAge(d); return age != null && age >= ageMin && age <= ageMax; })
    .sort((a,b) => rank(a)-rank(b));
  const linked = directors.find(d => String(d?.type_dirigeant || '').toLowerCase().includes('morale') && !auditor(d));
  return leaders.map(leader => {
    const alerts = [];
    if (!apeLabel) alerts.push('libelle_ape_absent');
    if (!siege.siret) alerts.push('siret_siege_absent');
    if (!siege.code_postal) alerts.push('code_postal_absent');
    if (!leader.date_de_naissance && !leader.annee_de_naissance) alerts.push('naissance_imprecise');
    const leaderBirthYear = leader.annee_de_naissance || String(leader.date_de_naissance || '').slice(0, 4);
    return {
      nom_entreprise: company.nom_complet || company.nom_raison_sociale || '', siren: company.siren || '', siret_siege: siege.siret || '',
      code_ape: company.activite_principale || '', libelle_ape: apeLabel, secteur: company.section_activite_principale || '', nature_juridique: company.nature_juridique || '', categorie_entreprise: company.categorie_entreprise || '',
      tranche_effectif: company.tranche_effectif_salarie || '', nombre_etablissements_ouverts: company.nombre_etablissements_ouverts ?? '',
      dirigeant_prenoms: leader.prenoms || '', dirigeant_nom_famille: leader.nom || '', dirigeant_nom: [leader.prenoms, leader.nom].filter(Boolean).join(' '), dirigeant_qualite: leader.qualite || '',
      dirigeant_type: leader.type_dirigeant || '', dirigeant_nationalite: leader.nationalite || '', dirigeant_annee_naissance: leaderBirthYear, dirigeant_date_naissance: leader.date_de_naissance || '', dirigeant_age: leaderAge(leader) ?? '',
      adresse_siege: [siege.adresse, siege.code_postal, siege.libelle_commune || siege.commune].filter(Boolean).join(' '), code_postal_siege: siege.code_postal || '', commune_siege: siege.libelle_commune || siege.commune || '',
      siret_etablissement_zone: matchedEstablishment?.siret || '', adresse_etablissement_zone: [matchedEstablishment?.adresse, matchedEstablishment?.code_postal, matchedEstablishment?.libelle_commune || matchedEstablishment?.commune].filter(Boolean).join(' '), code_postal_etablissement_zone: matchedEstablishment?.code_postal || '', commune_etablissement_zone: matchedEstablishment?.libelle_commune || matchedEstablishment?.commune || '',
      email: '', telephone: '',
      dirigeant_pm_nom: linked?.denomination || linked?.nom_complet || '', dirigeant_pm_siren: linked?.siren || '', dirigeant_pm_qualite: linked?.qualite || '',
      groupement_capitalistique_indice: linked ? "Indice prudent : dirigeant personne morale présent — pas une preuve d'actionnariat" : '',
      data_quality_score: Math.max(0, 100 - alerts.length * 15), data_quality_alerts: alerts.join(' | '),
      date_export: exportedAt, source_url: sourceUrl,
    };
  });
}

export function buildReferenceRow(company, options = {}) {
  return buildReferenceRows(company, options)[0] || null;
}

export function companyIsEligible(company, legalKeys) {
  if (company.etat_administratif && company.etat_administratif !== 'A') return false;
  if (company.siege?.etat_administratif && company.siege.etat_administratif !== 'A') return false;
  if (company.siege?.date_fermeture) return false;
  const codes = legalKeys.flatMap(k => LEGAL_CODES[k] || []);
  return codes.some(code => String(company.nature_juridique || '').startsWith(code));
}

function normalizedSearch(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function postalDepartments(value) {
  const postal = String(value || '').replace(/\D/g, '');
  if (/^97[1-4,6]/.test(postal)) return [postal.slice(0, 3)];
  if (postal.startsWith('20')) return [Number(postal.slice(0, 5)) < 20200 ? '2A' : '2B'];
  return postal.length >= 2 ? [postal.slice(0, 2)] : [];
}

export function referenceRowMatchesFilters(row, filters = {}, query = '') {
  if (filters.nafCodes?.length && !filters.nafCodes.includes(row?.code_ape)) return false;
  if (!filters.nafCodes?.length && filters.sectors?.length && !filters.sectors.includes(row?.secteur)) return false;
  if (filters.staffCodes?.length && !filters.staffCodes.includes(row?.tranche_effectif)) return false;
  if (filters.legal?.length) {
    const legalCodes = filters.legal.flatMap(key => LEGAL_CODES[key] || []);
    if (!legalCodes.some(code => String(row?.nature_juridique || '').startsWith(code))) return false;
  }
  const age = Number(row?.dirigeant_age);
  if (!Number.isFinite(age) || age < Number(filters.ageMin ?? 18) || age > Number(filters.ageMax ?? 100)) return false;
  const normalizedGeo = filters.geoParams && typeof filters.geoParams === 'object'
    ? filters.geoParams
    : geoParamsForZones(filters.zones);
  const rowPostals = [row?.code_postal_etablissement_zone, row?.code_postal_siege]
    .map(value => String(value || '').replace(/\D/g, ''))
    .filter(Boolean);
  const allowedDepartments = String(normalizedGeo.departement || '').split(',').filter(Boolean);
  if (normalizedGeo.region) allowedDepartments.push(...(REGION_DEPARTMENTS[String(normalizedGeo.region)] || []));
  if (allowedDepartments.length) {
    const rowDepartments = rowPostals.flatMap(postalDepartments);
    if (!rowDepartments.some(code => allowedDepartments.includes(code))) return false;
  }
  const requiredPostals = String(normalizedGeo.code_postal || '')
    .split(',')
    .map(value => value.replace(/\D/g, ''))
    .filter(Boolean);
  if (requiredPostals.length && !rowPostals.some(postal => requiredPostals.includes(postal))) return false;
  const terms = normalizedSearch(query).split(' ').filter(Boolean);
  if (terms.length) {
    const haystack = normalizedSearch([
      row?.dirigeant_nom, row?.nom_entreprise, row?.siren, row?.code_ape, row?.libelle_ape,
      row?.commune_etablissement_zone, row?.commune_siege,
    ].join(' '));
    if (!terms.every(term => haystack.includes(term))) return false;
  }
  return true;
}
