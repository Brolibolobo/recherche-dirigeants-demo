import { fetchSearchPage, buildSearchUrl } from './api.js';
import { SECTORS, LEGALS, LEGAL_CODES, parseGeo, parseNafCode, parseNafCodes, validateFilterInputs, clampMaxRows, staffCodes, findActiveMatchingEstablishment, buildReferenceRows, companyIsEligible } from './filters.js';
import { downloadCsv } from './csv.js';
import { saveSnapshot, loadLastSnapshot } from './storage.js';
import { isCentralConfigured, scanCentral } from './central-api.js';

const $ = id => document.getElementById(id);
let rows = [], naf = {}, selectedNafCodes = [], aborter;
const selected = (host) => [...$(host).querySelectorAll('[aria-pressed="true"]')].map(b => b.dataset.value);
function element(tag, text, className) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; }
function chips(host, values, pressed=true) { for (const [value,label] of values) { const b=element('button',label,'chip'); b.type='button'; b.dataset.value=value; b.setAttribute('aria-pressed',String(pressed)); b.addEventListener('click',()=>b.setAttribute('aria-pressed',b.getAttribute('aria-pressed')==='true'?'false':'true')); $(host).append(b); } }
function renderNafSelection() {
  $('selectedNaf').replaceChildren();
  $('nafCount').textContent=`${selectedNafCodes.length} code${selectedNafCodes.length>1?'s':''} APE sélectionné${selectedNafCodes.length>1?'s':''}`;
  $('clearNaf').disabled=!selectedNafCodes.length;
  for(const code of selectedNafCodes){const b=element('button',`${code} · ${naf[code]||''} ×`,'naf-tag');b.type='button';b.setAttribute('aria-label',`Retirer ${code}`);b.addEventListener('click',()=>{selectedNafCodes=selectedNafCodes.filter(value=>value!==code);renderNafSelection();});$('selectedNaf').append(b);}
  const hasNaf=selectedNafCodes.length>0;
  for(const b of $('sectors').querySelectorAll('button')){if(hasNaf)b.setAttribute('aria-pressed','false');b.disabled=hasNaf;}
  $('sectorHelp').textContent=hasNaf?'Secteurs désactivés : les codes APE sélectionnés définissent la recherche.':'Utilisée seulement lorsqu’aucun code APE n’est sélectionné.';
}
function addNaf() {
  const code=parseNafCode($('naf').value);
  if(!code)throw new Error('Choisissez un code APE dans la liste.');
  if(!naf[code])throw new Error('Code APE inconnu : choisissez une entrée de la liste.');
  if(!selectedNafCodes.includes(code))selectedNafCodes.push(code);
  $('naf').value='';renderNafSelection();
}
function filters() {
  if($('naf').value.trim())addNaf();
  const legal=selected('legals');
  const result={geo:$('geo').value.trim(),geoParams:parseGeo($('geo').value),nafCodes:parseNafCodes(selectedNafCodes),sectors:selected('sectors'),legal:legal.length?legal:LEGALS.map(([key])=>key),staffMin:$('staffMin').value,staffMax:$('staffMax').value,staffCodes:staffCodes($('staffMin').value,$('staffMax').value),ageMin:Number($('ageMin').value),ageMax:Number($('ageMax').value),maxRows:clampMaxRows($('maxRows').value)};
  validateFilterInputs(result);return result;
}
function render() {
  $('count').textContent=`${rows.length} ligne(s) complète(s)`; $('csv').disabled=!rows.length; $('preview').replaceChildren();
  if (!rows.length) return $('preview').append(element('p','Aucun résultat.','empty'));
  const table=element('table'), head=element('tr'); for(const h of ['Entreprise / APE','Dirigeant','Effectif','Établissement trouvé / siège','Indice prudent']) head.append(element('th',h)); table.append(head);
  for(const r of rows.slice(0,Number($('previewLimit').value)||50)){ const tr=element('tr'); const place=r.adresse_etablissement_zone?`Établissement zone : ${r.adresse_etablissement_zone}\nSiège : ${r.adresse_siege}`:r.adresse_siege; const cells=[`${r.nom_entreprise}\n${r.siren} · ${r.code_ape} ${r.libelle_ape}`,`${r.dirigeant_nom}\n${r.dirigeant_qualite} · ${r.dirigeant_age} ans`,r.tranche_effectif,place,r.dirigeant_pm_nom?`${r.dirigeant_pm_nom} (${r.dirigeant_pm_siren})\n${r.groupement_capitalistique_indice}`:'Aucun dirigeant personne morale hors audit']; for(const value of cells){const td=element('td'); for(const [i,line] of String(value??'').split('\n').entries()){if(i)td.append(document.createElement('br'));td.append(document.createTextNode(line));}tr.append(td);} table.append(tr); }
  $('preview').append(table);
}
async function runDirect(f) {
  const hasGeo=Object.keys(f.geoParams).length>0;
  for(let page=1; rows.length<f.maxRows; page++){
    status(`Mode direct · page ${page} · ${rows.length}/${f.maxRows}`);
    const data=await fetchSearchPage({page,filters:f},{signal:aborter.signal});
    const results=data.results||[]; if(!results.length)break;
    for(const company of results){
      if(!companyIsEligible(company,f.legal))continue;
      const matchedEstablishment=hasGeo?findActiveMatchingEstablishment(company):null;
      if(hasGeo&&!matchedEstablishment)continue;
      const code=company.activite_principale||'';
      const candidates=buildReferenceRows(company,{apeLabel:naf[code]||'',sourceUrl:buildSearchUrl({page,filters:f}),ageMin:f.ageMin,ageMax:f.ageMax,matchedEstablishment});
      for(const candidate of candidates){rows.push(candidate);if(rows.length>=f.maxRows)break;}
      if(rows.length>=f.maxRows)break;
    }
    render(); if(page >= (data.total_pages||page))break;
  }
}
async function run() {
  let f; try { f=filters(); } catch(e) { return status(e.message,true); }
  rows=[]; render(); aborter=new AbortController(); $('run').disabled=true; $('stop').disabled=false; status('Recherche en cours…');
  try {
    if(isCentralConfigured()){
      status('Cache central · recherche de dirigeants jamais livrés à ce workspace…');
      const result=await scanCentral({filters:f,target:f.maxRows},{signal:aborter.signal});
      rows=result.rows;render();
      const cache=result.cache||{};
      const collected=cache.oldest_collected_at?` · données collectées depuis le ${new Date(cache.oldest_collected_at).toLocaleString('fr-FR')}`:'';
      status(`${result.partial?'Résultat partiel':'Terminé'} : ${rows.length} nouveau(x) dirigeant(s) · ${cache.hit_pages||0} page(s) en cache · ${cache.fetched_pages||0} page(s) API${collected}${result.warning?` · ${result.warning}`:''}`,Boolean(result.partial));
    } else {
      await runDirect(f);
      status(`Terminé : ${rows.length} dirigeant(s). Cache central non configuré : mode direct, sans anti-doublon partagé.`);
    }
    await saveSnapshot({rows,filters:f,savedAt:new Date().toISOString()});
  } catch(e) { status(e.name==='AbortError'?'Recherche arrêtée.':`Erreur : ${e.message}`,e.name!=='AbortError'); }
  finally { $('run').disabled=false; $('stop').disabled=true; aborter=null; }
}
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
async function restore(){try{const s=await loadLastSnapshot();if(!s)return status('Aucun résultat local sauvegardé.');rows=s.rows;render();status(`Dernier résultat rechargé (${s.savedAt}).`);}catch(e){status(e.message,true);}}
async function init(){chips('sectors',SECTORS,false);chips('legals',LEGALS);renderNafSelection();try{naf=await fetch('./data/naf-rev2.json').then(r=>{if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json()});const list=$('naf-list');const aliases={'81.21Z':'ménage, entretien','81.22Z':'nettoyage industriel','81.29A':'désinfection, désinsectisation, dératisation','81.29B':'autres activités de nettoyage'};for(const [code,label] of Object.entries(naf)){const option=document.createElement('option');option.value=`${code} — ${label}${aliases[code]?` — ${aliases[code]}`:''}`;list.append(option);}status(`${Object.keys(naf).length} codes APE chargés. ${isCentralConfigured()?'Cache central actif.':'Mode direct : cache central non configuré.'}`);}catch(e){status(`Référentiel NAF indisponible : ${e.message}`,true);}}
$('addNaf').addEventListener('click',()=>{try{addNaf();status('Code APE ajouté.');}catch(e){status(e.message,true);}});$('naf').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('addNaf').click();}});$('clearNaf').addEventListener('click',()=>{selectedNafCodes=[];renderNafSelection();status('Codes APE effacés. Choisissez un secteur pour une recherche large.');});$('run').addEventListener('click',run);$('stop').addEventListener('click',()=>aborter?.abort());$('csv').addEventListener('click',()=>downloadCsv(rows));$('restore').addEventListener('click',restore);$('previewLimit').addEventListener('input',render);init();
