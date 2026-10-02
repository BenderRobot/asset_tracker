# Audit du Screener — cinq onglets et affichage EUR

Date : 1er octobre 2026. Référence : commit `301d7f7` (`fix codex screener 1`).

## Suivi — correctifs P1 autorisés le 1er octobre

**Les neuf P1 sont corrigés localement ; aucun déploiement effectué.** Les sections d'audit plus bas décrivent l'état avant ces corrections. La première phase de l'affichage EUR est également livrée localement ; les P2/P3 restent des lots distincts.

| Point | Correction livrée |
|---|---|
| D1 | Registres séparés pour les graphiques Quantitatif, Dividende et Valorisation ; ouverture directe de Dividende testée ; erreurs de rendu séparées du catch réseau. |
| V1 | Rendement calculé comme taux interne des flux futurs, incluant les dividendes et la valeur terminale. Un achat à la valeur actualisée restitue le rendement cible. |
| Q2 | BPA publié et nombre moyen de l'exercice conservés. Suppression du facteur déduit du nombre actuel d'actions. Les bases de titres incertaines (devises différentes, cotations étrangères aux États-Unis, intitulé dépositaire) sont masquées ; un facteur explicite par date est prévu, mais aucune table de ratios ADR vérifiés n'est fournie. Ce choix prudent masque aussi certains historiques de cotations ordinaires transfrontalières. |
| Q1 | CAGR calculé sur les années des bornes, en conservant les trous de données. |
| R1 | Comparaison sur l'intersection des dates de séance locales clôturées. Historique quotidien pour la clôture fiscale et le change historique ; pas de prix mensuel futur utilisé à une date fiscale antérieure. |
| R2 | Comparaisons explicitement hors dividendes, en base 100 ; l'option dividendes est masquée et ignorée pour ces benchmarks. Aucune série de rendement total n'est inventée. |
| V2 | Rendu partagé onglet/modale : prix actualisé à aujourd'hui, valeur terminale non actualisée à aujourd'hui + dix ans, échelles prix/métrique visibles. |
| V3 | Hypothèses hors domaine et résultats non finis rejetés ; message explicite, champs signalés, aucune projection invalide. |
| T1 | Validation SEARCH distincte du ticker, noms composés/accentués acceptés ; réponses tardives ignorées ; résolution du nom sur Entrée et sélection aux flèches. |

### Suivi — affichage EUR, phase 1

- En-tête partagé par les cinq onglets et en-tête des modales : cours natif conservé, contre-valeur EUR secondaire et date du taux.
- Conversion générique par devise Yahoo, y compris les unités mineures GBp/GBX ; précision adaptative pour les petits prix.
- Un cours déjà en EUR n'est pas dupliqué. Les indices restent exprimés en points et leur contre-valeur est marquée « indicative ».
- Un taux absent produit « Conversion EUR indisponible » ; un taux ancien est signalé. Le cache FX expire après quinze minutes et un échec n'est pas mémorisé, afin qu'une nouvelle tentative soit possible immédiatement.
- Résumé, estimations de valorisation, calculateur et montant du dividende reprennent la contre-valeur. Le dividende précise « au taux du jour ».
- Un sélecteur global « Cotation / EUR » pilote les graphiques de cours du Résumé et initialise les modales dans la même devise. Cours, régression et benchmark sont convertis point par point avec le taux de chaque date ; une série FX manquante ne déclenche jamais l'emploi du taux courant. Les graphiques purement financiers restent dans la devise de publication, conformément à la règle de cohérence définie plus bas.

### Suivi — robustesse P2, phase 1

- La période du Résumé et celle des modales ne changent qu'après réception d'un historique valide. En cas de panne, l'ancien graphique et son bouton actif restent cohérents, avec une action « Réessayer ».
- Les demandes de période concurrentes sont ordonnées par jeton. Fermer une modale invalide ses chargements et nettoie historique, tendance et graphiques temporaires.
- `safeFetchJson` interrompt une requête bloquée après quinze secondes et accepte aussi un signal d'annulation externe.
- Le cache des benchmarks expire après quinze minutes. Comme le cache FX, il ne conserve pas un échec.
- Le cours et son historique sont désormais rendus avant les fondamentaux, le benchmark et le change. La seconde passe enrichit la vue sans ramener l'utilisateur de force sur Résumé et actualise l'onglet qu'il a ouvert entre-temps.
- Les cartes Cours, Régression et Comparaison, ainsi que le graphique de la modale, possèdent leurs propres états chargement/erreur et leur propre action « Réessayer ». Une panne de changement de période laisse l'ancienne courbe visible.
- Les trois historiques partagés ne sont plus préchargés que pour les modales Cours et Régression. Comparaison charge ses deux séries quotidiennes, Radar aucune et Valorisation uniquement son historique long dédié.
- Restent à traiter dans la phase suivante : dédupliquer le changement de période de Comparaison, éviter de recharger dix ans de cours pour les seuls événements de dividende et affiner les états des graphiques Quantitatif/Dividende/Valorisation.

Validation : **61 fichiers, 498 tests réussis** (`npm test`), dont 45 tests supplémentaires par rapport au début du lot P1. Le script de reproduction est désormais un contrôle des six régressions corrigées. Vérifications réelles en lecture seule : Worker local → Yahoo pour « Air Liquide » = 200, résultat `AI.PA` ; BPA Apple publié/restitué = **7,46 / 7,46 USD** ; historique AAPL quotidien dix ans disponible (2 512 points lors du contrôle).

Pas de validation visuelle dans un navigateur réel : les parcours sont testés sur le HTML réel avec DOM et canvas simulés. Pour publier le lot, le front **et** le Worker Prices devront être déployés. Les références de lignes ci-dessous correspondent au code audité avant correction.

## Conclusion

Le Screener dispose désormais d'une meilleure base : les séries fictives ont été retirées, les états financiers conservent leur devise et les actifs sans fondamentaux n'ont plus de score artificiel. Les corrections du 30 septembre ne suffisent toutefois pas à garantir la cohérence des cinq onglets.

Les priorités sont : **corriger l'ouverture directe de Dividende, le rendement estimé, le calcul des données par action et les comparaisons de performance**, puis **afficher systématiquement le cours en euros en complément du cours de cotation**. La présentation de la capture est lisible, mais le score /20 et l'écart de valorisation sont visuellement plus affirmatifs que leur méthode ne le justifie.

Cet audit livre un diagnostic et un cahier de correction. Aucun fichier applicatif modifié, aucun déploiement effectué dans cette intervention. Le prix en euros est spécifié ci-dessous ; il n'est pas encore ajouté à l'application.

## Méthode et limites

- Inspection de `src/screenerApp.js`, `src/screenerMetrics.js`, `screener.html`, des styles pertinents, des tests et du Worker de prix.
- Relecture du suivi de l'[audit précédent](screener-data-audit-2026-09-30.md). Ses constats historiques ne sont pas tous des problèmes encore présents.
- Requêtes en lecture seule sur le Worker de production : AAPL, ULVR.L, TSM, SPY, BTC-USD ; historiques MC.PA, S&P 500, AAPL, dividendes ULVR.L et change USD/EUR ; recherche par nom.
- Six reproductions déterministes, sans réseau, dans [le script associé](screener-audit-reproductions-2026-10-01.mjs), en utilisant les vrais calculs et les méthodes de rendu de l'application avec un DOM simulé.
- `npm test -- --run tests/screenerMetrics.test.js` : **28 tests réussis**. La suite complète n'a pas été relancée pour cet audit documentaire.
- La capture fournie couvre le Résumé sur ordinateur. Pas de parcours interactif dans un vrai navigateur : les observations mobile/accessibilité sont issues du HTML/CSS et doivent être validées visuellement.
- Les vérifications de production portent sur les API. Elles ne prouvent pas que chaque fichier du front publié correspond au commit local.

Priorités : **P1** = résultat trompeur ou parcours cassé ; **P2** = qualité, résilience et lisibilité ; **P3** = enrichissement produit. EUR est une exigence utilisateur prioritaire, distincte d'un bug de calcul.

## Vue par onglet

| Zone | À corriger en premier | Améliorations utiles |
|---|---|---|
| En-tête commun | Double cours natif/EUR, date du change, précision adaptée aux petits prix | Actualiser, état du marché, ancienneté des données |
| Résumé | Alignement des séances et benchmark dividendes compris ; annualisation de la régression courte | Méthodologie du score, indice de référence choisi, drawdown, priorité aux informations utiles |
| Quantitatif | CAGR avec années manquantes ; valeurs par action et périmètre ADR | Variations annuelles, couverture des exercices, ROE/ROA documentés, export |
| Dividende | Ouverture directe et cycle de vie des graphiques | Détachement vs paiement, montant annuel réel, régularité, baisse/suspension, traduction EUR |
| Finances | Cohérence exercice/date/devise/unité ; identification du BPA par action ordinaire/ADR | Dernier exercice d'abord, écarts annuels, vues en % du CA, export CSV |
| Valorisation | Rendement estimé, prix présent placé dans le futur, données par action | Scénarios et sensibilité, hypothèses explicites, fourchette plutôt qu'un verdict unique |

## Exigence EUR : cours en euros pour chaque actif

### Affichage attendu

Conserver le cours natif en premier, puis une ligne immédiatement dessous : `≈ … €`. Cet en-tête est commun aux cinq onglets : la contre-valeur EUR reste donc visible partout. Pour une cotation déjà en EUR, un seul montant suffit.

Exemple **purement illustratif**, pas une cotation actuelle : `100,00 USD` puis `≈ 90,00 €`, avec `1 USD = 0,9000 EUR · change du …`. Ne pas convertir les 333,02 USD de la capture avec un taux d'une autre date sans l'indiquer.

Éléments nécessaires : cours et devise d'origine, heure du cours, taux positif fini, paire/sens de conversion, heure du taux et statut disponible/périmé/indisponible. Afficher une date lisible ; préciser le fuseau lorsqu'une heure de marché est montrée.

### Règles de conversion

| Cas | Calcul/affichage |
|---|---|
| Action/ETF/crypto coté en USD | Cours × USD→EUR ; utiliser la devise fournie, pas une déduction du ticker |
| Cotation en CHF, JPY, CAD, etc. | Paire spécifique devise→EUR ; ne pas passer systématiquement par EUR/USD |
| Cotation EUR | Identité, sans requête FX |
| GBp/GBX | Pence ÷ 100 puis GBP→EUR ; normaliser une seule fois |
| TSM ou autre ADR | Le prix coté USD se convertit USD→EUR ; la devise des comptes TWD n'intervient pas dans ce prix |
| Crypto à très petit prix | Nombre de décimales adaptatif pour ne pas afficher `0,00 €` alors que le cours est positif |
| Indice | Valeur principale en **points** ; ne pas présenter sa multiplication par un FX comme le prix achetable d'une part. Pour l'EUR, proposer une performance base 100 convertie, ou préciser le caractère indicatif de la contre-valeur |
| Future/matière première | Afficher l'unité de cotation et préciser qu'il ne s'agit pas nécessairement du coût d'un contrat |
| Taux absent ou invalide | Conserver le cours natif et afficher `Conversion EUR indisponible`, jamais un taux de 1 |

La base existe : [`normalizeCurrency`](../src/screenerMetrics.js#L19) gère GBp/GBX et [`fetchFxSeries`](../src/screenerApp.js#L511) sait demander une paire générique. En revanche, ce dernier ne restitue pas l'horodatage du taux et son cache n'expire pas. Il faut enrichir le contrat avant de l'utiliser pour une contre-valeur présentée comme actuelle.

Le helper `quoteInEur` de `src/currency.js` ne couvre que l'USD et l'EUR : il ne suffit pas tel quel pour tous les actifs proposés.

### Cohérence entre les vues

1. En-tête de page **et en-tête des modales** : même prix natif et même contre-valeur EUR.
2. Résumé : cours actuel et estimations de valorisation peuvent afficher une contre-valeur EUR secondaire. Les ratios sans unité restent identiques.
3. Graphiques : choix global `Devise de cotation / EUR`, clairement indiqué sur les axes et infobulles. Chaque point historique doit utiliser le taux correspondant à sa date, pas le taux courant appliqué à tout l'historique.
4. Variation journalière : conserver le pourcentage natif identifié comme tel. Un pourcentage en EUR demande deux cours **et deux taux datés** : `P(t)×FX(t) / [P(t−1)×FX(t−1)] − 1`.
5. Dividende : contre-valeur EUR du montant par action. Pour un historique, distinguer conversion à la date de l'événement et estimation au taux du jour.
6. Finances/Quantitatif : conserver par défaut les montants publiés dans la devise des comptes. Une vue EUR optionnelle doit définir sa méthode (flux sur période, bilan à la clôture), et être identifiée comme conversion indicative ; le besoin d'un prix en EUR ne justifie pas de rebaptiser tous les comptes en EUR.

Tests d'acceptation : USD, EUR, CHF, JPY, GBp, ADR USD/TWD, ETF USD, petite crypto, indice ; panne FX ; taux nul/négatif/périmé ; changement rapide d'actif ; concordance entre en-tête et modale ; aucun double facteur 0,01.

## Constats démontrés et corrections

### D1 — P1 — Dividende dépend du passage préalable par Quantitatif

**Preuve :** [`renderDividendeTab`](../src/screenerApp.js#L3211) appelle les helpers graphiques, qui exécutent `this.quantCharts.push(chart)` ([ligne 3391](../src/screenerApp.js#L3391)). Ce tableau n'est initialisé que par `renderQuantitativeTab`, pas par le constructeur ni l'onglet Dividende.

Reproduction : nouvelle page → titre payant des dividendes avec historique → cliquer directement sur Dividende. Le script d'audit produit `TypeError: Cannot read properties of undefined (reading 'push')`. La première erreur est même journalisée comme un échec de l'historique de paiement, alors qu'il s'agit du rendu ; une autre remonte lors du graphique annuel.

Même après initialisation, les graphiques Dividende partagent le registre Quantitatif : revenir à Quantitatif détruit des graphiques de l'autre onglet.

**Correction :** registres distincts par onglet, initialisés explicitement ; destruction limitée aux graphiques de la vue concernée ; séparer les erreurs réseau des erreurs de rendu. Tester ouverture directe, réouvertures et alternance Quantitatif/Dividende/Valorisation.

### V1 — P1 — « Rendement estimé » calculé à partir d'une valeur déjà actualisée

**Preuve :** [`fairPriceModel`](../src/screenerMetrics.js#L293) utilise `(fairPrice/currentPrice)^(1/years) − 1`. `fairPrice` est pourtant la valeur **présente**, après actualisation des flux et de la valeur terminale.

Reproduction à un an : métrique 10, multiple terminal 15, croissance 0, rendement cible 10 %, sans dividende. Prix terminal = 150 ; valeur présente = 136,36. Si l'achat coûte précisément 136,36, le modèle affiche **0 %/an**, alors que 150/136,36 − 1 = **10 %** selon ses propres hypothèses.

**Correction :** sans dividende, utiliser la valeur terminale non actualisée ; avec dividendes, résoudre le taux de rendement des flux comprenant le décaissement initial, les distributions et la revente. À défaut, retirer ce KPI ou le renommer pour décrire exactement l'écart qu'il mesure. Appliquer la correction dans la modale et l'onglet.

### Q2 — P1 — La correction ADR réécrit aussi les valeurs historiques des actions ordinaires

**Preuve :** [`fundamentalRows`](../src/screenerMetrics.js#L139) multiplie tous les nombres moyens d'actions historiques par `sharesOutstanding actuel / dernier nombre moyen dilué`. Il n'existe pas de distinction entre ratio de dépositaire, rachat d'actions et dilution ordinaire. Le BPA annuel fourni par Yahoo n'est pas utilisé par cette reconstruction.

Exemple déterministe : bénéfice 1 000, moyenne diluée 100, BPA publié 10 ; nombre de titres actuel 90 → BPA reconstruit **11,11**.

**Confirmation production AAPL :** `annualDilutedEPS` 2025 = **7,46 USD**, moyenne diluée = 15 004 697 000 ; avec 14 594 180 000 titres actuels, le helper reconstruit **7,675 USD**. Finances et les calculs de valorisation peuvent ainsi montrer des bases différentes pour le même exercice.

**Correction :** utiliser le BPA annuel publié et les nombres moyens de l'exercice. Ne corriger les ADR qu'avec un ratio identifié et daté ; si ce ratio est inconnu, indiquer l'indisponibilité de la donnée par titre coté. Traiter également splits/changements de ratio et données par action retraitées. Revalider P/E, FCF/action, dividende/action et croissance.

### Q1 — P1 — Le CAGR raccourcit les périodes quand une année manque

**Preuve :** [`annualSeriesStats`](../src/screenerMetrics.js#L81) filtre les valeurs absentes puis utilise `points.length − 1` comme durée.

Reproduction : `[100, null, 121]` sur 2023, 2024, 2025 → CAGR **21 %**, au lieu de **10 %** sur deux ans. Plusieurs pieds des graphiques Quantitatif/Dividende utilisent ce helper.

**Correction :** transmettre dates/années avec les valeurs et calculer la durée entre les deux bornes réellement utilisées. Préciser la fenêtre. Pour un passage perte→bénéfice, préférer l'évolution absolue et ne pas calculer de CAGR.

### R1 — P1 — L'alignement temporel n'est pas encore un alignement des séances

**Preuve :** [`alignSeriesByTime`](../src/screenerMetrics.js#L51) prend le dernier timestamp inférieur ou égal. Les séries Yahoo quotidiennes observées sont horodatées à **07:00 UTC pour MC.PA** et **13:30 UTC pour le S&P 500** en septembre. La séance parisienne du 2 septembre prend donc le S&P du **1er septembre**, même lorsqu'on consulte les deux clôtures une fois la journée terminée.

Autre difficulté : un timestamp de début de bougie mensuelle n'est pas l'instant où sa clôture est connue. L'historique AAPL mensuel expose des dates comme `2026-09-01T04:00:00Z`. [`historicalMultiples`](../src/screenerMetrics.js#L166), alimenté par `getLongHistory`, peut donc prendre une clôture de fin de mois **postérieure** à une clôture fiscale située en milieu de mois.

**Correction :** définir la convention de comparaison (séances locales ou information disponible à un instant donné), conserver fuseaux et bornes des bougies, et choisir le dernier **cours clôturé** admissible. Pour les clôtures fiscales, utiliser une série quotidienne ou des bornes explicites. Ne pas présenter automatiquement ces multiples annuels comme des ratios connus du marché à cette date : les comptes sont publiés ensuite.

### R2 — P1 — Cocher les dividendes ne transforme pas le S&P 500 en indice de rendement total

**Preuve :** [`renderComparisonModal`](../src/screenerApp.js#L2260) utilise `adjclose` des deux séries. Sur la réponse `^GSPC` testée, les tableaux `close` et `adjclose` sont **strictement identiques**. L'actif peut alors intégrer ses distributions, tandis que le benchmark reste un indice de prix.

**Correction :** sélectionner une série de rendement total appropriée, ou un ETF représentatif ajusté en indiquant frais/écarts de suivi ; sinon désactiver l'option et expliquer la limite. S&P distingue explicitement ses versions Price Return et Total Return dans sa [fiche officielle](https://www.spglobal.com/spdji/en/indices/equity/sp-500/). Yahoo documente les ajustements de ses cours dans [son aide sur les clôtures ajustées](https://in.help.yahoo.com/kb/adjusted-close-sln28256.html).

Dans cette même modale, l'axe ajoute `%` à des valeurs **base 100** ([ligne 2315 environ](../src/screenerApp.js#L2308)). Afficher `Base 100` ou tracer les valeurs moins 100. Pour une comparaison EUR, convertir les deux historiques dans la même devise avant normalisation.

### V2 — P1 — Le « prix juste » d'aujourd'hui est placé dix ans dans le futur

**Preuve :** `fairPriceData` place `result.fairPrice` à `endYear` dans la [modale](../src/screenerApp.js#L2690) et au dernier point dans [l'onglet](../src/screenerApp.js#L2962). Ce montant est pourtant actualisé à aujourd'hui.

L'onglet projette dix ans dans le calcul, mais la grille mensuelle se termine en janvier de `année courante + 10` : au 1er octobre, l'horizon visible est plus court que dix ans. Le cours et la métrique par action sont en outre sur deux échelles, dont celle de droite est cachée.

**Correction :** valeur actuelle à la date actuelle, valeur terminale non actualisée à la date exacte `aujourd'hui + N années`, et projection distincte. Montrer les deux échelles ou séparer les graphiques prix et fondamentaux.

### V3 — P1 — Des hypothèses invalides produisent une valorisation positive

**Preuve :** [`fairPriceModel`](../src/screenerMetrics.js#L280) vérifie la présence des entrées, mais n'exclut pas une croissance inférieure à −100 % ni les résultats non finis. Les champs HTML n'imposent pas de bornes métier.

Reproduction : croissance **−200 %**, base 10, multiple 15, actualisation 10 %, horizon 10 ans → prix positif **57,83**, parce qu'une puissance paire masque le problème. Les projections mensuelles avec exposants fractionnaires deviennent, elles, invalides.

**Correction :** domaine explicite des entrées, durée strictement positive, contrôle `Number.isFinite` des sorties ; message près du champ erroné ; aucun graphique calculé sur des valeurs invalides.

### T1 — P1 — La recherche rejette les noms composés

**Preuve :** le Worker valide `symbol` comme un ticker **avant** la branche `SEARCH` ([ligne 451](../cloudflare-workers/prices-worker/worker.js#L451)). Requête réelle `type=SEARCH&symbol=Air%20Liquide` → **400 Invalid symbol format**.

Le front annonce pourtant une recherche par nom. En plus, une ancienne réponse de suggestions peut remplacer une plus récente : aucun jeton/annulation propre à `fetchSuggestions`.

**Correction :** contrat distinct pour la requête textuelle de recherche, bornée en longueur mais acceptant espaces et accents ; garder la validation stricte des tickers pour les autres endpoints. Ajouter protection contre les réponses tardives et sélection au clavier ; ne pas envoyer tout nom tapé sur Entrée directement à `QUOTE_SUMMARY`.

### F1 — P2 — L'identité d'un exercice est trop simplifiée

**Preuve de structure, collision non constatée sur l'échantillon :** [`reshapeFundamentalsTimeseries`](../cloudflare-workers/prices-worker/worker.js#L34) regroupe par quatre chiffres d'année, garde la première `endDate` et la première devise, puis écrase les valeurs par métrique. Le front prend une devise pour tous les exercices via `currencyContext`.

Deux fins de période dans la même année ou un changement de devise de présentation peuvent donc être fusionnés/relibellés. L'onglet Finances n'affiche que l'année, alors que le code reçoit déjà la date de fin d'exercice.

**Correction :** conserver date complète et type de période, devise par exercice/métrique lorsque nécessaire ; détecter les incohérences. Afficher « exercice clos le … », distinguer montant total et montant par action. Pour les ADR, préciser que le BPA publié peut porter sur l'action ordinaire.

### T2 — P2 — Période sélectionnée et données affichées peuvent diverger après une panne

**Preuve :** [`setupPeriodButtons`](../src/screenerApp.js#L1322) modifie la période et son bouton avant la réponse. Si la récupération échoue, la fonction retourne sans restaurer l'ancienne sélection ni présenter d'erreur ; l'ancien graphique reste visible. Un clic supplémentaire sur la période maintenant « courante » ne réessaie pas. Mécanisme comparable dans les boutons de période du modal.

**Correction :** état de chargement par graphique, validation de la sélection seulement après succès ou restauration en échec, bouton Réessayer. Sur le premier chargement, distinguer graphique indisponible et absence d'historique.

### T3 — P2 — Fraîcheur, charges réseau et cycle de vie incomplets

**Preuves :** `fetchFxSeries` et `_cachedBenchmarkData` n'ont pas de durée de validité. Un échec FX est conservé comme promesse résolue à `null`. `loadStock` attend aussi les données optionnelles et le FX avant le rendu ; `safeFetchJson` n'a pas de timeout/annulation. Chaque ouverture de modale lance trois historiques, même pour le radar. Dividende recharge dix ans de cours quotidiens pour récupérer les événements.

`trendPrice` n'est pas remise à zéro lorsque le nouvel actif n'a pas assez d'historique ; la fermeture de la modale n'invalide pas `_modalToken`. Une ancienne tendance peut persister et des rendus continuer après fermeture.

**Correction :** cache partagé avec date et expiration par nature de donnée, échec réessayable, chargement progressif du cours puis des onglets, requêtes dédiées aux besoins du modal, délai maximal et annulation. Réinitialiser les états spécifiques au titre et invalider les opérations au changement/à la fermeture. Montrer la date du cours et celle des fondamentaux séparément ; le Worker demande 15 ans mais AAPL ne renvoie ici que **4 exercices**, 2022–2025.

## Améliorations produit par onglet

### Résumé

- **R3 — P2, régression courte :** la capture affiche `+92,5 %/an` calculé sur un mois. Le CAGR de performance est masqué sous un an, mais pas la pente annualisée ([renderRegressionChart](../src/screenerApp.js#L986)). Sur une courte fenêtre, montrer la pente sur la période et une mention descriptive ; renommer « Régression linéaire » en « Tendance semi-log » lorsque c'est le modèle utilisé. Les bandes des résidus ne sont pas des intervalles de prédiction garantis.
- **R4 — P2, score :** Retours et Rentabilité réemploient ROE ; Marges et Rentabilité réemploient marges nette/opérationnelle. Les plafonds créent plusieurs 5/5 comme sur la capture. `partial` extrapole les entrées manquantes et un dividende absent vaut 0, même si l'absence n'est pas établie. Documenter poids, seuils et couverture ; distinguer croissance sans dividende et mauvaise qualité ; tenir compte du secteur. Afficher « score interne » et accès à la méthode.
- **Valorisation synthétique :** le `+131,7 %` rouge est un écart à la médiane de modèles hétérogènes, pas un constat de marché. Le libellé est seulement dans une infobulle. Afficher « Écart aux hypothèses » en clair, la dispersion et le nombre de méthodes ; conserver l'avertissement déjà présent.
- Ajouter sélecteur de benchmark, unité/devise des graphiques, drawdown maximal et borne temporelle exacte. Les graphes vides doivent afficher un motif et Réessayer.
- Aider les actifs sans fondamentaux avec une vue adaptée (prix/risque pour crypto et indices, distributions/frais/composition pour ETF si disponibles), plutôt que trois onglets simplement grisés.

### Quantitatif

- Montrer chaque exercice et sa date, les trous de couverture et les variations annuelles ; les courbes `spanGaps: true` relient actuellement des valeurs à travers les années manquantes.
- ROE/ROA historiques : les ratios utilisent les capitaux propres/actifs de fin d'exercice, pas une moyenne. Les identifier comme approximations ou utiliser la moyenne ouverture/clôture ; ne pas noter normalement des capitaux propres négatifs.
- Renommer « Actions en circulation » en « Nombre moyen d'actions de base/diluées » pour ces séries ; remplacer « Dépenses » par « Investissements (CAPEX) ». Une hausse du nombre d'actions ou du CAPEX n'est pas automatiquement une amélioration à colorer en vert.
- Donner aux proportions des unités visibles (`%`, variation en points) et aux totaux une échelle stable. Proposer téléchargement des données et définitions de FCF/OCF/BPA.

### Dividende

- Après D1, proposer un historique **par événement et par année**, avec une table des dates et montants ; préciser si la date Yahoo est celle du détachement, sans la présenter implicitement comme une date de crédit au compte. L'aide Yahoo utilise explicitement la date ex-dividende pour ses ajustements.
- Ne pas confondre `aucun dividende`, `non applicable` et `donnée indisponible`. Le code interrompt le chargement des événements lorsque les champs de rendement/taux/historique comptable ne suggèrent aucun dividende ; un historique de distribution peut ainsi ne jamais être vérifié.
- Actuellement le KPI de montant, les événements et l'annuel estimé peuvent utiliser trois unités différentes. Exemple observé ULVR.L : cotation `GBp`, `dividendRate` 1,65, événements 40,46/39,82 dans l'historique coté, comptes EUR. Les labels doivent être visibles sans survol et comparables dans une vue EUR définie.
- Calculer les sommes annuelles depuis les événements lorsque leur couverture est connue ; garder séparée l'estimation issue des dividendes totaux/nombre moyen de titres. Séparer année fiscale/année civile, année complète/année en cours et exceptionnel/récurrent si la source le permet.
- Ajouter dernière hausse/baisse, continuité des distributions, couverture par bénéfice et FCF. Proposer un revenu brut indicatif selon le nombre de titres détenus, sans prétendre estimer le net fiscal.

### Finances

- Dernier exercice d'abord, date de clôture complète, unité explicite et en-têtes/colonne de libellés fixes lors du défilement.
- Modes montants, variations annuelles et pourcentage du CA/actif ; afficher des ratios seulement quand le dénominateur est valide. Ajouter sous-totaux et définitions, notamment « Marge brute » qui correspond ici à un **montant** (`annualGrossProfit`).
- Ne pas dépendre de l'existence de `financialData` pour autoriser l'affichage d'états annuels pourtant reçus : `hasFundamentalProfile` et `updateTabAvailability` constituent actuellement un filtre commun trop grossier.
- Export CSV des trois tableaux avec devises/dates/source ; vue trimestrielle/TTM seulement après vérification de la couverture fournisseur. Distinguer comptes publiés, restatements éventuels et calculs internes.

### Valorisation

- Corriger V1/V2/V3/Q2 avant d'ajouter de nouveaux modèles.
- Afficher trois scénarios explicites (prudent, central, favorable), une matrice croissance/multiple et une fourchette. Les paramètres doivent rester modifiables et documenter leur origine : publié, calculé ou saisi.
- La croissance du FCF est aujourd'hui tirée de valeurs par action converties au FX historique : elle inclut potentiellement le change. Le DCF du Résumé utilise quant à lui la croissance du **CA** comme hypothèse FCF, plafonnée à 20 %. Signaler ces différences et harmoniser le modèle choisi entre Résumé, modale et onglet.
- Distinguer BPA/FCF TTM, dernier exercice et consensus ; donner la date, le nombre d'observations et la couverture derrière chaque médiane. Une médiane de quatre ratios annuels n'est pas une médiane continue du marché.
- Documenter si le FCF utilisé représente un flux destiné aux actionnaires ou à l'entreprise, les hypothèses de dette/dilution et le traitement des dividendes. Une simple mise en garde textuelle ne remplace pas cette cohérence du calcul.

## Ergonomie et accessibilité transversales

- **P2 — mobile :** les quatre KPI Dividende ont un `grid-template-columns: repeat(4, 1fr)` inline ([HTML](../screener.html#L386)), qui prime sur les règles responsive de `.quant-dashboard-grid`. Le CSS des cinq onglets ne prévoit pas de défilement horizontal dédié. Prévoir 2 puis 1 colonnes pour les KPI et une navigation utilisable à 360/390 px ; confirmer en navigateur.
- **P2 — clavier :** les suggestions et sélecteurs personnalisés sont des `div` cliquables sans navigation clavier ni sémantique dédiée. Ajouter labels, états sélectionnés/désactivés, gestion des flèches/Entrée/Échap, focus visible, focus confiné puis restauré dans les modales et alternatives textuelles aux canvas.
- Harmoniser français/anglais : « Rendement » plutôt que « Yield actuel », « Trésorerie et dette », « Payout » expliqué. Adapter la précision à l'actif et à l'unité.
- Limiter la dépendance aux couleurs, mieux différencier valeur connue, estimation et donnée absente. Sur la capture, les petits libellés gris méritent une mesure de contraste, pas un verdict de conformité sans mesure.
- Persister période, devise et onglet choisis lorsque cela fait sens ; inclure l'onglet dans l'URL pour partager directement une analyse.

## Plan de livraison et validation

| Lot | Contenu | Validation attendue |
|---|---|---|
| 1 — Corrections prioritaires | D1, V1–V3, Q1–Q2, R1–R2, T1 | Reproductions transformées en tests du comportement attendu ; parcours direct de tous les onglets |
| 2 — EUR | En-têtes page/modale, taux daté, états FX, puis graphiques et valorisations | Matrice des devises/actifs ci-dessus ; contrôle sur GBp et ADR ; même résultat dans chaque vue |
| 3 — Robustesse | T2–T3, caches, chargement progressif, état par onglet | Pannes 429/502, timeout, changements rapides, fermeture pendant chargement, reprise après panne FX |
| 4 — Lecture et exploration | Score transparent, scénarios, exports, finances enrichies, mobile/clavier | Parcours AAPL/MC.PA/ULVR.L/TSM/SPY/BTC-USD ; tailles 360/768/1440 ; navigation sans souris |

Le correctif EUR n'exige pas une refonte complète des cinq onglets : commencer par l'en-tête partagé et les modales, puis rendre les graphiques convertibles avec une convention temporelle correcte.

## Reproduction locale

```powershell
node audit/screener-audit-reproductions-2026-10-01.mjs
npm test -- --run tests/screenerMetrics.test.js
```

Au moment de l'audit, le script constatait **six bugs du code audité**, malgré les 28 tests existants réussis. Après correction, ses assertions vérifient les résultats attendus. Les tests ADR utilisent maintenant un facteur explicitement fourni, jamais déduit du nombre actuel de titres ; des tests de parcours DOM complètent les tests des fonctions pures.

## Points conservés de l'audit antérieur

La suppression de la communauté fictive, les messages de données manquantes, les jetons de chargement du titre, le PRU après vente partielle, le traitement de GBp et les hypothèses libellées sont des acquis à préserver. Le Worker renvoie bien `currency` dans les états AAPL observés : la note historique indiquant qu'il reste à déployer ce champ n'est plus représentative de cette réponse de production.

Les droits de réutilisation commerciale restent un sujet distinct à vérifier contractuellement ; cet audit ne renouvelle pas la conclusion juridique catégorique de l'ancien document et ne tranche pas la licence Yahoo.
