# Asset Tracker

Application web de gestion de portefeuille financier personnel, hébergée sur Firebase et accessible à l'adresse **[asset-tracker.fr](https://asset-tracker.fr)**.

## Fonctionnalités

| Module | Description |
|--------|-------------|
| 🚀 **Dashboard** | Vue synthétique du portefeuille : valeur totale, P&L, répartition par actif |
| 📈 **Assets** | Liste de toutes les positions ouvertes avec prix en temps réel |
| 📋 **Transactions** | Historique complet des achats, ventes, dividendes et mouvements de cash |
| 📊 **Analytics** | Graphiques de performance, allocation, évolution historique |
| 👁️ **Watchlist** | Suivi de titres sans les posséder |
| 🔍 **Screener** | Analyse fondamentale et quantitative de n'importe quelle action |
| 📰 **News Feeds** | Flux d'actualités financières |
| 🏢 **Immobilier** | Suivi des investissements en crowdfunding immobilier |
| 🤖 **Assistant IA** | Assistant portfolio propulsé par Gemini (Google AI) |

## Stack technique

- **Frontend** : HTML / CSS / JavaScript vanilla (aucun framework)
- **Auth & Base de données** : Firebase Auth + Firestore
- **Hébergement** : Firebase Hosting
- **Proxies API** : Cloudflare Workers
  - `prices-worker` — proxy Yahoo Finance (cours boursiers, données fondamentales, recherche de tickers)
  - `gemini-worker` — proxy Google Gemini AI (assistant IA)
- **Données de marché** : Yahoo Finance via `yahoo-finance2`
- **PWA** : installable sur mobile (manifest + service worker)

## Structure du projet

```
asset-tracker/
├── src/                    # Logique JS (modules ES6)
│   ├── app.js              # Page Transactions
│   ├── dashboardApp.js     # Dashboard
│   ├── investmentsPage.js  # Assets
│   ├── screenerApp.js      # Screener
│   ├── assistantApp.js     # Assistant IA
│   ├── api.js              # Appels aux workers Cloudflare
│   ├── storage.js          # Abstraction Firestore / localStorage
│   └── ...
├── css/                    # Styles par page + mobile
├── cloudflare-workers/
│   ├── prices-worker/      # Proxy Yahoo Finance
│   └── gemini-worker/      # Proxy Gemini
├── functions/              # Firebase Cloud Functions
├── icons/                  # Icônes PWA
├── *.html                  # Pages de l'application
├── firebase.json           # Config Firebase Hosting + Firestore
└── firestore.rules         # Règles de sécurité Firestore
```

## Types d'actifs supportés

- **Actions** (Stocks)
- **ETF**
- **Cryptomonnaies**
- **Immobilier** (crowdfunding, avec rendement et date d'échéance)
- **Cash** (dépôts / retraits par courtier)
- **Dividendes**

## Devises

Multi-devises : **EUR** et **USD** avec conversion automatique.

## Import / Export

- Import de transactions via **fichier CSV**
- Export CSV de l'historique complet

## Déploiement

### Version de l'application

La version fonctionnelle suit le format `majeure.mineure.correctif`. Le numéro
effectivement servi par le site vient de `version.json` ; le build repère le
commit Git, mais ne constitue pas la version fonctionnelle.

- `feat: ...` ou `feature: ...` augmente la mineure (`1.17.0` → `1.18.0`).
- `fix: ...` et les autres changements augmentent le correctif
  (`1.17.0` → `1.17.1`).
- `feat!: ...` ou `BREAKING CHANGE:` augmente la majeure
  (`1.17.0` → `2.0.0`).

Le hook inclus met `version.json` à jour avant chaque commit. Il est activé
dans ce clone ; après un nouveau clonage, exécuter une fois :

```powershell
npm run version:setup
```

Le hook lit le message du commit, prépare `version.json` et ajoute la version
à `RELEASES.md`. Les scripts `deploy.ps1` et `deploy-beta.ps1` préparent la
version **avant** les tests, créent un commit pour chaque publication Hosting,
puis vérifient que le site sert exactement la version du commit. Même
`.\deploy.ps1 firebase` crée et pousse ce commit sur `main`. Le numéro visible
en bas de la barre latérale est lu depuis le manifeste en ligne. L'historique
des versions fonctionnelles et correctives figure dans `RELEASES.md`.

Pour comparer le dépôt local à la production depuis le terminal :

```powershell
npm run version:check
```

Pour publier le site, utiliser les scripts qui préparent sa version :

```powershell
.\deploy.ps1 firebase
.\deploy-beta.ps1
```

Un `firebase deploy` direct pour Hosting est bloqué par le hook de
pré-déploiement, car il ne peut pas garantir l'incrémentation de version.

Les workers Cloudflare sont déployés séparément via Wrangler :

```bash
cd cloudflare-workers/prices-worker
wrangler deploy

cd cloudflare-workers/gemini-worker
wrangler deploy
```

## Accès

L'application utilise un système d'invitation : les nouveaux utilisateurs doivent être invités par un administrateur. Une fois authentifié via Firebase Auth, chaque utilisateur accède uniquement à ses propres données.
