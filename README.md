# Recherche de dirigeants d’entreprise

Application publique statique servie par Vercel. Le navigateur appelle exclusivement la Vercel Function same-origin `POST /api/scan`; celle-ci utilise une base commune Neon Postgres et l’API Recherche d’entreprises.

## Garanties

- cache durable des pages amont et baux de récupération ;
- cadence et quota globaux persistés en PostgreSQL ;
- scans, historique commun et ledger anti-doublon atomique ;
- empreintes salées et `DATABASE_URL` exclusivement côté serveur ;
- aucune authentification utilisateur pour ce MVP public ;
- requêtes SQL paramétrées, corps limité à 16 Kio, filtres typés et bornés, origine same-origin stricte et deadline serverless ;
- pagination keyset du stock et de l’historique, sans plafond silencieux à 500 lignes ;
- `Retry-After`, retries bornés et renouvellement des leases pendant les attentes amont.

L’endpoint est volontairement public. Les rate limits et quotas réduisent l’abus, sans constituer une authentification.

## Installation locale et tests

```bash
npm ci
npm test
npm run check
```

Les tests Node n’utilisent aucune base distante. Ils exercent notamment l’adaptateur Node Vercel, la concurrence sur cache miss, la cadence et les retries, les résultats partiels, les compteurs et les parcours keyset au-delà de 500 lignes.

Le schéma et les fonctions SQL disposent aussi d’un test comportemental sur un PostgreSQL 16 local jetable (Docker) :

```bash
npm run test:postgres
```

Ce test couvre notamment la réservation SQL et l’identité faible/forte dans les deux ordres, dans un même batch et entre batches. Il ne constitue pas un E2E Neon : tant que la migration et les parcours applicatifs n’ont pas été exécutés contre une instance Neon autorisée, aucun test E2E Neon n’est revendiqué.

## Base neuve Neon

Dans le projet Vercel : **Vercel Marketplace → Neon**, puis créer une base neuve. La base commune neuve démarre vide.

Définir dans Vercel, pour les environnements voulus :

- `DATABASE_URL` fourni par Neon (connexion poolée recommandée pour la Function) ;
- `DIRECTOR_FINGERPRINT_SALT`, valeur aléatoire stable ;
- `RATE_LIMIT_SALT`, autre valeur aléatoire stable.

Ne jamais exposer ces variables au frontend ni les préfixer par `VITE_`/`NEXT_PUBLIC_`.

Appliquer le schéma depuis un environnement local autorisé ayant `DATABASE_URL` :

```bash
npm run db:migrate
```

La migration fraîche est `db/migrations/001_initial.sql`. Elle utilise PostgreSQL standard et les fonctions PL/pgSQL de Neon. Elle préserve cache, leases, limite globale, scans, leads, ledger atomique et historique commun.

## Déploiement Vercel

Après avoir relié le dépôt privé et configuré Neon/les variables :

```bash
vercel
# puis, lorsque la mise en production est autorisée :
vercel --prod
```

Vercel sert les fichiers statiques par son filesystem et interprète uniquement `api/scan.js` comme Function Node. La logique serveur et le client PostgreSQL lazy/singleton sont sous `server/`. Aucun secret ou identifiant de projet n’est stocké dans le dépôt.

## Rollback

L’ancien projet et l’ancien déploiement Supabase restent **intacts et non modifiés** dans leur environnement distant. Le rollback consiste à réorienter les utilisateurs vers cet ancien déploiement. Le dossier `legacy/supabase/` est conservé uniquement comme archive locale hors runtime Vercel ; il ne doit pas être déployé ni utilisé par le nouveau frontend.

## Limites des données

Les données sont administratives et publiques, avec une couverture non garantie. L’empreinte de dirigeant est une heuristique administrative, pas une identité civile. Le cache n’expire pas automatiquement ; un rafraîchissement devra être décidé explicitement.
