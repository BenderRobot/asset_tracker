# Audit du moteur financier, des graphiques et des résidus — 28 septembre 2026

**Suivi — correction USD/EUR :** les points prioritaires 1 et 2 ont été corrigés localement après cet audit. Les cotations conservent leurs montants natifs, les historiques portent leur devise et les soldes de cash sont convertis par devise. Les caches financiers ont été versionnés pour écarter les anciens calculs. Les cas B1/B2 attendent maintenant le résultat corrigé ; la couverture de non-régression se trouve dans `tests/currencyIntegration.test.js`. Aucun déploiement effectué. Le reste de ce document décrit l’état initial audité et les autres problèmes restent à traiter.

**Suivi — étape 3 (points 4, 6, 7) :** corrigés localement. Valorisation causale (aucun point après l’instant calculé, recherche de prix strictement antérieure, date de séance distincte dans `pointMeta.sessionDate`) ; seuls les titres détenus sur la fenêtre (quantité de veille, opérations du jour) sont requêtés et peuvent l’invalider, TWR soumis au même contrôle ; une cotation servie après un échec de rafraîchissement reste affichée avec sa date réelle mais rend le snapshot `degraded` (`sourceStale`, `pricesAsOf`). A3, A5, A6 et B3 attendent désormais le comportement corrigé ; couverture dans `tests/temporalCausality.test.js`, `tests/holdingIntervals.test.js`, `tests/stalePropagation.test.js`. Caches graphique (v22) et snapshot (v11) versionnés. Aucun déploiement effectué.

**Suivi — étape 5 (résidus, Hosting, déploiement) :** retirés : `loadCachedData`/`saveCacheSnapshot` (clé `portfolio_snapshot_cache` purgée), `indexCardChart.js`, `cacheRefresh.js` et ses balises, `_recoverFromClosedMarket`, `btc2.json` et le cache PowerShell (désormais ignoré). `debugDividendPhantomGap` est déplacé dans `audit/tools/`. Hosting prod et beta excluent `audit/`, `tests/`, `functions/`, `cloudflare-workers/`, les fichiers internes et le contenu des répertoires cachés : `**/.*` n’excluait pas `.git/`, qui faisait donc partie de l’upload (2 906 → 110 fichiers, vérifié avec `listFiles` de firebase-tools). `deploy.ps1` bloque sur `npm test` et déploie le Worker à chaque exécution (`-SkipWorker` pour l’exclure explicitement). Aucun déploiement effectué.

Le code contient encore des erreurs financières reproductibles, en plus de plusieurs restes d’anciennes versions. La priorité est la cohérence des devises, des dividendes et de la qualité des prix. Un simple nettoyage des fichiers ne corrigera pas ces erreurs.

Audit du commit `6cb50e0`, répertoire initialement sans modifications Git. Lecture des moteurs, du stockage, des API, des caches, des consommateurs Dashboard/Investissements/Analytics, des tests et du déploiement. Aucun fichier applicatif modifié et aucun déploiement effectué. Seuls ce rapport et deux fichiers de reproduction ont été ajoutés.

Les résultats ci-dessous proviennent de lecture de code et de tests locaux avec données synthétiques, sans compte utilisateur ni requête vers les services de production. Il ne s’agit pas d’un audit de sécurité exhaustif ni d’une validation visuelle dans un vrai navigateur.

**Vérifications effectuées**

| Vérification | Résultat | Interprétation |
| --- | --- | --- |
| `npm test` | 53 fichiers, 356 tests réussis | La suite actuelle passe. |
| `npm exec -- vitest run --config audit/vitest.config.js --silent --reporter=verbose` | 10 réussites, 1 échec sur 11 | Les tests de l’ancien audit affirment les comportements défectueux : 10 reproductions persistent ; l’échec A2 correspond à la classification des dividendes désormais corrigée. |
| `npm exec -- vitest run --config audit/current-code.config.js --silent --reporter=verbose` | 6 reproductions réussies | Nouveaux cas B1 à B6 décrits ci-dessous. Une réussite prouve le défaut, pas sa correction. |

Les tests Firestore, séparés de `npm test`, n’ont pas été exécutés pour cet audit financier. Les avertissements `HTMLCanvasElement.getContext` de la suite principale rappellent que les tests DOM ne valident pas un vrai rendu canvas.

**Problèmes prioritaires — P1 : résultat financier incorrect ou parcours bloqué**

1. **Les historiques USD peuvent être valorisés comme des EUR.**

   Sources : `src/storage.js:567`, `src/api.js:846`, `src/HistoryCalculator.js:1348`.

   Le stockage convertit les cotations USD en EUR et conserve `originalCurrency: 'USD'`. L’API historique conserve les bougies en devise native. Le moteur choisit pourtant la devise des bougies d’après `livePriceSnapshot.currency`, désormais EUR, et omet leur conversion.

   Reproduction B1 utilisant la vraie méthode `Storage.setCurrentPrice` : une action à 100 USD, avec USD→EUR = 0,80, vaut **80 EUR dans les positions mais 100 dans le graphique**, avec un coût investi de 80. Une plus-value inexistante peut donc apparaître. Les doublures habituelles de stockage ne reproduisent pas cette conversion.

   Correction : conserver la devise et la source de chaque prix historique ; convertir une seule fois au niveau financier. Ne pas appliquer globalement `originalCurrency` à tous les replis : certains prix de repli sont déjà convertis.

2. **Le cash USD est additionné au cash EUR sans conversion.**

   Sources : `src/dataManager.js:293`, `src/dataManager.js:317`, `src/app.js:659`.

   `calculateCashReserve` additionne `price × quantity` sans lire `currency`. Ce cas est accessible depuis la saisie normale : vendre un titre en USD génère un mouvement de cash USD.

   Reproduction B2 : 100 USD avec un taux de 0,80 donnent **100 dans la réserve en EUR au lieu de 80**. Cela touche la valeur totale et les répartitions par courtier.

   Correction : suivre les soldes par devise puis les convertir pour la valorisation courante ; conserver une règle distincte pour les flux historiques. Inclure les portefeuilles contenant uniquement du cash USD dans la résolution du change.

3. **Les dividendes sont encore supprimés du parcours des graphiques longs.**

   Sources : `src/dataManager.js:1508`, `src/historicalChart.js:972`, `src/historicalChart.js:1045`, `src/dataManager.js:1319`.

   `calculateHistory` filtre les dividendes avant d’appeler le moteur, alors que celui-ci sait les traiter comme revenu et cash. Le snapshot 1D emprunte un autre chemin qui les conserve.

   Reproduction A4 : achat à 100, cours constant, dividende de 10. L’appel direct donne cash = 10 et performance avec dividendes = +10 % ; le parcours `calculateHistory` donne cash = 0 et performance = 0 %.

   Reproduction B4 : la fenêtre de détail par courtier soustrait ensuite le cash incluant le dividende d’une valeur historique qui l’exclut. Elle affiche **−10 de rendement à cours constant**, avec une valeur totale de 100 au lieu de 110.

   Correction : transmettre le registre complet au moteur ; faire porter l’option « dividendes » sur la mesure de performance, sans supprimer le cash réellement reçu. Réutiliser `splitCanonicalPurchases` pour éviter de nouvelles divergences de filtrage.

4. **Un titre vendu depuis longtemps peut encore bloquer les graphiques actuels.**

   Sources : `src/HistoryCalculator.js:123`, `src/HistoryCalculator.js:163`, `src/HistoryCalculator.js:237`, `src/marketDataRepository.js:216`.

   La collecte considère tous les tickers du registre, puis une erreur d’un seul historique invalide toutes les valeurs. Le dépôt de snapshots demande également les cours actuels de tous les tickers historiques.

   Reproduction A3 : OLD vendu en 2025 échoue, HELD dispose de cours en septembre 2026 ; toute la courbe de la semaine devient `null`. Les TWR peuvent pourtant rester numériques, car ils ne sont pas soumis au même contrôle.

   Correction : déterminer les intervalles de détention utiles et la complétude par point. Pour la mesure du jour, conserver les actifs nécessaires à la référence de veille et aux ventes du jour, pas uniquement les positions positives actuelles.

5. **En période « All », le montant de performance perd toujours les gains réalisés.**

   Source : `src/historicalChart.js:1362`.

   Les périodes ordinaires utilisent désormais `periodPnl` : ce point a été amélioré depuis l’ancien audit. La branche `all` utilise encore `totalReturn`, qui représente le gain des positions restantes.

   Reproduction A7 : achat de 2 titres à 100, vente d’un titre à 120, dernier titre à 132. Gain total = **52**, montant affiché = **32**. Le pourcentage et le montant de la même carte n’ont alors plus le même périmètre.

   Correction : donner à « Période » une définition identique sur toutes les périodes et garder la plus-value latente dans un indicateur distinct.

6. **La valorisation peut lire des observations futures.**

   Sources : `src/HistoryCalculator.js:469`, `src/HistoryCalculator.js:841`, `src/MarketUtils.js:383`, `src/HistoryCalculator.js:1334`.

   Deux mécanismes persistent : les bougies journalières sont déplacées à 23:59:59, sans borne à l’heure courante sur les longues périodes ; la recherche crypto peut préférer une observation future plus proche.

   Reproduction A5 : à 10:00 UTC, un point est daté à 23:59:59.999 du même jour. Reproduction A6 : à T, un cours de 120 à T+1 h est choisi à la place du dernier cours connu de 100 à T−23 h.

   Correction : distinguer instant d’observation et date de séance ; limiter la valorisation aux observations disponibles à l’instant calculé. Ne pas confondre interpolation visuelle et donnée utilisable pour le calcul financier.

7. **Une panne de rafraîchissement peut perdre son statut dégradé dans le cache.**

   Sources : `src/marketDataTransport.js:148`, `src/api.js:443`, `src/api.js:597`, `src/marketDataRepository.js:65`.

   Le transport renvoie un ancien contenu avec `stale: true` en cas d’erreur, y compris pour les cours live. `PriceAPI` ignore ce statut et efface `liveFailures`. Le timestamp du prix reste ancien, mais l’information d’échec disparaît ; la fraîcheur du snapshot est principalement calculée depuis sa propre date de construction.

   Reproduction B3 : cotation mise en cache, horloge avancée d’un jour, HTTP 502 au rafraîchissement forcé. L’API retourne un succès et retire l’échec du ticker, sans transmettre `stale`.

   Correction : conserver les anciennes données pour l’affichage avec leur date, tout en propageant l’erreur et la fraîcheur de la source jusqu’au snapshot et à l’interface.

**Autres anomalies confirmées — P2**

| Problème | Preuve et emplacement | Amélioration |
| --- | --- | --- |
| Portefeuille entièrement liquidé rejeté par le graphique | A1 : valeur cash = 100, TWR final = `null` ; `src/historicalChart.js:361` refuse toute la courbe. | Valider séparément les vues Valeur et Performance ; conserver les points exploitables. |
| Gain journalier mal réparti entre courtiers | B6 : une action détenue hier chez A, une achetée aujourd’hui chez B, hausse 100→120 ; résultat 10/10 au lieu de 20/0 selon la règle actuelle de quantité de veille. `src/dataManager.js:1383`. | Calculer la contribution avec les quantités de référence par courtier, pas répartir selon les quantités actuelles. |
| Repli au prix d’achat non identifié comme tel | A8 : actif sans bougies valorisé à 100, `dataQuality.valid = true`, source devenue `valuation`. `src/HistoryCalculator.js:1250`, `src/HistoryCalculator.js:1337`, `src/HistoryCalculator.js:1566`. | Réserver la valorisation manuelle à une politique explicite et conserver sa provenance/date. Le repli actuel n’est pas limité à un type d’actif manuel. |
| Message de conservation du graphique contredit par le rendu | A9 : ancienne instance conservée mais canvas masqué. `src/historicalChart.js:718`, `src/historicalChart.js:1114`. | Conserver visiblement la courbe précédente avec son périmètre/date, ou annoncer clairement son absence. |
| Référence initiale 2D potentiellement trop récente | A10 : `previousClose = 120` choisi avant une observation antérieure à 100. `src/HistoryCalculator.js:597`. | Résoudre le prix à la borne demandée. L’impact final dépend de la présence de bougies qui remplacent ensuite ce prix initial. |
| Indices longs sans timestamps | B5 : `calculateIndexData` renvoie les valeurs et libellés, mais aucun timestamp. `src/dataManager.js:1573`. Les tooltips ont un repli sur le libellé ; le titre de sélection de plage devient vide (`src/historicalChart.js:2155`). | Uniformiser le contrat des séries avec le parcours indice 1D. |

**Risques supplémentaires établis par lecture, sans reproduction complète dans cette passe**

- Le change historique peut utiliser un taux futur dans les sept jours suivants, puis le taux courant si aucun historique n’est trouvé (`src/MarketUtils.js:83`). Un achat ancien peut ainsi changer de coût EUR au rechargement. L’avertissement console ne suffit pas à rendre l’approximation visible dans les KPI. Préférer un taux historique documenté et conservé, ou un état explicitement estimé.
- L’historique Gold est recalibré avec le prix courant divisé par la dernière clôture source (`src/api.js:797`). Une variation de la référence courante peut réécrire les niveaux historiques. Vérifier la correspondance instrument/devise/unité et utiliser une conversion indépendante du cours actuel.
- Le benchmark a ses propres bornes et prend sa première observation même si elle est postérieure au début de la courbe (`src/historicalChart.js:683`, `src/historicalChart.js:1911`). Partager une fenêtre commune et laisser un trou avant sa première observation disponible.

**Doublons et résidus réellement identifiés**

| Élément | Constat | Action proposée |
| --- | --- | --- |
| `src/dataManager.js:1030` et `:1086` | `loadCachedData` / `saveCacheSnapshot` : ancien cache `portfolio_snapshot_cache`, sans appelant trouvé dans le dépôt ; `MarketDataRepository` assure le cache courant. L’ancienne clé n’est pas liée à l’utilisateur. | Retirer ces méthodes après vérification des éventuels usages externes ; conserver seulement une migration/suppression de clé si nécessaire. Ce n’est pas une fuite active démontrée. |
| `src/indexCardChart.js` | Ancien moteur de sparklines encore importé dans `src/dashboardApp.js:12`, mais jamais instancié. Les appels réels utilisent `ChartKPIManager`. | Supprimer l’import et le module inutilisé. |
| `src/cacheRefresh.js` | Fichier ne contenant qu’un commentaire de compatibilité ; encore chargé par sept pages HTML. | Retirer le fichier et ses balises script. |
| `src/HistoryCalculator.js:574` | `_recoverFromClosedMarket` est une méthode asynchrone vide, encore appelée à chaque calcul. | Supprimer l’appel et la méthode ; conserver l’explication utile près du choix de fenêtre. |
| `src/dataManager.js:1782` | Environ 140 lignes de diagnostic « temporaire » `debugDividendPhantomGap`, avec rejeu d’un ancien comportement, livrées avec le moteur. | Déplacer le diagnostic dans les outils d’audit ou le charger à la demande. |
| Classification des transactions | `splitCanonicalPurchases` existe, mais les filtres cash/dividendes/immobilier sont encore recopiés dans les parcours historique, graphique et courtier. | Centraliser cette règle en priorité : sa divergence produit déjà les erreurs A4/B4. |
| Résolution des tickers | `PriceAPI.formatTicker` (`src/api.js:145`) et `MarketUtils.formatTicker` (`src/MarketUtils.js:362`) ont des règles différentes ; seul le premier ajoute `.PA` selon la catégorie. | Un seul résolveur, avec métadonnées explicites. Ne pas supprimer une version sans préserver sa règle de marché. |
| Versions d’import manuelles | `DataManager` est importé sans suffixe, avec `v=12`, `v=33` ou `v=35` selon les pages. | Uniformiser puis automatiser le versionnement des ressources. Ces suffixes ne prouvent pas que quatre anciennes copies physiques du moteur subsistent. |
| `Microsoft/Windows/PowerShell/ModuleAnalysisCache` et `btc2.json` | Fichiers suivis par Git ; cache système et capture de réponse de marché sans référence applicative trouvée. | Retirer le cache système, ajouter une exclusion ; archiver/supprimer ou transformer explicitement la capture BTC en fixture. |
| Ancien audit | A2 est corrigé ; son test attend encore le défaut. `compare-head.mjs` compare le HEAD courant au travail local, pas un commit historique fixe. | Archiver clairement l’état initial et convertir les cas corrigés en tests de non-régression. |

Les couches de cache ne sont pas toutes des doublons à supprimer : réponse fournisseur, bougies par instrument, snapshot financier et série affichable ont des objets différents. Leur contrat de fraîcheur et de provenance doit en revanche rester cohérent, notamment pour le problème B3.

**Déploiement et garde-fous**

`deploy.ps1:66` détecte les changements Worker depuis `origin/main`, puis pousse Git avant de lancer Wrangler (`:74`, `:88`). Si Wrangler échoue après le push, relancer le script donne un diff vide et peut **omettre le Worker restant à déployer**, tout en poursuivant le déploiement du frontend. Même cas si le code a déjà été poussé séparément. Comparer avec la dernière révision réellement déployée, ou rendre le déploiement Worker systématique/idempotent avec une option explicite de reprise.

Le script ne lance pas les tests et n’attend pas le résultat de CI avant le déploiement. La CI existe, mais cela ne constitue pas une barrière pour ce script. Ajouter une vérification bloquante avant publication, puis une vérification de version frontend/Worker après déploiement.

`firebase.json:5` et `:28` publient la racine avec peu d’exclusions. Les répertoires `audit/`, `tests/`, `functions/`, `cloudflare-workers/` et les artefacts cités sont donc éligibles au déploiement Hosting. Cela ne démontre pas la présence de secrets ; cela publie inutilement des sources et diagnostics non destinés au site. Préférer un répertoire de publication dédié ou une liste d’exclusions complète.

**Ordre de travail recommandé**

1. Corriger ensemble le contrat prix/devise et la conversion du cash ; verrouiller le parcours utilisant le vrai stockage avec des tests USD/EUR.
2. Unifier le registre cash/dividendes et les définitions gain latent/gain réalisé/performance de période ; couvrir le détail par courtier.
3. Corriger les intervalles de détention utiles, la causalité temporelle et la propagation des états incomplets/périmés.
4. Séparer les validations de série traçable, performance calculable et résultat admissible en cache ; harmoniser les indices et benchmarks.
5. Retirer les résidus identifiés, extraire les diagnostics et fiabiliser le déploiement.
6. Ajouter quelques tests de parcours complet avec vrai stockage, fournisseur simulé et rendu navigateur : achat/vente USD, dividende, vente totale, titre ancien indisponible, panne avec cache, passage 1D→All et changement de filtre pendant chargement.

La centralisation dans `DataManager`, `MarketDataRepository`, `TimeRangeEngine` et les snapshots est déjà utile. Les erreurs observées viennent surtout de contrats encore divergents entre ces composants et d’anciens chemins restés actifs. Il est préférable de les consolider progressivement, avec des tests aux frontières entre composants, plutôt que de réécrire l’ensemble du moteur.
