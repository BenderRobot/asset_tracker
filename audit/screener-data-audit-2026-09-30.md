# Audit des données du Screener — vue commerciale — 30 septembre 2026

> Mise à jour : voir l'[audit des cinq onglets du 1er octobre 2026](screener-audit-2026-10-01.md), réalisé après les corrections ci-dessous. Il recense les défauts encore présents et spécifie le double affichage du cours en devise native et en EUR. Le présent document conserve les constats historiques du 30 septembre.

**Suivi — corrections du 30 septembre 2026 (Yahoo conservé) :** corrigé localement, aucun déploiement effectué. Les calculs sont regroupés dans un module pur, `src/screenerMetrics.js`, couvert par `tests/screenerMetrics.test.js` (28 tests). La suite complète passe : 60 fichiers, 453 tests.

| Constat | Statut |
|---|---|
| #1 Communauté | Supprimée (HTML, JS, CSS). |
| #2–#8 Séries simulées de la Valorisation, « Médiane 25.4 » | Remplacées par des séries réelles : FCF/action publié, P/E, P/FCF, P/OCF et P/S à la clôture de chaque exercice, P/E sur BPA estimés (`earningsTrend`), régression semi-log sur 5 ans de clôtures mensuelles. Les indications affichent la médiane historique réelle ou le multiple actuel. |
| #9 Diagnostic radar | ROIC, « Hist. » et « Levier » retirés. Chaque barre est calculée à partir de la valeur, chaque carte porte le score de son propre axe, et une carte « Flux de trésorerie » affiche les montants dans la devise des comptes. |
| #10 `XNGS:` | Remplacé par la vraie place de cotation (`exchangeName`). |
| #11–#12 Sous-industrie, ISIN | Retirés, remplacés par le type d'instrument. |
| #13 `screenerQuantitativeTab.js` | Supprimé. |
| #14 Devise des états financiers | `financialCurrency` et `currencyCode` (ajouté par le Worker) sont convertis avec la vraie série de change, y compris historique par exercice. Les ADR sont ramenés à l'action cotée, et GBp est traité. TSM : DCF 6 943 → 218 USD, P/FCF 3,25 → 103. |
| #15 Conversion du modal | Devise de cotation par défaut, paires génériques `{A}{B}=X`, or via USD. Si le taux manque, les valeurs restent en devise de cotation avec un avertissement, jamais un taux de 1. |
| #16 PRU | Coût moyen des titres restants (ventes rejouées, dividendes exclus), converti dans la devise du graphique. |
| #17 Valeurs par défaut | Supprimées. Une entrée manquante donne « — » ou « Données insuffisantes », et les champs du calculateur restent vides à saisir. |
| #18 Calculs | « 3A » = 3 ans, comparaisons alignées par date (dividendes des deux côtés), écart en points, `$USD` corrigé, EMA correctement libellées, « tendance long terme » au lieu de « prix juste ». Le CAGR n'est affiché qu'au-delà d'un an. |
| #19 Score sans données | Onglets Quantitatif, Finances et Valorisation, radar et score désactivés pour les actifs autres qu'`EQUITY`. Un axe sans données vaut « n/d », et il faut au moins 4 axes pour un score. Le rendement moyen sur 5 ans était multiplié par 100 à tort. |
| #20 Multiples fixes | Libellés « (hyp.) », hypothèses en infobulle, avertissement de non-conseil. |
| #21 Badge PEA | Retiré. |
| #22 Quantitatif | Trous au lieu de zéros, message « Données indisponibles », devise des comptes indiquée, pieds Perf/CAGR seulement sur des bornes positives, repli mort supprimé. |
| #23 Grille populaire, recherche | EA retiré. La recherche accepte indices et cryptos. |
| P2 Fiabilité | Écouteurs liés une seule fois, jetons contre les réponses tardives (symbole, période, modal), historique propre au modal, échappement des données Yahoo, nouvelle tentative sur 502/503/504 et message d'erreur lisible. |
| Licence et fraîcheur | La source et l'heure de cotation sont affichées (« données différées »). **La question de la licence Yahoo reste ouverte.** |

Le Worker doit être redéployé pour transmettre `currency` dans `FUNDAMENTALS`. D'ici là, le front utilise `financialData.financialCurrency`, qui donne le même résultat.

Audit du commit `33ec902` (répertoire propre). Périmètre : `screener.html`, `src/screenerApp.js`, `src/screenerQuantitativeTab.js` et les endpoints du Worker `cloudflare-workers/prices-worker/worker.js` utilisés par le Screener (`QUOTE_SUMMARY`, `FUNDAMENTALS`, `SEARCH`, chart). Aucun fichier applicatif modifié, aucun déploiement.

**Méthode**

- Lecture intégrale du code du Screener (3 639 lignes JS + 873 lignes HTML) et des handlers du Worker.
- Requêtes réelles en lecture seule sur le Worker de production (`asset-tracker-prices.blaurens31.workers.dev`), espacées pour rester sous la limite de 180 requêtes par minute : `QUOTE_SUMMARY`, `FUNDAMENTALS` et historique 1 an pour **les 100 tickers de la grille « Actifs populaires »**.
- Rejeu hors navigateur, avec ces réponses réelles, des formules du Screener (valorisation du Résumé, score radar).
- Pas de validation visuelle dans un navigateur ; aucune suite de tests n'existe pour le Screener (`tests/` ne contient rien sur ce module).

## Verdict

**Le Screener n'est pas présentable en l'état dans une vue commerciale.** Trois catégories de problèmes :

1. **Des données inventées sont affichées comme réelles** (P0) : bloc « Communauté », graphiques historiques de la grille Valorisation, plusieurs lignes du diagnostic radar, et des libellés codés en dur.
2. **Des données réelles sont affichées fausses** (P1) : la devise des états financiers est ignorée (12 des 100 actifs populaires concernés), la conversion de devise du modal est incorrecte, le PRU est faux, et des valeurs par défaut sont injectées quand une donnée manque.
3. **Des données absentes produisent des chiffres plausibles au lieu de « — »** (P1/P2) : score /20 et radar calculés sur des champs vides pour les ETF, indices et cryptos (22 des 100 actifs populaires), barres à zéro, badge PEA heuristique.

Il existe aussi un point hors code, à trancher avant toute commercialisation : la **source des données** (voir la section « Licence et fraîcheur des données »).

---

## P0 — Données fictives affichées à l'utilisateur

| # | Où | Ce qui est affiché | Réalité |
|---|---|---|---|
| 1 | Onglet Valorisation → carte « Communauté » — [screenerApp.js:3129-3158](../src/screenerApp.js#L3129-L3158) | « NB. D'ÉVALUATIONS : 228 », « 138 évaluations », « 88 évaluations », prix de la communauté, croissance et multiples de la communauté | **Entièrement inventé** (commentaire `Dummy data for demo`). Les « prix de la communauté » valent `fairPrice × 0.95 / × 1.05 / × 0.92`, les croissances `growthRate × 1.1 / × 0.9`, et les multiples `trailingPE × 0.9 / × 1.1`. Aucune fonctionnalité communautaire n'existe. |
| 2 | Grille Valorisation → « Free Cash Flow / Action » — [L3168-3174](../src/screenerApp.js#L3168-L3174) | Histogramme sur 5 ans | **Simulé** : `baseMetric / (1+g)^n`, soit la valeur actuelle rétro-actualisée avec la croissance saisie. Ce n'est pas un historique. |
| 3 | Grille Valorisation → « Régression linéaire » — [L3177-3180](../src/screenerApp.js#L3177-L3180) | Courbe « Régression » | **Fictive** : `prices[0] × 1.15^i`, une pente de +15 %/an fixe (commentaire `Dummy regression line`). |
| 4 | Grille Valorisation → « P/E », « P/FCF », « P/OCF », « P/S » — [L3170, L3186-3196](../src/screenerApp.js#L3186-L3196) | 4 séries historiques | **Dérivées du FCF simulé** (#2), puis `P/FCF = P/E × 0.9`, `P/OCF = P/E × 0.7`, `P/S = P/E × 0.2`. Aucune de ces courbes ne vient d'une donnée. Pour les années manquantes, le prix de l'année est remplacé par le cours actuel ([L3166](../src/screenerApp.js#L3166)). |
| 5 | Grille Valorisation → « Forward P/E projeté » — [L3171, L3184](../src/screenerApp.js#L3171) | 5 barres colorées | Projection mécanique `prix / (métrique × (1+g)^i)` : ce n'est pas un forward P/E de consensus. Couleurs rouge→bleu arbitraires. |
| 6 | Grille Valorisation → « Métriques clés » — [L3107](../src/screenerApp.js#L3107) | « P/E … Médiane: 25.4 » | **Codé en dur** pour tous les titres. |
| 7 | Calculateur de prix juste (onglet et modal) — [L2533-2534](../src/screenerApp.js#L2533-L2534), [L2873-2874](../src/screenerApp.js#L2873-L2874) | « Médiane P/E: xx » | C'est le **P/E courant**, pas une médiane. Et `20` s'il est absent. |
| 8 | Calculateur de prix juste (onglet) → courbe « FCF/Actions » historique — [L2937-2948](../src/screenerApp.js#L2937-L2948) | Courbe continue sur 5 ans | **Rétro-calculée** à partir de la valeur actuelle et de la croissance saisie (même mécanisme que #2). Modifier la croissance réécrit donc « l'historique ». |
| 9 | Modal « Diagnostic fondamental » (radar) — [L2432-2468](../src/screenerApp.js#L2432-L2468) | ROIC | `ROE × 0.8` : **inventé**. |
| | | « Hist. » | Toujours `--`, avec une barre orange à score fixe de 2. |
| | | « Levier » | Affiche `revenuePerShare` (CA par action), qui n'a rien à voir avec un levier. |
| | | « Capex/Rev » | Affiche `FCF / CA`. |
| | | Barres EPS Fwd, OCF, FCF, Levier | Scores **fixes** (3 ; 4 ; 3,5 ; 3) : la couleur n'est pas liée à la valeur. |
| | | Titres des cartes | La carte 2 « Rentabilité » affiche le score de l'axe **Marges**, et la carte 4 « Cash Flows » celui de l'axe **Rentabilité**. |
| 10 | En-tête du modal KPI — [L1642](../src/screenerApp.js#L1642) | `XNGS:MC.PA`, `XNGS:BTC-USD`… | Préfixe XNGS (Nasdaq Global Select) **codé en dur** pour tous les titres. |
| 11 | Carte Informations → « Sous-industrie » — [L739](../src/screenerApp.js#L739) | Valeur de l'industrie | Doublon de « Industrie » présenté comme un champ distinct. |
| 12 | Carte Informations → « ISIN » — [L734](../src/screenerApp.js#L734) | Toujours « — » | **Vérifié** : `defaultKeyStatistics.isin` n'existe pour aucun des 100 tickers testés. Ce champ ne peut jamais s'afficher. |
| 13 | `src/screenerQuantitativeTab.js` | — | Génère des KPI avec `Math.random()`. Il n'est **importé nulle part** (code mort), mais il est déployé : à supprimer. |

**Correction attendue :** supprimer les éléments #1 à #6 et #13, ou les remplacer par des séries réelles. Les séries historiques existent déjà dans `FUNDAMENTALS` : FCF, CA, OCF et nombre d'actions par exercice, avec lesquels P/E, P/FCF, P/OCF et P/S s'obtiennent en croisant avec le cours de clôture de fin d'exercice. Pour le point #9, afficher uniquement les métriques réellement fournies et calculer les barres à partir des valeurs.

---

## P1 — Données réelles affichées fausses

### 14. La devise des états financiers est ignorée

Yahoo fournit `financialData.financialCurrency`, qui diffère de `price.currency` pour les ADR et les doubles cotations. Le Screener ne lit jamais ce champ, et le Worker supprime aussi le `currencyCode` des séries `FUNDAMENTALS` dans `reshapeFundamentalsTimeseries` ([worker.js:34-54](../cloudflare-workers/prices-worker/worker.js#L34-L54)). Les montants en TWD, JPY ou DKK sont donc libellés et comparés comme s'ils étaient en USD.

**Actifs populaires concernés (vérifié) :** ASML (USD/EUR), NVO (USD/DKK), NOVN.SW (CHF/USD), SPOT (USD/EUR), TTE.PA (EUR/USD), SAP (USD/EUR), ULVR.L (GBp/EUR), TM (USD/JPY), SONY (USD/JPY), BABA (USD/CNY), BIDU (USD/CNY), TSM (USD/TWD).

**Reproduction sur TSM (données réelles du jour)** : cours de 458,04 USD, FCF de 730,8 Md **TWD**, 5,19 Md d'ADR.

| Indicateur Screener | Valeur affichée | Commentaire |
|---|---|---|
| FCF / action | 140,91 « USD » | En réalité ≈ 4,4 USD (TWD ≈ 1/32 USD) |
| P/FCF | 3,25 | Réel ≈ 100 |
| DCF (simplifié), Résumé | **6 942,78 USD** | Pour un cours de 458 USD |
| Revenus, bénéfices, FCF (Quantitatif, Finances) | libellés « USD » | En TWD |

Sont touchés : la valorisation du Résumé ([L1116](../src/screenerApp.js#L1116)), le calculateur (onglet et modal), les métriques P/FCF et P/OCF ([L3110-3111](../src/screenerApp.js#L3110-L3111)), les montants OCF/FCF du radar ([L2452-2453](../src/screenerApp.js#L2452-L2453)), les onglets Quantitatif, Finances et Dividende (DPS).

**Correction :** propager `financialCurrency` depuis le Worker (`currencyCode` des séries), libeller les montants dans cette devise et convertir avant tout ratio croisé avec le cours.

### 15. Conversion de devise du modal Prix : incorrecte et silencieuse

[L1373-1463](../src/screenerApp.js#L1373-L1463), [L1722](../src/screenerApp.js#L1722)

- La devise par défaut du modal est **USD** ([screener.html:727](../screener.html#L727)). Pour un titre en EUR (MC.PA), la paire EUR→USD n'est pas gérée par `getHistoricalRateArray` et renvoie un taux de 1 : les cours en EUR sont affichés sous le libellé **« Prix (USD) »**.
- EUR est toujours converti via `EURUSD=X`, **quelle que soit la devise source** : un titre CHF, GBp, JPY ou INR (NOVN.SW, NESN.SW, ULVR.L, 9984.T, RELIANCE.NS) « converti » en EUR est divisé par le cours EUR/USD.
- XAU : un titre en EUR est divisé par le cours de l'or en USD, sans conversion EUR→USD.
- Si le taux est introuvable, le code applique un taux de 1 sans l'indiquer ([L1432](../src/screenerApp.js#L1432), [L1461](../src/screenerApp.js#L1461)).
- Le sélecteur de devise est masqué en mode Régression, mais la conversion choisie en mode Prix continue de s'y appliquer.

**Correction :** partir de la devise native et proposer celle-ci par défaut. Construire la paire `{from}{to}=X` de façon générique, gérer GBp (÷100), et afficher une erreur au lieu d'appliquer 1.

### 16. Ligne PRU fausse sur le graphique de prix

[L780-787](../src/screenerApp.js#L780-L787)

Le calcul prend **toutes** les lignes du ticker : les ventes (quantité négative) et les dividendes (même ticker, `assetType: 'Dividend'`).

- Achat de 10 × 100, puis vente de 5 × 150 : quantité 5, coût `1000 − 750 = 250`, **PRU affiché 50** au lieu de 100.
- Position entièrement soldée : division par 0, ce qui donne une ligne `Infinity` ou `NaN`.
- Les prix d'achat saisis en EUR sont tracés sur un graphique en devise native (USD) sans conversion.

**Correction :** réutiliser le PRU du moteur (`splitCanonicalPurchases` puis `calculateHoldings`), déjà corrigé lors de l'audit du 28/09, et le convertir dans la devise du graphique.

### 17. Valeurs par défaut injectées dans la valorisation

| Donnée manquante | Remplacée par | Source |
|---|---|---|
| `sharesOutstanding` | `1` : le **FCF total** devient le « FCF par action » | [L2498](../src/screenerApp.js#L2498), [L2843](../src/screenerApp.js#L2843), [L3110-3111](../src/screenerApp.js#L3110-L3111) |
| `trailingPE` | `20` | [L2500](../src/screenerApp.js#L2500), [L2845](../src/screenerApp.js#L2845) |
| Historique BPA | croissance de `10 %` | [L2513](../src/screenerApp.js#L2513), [L2856](../src/screenerApp.js#L2856) |
| BPA et FCF | métrique de base `1` | [L2522](../src/screenerApp.js#L2522), [L2864](../src/screenerApp.js#L2864) |
| `revenueGrowth` | `5 %` (DCF du Résumé) | [L1120](../src/screenerApp.js#L1120) |
| `regularMarketPrice` | `previousClose`, puis `0` | [L691](../src/screenerApp.js#L691), [L1076](../src/screenerApp.js#L1076) |

Le cas FCF indisponible illustre le problème : le métrique « FCF/Actions » bascule silencieusement sur le BPA, puis sur 1, et un « prix juste » est calculé et affiché quand même. **Correction :** afficher « Données insuffisantes » dès qu'une entrée manque.

### 18. Autres calculs faux

- **Bouton « 3A » = 2 ans** : `'3y': { range: '2y' }` ([L611](../src/screenerApp.js#L611)). Le CAGR et la performance affichés sous « 3A » portent sur 2 ans.
- **Modal Comparaison, séries alignées par index et non par date** ([L2174-2180](../src/screenerApp.js#L2174-L2180)) : les séries du titre et du benchmark sont indexées par position. Leurs calendriers diffèrent (Paris et New York, crypto 7 j/7 contre indice 5 j/7) : les courbes sont décalées et le « Diff » compare des dates différentes. Avec « Inclure les dividendes », seul le titre utilise `adjclose` : la comparaison est biaisée en faveur du titre.
- **Comparaison S&P du Résumé** : le « Diff. » est un écart de points d'indice libellé en « % ». Au premier affichage, `currentPeriod` est `undefined`, donc le libellé vaut « Diff. » sans période ([L925-927](../src/screenerApp.js#L925-L927)). La base 100 du S&P est le premier point hebdomadaire postérieur au début de la série du titre, avec jusqu'à 7 jours de décalage sur la vue 1M.
- **Modal Valorisation : « 123,45 $USD »** : faute de frappe dans `` `$${currency}` `` ([L2665](../src/screenerApp.js#L2665)).
- **Points historiques « BPA » du modal Valorisation** ([L2506-2510](../src/screenerApp.js#L2506-L2510)) : ils valent le résultat net divisé par le nombre d'actions **actuel**, et sont libellés « FCF/Actions » quand ce métrique est sélectionné ([L2598](../src/screenerApp.js#L2598)).
- **« MM50/MM200 »** dans la case à cocher ([screener.html:704](../screener.html#L704)), alors que ce sont des **EMA** qui sont calculées et légendées.
- **Infobulle « Prix juste… basé sur la régression linéaire et les fondamentaux »** ([screener.html:711](../screener.html#L711)) : le calcul ne repose que sur une régression du cours ([L1664-1669](../src/screenerApp.js#L1664-L1669)).

---

## P1/P2 — Données absentes présentées comme des chiffres

### 19. Score /20 et radar calculés sans données

[L2260-2307](../src/screenerApp.js#L2260-L2307)

Les champs absents valent 0, sauf `currentRatio` (1), `payoutRatio` (0,5 pt) et `debtToEquity` (1 pt). **22 des 100 actifs populaires n'ont pas de `financialData`** (8 ETF, 4 indices, 10 cryptos). Scores rejoués sur des réponses réelles :

| Actif | Score affiché | Remarque |
|---|---|---|
| SPY | **3,9 / 20** (badge rouge) | ETF : aucune donnée fondamentale |
| Actif sans aucune donnée (crypto, indice) | **2,7 / 20** | Santé 2,17/5 et Croissance 1,36/5 **sans aucune donnée** |
| AAPL | 17,1 / 20 | Retours, Marges, Croissance et Rentabilité saturés à 5/5 |
| TSM | 18,5 / 20 | |

**Correction :** masquer le score, le radar et l'onglet Valorisation quand `quoteType` ≠ `EQUITY` ou que `financialData` est absent. Ne noter un axe que si ses entrées existent.

### 20. Valorisation du Résumé fondée sur des multiples arbitraires

[L1078-1148](../src/screenerApp.js#L1078-L1148)

« Prix juste » = BPA × **18**, BPA forward × **15**, valeur comptable × **2,5**, DCF à **10 %** d'actualisation. La médiane de ces valeurs produit un verdict coloré « surévalué / sous-évalué ». Données réelles du jour : **AAPL « +134,1 % »** (surévalué), **TSM « +89,5 % »** (faussé par le point #14), MC.PA « +13,0 % ».

Ce sont des hypothèses, pas des données. En vue commerciale, un « prix juste » et une « marge de sécurité » présentés sans avertissement peuvent s'apparenter à une recommandation d'investissement. **Correction :** afficher les hypothèses en clair, ajouter un avertissement (« indicatif, ne constitue pas un conseil en investissement ») et faire valider ce point côté conformité.

### 21. Badge PEA heuristique et faux

[L741-751](../src/screenerApp.js#L741-L751)

La liste de codes de place est mal choisie. Résultats réels :

- **Marqués éligibles à tort** : NESN.SW et NOVN.SW (Suisse, code `EBS`, hors UE et EEE), IWDA.AS et VUSA.AS (ETF irlandais non éligibles), ^FCHI (un indice).
- **Marqués non éligibles à tort** : ALV.DE, SIE.DE, BMW.DE, VOW3.DE, car Yahoo renvoie le code `GER` et non `FRA`.

Un ETF n'est pas éligible selon sa place de cotation. **Correction :** retirer le badge, ou l'alimenter par une source d'éligibilité réelle (liste ISIN).

### 22. Onglet Quantitatif

[L3202-3346](../src/screenerApp.js#L3202-L3346)

- Les valeurs absentes deviennent `0` (`|| 0`) et sont tracées comme des barres à zéro, au lieu d'un trou.
- Le pied « Perf / CAGR » divise par `start || 1` : une première année à 0 ou négative produit un pourcentage absurde ([L3568-3569](../src/screenerApp.js#L3568-L3569)).
- **La branche de repli ne peut jamais fonctionner** : elle lit `incomeStatementHistory`, que le Worker ne demande pas ([worker.js:469-477](../cloudflare-workers/prices-worker/worker.js#L469-L477)). Quand `FUNDAMENTALS` est vide (les 22 ETF, indices et cryptos, et ROG.SW), les graphiques Revenus, Bénéfices et Marges restent vides sans message.
- Le repli « Dividende (Actuel) » met un **pourcentage et un montant dans le même histogramme** ([L3322](../src/screenerApp.js#L3322)).
- « CAPEX Est. » = |OCF − FCF| présenté comme une dépense ([L3343](../src/screenerApp.js#L3343)).
- Dividende par action historique = dividendes versés ÷ nombre moyen d'actions : c'est une approximation, présentée sans mention, et dans la devise financière (voir #14).

### 23. Couverture des actifs populaires (test réel sur 100 tickers)

- **ROG.SW** : `QUOTE_SUMMARY` en 502 et historique en 502 lors du test. La carte mène à un écran d'erreur. À retester : BTC-USD, en 502 lors d'un premier appel, a répondu au second.
- **EA** : un seul point de cotation sur 1 an. Le titre ne cote plus normalement ; retirer la carte.
- **Aucun état financier** pour les 22 ETF, indices et cryptos : les onglets Quantitatif, Finances et Valorisation sont vides ou fabriqués (voir #19 et #22).
- La recherche filtre les résultats sur `EQUITY`, `ETF` et `MUTUALFUND` ([L345-347](../src/screenerApp.js#L345-L347)), alors que la grille propose des indices et des cryptos. Le comportement est donc incohérent.
- Doublons dans la grille : AMZN, SAN.PA, BNP.PA, ROG.SW, NOVN.SW, NVO et HSBC apparaissent dans deux groupes.

---

## P2 — Fiabilité de l'affichage

- **Accumulation d'écouteurs** : `setupPeriodButtons`, `setupKpiModals` et `setupModalSettings` sont rappelés à chaque `render()` ([L683-685](../src/screenerApp.js#L683-L685)), et `setupModalPeriodButtons` à chaque ouverture du modal. Après N recherches, un clic sur « agrandir » lance N fois `openKpiModal`, soit 3N requêtes en parallèle, et le dernier rendu terminé l'emporte.
- **Pas d'annulation des requêtes** : `loadStock` n'a pas de jeton de requête. Une réponse lente pour le titre précédent peut écraser le titre courant.
- **Fuite d'état du modal** : `openKpiModal` remplace `currentData.priceHistory` par l'historique 10 ans mensuel ([L1661](../src/screenerApp.js#L1661)). Après fermeture, le Résumé n'est pas re-rendu, mais l'onglet Valorisation et un changement de période repartent de cette série.
- **Formatage** : `fmtBig` n'abrège pas les montants négatifs, et « B » signifie 10¹² (billion français), ce qu'un lecteur anglophone lira comme 10⁹.
- **Échappement** : `website` et `name` sont injectés dans `innerHTML` et dans des attributs sans échappement ([L713](../src/screenerApp.js#L713), [L731-733](../src/screenerApp.js#L731-L733), [L2351](../src/screenerApp.js#L2351)). Ce sont des données Yahoo ; un nom contenant `'` ou `"` casse déjà le repli `onerror`.

---

## Licence et fraîcheur des données (hors code, bloquant commercial)

- **Toutes** les données du Screener proviennent d'endpoints Yahoo Finance non documentés (`quoteSummary`, `fundamentals-timeseries`, `chart`, `search`), appelés avec un cookie et un crumb de session et un User-Agent de navigateur. Les conditions d'utilisation de Yahoo n'autorisent pas la redistribution de ces données dans un produit commercial. Avant commercialisation, il faut un fournisseur sous licence (par exemple FMP, EOD Historical Data, Twelve Data ou Refinitiv), ou un accord explicite.
- Aucune source, heure de cotation ni mention de délai n'est affichée. Les cours Yahoo sont généralement différés (≈ 15 min selon les places). Il faut afficher la source, `regularMarketTime` et le statut de marché.

---

## Ce qui est correct

- Les cours, variations, capitalisations, secteurs, pays et sites affichés viennent bien de Yahoo, sans substitution (hors #17).
- La performance, le CAGR et la volatilité du graphique de prix sont calculés sur la cadence réelle des points.
- La régression du Résumé (bandes ±1σ issues des résidus) et la régression du modal (semi-log, log-log, linéaire, σ, R²) sont mathématiquement correctes sur les données fournies, hors conversion de devise (#15).
- Les tables de l'onglet Finances affichent les valeurs `FUNDAMENTALS` telles quelles, avec « — » pour les valeurs absentes. Seul le libellé de devise est faux dans les cas du point #14.
- L'historique des versements de dividendes (`events=div`) est réel.

## Plan de correction proposé

1. **Immédiat (retrait)** : supprimer la carte Communauté et les graphiques #2 à #5 de la grille Valorisation, les lignes inventées du radar (#9), `XNGS:`, la sous-industrie, l'ISIN (ou une vraie source), le badge PEA et `screenerQuantitativeTab.js`.
2. **Devises** : propager `financialCurrency` et `currencyCode` depuis le Worker, réécrire la conversion (#14, #15) et corriger le PRU (#16).
3. **Données manquantes** : supprimer les valeurs par défaut (#17), masquer score, radar et valorisation pour les actifs autres qu'`EQUITY` (#19), et afficher des trous au lieu de zéros (#22).
4. **Correctifs ponctuels** : `3y`, alignement par date du modal Comparaison, `$${currency}`, libellés EMA et infobulle.
5. **Tests** : aucune couverture n'existe. Ajouter des tests unitaires sur des réponses Yahoo figées (TSM pour la devise, SPY pour un ETF, MC.PA pour l'EUR, un cas de vente partielle pour le PRU).
6. **Conformité** : fournisseur de données sous licence, affichage de la source et de l'heure, avertissement sur la valorisation.
