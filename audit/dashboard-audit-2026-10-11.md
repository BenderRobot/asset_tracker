# Audit du dashboard — évolution vers un suivi boursier premium

Date : 11 octobre 2026.

Périmètre de l'audit initial : capture fournie et lecture du code local du dashboard, de son adaptateur de cotations, de ses styles et de composants partagés. Audit de présentation, d'usage et de contrats de données ; aucun parcours authentifié exécuté, aucun cours actuel vérifié, aucun audit exhaustif des calculs de portefeuille. Les références de lignes décrivent le code avant les changements décrits dans le suivi ci-dessous.

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
