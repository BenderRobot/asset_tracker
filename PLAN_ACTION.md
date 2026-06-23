# Plan d'action - Stabilisation et evolution de l'app

## Objectif

Sur 10 jours, l'objectif est de:
- reduire les risques securite et regressions,
- ameliorer la maintenabilite du code,
- poser une base qualite (tests + CI),
- garder le produit livrable pendant le refacto.

## Priorites

- `P0` Securite et hygiene repo
- `P1` Fiabilite (gestion d'erreurs, coherence des donnees)
- `P1` Refacto ciblee des gros modules
- `P2` Tests automatises
- `P2` CI/CD et hardening

## Planning detaille (10 jours)

### Jour 1 - Audit securite express (`P0`)

Actions:
- Identifier les valeurs sensibles hardcodees (emails admin, whitelist, tokens, fallbacks sensibles).
- Basculer en variables d'environnement / secrets (Firebase Functions, Workers, config runtime).
- Verifier que rien de sensible n'est expose dans les logs.

Livrables:
- Checklist securite initiale.
- Premier lot de correctifs de secrets.

Definition of Done:
- Plus de valeur sensible en dur dans les fichiers critiques.

---

### Jour 2 - Hygiene repo et dette evidente (`P0`)

Actions:
- Retirer `functions/node_modules` du versioning (et verifier `.gitignore`).
- Nettoyer les scripts temporaires inutiles ou les marquer clairement.
- Supprimer les logs debug bruyants dans les parcours de prod.

Livrables:
- Repo allege et plus lisible.
- Base propre pour les PR suivantes.

Definition of Done:
- Aucun artefact de build/dependances versionne par erreur.

---

### Jour 3 - Gestion d'erreurs unifiee (`P1`)

Actions:
- Creer un standard d'erreur commun (code, message user-friendly, contexte technique).
- Harmoniser les erreurs entre API, Firebase, Workers et UI.
- Afficher des messages cohérents cote utilisateur (toasts, banniere, etc.).

Livrables:
- Utilitaire central de normalisation des erreurs.
- Parcours critiques alignes.

Definition of Done:
- Les erreurs critiques remontent de facon previsible et lisible.

---

### Jours 4-5 - Refacto ciblee Dashboard (`P1`)

Actions:
- Decouper le module dashboard en couches:
  - `services` (fetch/transformation),
  - `state` (etat metier),
  - `ui` (rendu/events).
- Isoler les appels reseau pour faciliter test et debug.

Livrables:
- Dashboard conserve le meme comportement fonctionnel.
- Fichier principal plus court et plus lisible.

Definition of Done:
- Pas de regression visible sur le dashboard.
- Architecture modulaire clairement identifiable.

---

### Jours 6-7 - Refacto ciblee Screener et App core (`P1`)

Actions:
- Appliquer la meme strategie au screener et a la logique coeur de l'app.
- Eliminer la logique meleee UI/metier lorsque possible.
- Corriger duplications et incoherences detectees pendant refacto.

Livrables:
- Screener plus maintenable.
- Base metier plus claire pour futures features.

Definition of Done:
- Les flux screener + portefeuille restent stables apres refacto.

---

### Jour 8 - Base de tests unitaires (`P2`)

Actions:
- Ajouter des tests sur la logique pure:
  - calculs KPI,
  - transformations de donnees,
  - utilitaires de cache/storage/api.
- Cibler d'abord les modules avec plus de risque de regression.

Livrables:
- Premier socle de tests unitaires executables localement.

Definition of Done:
- Les composants metier critiques sont couverts par des tests de base.

---

### Jour 9 - Tests E2E des flux critiques (`P2`)

Actions:
- Ajouter des tests end-to-end minimaux sur:
  - login,
  - ajout de transaction,
  - refresh des prix.
- Verifier parcours desktop + mobile si possible.

Livrables:
- Suite smoke E2E.

Definition of Done:
- Les 3 parcours critiques sont verifies automatiquement.

---

### Jour 10 - CI/CD et hardening final (`P2`)

Actions:
- Mettre en place pipeline CI:
  - lint,
  - tests unitaires,
  - smoke E2E.
- Ajouter controle securite basique:
  - scan dependances,
  - scan secrets.
- Fixer les derniers points bloquants avant merge.

Livrables:
- Workflow de validation automatique sur PR.
- Projet merge-ready.

Definition of Done:
- Une PR ne passe plus sans verifications minimales qualite/securite.

## Decoupage en 3 PRs (recommande)

### PR1 - Securite et hygiene
- Secrets/env, nettoyage repo, logs.
- Risque faible, impact fort.

### PR2 - Refacto structurelle
- Dashboard + Screener + coeur app en modules.
- Risque moyen, necessite validation fonctionnelle.

### PR3 - Qualite et industrialisation
- Tests unitaires, E2E smoke, CI/CD.
- Risque moyen, gros gain de fiabilite.

## KPI de succes a suivre

- Reduction du nombre d'erreurs runtime en prod.
- Temps moyen pour ajouter une feature sur dashboard/screener.
- Nombre de regressions detectees apres merge.
- Taux de couverture sur modules critiques.
- Temps moyen de validation d'une PR.

## Risques et parades

- Refacto trop large d'un coup:
  - Parade: petits commits, PR limitees, feature flags si besoin.
- Donnees incoherentes entre caches/sources:
  - Parade: source de verite explicite + tests de non-regression.
- Glissement planning:
  - Parade: prioriser `P0`/`P1` et reporter les optimisations `P2`.

## Backlog apres les 10 jours

- Moteur d'alertes avance (regles utilisateur).
- Scoring transparent et parametrable.
- Multi-provider de donnees marche avec fallback robuste.
- Amelioration UX mobile des pages a fort usage.

