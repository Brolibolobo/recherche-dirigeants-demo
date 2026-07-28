# Recherche de dirigeants d’entreprise

Application française compatible avec GitHub Pages. Elle interroge l’[API Recherche d’entreprises](https://recherche-entreprises.api.gouv.fr/), qualifie les dirigeants et exporte les résultats en CSV.

## Fonctionnalités

- sélection de plusieurs codes NAF/APE, combinés en logique **OU** ;
- secteur large utilisé uniquement lorsqu’aucun APE précis n’est sélectionné ;
- zones choisies dans des listes lisibles de départements et régions, combinées en logique **OU** ; seuls les établissements actifs correspondants sont gardés ;
- filtres forme juridique, effectif, âge et limite MVP de 1 à 100 dirigeants ;
- un résultat par dirigeant physique éligible, même lorsqu’une entreprise en expose plusieurs ;
- export CSV et copie locale du dernier résultat dans IndexedDB ;
- cache Supabase central optionnel avec anti-doublon atomique par workspace ;
- cadence globale de l’API amont limitée, reprise HTTP 429 et verrou par page de cache ;
- aucun champ financier demandé ou exporté ;
- rendu des champs API via les API DOM, sans injection HTML.

## Cache central et anti-doublons

Quand `src/central-config.js` contient l’URL Supabase et la clé publique du projet, le navigateur appelle uniquement l’Edge Function `scan` :

1. la requête API est normalisée et hachée ; l’âge, la forme juridique et la taille demandée ne fragmentent pas inutilement le cache amont ;
2. chaque page déjà connue est relue depuis `api_cache_pages` sans rafraîchissement automatique ;
3. les pages absentes sont récupérées une seule fois autant que possible grâce à un bail SQL, puis conservées ;
4. chaque dirigeant reçoit une empreinte salée côté serveur ;
5. `reserve_scan_leads` sérialise brièvement les réservations d’un même workspace et compare à la fois la clé exacte et l’alias nom/année avant toute livraison ;
6. au plus 50 pages sont parcourues pendant 25 secondes pour obtenir jusqu’à 100 inédits ; un budget global partagé limite aussi les appels à l’API amont ;
7. si l’API publique tombe, les pages déjà en cache restent exploitables et le résultat peut être marqué partiel.

Le MVP utilise volontairement un unique workspace public défini par `PUBLIC_WORKSPACE_ID` : tous les collègues qui utilisent ce déploiement partagent donc le même registre anti-doublons. Le schéma contient aussi `workspace_members` et `created_by` pour raccorder Supabase Auth plus tard. Il ne fournit pas encore de sélection multi-workspace côté navigateur. Les tables ne sont pas accessibles directement par les rôles `anon` ou `authenticated` : l’Edge Function utilise la clé `service_role`, qui ne doit jamais arriver dans le navigateur.

Le mode historique est lui aussi public pour ce MVP, borné et limité en mémoire par instance Edge. Il expose la sélection de dirigeants administratifs déjà livrés dans le workspace partagé : aucune donnée privée ou enrichie ne doit y être ajoutée sans authentification.

L’empreinte anti-doublon `person:v2` est basée sur les prénoms, le nom et l’année de naissance normalisés. Une date complète, `YYYY-MM` et une année seule convergent volontairement vers la même clé. La qualité de la source reste enregistrée comme `strong`, `medium` ou `weak`. Le SIREN et la nationalité n’entrent pas dans l’identité. En plus de la clé exacte, le registre conserve un hash des noms et l’année séparément : une identité sans année bloque et est bloquée par toute identité du même nom, tandis que deux homonymes ayant des années connues différentes restent distincts. Ce choix conservateur évite la réapparition quand la précision de naissance change, au prix d’un risque de fusion lorsque l’année manque. Ce mécanisme reste une heuristique administrative, pas une identité civile certifiée. Le sel `DIRECTOR_FINGERPRINT_SALT` ne doit pas changer sans migration des empreintes existantes.

Si Supabase n’est pas configuré, l’interface affiche explicitement le **mode direct sans anti-doublon partagé**. IndexedDB ne sert alors qu’à recharger le dernier résultat dans le même navigateur.

## Architecture

- `.nojekyll` : garantit que GitHub Pages publie aussi les modules sous `_shared` ;
- `src/api.js` : paramètres API, cadence et gestion HTTP ;
- `src/filters.js` : validation, qualification et construction d’un lead par dirigeant ;
- `src/cache.js` : clé canonique, normalisation d’identité et hachage ;
- `src/central-api.js` : client navigateur de l’Edge Function ;
- `src/central-config.js` : configuration publique Supabase, vide par défaut ;
- `src/storage.js` : secours local IndexedDB du dernier résultat ;
- `supabase/migrations/` : schéma, RLS, verrous et fonctions SQL atomiques ;
- `supabase/functions/scan/` : cache central et orchestration d’un scan ;
- `supabase/tests/` : tests SQL et test de concurrence réelle ;
- `tests/` : tests Node sans dépendance de production.

## Lancement et tests frontend

```bash
npm test
for file in src/*.js; do node --check "$file"; done
python3 -m http.server 8765
```

Ouvrir <http://127.0.0.1:8765>.

## Tests Supabase locaux

Docker et le CLI Supabase sont nécessaires :

```bash
npx supabase start
npx supabase db reset --local
docker exec -i supabase_db_recherche-dirigeants-demo \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - \
  < supabase/tests/central_cache.sql
uv run --with 'psycopg[binary]' python supabase/tests/concurrency.py
```

Arrêter ensuite la stack locale :

```bash
npx supabase stop --no-backup
```

## Déploiement Supabase

Cette étape nécessite un projet Supabase et une authentification CLI. Ne jamais commiter le fichier de secrets. Tant que `src/central-config.js` reste vide, l’artefact GitHub Pages fonctionne volontairement en mode direct et ne possède pas d’anti-doublon partagé.

```bash
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npx supabase db push --dry-run
npx supabase db push
cp supabase/functions/.env.example supabase/.env.production.local
# Remplacer les deux sels et ALLOWED_ORIGINS dans ce fichier ignoré par Git.
npx supabase secrets set --env-file supabase/.env.production.local
npx supabase functions deploy scan
```

Puis renseigner dans `src/central-config.js` uniquement les deux valeurs publiques :

```js
export const centralConfig = Object.freeze({
  url: 'https://<PROJECT_REF>.supabase.co',
  publicKey: '<SUPABASE_ANON_KEY>',
});
```

La clé publique/anon sert uniquement à invoquer l’Edge Function depuis le navigateur. Les tables restent révoquées pour `anon` et `authenticated`, avec RLS activé. La clé `service_role` reste un secret injecté automatiquement dans l’Edge Function.

## Données et limites

Les données viennent de sources administratives publiques. Leur couverture et leur qualité ne sont pas garanties. L’âge est estimé depuis la date ou l’année de naissance publiée. Les tranches d’effectif rendent le filtre approximatif. Un cache sans rafraîchissement automatique peut devenir ancien ; un rafraîchissement administratif explicite devra être ajouté avant usage métier durable.

L’indice de personne morale signale seulement qu’un dirigeant personne morale hors commissaire aux comptes est fourni par l’API. Ce n’est pas une preuve d’actionnariat ni de contrôle capitalistique.
