# Audit du dashboard — évolution vers un suivi boursier premium

Date : 11 octobre 2026 · mis à jour le 13 octobre 2026.

## Suivi — lecture IA des mouvements (13 octobre 2026)

Le panneau Radar du Dashboard contient désormais une lecture IA des mouvements, avec lancement manuel. Lorsque la page est ouverte, un premier scan part après disponibilité du snapshot et des actualités ; un nouveau scan peut partir après une heure ou après un changement d'au moins 0,75 point de pourcentage de la variation du jour (délai minimal de 15 minutes). Un snapshot ancien ou une variation de séance précédente bloque le scan. La requête transmet les huit positions qui contribuent le plus au mouvement, des mesures agrégées et au plus huit titres d'actualité récents, sans identifiant de courtier ou de compte. Le modèle reçoit des consignes pour séparer faits, hypothèses et inconnues, chercher sur le Web et ne pas attribuer une cause sans preuve. Seuls les liens renvoyés par le *grounding* Google Search sont affichés comme sources consultées ; l'heure et la date de l'analyse restent visibles.

Le Worker Gemini passe de 2.5 Flash à 3.8 Flash. Les requêtes Radar utilisent Google Search et un quota distinct de huit appels par utilisateur et par jour ; le navigateur limite en plus les appels automatiques à cinq par jour. Le Radar refuse les appels si le binding KV requis pour son quota manque. Le cache local est lié à l'utilisateur et aux positions/quantités, et une analyse de plus d'une heure ou fondée sur des cotations devenues anciennes porte la mention « à actualiser ». Le reste de l'assistant garde son quota et son parcours existants. [Modèle Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [recherche Google et facturation](https://ai.google.dev/gemini-api/docs/google-search/).

**Périmètre :** scans automatiques lorsque le Dashboard est ouvert ; aucune notification ni analyse lorsque l'application est fermée. La recherche peut coûter par requête et une réponse sourcée peut malgré tout se tromper : le panneau ne constitue pas une preuve de causalité. Validation locale : **768 tests réussis, 96 fichiers réussis**, dont le déclenchement, le contexte transmis, les quotas et le Worker réel simulé ; aperçu Chrome isolé sur données fictives à 360, 390, 768, 1 366 et 1 920 px. Aucun compte authentifié ni résultat Gemini réel testé. La page et le Worker ne sont pas encore déployés.

## Suivi — radar du portefeuille et prochaines publications (13 octobre 2026)

Un panneau « Radar de mon portefeuille » est ajouté juste sous le graphique : les trois plus fortes contributions négatives du snapshot canonique, chacune rapprochée d'un article de moins de 48 heures explicitement relié à la position détenue. Le titre, la source et l'heure de l'article sont visibles ; un clic ouvre le détail déjà utilisé par le Dashboard. En l'absence d'article, le panneau le dit clairement. Cette proximité ne constitue **pas une preuve de causalité** ; un avertissement permanent le rappelle. Les prix anciens et contributions partielles sont signalés.

La seconde colonne montre les prochaines dates de résultats des sociétés détenues, issues du module `calendarEvents` de Yahoo Finance via une nouvelle requête légère `EARNINGS_CALENDAR` du Worker Prices. Les dates estimées et les fenêtres de dates sont indiquées ; une absence de date ou une panne du fournisseur n'est jamais remplacée par une estimation fabriquée. Chaque ligne mène au Screener pour consulter les données financières et bilans publiés lorsqu'ils sont disponibles. Le calendrier est mis en cache 12 heures par symbole, limité à trois requêtes simultanées, et peut être actualisé manuellement. [Schéma du fournisseur pour `calendarEvents`](https://github.com/gadicc/yahoo-finance2/blob/dev/src/modules/quoteSummary.schema.json).

Validation locale : **762 tests réussis sur 762, 95 fichiers sur 95** ; contrôle Chrome isolé à 360, 390, 768, 1 366 et 1 920 px sans débordement. [Aperçu bureau](dashboard-preview-1366.png), [aperçu mobile](dashboard-preview-390.png). Les données de ces captures sont fictives. Aucun portefeuille authentifié ni calendrier réel n'a été testé. La nouvelle route du Worker est modifiée localement ; elle doit être déployée avec la page pour rendre les dates disponibles en production.

## Suivi — personnalisation du bandeau et des marchés favoris (12 octobre 2026)

- Le libellé « Mes actifs » du bandeau est maintenant un bouton : il permet de choisir les positions du portefeuille, les indices/marchés favoris de droite ou un groupe existant de la watchlist. Le choix est conservé localement. Les cotations des groupes et des indices gardent leur unité native et leur état de séance ; une cotation indisponible reste affichée comme telle.
- L'ajout aux marchés favoris propose aussi les actifs des groupes de watchlist. Chaque carte possède des boutons Monter/Descendre pour fixer sa position ; l'ordre enregistré est réappliqué après chaque actualisation. Un actif comme ASML peut ainsi occuper la première place. Les futures gardent leur étiquette de contrat, mais leur bordure et leur fond suivent les mêmes règles de variation et d'état que les autres cartes.
- La carte « Variation du jour » n'affiche plus « Voir le détail ». Elle reste entièrement ouvrable comme les quatre autres cartes secondaires.

Validation : tests ciblés du sélecteur, de l'ajout depuis la watchlist, de l'ordre sauvegardé et des futures ; contrôle navigateur à 360, 390, 768, 1 366 et 1 920 px sans débordement. Suite complète : 729 tests réussis sur 730 ; seul le décalage préexistant `version.json` 1.17.1 / `RELEASES.md` 1.17.0 échoue. Le portefeuille connecté n'était pas accessible depuis cet environnement.

Périmètre de l'audit initial : capture fournie et lecture du code local du dashboard, de son adaptateur de cotations, de ses styles et de composants partagés. Audit de présentation, d'usage et de contrats de données ; aucun parcours authentifié exécuté, aucun cours actuel vérifié, aucun audit exhaustif des calculs de portefeuille. Les références de lignes décrivent le code avant les changements décrits dans le suivi ci-dessous.

## Suivi — rapprochement et calendrier de marché (12 octobre 2026)

- Le dashboard contrôle désormais chaque snapshot reçu : variation du jour contre la somme des positions, valeur totale contre positions + cash, gain total contre la somme des gains, et variation contre le résumé du moteur. Le résultat figure dans la fenêtre « Contributions du jour » ; une composante manquante reste signalée. La vérification se fait sur les données du compte à l'exécution, sans les exporter ni modifier les montants. Les tests du moteur réel couvrent notamment actions EUR/USD, achat du jour et cash. **Aucune session connectée n'était accessible depuis cet environnement** : le résultat sur le portefeuille personnel reste à constater dans l'application.
- Les fermetures publiées et demi-séances sont appliquées avant les horaires Yahoo. Les demi-séances US ont une heure officielle et corrigent une fenêtre Yahoo trop longue. Euronext confirme les demi-séances de fin 2026 sans encore publier leur heure exacte : une séance Yahoo à horaires normaux reste donc **non confirmée** ; une clôture anticipée explicite du fournisseur est acceptée. Couverture : actions/indices US 2026–2028 ([NYSE](https://www.nyse.com/trade/hours-calendars), [Nasdaq](https://www.nasdaq.com/market-activity/stock-market-holiday-schedule) pour 2026), Euronext Paris/Amsterdam/Bruxelles/Milan 2026 ([Euronext](https://www.euronext.com/en/trading/trading-hours-holidays)), Xetra 2026–2027 ([Deutsche Börse](https://www.cashmarket.deutsche-boerse.com/cash-en/trading/trading-calendar-and-trading-hours)). Une place/année non couverte reste non confirmée sans preuve du fournisseur ; les arrêts imprévus ne sont pas prévisibles avec un calendrier statique.
- Préférences confirmées : aucun rattrapage des anciens ATH ; les futurs pics observés suffisent. La répartition par devise appartient à Analytics, pas au dashboard.

Validation : 726 tests réussis sur 727 ; seul `versionTracking.test.js` échoue sur le décalage déjà présent `version.json` 1.17.1 / `RELEASES.md` 1.17.0. Contrôle Chrome isolé à 360, 390, 768, 1 366 et 1 920 px sans débordement.

## Suivi — carte Variation du jour compacte (12 octobre 2026)

Le grand tableau des contributions est déplacé dans une fenêtre ouverte depuis la première des **cinq cartes KPI secondaires**. La carte affiche les deux impacts positifs les plus élevés et les deux impacts négatifs les plus forts, en euros. Le tableau complet conserve ses poids, variations, impacts et messages de rapprochement ou de données partielles. Sur bureau (1 366 et 1 920 px), les cinq cartes tiennent sur une ligne ; sur mobile, elles s'empilent.

Validation : tests ciblés (27 réussis), contrôle Chrome isolé à 360, 390, 768, 1 366 et 1 920 px avec ouverture du tableau à chaque taille, sans débordement. Suite complète : 717 tests réussis sur 718 ; l'unique échec est le décalage préexistant entre `version.json` (1.17.1) et `RELEASES.md` (1.17.0).

## Suivi — premier lot livré localement

La demande « go pour le premier lot » suit la proposition de regrouper fiabilité, bandeau et réorganisation du haut de page. Ce lot est implémenté localement ; aucun déploiement effectué.

- Bandeau animé des **marchés favoris**, alimenté par le même cycle que les cartes : cours natif, variation, état de séance et heure du cours. Pause persistante, survol, accès clavier, défilement manuel sur mobile et mouvement réduit. Les mises à jour conservent les nœuds du bandeau et le focus. Une liste trop courte pour défiler reste statique.
- Réglages du bandeau reliés au catalogue des favoris ; fermeture par Échap, focus confiné puis restauré. Sélection d'un marché dans le graphique et bouton de retour au portefeuille. Les trois KPI principaux continuent à représenter le portefeuille pendant l'exploration d'un marché.
- Graphique remonté avant les quatre cartes secondaires, indices compactés, détails de période/records repliés, en-tête et horodatage du portefeuille, principaux libellés et formats français. Zoom tactile rétabli et disposition mobile simplifiée. Les actualités vides n'occupent plus un panneau de 500 px.
- Nasdaq 100 corrigé en `^NDX` dans le catalogue, le benchmark, les valeurs par défaut et le mapping futures. Migration ciblée des anciens favoris `^IXIC` intitulés Nasdaq 100 ; un Composite explicitement nommé conserve `^IXIC`. Les règles de notifications existantes ne sont pas réaffectées à un autre instrument.
- Contrat de cotation natif partagé dans `dashboardMarketData.js` : points pour les indices, devises conservées, paire/unité explicite, horodatage fournisseur distinct de la récupération. Le chart quotidien fournit la référence de séance ; `chartPreviousClose`, qui peut désigner le début d'une plage, n'est plus pris pour la clôture précédente. Une référence absente produit `—`.
- Référence crypto quotidienne à la frontière UTC, uniquement si la bougie de la veille et une cotation du jour sont disponibles. Les métadonnées de séance alimentent le calendrier partagé ; les horaires indicatifs servent seulement à choisir un éventuel future. Aucun badge « LIVE » déduit de l'heure locale. Un contrat à terme porte son identité propre.
- Déduplication des demandes de cotation et propagation de l'état périmé du transport existant. Un échec ne renouvelle jamais artificiellement la date du cours. Retrait des anciens chargements de sparklines par carte ; l'historique détaillé reste disponible dans le graphique sélectionné.
- Actualités : distinction chargement/absence/erreur/erreur partielle, conservation des derniers articles par source et par sélection, bouton Réessayer et rejet des réponses tardives d'une ancienne sélection.
- Correction annexe observée pendant l'intégration : les identifiants des listes KPI secondaires étaient supprimés après leur premier rendu, empêchant leurs actualisations suivantes. Ils sont désormais conservés.

Validation : **29 tests ciblés réussis dans 7 fichiers**, dont 16 nouveaux tests. Dernière suite complète : **704 réussis / 705**, 90 fichiers réussis sur 91. L'unique échec, `versionTracking.test.js`, provient de l'écart préexistant entre `version.json` déjà modifié/stagé en `1.17.1` avant ce travail et `RELEASES.md` se terminant en `1.17.0`. Ces deux fichiers n'ont pas été modifiés par ce lot.

Contrôle Chrome avec HTML, CSS et composants réels sur données de démonstration : **360, 390, 768, 1 366 et 1 920 px**, sans débordement de page ou de valeur principale ; détails ouverts également vérifiés à chaque taille. Pause, mouvement réduit, sélection/retour portefeuille, ouverture/fermeture des réglages et restitution du focus vérifiés. Aucune erreur JavaScript dans ce parcours isolé. Ce contrôle ne remplace pas une session connectée réelle ni un audit complet d'accessibilité.

Artefacts : [aperçu bureau](dashboard-preview-1366.png), [aperçu mobile](dashboard-preview-390.png), [résultats navigateur](dashboard-preview-results.json), [script reproductible](dashboard-preview.mjs). Le script nécessite Chrome et Playwright ; son second argument permet de désigner une installation existante de Playwright sans ajouter de dépendance à l'application.

Les contributions quotidiennes, le calendrier, les listes de bandeau Mes actifs/Watchlist et la personnalisation avancée restent des évolutions suivantes de la proposition. Les sections ci-dessous conservent l'audit initial et sa feuille de route.

> **Attention :** le lot 2 ci-dessous remplace plusieurs points du premier lot : bandeau des marchés favoris, réglages du bandeau, détails repliés, en-tête « Mon portefeuille », retrait des sparklines et sous-titres des KPI. En cas de contradiction, c'est le lot 2 qui fait foi.

## Suivi — lot 2 : retours utilisateur sur le premier lot (11–12 octobre 2026)

Après test du premier lot (commit `d65c771 audit codex dashboard`), l'utilisateur a refusé plusieurs changements visuels. Ce lot rétablit les fonctionnalités perdues et applique ses demandes. Il conserve les corrections de données du premier lot : `^NDX`, contrat de cotation natif, absence de faux « LIVE », états des actualités et listes KPI rafraîchies. Implémenté localement ; aucun commit ni déploiement.

### Préférences exprimées par l'utilisateur (à respecter pour la suite)

- Rien au-dessus du bandeau de cotations : pas d'en-tête de page ni d'horodatage global.
- Le bandeau montre **les positions du portefeuille**, pas les marchés favoris.
- Les marchés favoris de droite gardent leurs **sparklines du jour** et un **code couleur**. Le panneau a **la même hauteur que la colonne de gauche** et défile à l'intérieur : aucune zone vide au-dessus des actualités.
- **Aucune information du graphique cachée** derrière un volet repliable.
- **Aucun sous-titre** sur les KPI (ni sur les 3 principaux, ni sur les 4 cartes secondaires).
- Montants des KPI principaux grands par rapport à leur carte.
- **ATH = plus haut niveau jamais atteint, pics de séance compris, identique dans toutes les vues.** Jamais une simple valeur de clôture si un pic plus haut a été observé.

### Changements livrés

**Haut de page — `dashboard.html`, `css/dashboard-premium.css`**
- Suppression de `.dashboard-page-header` (« Vue d'ensemble / Mon portefeuille ») et de `#dashboard-freshness`, ainsi que du code JS associé dans `renderSnapshot`.

**Bandeau « Mes actifs » — `src/marketTicker.js`, branché dans `DashboardApp.renderSnapshot`**
- Alimenté par chaque snapshot du portefeuille (`holdings`), sans timer réseau propre. La fonction pure `selectPortfolioMovers(holdings, { now, calendar })` :
  - exclut l'immobilier, le cash `CASH-*`, les prix indisponibles et les quantités nulles ;
  - trie par variation décroissante ;
  - au-delà de 12 positions, garde les 6 meilleures et les 6 pires.
- La variation affichée est `displayDayPct` / `displayDayChange` (repli : `dayPct` / `dayChange`). Le moteur y place la dernière séance quand le marché est fermé : le week-end, on voit donc la séance du vendredi, et les cryptos leur variation depuis 00:00 UTC.
- L'état vient de `marketCalendarEngine` (`getTradingModel`, `isMarketOpen`, `getSession`, `isTradingDay`) :
  - `continuous` pour les cryptos : point bleu, « Marché 24/7 » ;
  - `open` : point vert, « Séance ouverte » ;
  - `closed` : point orange, fond teinté, « Fermé · séance du ven. 09/10 ».
  - Une légende Ouvert / 24/7 / Fermé est affichée dans le bandeau. Les jours fériés ne sont pas connus.
- Chaque élément affiche nom, cours en €, variation en % et impact en €.
- Un clic appelle `DashboardApp.selectTickerAsset` → `chart.showAssetChart(ticker)`, avec le bouton `#dashboard-back-portfolio` ; un second clic revient au portefeuille.
- Pause persistante, mouvement réduit et défilement manuel sur mobile sont conservés. Le bouton de réglages `#ticker-settings` est supprimé.

**Marchés favoris (colonne droite) — `DashboardApp.loadMarketIndices` / `renderMarketSparklines`**
- Les sparklines du jour reviennent en fond de carte, via `chartKPIManager.fetchIndexData(ticker, '1D', allowFallback)` et `generateSparkline` :
  - cache de 5 minutes par instrument (`SPARKLINE_TTL_MS`), pour que le cycle de 30 s ne les recharge pas ;
  - repli sur la dernière séance autorisé hors séance ouverte, et aussi en séance quand le cours est « Cours ancien ».
- Code couleur de la carte :
  - classe de tendance `stat-positive` / `stat-negative` / `stat-neutral`, pour le bord et la lueur ;
  - classe d'état `is-open` (vert), `is-continuous` (bleu), `is-closed` (rouge), `is-stale` (orange), `is-unknown` (gris), pour la pastille de séance (`marketCardStateClass`).
- Disposition de la carte : titre, badge future, prix, variation, puis heure et pastille sur la même ligne.
- Hauteur alignée sur la colonne gauche : on revient au mécanisme d'origine de `css/dashboard.css` (`height: 0; min-height: 100%` sur `.dashboard-indices-panel-full`, liste en `overflow-y: auto`). La surcharge `height: auto; overflow: visible` du premier lot l'annulait.

**Or et contrats à terme le week-end — `src/dashboardMarketData.js`, fonction `quoteSession`**
- Constat sur la réponse réelle de Yahoo pour `GC=F` un dimanche : `currentTradingPeriod.regular` couvre tout le dimanche (00:00 → 23:59, heure de New York). Le marché passait donc pour ouvert, d'où « Cours ancien » et une sparkline vide.
- Correction : `inWeeklyFuturesBreak` considère `=F` et `=X` comme fermés du vendredi 17:00 au dimanche 18:00 (heure de New York), avant de croire la séance fournisseur.

**Graphique — `dashboard.html`**
- Suppression du `<details class="dashboard-chart-details">` et des surcharges CSS correspondantes. La barre de stats retrouve la table unifiée d'une ligne de `css/chart-toolbar.css` : Période/Performance · Var. jour/Clôture hier (1J) · Début/Fin/Haut/Bas · bloc ATH.

**KPI**
- Suppression de `.summary-card-context` (2 occurrences) et `.kpi-horizon` (4 occurrences).
- Cartes principales plus compactes ; montant dimensionné sur la largeur de la carte (`container-type: inline-size`, `font-size: clamp(22px, 13cqi, 44px)`), pour rester sur une ligne de 360 à 1920 px. Pourcentage et « Investi » à 17 px.

**ATH avec pics de séance, identique dans toutes les vues — `src/dataManager.js`, `src/historicalChart.js`**
- Constat : en 1S, la ligne ATH (+0,74 %, 37 910,02 €) passait sous le pic visible (HAUT 38 008,70 €, mardi 6 oct. vers 09:30). L'historique « tout » n'a qu'une clôture par jour. Le registre des pics de séance (`athIntraday`) ne recevait que les 2 derniers jours en points de 5 min, et seulement via les vues 1J/2J ou à la reconstruction de l'historique ATH.
- Correction :
  - chaque reconstruction de l'historique ATH verse les **7 derniers jours en points de 15 min** dans le registre (`ATH_INTRADAY_DAYS = 7`, pour le portefeuille comme pour un actif seul) ;
  - la vue **1S** alimente aussi le registre et trace la ligne dans son repère, comme 1J et 2J (`ATH_INTRADAY_RESOLUTION_MS` : 1J/2J = 5 min, 1S = 15 min) ;
  - toutes les vues lisent le même registre : `computeAthReference` retient `max(clôtures, registre)`.
- `mergeAthIntradayHistory(…, { resolutionMs })` marque chaque barre avec sa finesse :
  - une fenêtre plus grossière n'efface jamais une barre plus fine (un pic 5 min de la 1J survit à une fenêtre 15 min) ;
  - la jointure d'ancrage (`athWindowBases`) ne compare que des barres de même finesse ;
  - sans finesse connue (`null`), on garde les règles de révision d'origine, ce qui continue de corriger les barres provisoires.
- `ATH_INTRADAY_VERSION = 4` : les caches en version 3 sont reconstruits au prochain chargement.
- Limite : les pics de séance des périodes jamais observées en intraday restent inconnus. Pour celles-ci, le record reste la meilleure clôture. À partir de maintenant, aucun pic n'est perdu si l'app est ouverte au moins une fois par semaine avec l'ATH activé en vue %.

### Validation du lot 2

- Suite complète : **709 réussis / 710**. L'unique échec reste `versionTracking.test.js` (écart préexistant entre `version.json` 1.17.1 et `RELEASES.md` 1.17.0).
- Tests modifiés ou ajoutés :
  - `tests/dashboardPremium.test.js` : bandeau sur les positions, sélection week-end (crypto 24/7, vendredi fermé), limitation à 6+6, état neutre des cartes, or fermé le week-end malgré la séance Yahoo du dimanche ;
  - `tests/athReference.test.js` : pic 1S devenu ATH identique en vue 1S et en vue Tout ; une fenêtre 15 min n'efface pas un pic 5 min.
- `audit/dashboard-preview.mjs` adapté (bandeau sur les positions, sparklines factices, plus de volet ni de réglages du bandeau) :
  - il vérifie aussi que Début/Fin/Haut/Bas sont visibles à toutes les tailles et que le panneau de droite a la même hauteur que la colonne de gauche au-dessus de 1200 px ;
  - lancé avec succès de 360 à 1920 px, captures régénérées.
- Pas de parcours connecté réel. À confirmer sur les vraies données :
  - le passage bandeau → graphique d'un actif ;
  - la ligne ATH 1S posée sur le pic du 6 oct. après reconstruction du cache.

### Pistes suivantes

1. Rattrapage ponctuel des pics de séance sur environ 60 jours (limite Yahoo en 15 min), pour compléter le registre ATH au-delà de la dernière semaine. Coût réseau au premier chargement à mesurer. La vue 1M (90 min) n'alimente pas le registre, à cause du décalage de chaînage TWR documenté dans `athReference.test.js`.
2. Jours fériés absents du calendrier : le bandeau peut marquer « ouvert » un marché fermé.
3. Reprendre la feuille de route de l'audit initial (contributions quotidiennes, alertes, calendrier, allocation par devise), en respectant les préférences ci-dessus.

## Diagnostic

La base est riche : valorisation, variation quotidienne, historique avec comparaison, dividendes, plus hauts historiques, allocation, marchés personnalisables et actualités. L'impression de qualité est surtout freinée par une hiérarchie trop uniforme, des horizons de performance implicites et des informations de marché insuffisamment qualifiées.

Le dashboard devrait répondre, dans cet ordre, à quatre questions : combien vaut mon portefeuille ; qu'est-ce qui a changé ; quels actifs expliquent ce changement ; quels événements méritent mon attention ?

Le bandeau de cotations façon Times Square est pertinent. Il doit servir de contexte de marché, rester compact et laisser le portefeuille au premier plan.

## Constats et priorités

P0 = confiance dans les données ; P1 = première refonte ; P2 = enrichissement après stabilisation. L'effort indiqué est relatif, sans engagement de délai.

| Priorité | Constat et preuve | Amélioration proposée | Effort |
|---|---|---|---|
| P0 | `^IXIC` porte le nom « Nasdaq 100 » dans le sélecteur de comparaison (`dashboard.html:198`) et le catalogue (`src/dashboardApp.js:1518`). Le mapping futures l'associe à `NQ=F` (`src/indexFutures.js:7`). | Choisir explicitement Nasdaq Composite ou Nasdaq 100. Pour ce dernier, utiliser `^NDX` et adapter ensemble catalogue, benchmark, horaires, mapping futures et préférences sauvegardées. Un simple changement de texte serait insuffisant. | Moyen |
| P0 | `getSmartVariation` attribue « LIVE » pendant l'ouverture si l'heure du cours n'est pas connue ou si elle a moins de 30 minutes (`src/dashboardApp.js:486`). | Séparer état de séance et fraîcheur de cotation. « Marché ouvert » ne prouve pas le temps réel. Afficher l'heure du cours ; réserver « Temps réel » à un flux dont cette propriété est établie. | Moyen |
| P0 | Le statut des cartes utilise les heures locales du navigateur, des plages fixes et une plage commune aux indices asiatiques (`src/dashboardApp.js:393`). | Unifier avec `MarketCalendarEngine`, ses métadonnées fournisseur et ses niveaux de confiance. Conserver un état inconnu lorsque nécessaire ; ce moteur ne garantit pas à lui seul un calendrier complet de jours fériés. | Moyen à élevé |
| P0 | L'adaptateur conserve les indices en points, les futures en devise native et le forex en taux, mais retourne toujours `currency: 'EUR'` (`src/api.js:375–408`). Les matières premières sont affichées sans unité (`src/dashboardApp.js:1338`). | Préserver devise native, unité et éventuelle conversion dans des champs distincts. Afficher « pts », la paire de change, ou devise/unité du contrat. Ne pas brancher le bandeau directement sur ce contrat ambigu. | Moyen |
| P0 | `fetchGoogleRSS` transforme toute erreur en tableau vide, puis `renderNewsList` affiche « Aucune news » (`src/dashboardApp.js:889–900`). | Distinguer aucune actualité, erreur fournisseur, chargement et résultat partiel. Conserver les derniers articles avec leur date et proposer Réessayer. La capture seule ne permet pas de déterminer pourquoi les deux blocs sont vides. | Faible à moyen |
| P1 | « Top Loser » contient un gain positif dans la capture. Le code sélectionne les trois plus faibles performances, sans filtre de signe (`src/dataManager.js:1312–1337`). | Soit renommer « Moins bonnes performances — depuis l'achat », soit ne montrer que les pertes. Pour le dashboard, privilégier les contributions en euros à la variation du jour. | Faible pour le libellé, moyen pour les contributions |
| P1 | Les cartes Top utilisent des performances cumulées alors que la variation principale et le graphique sont sur la journée. | Afficher l'horizon dans chaque bloc ; proposer Jour / Période / Depuis l'achat. Ne pas faire varier silencieusement la portée des KPI lors d'un changement de graphique. | Moyen |
| P1 | Le panneau d'indices consomme une colonne entière avec un défilement interne ; les statistiques du graphique répètent plusieurs informations visibles au-dessus. | Bandeau compact, graphique remonté, panneau secondaire réduit à quelques marchés favoris ou à une liste de surveillance. Placer début/fin/haut/bas/ATH dans un volet Détails. | Moyen |
| P1 | Mélange français/anglais, formats `€10,594` et `37 398,06 €`, textes secondaires discrets, noms tronqués. | Français homogène, nombres localisés, chiffres à largeur fixe, devise cohérente, nom court + symbole, détails accessibles au clic/clavier. Mesurer le contraste dans le navigateur avant de conclure à une conformité. | Faible à moyen |
| P1 | La page interdit le zoom tactile (`dashboard.html:6–7`) ; certains textes mobiles descendent à 9–10 px (`css/dashboard-mobile.css`). | Rétablir le zoom, simplifier le contenu sur petit écran, agrandir les textes, vérifier navigation clavier et restitution des graphiques. | Moyen |

La distinction Nasdaq est vérifiée auprès du fournisseur : [NASDAQ Composite, ^IXIC](https://finance.yahoo.com/quote/%5EIXIC/history/) et [NASDAQ-100, ^NDX](https://finance.yahoo.com/quote/%5ENDX/).

### Points à investiguer sans conclure prématurément

- Dans la capture, valeur totale moins « Invested » donne 8 711,30 €, contre 8 332,01 € pour « Total Return ». Ce n'est pas une preuve de calcul erroné : liquidités, flux, gains réalisés ou périmètres peuvent intervenir. Ajouter une décomposition explicite permettant de rapprocher les montants.
- L'horodatage `#last-update` est masqué dans le HTML ; le code du graphique remplit son contenu sans retirer ce style dans la méthode examinée. Un badge de cache existe déjà pour les données dégradées. Vérifier le rendu réel et rendre la date des cotations visible en fonctionnement normal, distincte de la date de recalcul.
- L'absence d'articles peut aussi résulter du filtrage par nom complet dans les titres. Tester noms commerciaux, tickers et alias avant de remplacer les sources.
- La lisibilité et le responsive sont évalués ici sur capture/code ; ils restent à contrôler à 360, 390, 768, 1 366 et 1 920 px, ainsi qu'à 200 % de zoom.

## Bandeau de cotations : proposition concrète

### Position et apparence

Une bande de 40 à 48 px sous l'en-tête, au-dessus des KPI, sur la largeur du contenu hors navigation. Fond légèrement distinct, séparateurs fins, typographie sobre, chiffres stables. Réserver vert/rouge aux variations, sans clignotement permanent. Le défilement lent continu apporte l'effet Times Square ; les cours restent lisibles.

Exemple fictif de présentation, sans valeur de cotation actuelle :

```text
MARCHÉS   CAC 40  8 000,00 pts  ▲ +0,42 %  ·  S&P 500  6 000,00 pts  ▼ −0,18 %  ·  BTC/EUR  75 000 €  ▲ +1,10 %    ⏸  ⚙
```

### Comportement

- Trois listes sélectionnables : Marchés, Mes actifs, Ma watchlist. Par défaut, 8 à 12 instruments utiles, ordonnables et masquables.
- Chaque élément affiche nom court/symbole, cours, unité et variation signée. Un détail accessible indique source, heure du cours, séance et référence de variation.
- Clic sur un instrument : ouvrir son détail ou sélectionner sa courbe. Garder un retour évident au portefeuille global si la courbe principale change de contexte.
- Pause au survol et au focus, bouton Pause/Reprendre persistant, possibilité de masquer le bandeau. Respect de `prefers-reduced-motion` avec liste statique défilable manuellement.
- Sur mobile : défilement manuel par défaut, quelques cotations visibles, aucun déplacement horizontal de toute la page.
- Une mise à jour de prix ne réinitialise pas la position du défilement et ne déplace pas le focus clavier.

Un mouvement automatique durable doit pouvoir être mis en pause, arrêté ou masqué : [W3C, critère Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide). La seule pause au survol ne constitue pas ici une commande persistante suffisante.

### Règles indispensables pour les données

- **Actions et indices :** variation par rapport à la clôture de séance précédente ; hors séance, afficher « Dernière séance · date ». Ne pas présenter une clôture du vendredi comme un mouvement du dimanche.
- **Crypto :** choisir explicitement « depuis 00:00 UTC » ou « sur 24 h glissantes » et calculer la référence correspondante. Un champ `previousClose` ne prouve pas à lui seul l'un ou l'autre.
- **Forex et contrats à terme :** conserver le calendrier et la référence propres à l'instrument, ainsi que son unité. Un future doit être nommé comme tel.
- **Absence de cours :** `—` et « Indisponible ». Une valeur manquante ne devient jamais 0 ni 0 %.
- **Cours ancien :** garder la dernière valeur avec heure/date et mention explicite. Une clôture valide pendant une fermeture normale se distingue d'un échec d'actualisation en séance.
- **Devises :** cotation native par défaut ; une conversion EUR éventuelle précise la date du change. La performance du cours natif et la performance en EUR peuvent différer.

### Intégration technique proposée

Créer un composant dédié au bandeau, alimenté par un service partagé de cotations. Le bandeau et les cartes de marché consomment le même résultat normalisé ; éviter un second intervalle réseau par instrument. Le portefeuille conserve son snapshot canonique existant.

Le contrat doit distinguer au minimum : `symbol`, `instrumentType`, `price`, `currency`, `unit`, `quoteAsOf`, `fetchedAt`, `sessionState`, `referencePrice`, `referenceAsOf`, `changeBasis`, `source`, `freshness` et le délai connu du fournisseur. L'heure de réception n'est pas celle de la cotation.

Le dashboard a déjà un cycle de 30 secondes et ignore les rafraîchissements lorsque l'onglet est masqué (`src/dashboardApp.js:162`, `1915`). Réutiliser cette orchestration et dédupliquer les requêtes ; adapter la fréquence aux instruments et à la disponibilité effective du fournisseur. Interroger toutes les 30 secondes ne rend pas un flux différé « temps réel ».

L'animation doit utiliser une translation CSS ; ses éventuelles copies visuelles restent hors du parcours clavier et des annonces de lecteur d'écran. Fournir une liste statique accessible. Réserver des largeurs stables pour limiter les mouvements lors des variations de prix.

## Organisation recommandée

```text
En-tête : Mon portefeuille | compte/périmètre | date des données | masquer les montants
Bandeau : Marchés / Mes actifs / Watchlist                         pause · réglages

Valeur totale               Variation du jour             Gain depuis l'origine
Liquidités incluses         € et % + référence             € et % + méthode

Graphique principal, environ 2/3 de la largeur              À surveiller
Valeur / Performance · périodes · benchmark                Alertes déclenchées
Détails avancés repliables                                 Échéances à venir

Contributions à la variation du jour                       Allocation actuelle
Actif · variation · impact en € · poids                    Classes / devises

Actualités liées aux positions                             Calendrier
Source · date · actifs concernés                           Résultats / dividendes
```

Sur petit écran : valeur totale, variation, graphique, contributions, puis événements. Les outils avancés restent accessibles par panneaux dédiés. Garder la navigation détaillée pour les pages Assets, Analytics et Screener.

## Fonctionnalités qui apporteraient le plus de valeur

1. **Contributions quotidiennes.** Montrer quels actifs expliquent le gain ou la perte en euros, avec leur poids. Distinguer la performance de l'actif de son effet sur le portefeuille. Prévoir le change et les autres composantes nécessaires pour rapprocher la somme du KPI ; ne pas afficher une décomposition incomplète comme exacte.
2. **Performance expliquée.** Les bases TWR et dividendes existent déjà dans le graphique. Rendre la méthode visible, comparer à un benchmark sur les mêmes dates/devise et préciser le traitement des dividendes. Ajouter éventuellement un rendement personnel pondéré par les flux après validation de la couverture des transactions.
3. **Allocation utile.** Ajouter la répartition par devise et des seuils de concentration configurables. Les expositions sectorielles et géographiques à travers les ETF exigent leurs compositions ; afficher la couverture connue avant d'annoncer une exposition globale.
4. **Calendrier lié aux positions.** Prochains résultats, détachements et paiements de dividendes, avec distinction entre annoncé et estimé. Dépend de données événementielles datées et fiables.
5. **Alertes contextualisées.** Réutiliser le gestionnaire de notifications existant. Montrer les alertes déclenchées et permettre d'en créer depuis une cotation, sans multiplier les badges sans action.
6. **Personnalisation légère.** Choix des blocs visibles, compte/courtier, période par défaut, instruments favoris et masquage des montants. Commencer par ces réglages avant un système complet de déplacement de widgets.
7. **Actualités pertinentes.** Montrer les articles associés aux positions et leur source/date. Un résumé IA reste relié aux sources ; il ne doit pas affirmer qu'un article explique un mouvement de cours sans preuve.

## Plan de livraison proposé

| Lot | Contenu | Critère de réussite |
|---|---|---|
| 1 — Fiabilité | Identité Nasdaq, unités/devises, états de cotation, horizons des performances, distinction erreur/absence de news. | Chaque chiffre peut être interprété : instrument, unité, horizon, référence et date. |
| 2 — Refonte visible | Bandeau de cotations, français homogène, graphique remonté, indices compactés, statistiques avancées repliées. | Le portefeuille se comprend sans parcourir toute la page ; le bandeau reste lisible, contrôlable et utilisable au clavier/mobile. |
| 3 — Suivi quotidien | Contributions, alertes contextualisées, allocation par devise, actualités mieux ciblées. | L'utilisateur comprend ce qui a changé et peut explorer l'actif concerné. |
| 4 — Personnalisation | Préférences de widgets/périmètre, calendrier alimenté par des sources adaptées, analyses complémentaires. | Les informations restent cohérentes lors d'un changement de compte, de période ou d'appareil. |

### Validation à prévoir lors de l'implémentation

- Vérifier séance ouverte, fermeture, week-end, changement d'heure et calendrier inconnu, ainsi que portefeuille mêlant titres et crypto.
- Vérifier qu'une erreur de prix ne produit ni 0 %, ni faux statut temps réel, ni disparition de la dernière valeur connue.
- Vérifier Nasdaq cash/future et préférences existantes après correction de symbole.
- Rapprocher KPI, contributions et graphique avec transactions et change ; rendre visibles les composantes non disponibles.
- Mesurer les requêtes avant/après : le bandeau ne doit pas dupliquer les appels des cartes pour les mêmes données.
- Vérifier pause persistante, mouvement réduit, clic/clavier, absence de perte de focus et absence de saut à l'actualisation.
- Vérifier actualités vides, erreur totale, erreur partielle et reprise ; conserver les contenus utiles.

Ces contrôles sont un plan de validation futur, pas des tests exécutés pendant cet audit. Les suites existantes couvrent notamment snapshots, allocation et affichage des futures ; elles sont à compléter selon les changements retenus.
