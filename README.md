# Recherche de dirigeants d’entreprise

Application statique modulaire en français, compatible avec GitHub Pages. Elle interroge l’[API Recherche d’entreprises](https://recherche-entreprises.api.gouv.fr/), qualifie des sociétés commerciales et exporte les résultats complets en CSV.

## Fonctionnalités

- recherche NAF/APE fine dans les **732 codes officiels** : saisir par exemple `ménage`, `nettoyage` ou `81.21Z` ;
- zone par département (`75`), code postal (`75001`) ou région (`region:11`) ; seules les correspondances avec un établissement encore actif sont gardées ;
- filtres secteur, forme juridique, effectif, âge et limite de 1 à 1 000 lignes ;
- code et libellé APE, adresse du siège et adresse de l’établissement correspondant à la zone dans l’aperçu et le CSV complet ;
- sauvegarde du dernier résultat complet dans IndexedDB, puis rechargement local ;
- cadence limitée à 6 appels/s, reprise sur HTTP 429 avec `Retry-After`, message exact de l’API sur erreur 400 ;
- aucune demande de données `finances`, aucun filtre ni colonne de chiffre d’affaires ;
- rendu des champs API avec les API DOM (`textContent`/nœuds texte), sans injection HTML.

### Indice de groupement capitalistique

Si l’API fournit un dirigeant **personne morale** qui n’est pas commissaire aux comptes, l’application exporte son nom, son SIREN et sa qualité comme un **indice prudent de gouvernance**. Le schéma officiel le décrit comme un dirigeant, pas comme un actionnaire. Sa présence n’est donc **pas une preuve d’actionnariat ni de contrôle capitalistique**.

## Architecture

- `index.html` : structure légère et accessible ;
- `styles.css` : présentation responsive ;
- `src/api.js` : paramètres, limitation de débit et gestion HTTP ;
- `src/filters.js` : validation, qualification et ligne de référence ;
- `src/csv.js` : CSV UTF-8 complet ;
- `src/storage.js` : persistance IndexedDB ;
- `src/app.js` : orchestration et interface sécurisée ;
- `data/naf-rev2.json` : référentiel NAF rév. 2 utilisé par le [dépôt public de l’API](https://github.com/annuaire-entreprises-data-gouv-fr/search-api/blob/main/app/labels/codes-NAF.json) ;
- `tests/` : tests Node sans dépendance tierce.

## Données et limites

Les données sont publiques et viennent de l’API Recherche d’entreprises. La couverture, la fraîcheur et la qualité dépendent des sources administratives. Le filtre géographique de l’API vise les établissements : l’application demande donc `matching_etablissements`, écarte les établissements fermés et conserve dans le CSV l’adresse trouvée dans la zone séparément de l’adresse du siège. L’âge est estimé depuis la date/année de naissance publique. Les tranches d’effectif rendent le filtre approximatif. IndexedDB reste sur l’appareil et peut être effacé par le navigateur. Aucun résultat n’est envoyé à un serveur par cette application.

Le CSV de référence contient les identifiants entreprise/établissement, APE, secteur, forme et catégorie, effectif, dirigeant, adresses, éventuel dirigeant personne morale hors audit, indice prudent de gouvernance, score d’alerte, date d’export et URL source. Les colonnes `email` et `telephone` restent vides : l’API utilisée ne les fournit pas. Aucun champ financier n’est demandé ni exporté.

## Lancement et tests

```bash
npm test
for file in src/*.js; do node --check "$file"; done
python3 -m http.server 8000
```

Ouvrir <http://localhost:8000>. Un serveur HTTP est nécessaire au chargement des modules et du JSON.

## GitHub Pages

Publier la racine de la branche choisie via **Settings → Pages → Deploy from a branch**. Les chemins sont relatifs, sans compilation ni backend. Vérifier que l’API autorise toujours l’origine GitHub Pages et consulter sa documentation si ses quotas évoluent.
