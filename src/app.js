import { SECTORS, LEGALS, parseNafCodes, validateFilterInputs, clampMaxRows, staffCodes, geoParamsForZones, findActiveMatchingEstablishment, buildReferenceRows, companyIsEligible, sortNamedEntries, postalZoneFromQuery, appendCompatibleZone } from './filters.js';
import { DEPARTMENTS, REGIONS } from './geo-data.js';
import { downloadCsv } from './csv.js';
import { saveSnapshot, loadLastSnapshot } from './storage.js';
import { isCentralConfigured, scanCentral } from './central-api.js';

const $ = id => document.getElementById(id);
const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const selected = host => [...$(host).querySelectorAll('[aria-pressed="true"]')].map(button => button.dataset.value);
const element = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };

let rows = [];
let naf = {};
let selectedNafCodes = [];
let selectedZones = [];
let mode = 'new';
let aborter;
let loadingTimer;
let nafPicker;
let zonePicker;

function chips(host, values, pressed = true) {
  for (const [value, label] of values) {
    const button = element('button', label, 'chip');
    button.type = 'button';
    button.dataset.value = value;
    button.setAttribute('aria-pressed', String(pressed));
    button.addEventListener('click', () => button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'));
    $(host).append(button);
  }
}

function createPicker({ inputId, optionsId, items, isSelected, choose }) {
  const input = $(inputId);
  const options = $(optionsId);
  const visibleItems = () => {
    const rawQuery = input.value.trim();
    const query = normalize(rawQuery);
    return items(rawQuery).filter(item => !query || normalize(`${item.code} ${item.label} ${item.search || ''}`).includes(query)).slice(0, 100);
  };
  const render = () => {
    const scrollTop = options.scrollTop;
    const matches = visibleItems();
    options.replaceChildren();
    if (!matches.length) options.append(element('p', 'Aucun résultat pour ce texte.', 'picker-empty'));
    for (const item of matches) {
      const button = element('button', null, 'picker-option');
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(isSelected(item)));
      button.append(element('span', item.label));
      button.append(element('strong', isSelected(item) ? 'Ajouté' : item.code));
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('click', () => {
        choose(item);
        input.focus();
      });
      button.addEventListener('keydown', event => {
        const buttons = [...options.querySelectorAll('.picker-option')];
        const index = buttons.indexOf(button);
        if (event.key === 'Escape') {
          event.preventDefault();
          input.focus();
          return close();
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const target = event.key === 'Home' ? buttons[0]
          : event.key === 'End' ? buttons.at(-1)
          : event.key === 'ArrowDown' ? buttons[Math.min(index + 1, buttons.length - 1)]
          : buttons[Math.max(index - 1, 0)];
        target?.focus();
      });
      options.append(button);
    }
    options.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    options.scrollTop = scrollTop;
  };
  const close = () => { options.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') return close();
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      render();
      const buttons = [...options.querySelectorAll('.picker-option')];
      const target = event.key === 'ArrowDown' || event.key === 'Home' ? buttons[0] : buttons.at(-1);
      return target?.focus();
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = visibleItems().find(candidate => !isSelected(candidate));
      if (item) choose(item);
    }
  });
  document.addEventListener('pointerdown', event => {
    if (!input.parentElement.contains(event.target)) close();
  });
  close();
  const refresh = () => {
    if (input.getAttribute('aria-expanded') === 'true') render();
  };
  return { render, refresh, close };
}

function renderNafSelection() {
  $('selectedNaf').replaceChildren();
  $('nafCount').textContent = `${selectedNafCodes.length} code${selectedNafCodes.length > 1 ? 's' : ''} APE sélectionné${selectedNafCodes.length > 1 ? 's' : ''}`;
  $('clearNaf').disabled = !selectedNafCodes.length;
  for (const code of selectedNafCodes) {
    const button = element('button', `${code} · ${naf[code] || ''} ×`, 'value-tag');
    button.type = 'button';
    button.setAttribute('aria-label', `Retirer ${code}`);
    button.addEventListener('click', () => {
      selectedNafCodes = selectedNafCodes.filter(value => value !== code);
      renderNafSelection();
    });
    $('selectedNaf').append(button);
  }
  const hasNaf = selectedNafCodes.length > 0;
  for (const button of $('sectors').querySelectorAll('button')) {
    if (hasNaf) button.setAttribute('aria-pressed', 'false');
    button.disabled = hasNaf;
  }
  $('sectorHelp').textContent = hasNaf
    ? 'Secteurs désactivés : les codes APE sélectionnés définissent la recherche.'
    : 'Utilisée seulement lorsqu’aucun code APE n’est sélectionné.';
  nafPicker?.refresh();
}

function renderZoneSelection() {
  $('selectedZones').replaceChildren();
  $('zoneCount').textContent = selectedZones.length
    ? `${selectedZones.length} zone${selectedZones.length > 1 ? 's' : ''} sélectionnée${selectedZones.length > 1 ? 's' : ''}`
    : 'France entière';
  $('clearZones').disabled = !selectedZones.length;
  for (const zone of selectedZones) {
    const button = element('button', `${zone.label} ×`, 'value-tag');
    button.type = 'button';
    button.setAttribute('aria-label', `Retirer ${zone.label}`);
    button.addEventListener('click', () => {
      selectedZones = selectedZones.filter(value => value.key !== zone.key);
      renderZoneSelection();
    });
    $('selectedZones').append(button);
  }
  zonePicker?.refresh();
}

function currentFilters() {
  const legal = selected('legals');
  const result = {
    zones: selectedZones.map(({ type, code }) => ({ type, code })),
    geoParams: geoParamsForZones(selectedZones),
    nafCodes: parseNafCodes(selectedNafCodes),
    sectors: selected('sectors'),
    legal: legal.length ? legal : LEGALS.map(([key]) => key),
    staffMin: Number($('staffMin').value),
    staffMax: Number($('staffMax').value),
    staffCodes: staffCodes($('staffMin').value, $('staffMax').value),
    ageMin: Number($('ageMin').value),
    ageMax: Number($('ageMax').value),
    maxRows: clampMaxRows($('maxRows').value),
  };
  validateFilterInputs(result, { allowEmptyActivity: mode === 'history' });
  return result;
}

function render() {
  $('count').textContent = `${rows.length} ligne${rows.length > 1 ? 's' : ''}`;
  $('csv').disabled = !rows.length;
  $('preview').replaceChildren();
  if (!rows.length) {
    const text = mode === 'history' ? 'Aucun dirigeant historique ne correspond aux critères.' : 'Aucun nouveau dirigeant trouvé.';
    return $('preview').append(element('p', text, 'empty'));
  }
  const table = element('table');
  const head = element('tr');
  for (const label of ['Entreprise / APE', 'Dirigeant', 'Effectif', 'Établissement trouvé / siège', 'Indice prudent']) head.append(element('th', label));
  table.append(head);
  for (const row of rows.slice(0, Number($('previewLimit').value) || 50)) {
    const tr = element('tr');
    const place = row.adresse_etablissement_zone ? `Établissement zone : ${row.adresse_etablissement_zone}\nSiège : ${row.adresse_siege}` : row.adresse_siege;
    const cells = [
      `${row.nom_entreprise}\n${row.siren} · ${row.code_ape} ${row.libelle_ape}`,
      `${row.dirigeant_nom}\n${row.dirigeant_qualite} · ${row.dirigeant_age} ans`,
      row.tranche_effectif,
      place,
      row.dirigeant_pm_nom ? `${row.dirigeant_pm_nom} (${row.dirigeant_pm_siren})\n${row.groupement_capitalistique_indice}` : 'Aucun dirigeant personne morale hors audit',
    ];
    for (const value of cells) {
      const td = element('td');
      for (const [index, line] of String(value ?? '').split('\n').entries()) {
        if (index) td.append(document.createElement('br'));
        td.append(document.createTextNode(line));
      }
      tr.append(td);
    }
    table.append(tr);
  }
  $('preview').append(table);
}

function setLoading(active) {
  clearInterval(loadingTimer);
  $('searchProgress').hidden = !active;
  if (!active) return;
  const startedAt = Date.now();
  const history = mode === 'history';
  $('progressTitle').textContent = history ? 'Consultation de l’historique' : 'Recherche de nouveaux dirigeants';
  $('progressDetail').textContent = history
    ? 'Application de la recherche rapide et des filtres.'
    : 'Consultation de la base partagée, puis de l’API si nécessaire.';
  const update = () => { $('progressTime').textContent = `${Math.floor((Date.now() - startedAt) / 1000)} s`; };
  update();
  loadingTimer = setInterval(update, 1000);
}

function setMode(nextMode) {
  mode = nextMode;
  $('modeNew').setAttribute('aria-pressed', String(mode === 'new'));
  $('modeHistory').setAttribute('aria-pressed', String(mode === 'history'));
  $('historyQueryField').hidden = mode !== 'history';
  $('run').textContent = mode === 'history' ? 'Afficher l’historique' : 'Trouver de nouveaux dirigeants';
  $('modeHelp').textContent = mode === 'history'
    ? 'Retrouvez et réexportez les dirigeants déjà livrés. La recherche rapide peut être utilisée seule.'
    : 'La base existante est consultée avant l’API. Un dirigeant déjà livré ne réapparaît pas.';
  render();
}

async function run() {
  let filters;
  try { filters = currentFilters(); } catch (error) { return status(error.message, true); }
  if (mode === 'history' && !isCentralConfigured()) return status('Historique indisponible : base centrale non configurée.', true);
  rows = [];
  render();
  aborter = new AbortController();
  $('run').disabled = true;
  $('stop').disabled = false;
  setLoading(true);
  status('Recherche en cours…');
  try {
    const serverFilters = {
      zones: filters.zones,
      nafCodes: filters.nafCodes,
      sectors: filters.sectors,
      legal: filters.legal,
      staffMin: filters.staffMin,
      staffMax: filters.staffMax,
      ageMin: filters.ageMin,
      ageMax: filters.ageMax,
    };
    const result = await scanCentral({
        mode,
        query: mode === 'history' ? $('historyQuery').value.trim() : '',
        filters: serverFilters,
        target: filters.maxRows,
      }, { signal: aborter.signal });
      rows = result.rows;
      render();
      const cache = result.cache || {};
      if (mode === 'history') {
        status(`${result.partial ? 'Historique partiel' : 'Historique terminé'} : ${rows.length} dirigeant(s) retrouvé(s)${result.warning ? ` · ${result.warning}` : ''}.`, Boolean(result.partial));
      } else {
        const collected = cache.oldest_collected_at ? ` · données collectées depuis le ${new Date(cache.oldest_collected_at).toLocaleString('fr-FR')}` : '';
        status(`${result.partial ? 'Résultat partiel' : 'Terminé'} : ${rows.length} nouveau(x) dirigeant(s) · ${cache.stored_rows || 0} depuis la base · ${cache.hit_pages || 0} page(s) en cache · ${cache.fetched_pages || 0} page(s) API${collected}${result.warning ? ` · ${result.warning}` : ''}`, Boolean(result.partial));
    }
    await saveSnapshot({ rows, filters, mode, savedAt: new Date().toISOString() });
  } catch (error) {
    status(error.name === 'AbortError' ? 'Recherche arrêtée.' : `Erreur : ${error.message}`, error.name !== 'AbortError');
  } finally {
    setLoading(false);
    $('run').disabled = false;
    $('stop').disabled = true;
    aborter = null;
  }
}

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

async function restore() {
  try {
    const snapshot = await loadLastSnapshot();
    if (!snapshot) return status('Aucun résultat local sauvegardé.');
    rows = snapshot.rows;
    if (snapshot.mode === 'history' || snapshot.mode === 'new') setMode(snapshot.mode);
    render();
    status(`Dernier résultat rechargé (${new Date(snapshot.savedAt).toLocaleString('fr-FR')}).`);
  } catch (error) { status(error.message, true); }
}

async function init() {
  chips('sectors', SECTORS, false);
  chips('legals', LEGALS);
  const aliases = { '81.21Z': 'ménage, entretien', '81.22Z': 'nettoyage industriel', '81.29A': 'désinfection, désinsectisation, dératisation', '81.29B': 'autres activités de nettoyage' };
  try {
    naf = await fetch('./data/naf-rev2.json').then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
    nafPicker = createPicker({
      inputId: 'naf', optionsId: 'nafOptions',
      items: () => sortNamedEntries(Object.entries(naf)).map(([code, label]) => ({ code, label: `${code} · ${label}`, search: aliases[code] || '' })),
      isSelected: item => selectedNafCodes.includes(item.code),
      choose: item => {
        if (!selectedNafCodes.includes(item.code)) selectedNafCodes.push(item.code);
        renderNafSelection();
      },
    });
    const zoneEntries = [
      ...sortNamedEntries(REGIONS).map(([code, label]) => [code, label, 'region']),
      ...sortNamedEntries(DEPARTMENTS).map(([code, label]) => [code, label, 'departement']),
    ];
    const zoneItems = sortNamedEntries(zoneEntries).map(([code, label, type]) => ({
      key: `${type}:${code}`,
      type,
      code,
      label: type === 'region' ? `${label} · Région` : `${label} (${code}) · Département`,
    }));
    zonePicker = createPicker({
      inputId: 'zone', optionsId: 'zoneOptions',
      items: query => [postalZoneFromQuery(query), ...zoneItems].filter(Boolean),
      isSelected: item => selectedZones.some(zone => zone.key === item.key),
      choose: item => {
        selectedZones = appendCompatibleZone(selectedZones, item);
        renderZoneSelection();
      },
    });
    renderNafSelection();
    renderZoneSelection();
    status(`${Object.keys(naf).length} codes APE chargés. Mode central : base commune active.`);
  } catch (error) {
    status(`Initialisation incomplète : ${error.message}`, true);
  }
}

$('clearNaf').addEventListener('click', () => { selectedNafCodes = []; renderNafSelection(); });
$('clearZones').addEventListener('click', () => { selectedZones = []; renderZoneSelection(); });
$('modeNew').addEventListener('click', () => setMode('new'));
$('modeHistory').addEventListener('click', () => setMode('history'));
$('run').addEventListener('click', run);
$('stop').addEventListener('click', () => aborter?.abort());
$('csv').addEventListener('click', () => downloadCsv(rows));
$('restore').addEventListener('click', restore);
$('previewLimit').addEventListener('input', render);
setMode('new');
init();
