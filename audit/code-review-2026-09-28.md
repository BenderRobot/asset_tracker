# Audit du moteur financier, des graphiques et des résidus — 28 septembre 2026

**Suivi — correction USD/EUR :** les points prioritaires 1 et 2 ont été corrigés localement après cet audit. Les cotations conservent leurs montants natifs, les historiques portent leur devise et les soldes de cash sont convertis par devise. Les caches financiers ont été versionnés pour écarter les anciens calculs. Les cas B1/B2 attendent maintenant le résultat corrigé ; la couverture de non-régression se trouve dans `tests/currencyIntegration.test.js`. Aucun déploiement effectué. Le reste de ce document décrit l’état initial audité ; les suivis suivants consignent sa résolution progressive.

**Suivi — étape 3 (points 4, 6, 7) :** corrigés localement. Valorisation causale (aucun point après l’instant calculé, recherche de prix strictement antérieure, date de séance distincte dans `pointMeta.sessionDate`) ; seuls les titres détenus sur la fenêtre (quantité de veille, opérations du jour) sont requêtés et peuvent l’invalider, TWR soumis au même contrôle ; une cotation servie après un échec de rafraîchissement reste affichée avec sa date réelle mais rend le snapshot `degraded` (`sourceStale`, `pricesAsOf`). A3, A5, A6 et B3 attendent désormais le comportement corrigé ; couverture dans `tests/temporalCausality.test.js`, `tests/holdingIntervals.test.js`, `tests/stalePropagation.test.js`. Caches graphique (v22) et snapshot (v11) versionnés. Aucun déploiement effectué.

**Suivi — A7 (performance « All ») :** corrigé localement. Le montant « Période » utilise désormais `periodPnl` sur toutes les périodes, y compris `All`, et conserve donc les gains réalisés par les ventes partielles. `totalReturn` reste l’indicateur distinct de plus-value latente. Couverture dans `tests/transactionMarkers.test.js` et mise à jour de la reproduction A7. Aucun déploiement effectué.

**Suivi — B5 (timestamps des indices) :** corrigé localement. `calculateIndexData` renvoie désormais les timestamps alignés avec les valeurs et libellés sur les périodes longues, ce qui rétablit les dates des tooltips et des sélections de plage. Couverture dans `tests/historicalChartRobustness.test.js` et mise à jour de la reproduction B5. Aucun déploiement effectué.

**Suivi — A9 (conservation du graphique) :** corrigé localement. Lorsqu’un rafraîchissement renvoie une série invalide, une instance déjà validée reste visible avec ses statistiques après la fermeture du loader ; sans graphique antérieur, le canvas vide reste masqué. Le message de conservation n’est affiché que lorsqu’un graphique existe réellement. Couverture dans `tests/historicalChartRobustness.test.js` et mise à jour de la reproduction A9. Aucun déploiement effectué.

**Suivi — A10 (amorçage 2D) :** corrigé localement. L’amorçage recherche d’abord la dernière observation historique disponible à la borne de la fenêtre ; le `previousClose` courant n’est utilisé qu’en repli lorsqu’aucun prix antérieur n’existe. Une clôture courante plus récente ne peut donc plus remplacer le prix d’ouverture historique d’une vue 2D. Couverture dans `tests/longRangeTwr.test.js` et mise à jour de la reproduction A10. Aucun déploiement effectué.

**Suivi — A8 (provenance des prix de transaction) :** corrigé localement. Lorsqu’un prix d’exécution est la seule valorisation disponible, les points conservent désormais la source `transaction` et sa date dans `pointMeta.tickerSourceDates`. La série reste affichable mais `dataQuality` la signale explicitement comme estimée (`estimatedInstruments`, `TRANSACTION_PRICE_FALLBACK`) au lieu de la confondre avec un report de marché ordinaire. Couverture dans `tests/pointMetaProvenance.test.js` et mise à jour de la reproduction A8. Aucun déploiement effectué.

**Suivi — change historique causal :** corrigé localement. Une conversion USD historique utilise le taux exact du jour ou le dernier taux antérieur dans une fenêtre de sept jours. Les taux futurs et le taux courant sont interdits ; sans taux causal disponible, les positions et séries concernées passent en `FX_DATA_UNAVAILABLE`. Couverture dans `tests/marketUtilsFx.test.js`, `tests/portfolioInvariants.test.js` et les tests d’intégration devises. Aucun déploiement effectué.

**Suivi — historique Gold immuable :** corrigé localement. La substitution longue période conserve `GOLD.PA`, identifié par Euronext comme l’Amundi Physical Gold FR0013416716 coté en EUR, mais utilise désormais ses clôtures sans recalage sur le prix courant. L’override EUR reste nécessaire car Yahoo renvoie actuellement une métadonnée `USD` incohérente pour ce symbole. Les caches concernés sont versionnés et la couverture se trouve dans `tests/tickerMapping.test.js`. Aucun déploiement effectué.

**Suivi — alignement causal du benchmark :** corrigé localement. La requête du benchmark reprend désormais les bornes exactes des timestamps produits pour le portefeuille, au lieu de recalculer une fenêtre parallèle. Si sa première observation est postérieure au début de la courbe, les points antérieurs restent `null` ; aucune base 0 % future n’est projetée dans le passé. Couverture dans `tests/historicalChartRobustness.test.js`. Aucun déploiement effectué.

**Suivi — actualisation des périodes longues :** corrigé localement. Le scheduler du graphique reste actif sur toutes les périodes, pas seulement en 1D. Les lectures fréquentes continuent de servir le cache sans requête inutile ; une reconstruction est déclenchée lorsque le TTL expire, que le jour civil change ou qu’une nouvelle clôture de marché est stabilisée, même pour les caches 2Y/All de 24 h. Couverture dans `tests/chartSeriesCache.test.js`. Aucun déploiement effectué.

**Suivi — A1 (portefeuille entièrement liquidé) :** corrigé et verrouillé. Après une vente totale, la valeur cash finale reste traçable, le TWR conserve sa dernière base définie et la validation du composant n’exige plus le TWR pour accepter une série de valeur exploitable. La reproduction A1 attend maintenant ce comportement et la couverture de non-régression se trouve dans `tests/historicalChartRobustness.test.js`. Aucun déploiement effectué.

**Suivi — étape 5 (résidus, Hosting, déploiement) :** retirés : `loadCachedData`/`saveCacheSnapshot` (clé `portfolio_snapshot_cache` purgée), `indexCardChart.js`, `cacheRefresh.js` et ses balises, `_recoverFromClosedMarket`, `btc2.json` et le cache PowerShell (désormais ignoré). `debugDividendPhantomGap` est déplacé dans `audit/tools/`. Hosting prod et beta excluent `audit/`, `tests/`, `functions/`, `cloudflare-workers/`, les fichiers internes et le contenu des répertoires cachés : `**/.*` n’excluait pas `.git/`, qui faisait donc partie de l’upload (2 906 → 110 fichiers, vérifié avec `listFiles` de firebase-tools). `deploy.ps1` bloque sur `npm test` et déploie le Worker à chaque exécution (`-SkipWorker` pour l’exclure explicitement). Aucun déploiement effectué.

**Bilan final — 30 septembre 2026 : entièrement vert.** Les quatre derniers tests d’audit obsolètes ont été convertis en tests de non-régression : A2 conserve le type investissable malgré une ligne de dividende, A4 transmet les dividendes au registre historique, B4 inclut le cash des dividendes dans le détail courtier et B6 répartit le gain journalier selon les quantités détenues à la clôture précédente. B6 a révélé puis permis de corriger un reliquat : une position ouverte le jour même n’expose désormais plus sa quantité courante comme quantité de veille. Avec les suivis précédents, **A1 à A10 et B1 à B6 attendent tous le comportement corrigé**. La CI fixe aussi explicitement `TZ: Europe/Paris` (sans entité HTML ni espace parasite). Aucun déploiement effectué.

Les constats détaillés ci-dessous sont conservés comme historique de l’état initial audité. Ils ne décrivent plus des défauts encore reproductibles ; les éventuels éléments non barrés dans les sections de dette technique ne bloquent pas le bilan fonctionnel vert.

Audit du commit `6cb50e0`, répertoire initialement sans modifications Git. Lecture des moteurs, du stockage, des API, des caches, des consommateurs Dashboard/Investissements/Analytics, des tests et du déploiement. Aucun fichier applicatif modifié et aucun déploiement effectué. Seuls ce rapport et deux fichiers de reproduction ont été ajoutés.

Les résultats ci-dessous proviennent de lecture de code et de tests locaux avec données synthétiques, sans compte utilisateur ni requête vers les services de production. Il ne s’agit pas d’un audit de sécurité exhaustif ni d’une validation visuelle dans un vrai navigateur.

**Vérifications effectuées**

| Vérification | Résultat | Interprétation |
| --- | --- | --- |
| `npm test -- --reporter=dot` | **59 fichiers, 422 tests réussis** | Suite principale entièrement verte, avec les non-régressions B6, le résolveur Yahoo partagé et l’unicité des modules ES. |
| `npm exec -- vitest run --config audit/vitest.config.js --silent --reporter=verbose` | **11 tests réussis sur 11** | A1 à A10 valident maintenant le comportement corrigé. |
| `npm exec -- vitest run --config audit/current-code.config.js --silent --reporter=verbose` | **6 tests réussis sur 6** | B1 à B6 valident maintenant le comportement corrigé. |

Les tests Firestore, séparés de `npm test`, n’ont pas été exécutés pour cet audit financier. Les avertissements `HTMLCanvasElement.getContext` de la suite principale rappellent que les tests DOM ne valident pas un vrai rendu canvas.

**Problèmes prioritaires — P1 : résultat financier incorrect ou parcours bloqué**

1. **~~Les historiques USD peuvent être valorisés comme des EUR.~~ Corrigé.**

   Sources : `src/storage.js:567`, `src/api.js:846`, `src/HistoryCalculator.js:1348`.

   Le stockage convertit les cotations USD en EUR et conserve `originalCurrency: 'USD'`. L’API historique conserve les bougies en devise native. Le moteur choisit pourtant la devise des bougies d’après `livePriceSnapshot.currency`, désormais EUR, et omet leur conversion.

   Reproduction B1 utilisant la vraie méthode `Storage.setCurrentPrice` : une action à 100 USD, avec USD→EUR = 0,80, vaut **80 EUR dans les positions mais 100 dans le graphique**, avec un coût investi de 80. Une plus-value inexistante peut donc apparaître. Les doublures habituelles de stockage ne reproduisent pas cette conversion.

   Correction : conserver la devise et la source de chaque prix historique ; convertir une seule fois au niveau financier. Ne pas appliquer globalement `originalCurrency` à tous les replis : certains prix de repli sont déjà convertis.

2. **~~Le cash USD est additionné au cash EUR sans conversion.~~ Corrigé.**

   Sources : `src/dataManager.js:293`, `src/dataManager.js:317`, `src/app.js:659`.

   `calculateCashReserve` additionne `price × quantity` sans lire `currency`. Ce cas est accessible depuis la saisie normale : vendre un titre en USD génère un mouvement de cash USD.

   Reproduction B2 : 100 USD avec un taux de 0,80 donnent **100 dans la réserve en EUR au lieu de 80**. Cela touche la valeur totale et les répartitions par courtier.

   Correction : suivre les soldes par devise puis les convertir pour la valorisation courante ; conserver une règle distincte pour les flux historiques. Inclure les portefeuilles contenant uniquement du cash USD dans la résolution du change.

3. **~~Les dividendes sont supprimés du parcours des graphiques longs.~~ Corrigé.**

   Sources : `src/dataManager.js:1508`, `src/historicalChart.js:972`, `src/historicalChart.js:1045`, `src/dataManager.js:1319`.

   `calculateHistory` filtre les dividendes avant d’appeler le moteur, alors que celui-ci sait les traiter comme revenu et cash. Le snapshot 1D emprunte un autre chemin qui les conserve.

   Reproduction A4 : achat à 100, cours constant, dividende de 10. L’appel direct donne cash = 10 et performance avec dividendes = +10 % ; le parcours `calculateHistory` donne cash = 0 et performance = 0 %.

   Reproduction B4 : la fenêtre de détail par courtier soustrait ensuite le cash incluant le dividende d’une valeur historique qui l’exclut. Elle affiche **−10 de rendement à cours constant**, avec une valeur totale de 100 au lieu de 110.

   Correction : transmettre le registre complet au moteur ; faire porter l’option « dividendes » sur la mesure de performance, sans supprimer le cash réellement reçu. Réutiliser `splitCanonicalPurchases` pour éviter de nouvelles divergences de filtrage.

4. **~~Un titre vendu depuis longtemps peut bloquer les graphiques actuels.~~ Corrigé.**

   Sources : `src/HistoryCalculator.js:123`, `src/HistoryCalculator.js:163`, `src/HistoryCalculator.js:237`, `src/marketDataRepository.js:216`.

   La collecte considère tous les tickers du registre, puis une erreur d’un seul historique invalide toutes les valeurs. Le dépôt de snapshots demande également les cours actuels de tous les tickers historiques.

   Reproduction A3 : OLD vendu en 2025 échoue, HELD dispose de cours en septembre 2026 ; toute la courbe de la semaine devient `null`. Les TWR peuvent pourtant rester numériques, car ils ne sont pas soumis au même contrôle.

   Correction : déterminer les intervalles de détention utiles et la complétude par point. Pour la mesure du jour, conserver les actifs nécessaires à la référence de veille et aux ventes du jour, pas uniquement les positions positives actuelles.

5. **~~En période « All », le montant de performance perd les gains réalisés.~~ Corrigé.**

   Source : `src/historicalChart.js:1362`.

   Les périodes ordinaires utilisent désormais `periodPnl` : ce point a été amélioré depuis l’ancien audit. La branche `all` utilise encore `totalReturn`, qui représente le gain des positions restantes.

   Reproduction A7 : achat de 2 titres à 100, vente d’un titre à 120, dernier titre à 132. Gain total = **52**, montant affiché = **32**. Le pourcentage et le montant de la même carte n’ont alors plus le même périmètre.

   Correction : donner à « Période » une définition identique sur toutes les périodes et garder la plus-value latente dans un indicateur distinct.

6. **~~La valorisation peut lire des observations futures.~~ Corrigé.**

   Sources : `src/HistoryCalculator.js:469`, `src/HistoryCalculator.js:841`, `src/MarketUtils.js:383`, `src/HistoryCalculator.js:1334`.

   Deux mécanismes persistent : les bougies journalières sont déplacées à 23:59:59, sans borne à l’heure courante sur les longues périodes ; la recherche crypto peut préférer une observation future plus proche.

   Reproduction A5 : à 10:00 UTC, un point est daté à 23:59:59.999 du même jour. Reproduction A6 : à T, un cours de 120 à T+1 h est choisi à la place du dernier cours connu de 100 à T−23 h.

   Correction : distinguer instant d’observation et date de séance ; limiter la valorisation aux observations disponibles à l’instant calculé. Ne pas confondre interpolation visuelle et donnée utilisable pour le calcul financier.

7. **~~Une panne de rafraîchissement peut perdre son statut dégradé dans le cache.~~ Corrigé.**

   Sources : `src/marketDataTransport.js:148`, `src/api.js:443`, `src/api.js:597`, `src/marketDataRepository.js:65`.

   Le transport renvoie un ancien contenu avec `stale: true` en cas d’erreur, y compris pour les cours live. `PriceAPI` ignore ce statut et efface `liveFailures`. Le timestamp du prix reste ancien, mais l’information d’échec disparaît ; la fraîcheur du snapshot est principalement calculée depuis sa propre date de construction.

   Reproduction B3 : cotation mise en cache, horloge avancée d’un jour, HTTP 502 au rafraîchissement forcé. L’API retourne un succès et retire l’échec du ticker, sans transmettre `stale`.

   Correction : conserver les anciennes données pour l’affichage avec leur date, tout en propageant l’erreur et la fraîcheur de la source jusqu’au snapshot et à l’interface.

**Autres anomalies confirmées — P2**

| Problème | Preuve et emplacement | Amélioration |
| --- | --- | --- |
| ~~Portefeuille entièrement liquidé rejeté par le graphique~~ | A1 corrigé : valeur cash finale conservée, TWR prolongé depuis sa dernière base définie et validation fondée sur la série de valeur traçable. | Couvert par la reproduction A1 et `tests/historicalChartRobustness.test.js`. |
| ~~Gain journalier mal réparti entre courtiers~~ | B6 corrigé : une position ouverte aujourd’hui conserve une référence de veille explicite à zéro ; le gain 100→120 revient donc 20/0 aux courtiers ancien/nouveau, sans duplication. | Couvert dans `tests/holdingIntervals.test.js` et par la reproduction B6. |
| ~~Repli au prix d’achat non identifié comme tel~~ | A8 corrigé : le point expose la source `transaction`, sa date et l’état estimé `TRANSACTION_PRICE_FALLBACK`. | Couvert dans `tests/pointMetaProvenance.test.js` et par la reproduction A8. |
| ~~Message de conservation du graphique contredit par le rendu~~ | A9 corrigé : un graphique validé reste visible après un rafraîchissement invalide ; sans graphique antérieur, le canvas reste masqué. | Couvert dans `tests/historicalChartRobustness.test.js` et par la reproduction A9. |
| ~~Référence initiale 2D potentiellement trop récente~~ | A10 corrigé : l’amorçage prend la dernière observation disponible à la borne historique avant tout repli courant. | Couvert dans `tests/longRangeTwr.test.js` et par la reproduction A10. |
| ~~Indices longs sans timestamps~~ | B5 corrigé : valeurs, libellés et timestamps sont alignés sur les périodes longues. | Couvert dans `tests/historicalChartRobustness.test.js` et par la reproduction B5. |

**Risques supplémentaires établis par lecture, sans reproduction complète dans cette passe**

- ~~Le change historique pouvait utiliser un taux futur, puis le taux courant.~~ Corrigé le 30 septembre 2026 : seuls le taux exact ou le dernier taux antérieur sur sept jours sont admis ; sinon le calcul échoue explicitement avec `FX_DATA_UNAVAILABLE`.
- ~~L’historique Gold est recalibré avec le prix courant divisé par la dernière clôture source.~~ Corrigé le 30 septembre 2026 : Euronext confirme que `GOLD.PA` correspond à l’Amundi Physical Gold FR0013416716 coté en EUR ; les clôtures fournisseur sont maintenant conservées telles quelles, sans dépendance au cours courant. L’override de devise EUR compense uniquement la métadonnée Yahoo erronée.
- ~~Le benchmark avait ses propres bornes et projetait sa première observation future au début de la courbe.~~ Corrigé le 30 septembre 2026 : il utilise la fenêtre canonique du portefeuille et conserve des points `null` jusqu’à sa première observation réelle.

**Doublons et résidus réellement identifiés**

| Élément | Constat | Action proposée |
| --- | --- | --- |
| ~~`loadCachedData` / `saveCacheSnapshot`~~ | Méthodes retirées et ancienne clé `portfolio_snapshot_cache` purgée au démarrage. | Terminé. |
| ~~`src/indexCardChart.js`~~ | Import et module inutilisés retirés. | Terminé. |
| ~~`src/cacheRefresh.js`~~ | Fichier et balises script retirés. | Terminé. |
| ~~`_recoverFromClosedMarket`~~ | Appel et méthode vide retirés. | Terminé. |
| ~~`debugDividendPhantomGap` dans le moteur~~ | Diagnostic déplacé vers `audit/tools/`. | Terminé. |
| Classification des transactions | `splitCanonicalPurchases` fournit désormais le registre complet aux parcours historiques et courtiers ; A4/B4 ne se reproduisent plus. Quelques filtres spécialisés peuvent encore être consolidés. | Dette de simplification non bloquante ; conserver les tests A4/B4 lors d’une future consolidation. |
| ~~Résolution des tickers~~ | `MarketUtils.formatTicker` est maintenant le résolveur Yahoo unique. `PriceAPI` lui transmet explicitement la catégorie issue du stockage, ce qui conserve l’ajout `.PA` pour les instruments EUR non suffixés. | Terminé et couvert par la matrice de `tests/tickerMapping.test.js`. |
| ~~Versions JavaScript manuelles~~ | Imports ES, scripts d’entrée HTML et Web Worker utilisent maintenant leurs URL canoniques sans `?v=`, ce qui garantit une seule identité par module. Les deux cibles Hosting servent `**/*.js` avec `no-cache, no-store, must-revalidate`. | Terminé et verrouillé par `tests/moduleImportConsistency.test.js`. |
| ~~`Microsoft/Windows/PowerShell/ModuleAnalysisCache` et `btc2.json`~~ | Fichiers retirés ; le cache PowerShell est ignoré. | Terminé. |
| ~~Ancien audit~~ | Les scénarios A1-A10 et B1-B6 attendent désormais les comportements corrigés. `compare-head.mjs` reste un outil historique distinct. | Terminé pour les tests de reproduction. |

Les couches de cache ne sont pas toutes des doublons à supprimer : réponse fournisseur, bougies par instrument, snapshot financier et série affichable ont des objets différents. Leur contrat de fraîcheur et de provenance doit en revanche rester cohérent, notamment pour le problème B3.

**Déploiement et garde-fous**

`deploy.ps1` lance maintenant la suite de tests comme garde bloquante et déploie le Worker de façon systématique et idempotente ; `-SkipWorker` reste l’exclusion explicite. Les configurations Hosting prod et beta excluent désormais les sources, tests, audits, fonctions, Workers, fichiers internes et répertoires cachés. La vérification locale avec `firebase-tools` a réduit la publication de 2 906 à 110 fichiers. La CI exécute en outre les tests avec `TZ: Europe/Paris` afin d’aligner les calculs calendaires avec le fuseau métier.

**Ordre de travail exécuté (historique)**

1. Corriger ensemble le contrat prix/devise et la conversion du cash ; verrouiller le parcours utilisant le vrai stockage avec des tests USD/EUR.
2. Unifier le registre cash/dividendes et les définitions gain latent/gain réalisé/performance de période ; couvrir le détail par courtier.
3. Corriger les intervalles de détention utiles, la causalité temporelle et la propagation des états incomplets/périmés.
4. Séparer les validations de série traçable, performance calculable et résultat admissible en cache ; harmoniser les indices et benchmarks.
5. Retirer les résidus identifiés, extraire les diagnostics et fiabiliser le déploiement.
6. Ajouter quelques tests de parcours complet avec vrai stockage, fournisseur simulé et rendu navigateur : achat/vente USD, dividende, vente totale, titre ancien indisponible, panne avec cache, passage 1D→All et changement de filtre pendant chargement.

Cet ordre a été réalisé par étapes et verrouillé par les suites principale et d’audit. Les dettes techniques explicitement recensées dans ce rapport sont désormais traitées ou classées comme simplifications non bloquantes.
