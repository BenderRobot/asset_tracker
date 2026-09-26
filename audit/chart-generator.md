# Audit du générateur de graphique — 26 septembre 2026

Le symptôme « 1D fonctionne, 1W et toutes les périodes longues sont vides » est **reproduit sur le moteur du commit `12aa7cc`**, avec un portefeuille synthétique contenant un actif coté et un actif sans historique. Le correctif déjà présent dans le répertoire de travail rétablit les séries dans ce scénario. Il reste plusieurs défauts de sélection des données, de validation et de calcul.

Cet audit n'a modifié aucun fichier applicatif existant et n'a exécuté aucun déploiement. Les seuls ajouts sont ce rapport et ses outils de reproduction dans `audit/`.

## Périmètre et niveau de preuve

Parcours examinés : Dashboard et Investissements, sélection des périodes, modes portefeuille/actif/indice, benchmark, API et Worker prix, cache historique, registre des transactions, valorisation, performance, dividendes, change, transmission aux KPI et état du canvas.

Sources : code du répertoire de travail, comparaison avec `HEAD`, capture d'écran, logs fournis et tests locaux. Les logs portent `HistoryCalculator.js?v=13` et `dashboardApp.js?v=84` ; le code local référence respectivement `v=14` et `v=85`. Les corrections locales ne doivent donc pas être présumées actives dans la session photographiée. Le contenu effectivement servi aujourd'hui en production n'a pas été vérifié.

Pas de connexion au compte utilisateur ni de lecture de ses 358 transactions. L'identité exacte de l'instrument qui rend la valorisation incomplète dans ce portefeuille reste à confirmer. Les reproductions utilisent des données synthétiques et aucun appel réseau réel.

## Cause du graphique vide

Le parcours est :

`bouton période → HistoricalChart.update → DataManager → HistoryCalculator → validation du résultat → rendu Chart.js`.

En 1D, `HistoricalChart.update` utilise le snapshot du jour. Pour 1W et au-delà, il demande une nouvelle reconstruction historique (`src/historicalChart.js:812`).

Dans le moteur engagé dans Git :

1. En 1D, un titre sans bougies peut recevoir un prix depuis la cotation stockée ou la clôture précédente.
2. À partir de 1W, `_seedLastKnownPrices` refuse les prix actuels pour valoriser le passé — précaution justifiée.
3. Un actif détenu sans autre source de prix rend chaque valorisation du portefeuille incomplète.
4. Le moteur émet alors `values = null` et `twr = null` pour ces points. Il conserve pourtant `dataQuality.valid = true` si l'API a simplement répondu avec un historique vide, sans erreur réseau.
5. Le composant refuse la série et affiche « Pas de données disponibles pour cette période ».

Cela explique comment des requêtes Yahoo réussies et des logs `closeBefore` peuvent coexister avec un graphique vide. Ces logs décrivent la résolution des clôtures, pas la validité finale de tous les points.

### Reproduction comparée

Script : `node audit/compare-head.mjs`.

Portefeuille fictif : AAPL avec historique et PRIVATE sans historique ; date figée au 26 septembre 2026. PRIVATE a un prix de transaction de 100 et une cotation stockée de 125. Le script charge directement le moteur de `HEAD`, puis celui du répertoire de travail.

| Période | Points valorisés, moteur HEAD | Points valorisés, moteur local |
| --- | ---: | ---: |
| 1D | 2/2 | 2/2 |
| 1W | 0/625 | 625/625 |
| 1M | 0/11 | 11/11 |
| 3M | 0/11 | 11/11 |
| 6M | 0/11 | 11/11 |
| YTD | 0/11 | 11/11 |
| 1Y | 0/11 | 11/11 |
| 2Y | 0/11 | 11/11 |
| All | 0/11 | 11/11 |

La faible densité des longues périodes est volontaire dans cette fixture : elle vérifie le blocage, pas la disponibilité réelle de Yahoo sur plusieurs années.

Le correctif local (`src/HistoryCalculator.js:997–1024`, `1083–1087`) utilise le dernier prix de transaction connu. Il traite ce scénario d'absence simple de bougies. Il ne traite ni tous les échecs API ni tous les rejets du composant. La valorisation finale synthétique est 234 en 1D contre 209 en 1W, notamment parce que PRIVATE est valorisé à 125 dans le premier cas et à 100 dans le second.

Dans les logs réels, APC, EUEA et MSF sont explicitement ignorés avec `type: DIVIDEND`. C'est un signal concret de classification à vérifier. SPCX reçoit une requête, mais les logs ne suffisent pas à conclure qu'il est privé ou dépourvu de données. Les ratios `25/28 priced` ne prouvent pas à eux seuls trois positions détenues non valorisées : des positions soldées peuvent être dans le dénominateur.

## Défauts confirmés sur le code local

Les identifiants A1 à A10 correspondent aux reproductions dans `chart-generator.repro.test.js`. P1 : blocage ou résultat financier incorrect ; P2 : transparence, restitution ou cas secondaire.

### A1 — P1 : validation de toute la courbe conditionnée au dernier TWR

**Code :** `src/historicalChart.js:228–241`, `src/HistoryCalculator.js:1297–1302`.

La validation exige simultanément une dernière valeur finie et un dernier TWR fini, y compris pour la vue Valeur (€). Un seul point terminal manquant rejette également les points antérieurs exploitables. Ce durcissement fait partie des modifications locales déjà présentes.

Reproduction supplémentaire : un portefeuille entièrement vendu possède encore 100 € de cash et un historique réel. Après la vente, le TWR devient `null` lorsqu'il n'existe plus aucun titre. La valeur finale reste 100, `dataQuality.valid` reste vrai, mais le graphique entier est rejeté.

**Correction proposée :** séparer la capacité à tracer une série, sa complétude et son aptitude à entrer dans le cache. Permettre la valeur du cash même sans performance de titres définie. Conserver des trous explicites et dater la dernière valorisation valide ; ne pas transformer les valeurs manquantes en zéro.

### A2 — P1 : le type du titre dépend de la première transaction trouvée

**Code :** `src/storage.js:745–747`, `src/api.js:622–628`.

`getAssetType` prend le premier enregistrement du ticker, sans distinguer achat et dividende. Si cet enregistrement est un dividende, l'API retourne `{}` immédiatement pour le titre, sans requête historique, même si d'autres lignes sont de vrais achats d'actions.

Reproduction : une ligne Dividend APC suivie d'une ligne Stock APC produit `getAssetType('APC') === 'Dividend'` et zéro appel historique. Ce comportement est cohérent avec les exclusions APC/EUEA/MSF visibles dans les logs.

**Correction proposée :** résoudre la nature de l'instrument à partir de métadonnées stables ou des transactions de titres ; garder le type de mouvement séparé. Tester aussi l'ordre inverse des transactions et les portefeuilles multi-courtiers.

### A3 — P1 : un titre soldé hors période peut invalider tout le portefeuille

**Code :** `src/HistoryCalculator.js:133–150`, `205–222`, `439–481`.

La collecte demande les historiques de tous les tickers du registre et construit une validité globale à partir des échecs réseau. Elle ne limite pas cette invalidation aux actifs réellement détenus dans la période.

Reproduction : OLD vendu en 2025 renvoie un échec confirmé ; HELD est correctement valorisé pendant la semaine de septembre 2026. Toutes les valeurs du portefeuille deviennent néanmoins `null`. Le TWR peut rester fini, ce qui révèle aussi une incohérence de contrat entre les séries retournées.

**Correction proposée :** calculer les intervalles de détention requis avant les requêtes et évaluer la complétude par point. Un titre non détenu sur la période ne doit pas bloquer celle-ci. Un actif réellement détenu et indisponible doit rester signalé comme tel.

### A4 — P1 : les dividendes sont retirés du parcours historique

**Code :** `src/dataManager.js:1481–1486`, `src/historicalChart.js:812–815`.

`calculateHistory` supprime les mouvements Dividend avant de les transmettre au moteur, alors que celui-ci sait les distinguer des achats et les compter dans le cash et la performance avec dividendes. Le snapshot 1D utilise un autre parcours qui conserve ces mouvements.

Reproduction à prix constant : achat de 100 puis dividende de 10. L'appel direct au moteur donne 10 de cash et un indice avec dividendes de 1,10 ; le parcours utilisé par le graphique long donne 0 de cash et un indice de 1,00.

**Correction proposée :** conserver les dividendes dans le registre transmis. Leur traitement comme revenu, jamais comme quantité d'actions, doit rester centralisé dans le moteur. Tester via `calculateHistory`, pas seulement via `calculateGenericHistory`.

### A5 — P1 : les bougies journalières peuvent être placées dans le futur

**Code :** `src/HistoryCalculator.js:421`, `764–803`.

La grille déplace chaque bougie journalière à `23:59:59.999 UTC`. Hors 1D, la borne supérieure vaut `Infinity` ; une bougie du jour peut donc créer un point dont l'horodatage dépasse l'heure actuelle. La grille 1W dispose d'une borne spécifique, mais les vues journalières longues ne l'ont pas.

Reproduction à 10:00 UTC : une observation du même jour à 08:00 apparaît à 23:59:59.999. Cela peut aussi faire intégrer des transactions dont la date se situe entre l'observation et cette fin de journée fictive.

**Correction proposée :** distinguer la date de séance, l'instant de l'observation et le libellé d'affichage. Borner les valorisations à l'instant réellement calculable et traiter explicitement la bougie quotidienne encore ouverte.

### A6 — P1 : les historiques crypto peuvent utiliser une observation future

**Code :** `src/MarketUtils.js:402–423`, `src/HistoryCalculator.js:1161`.

Pour les cryptos, `findClosestPrice` autorise une bougie future plus proche que la précédente : jusqu'à trois heures en 15m et deux jours en 1d. La recherche peut donc modifier le passé avec un prix qui n'existait pas encore à cet instant.

Reproduction : un prix connu de 100 à T−23h et un futur prix de 120 à T+1h donnent une valorisation de 120 à T. Sans recherche vers le futur, le résultat est 100.

**Correction proposée :** utiliser uniquement les observations antérieures ou exactes pour une valorisation causale ; conserver les lacunes lorsqu'aucune observation n'est disponible.

### A7 — P1 : le montant « Période » perd des gains réalisés

**Code :** `src/historicalChart.js:1094–1099`.

Le moteur produit un P&L cumulé `periodPnl`, mais le rendu lit `totalReturn`, qui représente ici la plus-value des positions restantes. Après une vente partielle, cette quantité ne contient plus le gain de la partie vendue.

Reproduction : achat de 2 titres à 100, hausse à 120, vente d'un titre à 120, puis dernier titre à 132. Gain réalisé 20 + latent 32 = 52. Le moteur calcule bien `periodPnl = 52`, mais le KPI reçoit `perfAbs = 32`.

**Correction proposée :** alimenter le montant de performance de période à partir du P&L de période, avec un traitement explicite des dividendes selon le bouton. Distinguer ce montant de la plus-value latente du portefeuille courant.

### A8 — P2 : le repli local au prix de transaction perd sa provenance

**Code :** `src/HistoryCalculator.js:997–1024`, `1083–1087`, `1164`, `1374–1380`.

La modification locale permet de produire une courbe constante à 100 pour un actif sans aucune bougie. Le résultat est déclaré valide et sa provenance devient simplement `valuation`. La date et la nature de l'observation de transaction ne sont pas exposées ; l'affectation `transaction` faite dans la boucle est ensuite écrasée.

Ce repli peut convenir à une valorisation manuelle, mais il ne suffit pas à établir une performance de marché connue. Il peut aussi masquer le défaut A2 en rendant traçable un titre coté dont l'historique a été supprimé par erreur.

**Correction proposée :** expliciter la politique des actifs manuels, conserver la source et la date du prix, signaler une estimation ou une couverture incomplète. Ne pas appliquer silencieusement le même traitement à un titre coté indisponible.

### A9 — P2 : le dernier graphique est conservé en mémoire, mais masqué

**Code :** `src/historicalChart.js:560–573`, `843–847`, `880` ; `dashboard.html:195`.

Lors d'une erreur, le message annonce que le dernier graphique validé sera conservé. Pourtant `committed` reste faux et le canvas termine en `visibility: hidden`. La reproduction conserve bien l'ancienne instance Chart tout en la rendant invisible.

Sur le Dashboard, `chart-info` se trouve dans la ligne des commandes. Le texte d'erreur concurrence les boutons et se replie dans une colonne étroite, comme sur la capture.

**Correction proposée :** afficher l'erreur dans la zone du graphique et donner son motif précis. Si une ancienne courbe reste visible, afficher explicitement sa période, son périmètre et sa date pour ne pas la confondre avec la demande en échec.

### A10 — P2 : l'initialisation 2D peut prendre une clôture trop récente

**Code :** `src/HistoryCalculator.js:535–549`.

Le cas `days <= 2` privilégie `storage.previousClose` avant la recherche d'une observation antérieure à la borne. Reproduction : une observation historique de 100 et une clôture courante de 120 produisent un prix initial de 120.

L'impact final concerne surtout les points sans bougie historique utilisable : une observation antérieure trouvée ensuite par la boucle peut remplacer ce prix initial. Ce n'est pas la cause démontrée du problème 1W, mais un risque propre à 2D.

**Correction proposée :** associer le prix initial à la date de référence demandée, et non seulement au champ de clôture courant.

## Autres risques identifiés par lecture de code

Ces points n'ont pas fait l'objet d'une reproduction de bout en bout avec les données utilisateur.

- **Gold : passé dépendant du prix présent.** `src/api.js:806` multiplie l'historique substitué par `targetPrice / lastSourcePrice`. Une modification de la référence courante peut donc réécrire des prix historiques et les pondérations du portefeuille. Un ratio constant s'annule dans certains rendements d'un titre isolé ; cela ne rend pas correcte la valorisation agrégée en euros. Vérifier l'identité, la devise et l'échelle de l'instrument source.
- **FX historique approximatif.** `src/MarketUtils.js:83–115` retourne le taux courant quand l'historique manque et accepte aussi des jours futurs dans sa recherche. Le repli est logué, mais la qualité du résultat graphique ne le signale pas. `getHistoricalFxMap` décide également du besoin d'historique à partir de la devise des transactions, alors que la valorisation peut utiliser celle des cotations.
- **Benchmark : bornes et base distinctes.** `getStartEndTs` recalcule ses bornes indépendamment de `TimeRangeEngine`. Si aucun cours du benchmark n'existe avant le premier point, `src/historicalChart.js:1540` utilise sa première observation, même future. Les lignes doivent partager une base temporelle réellement disponible.
- **Actualisation des longues périodes.** Le rafraîchissement automatique fonctionne uniquement en 1D. Les autres périodes utilisent un cache expirant jusqu'à 24 h et une revalidation lors d'une nouvelle demande. Une courbe longue laissée ouverte ne suit donc pas automatiquement les nouvelles observations.
- **Coût des requêtes.** Le chargement se fait par lots de trois et inclut des tickers historiques non pertinents pour la période. À froid, le snapshot du jour peut aussi être attendu avant le calcul long. Le Worker accepte les intervalles et ne contient pas de branche limitant le graphique à 1D ; les logs joints ne démontrent pas de panne réseau prix sur 1W. Les latences et quotas doivent être mesurés sur un compte réel avant de modifier la concurrence.

## Ce que les logs ne permettent pas d'accuser

Les erreurs HTTP 500 visibles concernent principalement le RSS. Les erreurs FCM concernent les notifications. Leur présence ne prouve pas qu'elles causent l'échec du graphique. La capture du listener Firestore ne contient pas assez de détail pour diagnostiquer son exception ; les transactions sont néanmoins annoncées chargées et le calcul 1W démarre.

Les messages « Parsing Yahoo format » prouvent l'entrée dans le parseur, pas la présence d'un nombre suffisant de bougies pour chaque position. Il manque dans les logs actuels un diagnostic final par ticker : quantité détenue, source, timestamp, prix manquant et motif de rejet de la série.

## Vérifications effectuées et limites des tests actuels

- `npm test -- --reporter=dot` : **45 fichiers, 302 tests réussis**. Les tests Firestore nécessitant l'émulateur sont exclus par la configuration normale ; ils ne sont pas pertinents pour les reproductions financières de cet audit et n'ont pas été lancés.
- `npm exec -- vitest run --config audit/vitest.config.js --silent --reporter=verbose` : **11 reproductions réussies**, couvrant A1 à A10.
- `node audit/compare-head.mjs` : **18 calculs comparés**, neuf périodes sur chacun des deux moteurs.

Les 11 tests d'audit sont des tests de caractérisation : ils affirment le comportement défectueux observé pour le rendre reproductible. Leur réussite prouve la reproduction, pas la correction. Ils sont volontairement séparés de la suite de régression normale.

Pourquoi les tests habituels restent verts : les tests longs passent principalement par `calculateGenericHistory`, ce qui contourne le filtrage des dividendes de `calculateHistory`. Les doubles de stockage fournissent directement un type d'actif et ne reproduisent pas la recherche du premier mouvement de `Storage`. Les assertions « au moins un point fini » ne garantissent pas que le composant accepte le dernier point. Aucun test habituel ne suffit donc à certifier le parcours complet de toutes les périodes.

## Ordre de correction recommandé

1. Résoudre la classification des instruments (A2) et rendre le diagnostic des données manquantes visible. Ajouter des états distincts : panne API, historique absent, prix manuel, couverture partielle, performance non définie.
2. Restreindre les requêtes et la complétude aux positions effectivement nécessaires (A3), puis séparer valeur, performance et validation de cache (A1).
3. Corriger le registre transmis et le KPI de période (A4, A7).
4. Unifier les bornes temporelles et supprimer les observations futures en valorisation (A5, A6, A10, benchmark).
5. Formaliser les valorisations manuelles et le change approximatif, revoir la substitution Gold, puis traiter le rendu d'erreur (A8, A9).
6. Valider le parcours réel Dashboard/Investissements sur toutes les périodes, avec cash seul, ventes partielles/totales, dividendes, achat récent, ancien titre soldé, actif manuel, erreur réseau, USD, crypto et changement de période pendant le chargement.

Le correctif local explique pourquoi la reproduction principale peut désormais fonctionner. Déployer uniquement ce repli ne suffit toutefois pas à garantir des graphiques complets et financièrement cohérents.
