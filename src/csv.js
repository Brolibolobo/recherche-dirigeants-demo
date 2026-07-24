export const CSV_HEADERS = [
  'nom_entreprise','siren','siret_siege','code_ape','libelle_ape','secteur','nature_juridique','categorie_entreprise',
  'tranche_effectif','nombre_etablissements_ouverts',
  'dirigeant_prenoms','dirigeant_nom_famille','dirigeant_nom','dirigeant_qualite','dirigeant_type','dirigeant_nationalite',
  'dirigeant_annee_naissance','dirigeant_date_naissance','dirigeant_age',
  'adresse_siege','code_postal_siege','commune_siege',
  'siret_etablissement_zone','adresse_etablissement_zone','code_postal_etablissement_zone','commune_etablissement_zone',
  'email','telephone',
  'dirigeant_pm_nom','dirigeant_pm_siren','dirigeant_pm_qualite','groupement_capitalistique_indice',
  'data_quality_score','data_quality_alerts','date_export','source_url',
];
const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
export function toCsv(rows) { return '\ufeff' + [CSV_HEADERS.join(','), ...rows.map(row => CSV_HEADERS.map(key => quote(row[key])).join(','))].join('\n'); }
export function downloadCsv(rows, filename = 'recherche_entreprises_results.csv') {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
