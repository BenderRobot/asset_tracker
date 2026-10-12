# Audit Investment — vers une expérience premium

Date : 12 octobre 2026. Page : `investments.html`, intitulée « Assets » dans la navigation.

## Diagnostic

**La priorité est de faire d’Investment une excellente page de consultation des positions.** Elle dispose déjà d’un moteur partagé, d’un graphique riche, de filtres combinables et d’un accès aux achats. Mais elle reprend une grande partie du dashboard avant de montrer le portefeuille détaillé. La densité du tableau, le mobile et les états d’erreur rendent l’ensemble moins abouti que ses fonctionnalités.

Le gain premium viendra de trois changements : **des chiffres dont le périmètre est évident, des positions identifiables immédiatement, et des interactions stables**. La palette sombre, les grands montants et les couleurs de variation peuvent être conservés.

Cet audit livre un diagnostic, des reproductions et une feuille de route. Aucun fichier applicatif modifié par cet audit, aucun déploiement effectué.

## Méthode et limites

- Lecture de `investments.html`, `investmentsPage.js`, des trois feuilles de style Investment, de `app.js`, `filters.js`, `ui.js`, `logoUtils.js`, et des chemins pertinents de `historicalChart.js`, `dataManager.js`, `portfolioKPIs.js`, `marketStatus.js` et du calendrier partagé.
- Relecture des audits Dashboard et Screener, notamment des préférences utilisateur et des corrections déjà livrées. Les anciens constats ne sont pas présumés encore présents.
- Chrome isolé avec **HTML/CSS et composants de rendu réels**, stockage/API simulés et six positions fictives : actions, ETF au nom long, crypto. Largeurs : **360, 390, 768, 1 024, 1 366 et 1 920 px**, hauteur de fenêtre 900 px.
- Le graphique des captures est une illustration déterministe Chart.js. Il ne valide ni les historiques financiers ni tout le montage de la barre d’outils. Le scénario d’historique invalide exécute en revanche la vraie méthode `HistoricalChart.update` avec une source de données simulée.
- Pas de session authentifiée utilisée ; aucune donnée personnelle consultée ou modifiée. Pas de mesure réseau de production, de mesure Core Web Vitals, de certification WCAG, ni d’audit complet des règles Firestore ou du calcul financier.
- **Suite existante : 740 tests réussis, 92 fichiers réussis**, commande `npm test -- --reporter=dot`. Les tests Firestore nécessitant l’émulateur sont exclus de cette commande. Le décalage de version signalé dans l’ancien audit Dashboard n’échoue plus dans cet état du dépôt.
- Aucun nouvel automatisme de production ajouté. Le script d’audit consigne les comportements observés, y compris les défauts ; son succès d’exécution ne signifie pas que ces comportements sont corrects.
- À la vérification finale, des modifications concurrentes sont apparues dans `src/historicalChart.js` et `tests/athReference.test.js` concernant la référence de début de séance des indices. Elles n’ont pas été modifiées par cet audit. Les 740 tests décrivent l’état au moment de leur exécution, avant cette dernière vérification.

**Niveaux de preuve :** « reproduit » = observé dans le navigateur isolé ; « code » = chemin établi par lecture ; « proposition » = choix produit recommandé. **P1** = information trompeuse ou parcours essentiel dégradé ; **P2** = usage, lisibilité, robustesse ; **P3** = enrichissement.

## Ce qu’il faut préserver

- Le snapshot canonique, le partage du moteur avec le dashboard, les protections contre les réponses tardives et le chargement depuis le cache.
- Le filtrage des transactions avant agrégation des positions : essentiel lorsqu’un actif est détenu chez plusieurs courtiers.
- Les montants en euros, avec conservation de la devise d’achat dans les détails ; ne pas réintroduire de double conversion USD/EUR.
- Le graphique, ses périodes, ses comparaisons et son ATH partagé. Les préférences de l’audit Dashboard demandent de garder les informations du graphique visibles et de ne pas ajouter de sous-titres aux KPI. Les respecter dans la proposition Investment ; leur portée exacte à cette page reste un choix de conception, pas un consentement à supprimer du contenu.
- L’expansion d’une position et les accès Graphique/Screener : bonnes fonctions, à rendre explicites et accessibles.
- La séparation fonctionnelle : Dashboard pour la synthèse, Investment pour les positions, Transactions pour le registre, Analytics pour les analyses de répartition, notamment par devise.

## Constats prioritaires

### I01 — P1 — Le tableau peut rester définitivement sur « Loading… »

**Reproduit.** `InvestmentsPage.render` remplace immédiatement le tableau par un chargement (`src/investmentsPage.js:132`). Dans `HistoricalChart.update`, le rendu des positions est placé dans la branche où l’historique est valide (`src/historicalChart.js:1171`). Si les données historiques sont invalides, le graphique affiche une erreur, mais le tableau n’est pas rétabli.

Scénario : positions présentes dans le snapshot simulé, historique vide marqué invalide → message « Données de marché indisponibles pour cette période. » et tableau « Loading… » après résolution complète de la promesse. La branche `catch` présente le même risque structurel. Les zéros initiaux du HTML ne distinguent pas non plus un portefeuille réellement vide d’un chargement encore incomplet.

**Correction attendue :** rendre les positions depuis le snapshot indépendamment du succès de l’historique. Conserver les dernières lignes valides pendant une actualisation ; distinguer absence de positions, recherche sans résultat, chargement et indisponibilité, avec réessai. Les KPI conservés après une erreur doivent porter explicitement l’état de leurs données.

**Acceptation :** une erreur du graphique ne supprime pas les positions disponibles ; aucun chargement permanent après succès ou échec terminé ; premier lancement vide avec accès clair à Transactions.

### I02 — P1 — Le détail après vente partielle ressemble à un calcul de gain, mais n’en est pas un

**Reproduit sur transactions fictives ; chemin confirmé dans le moteur.** Les positions gardent achats **et ventes** dans `purchases` (`src/dataManager.js:551`). Le rendu applique à chaque mouvement `cours actuel × quantité du mouvement − montant du mouvement` (`src/investmentsPage.js:243`), sous les titres « DATE D’ACHAT » et « GAIN TOTAL ».

Exemple : achat de 10 titres à 100 €, vente de 5 à 150 €, cours actuel 200 €.

| Élément | Résultat |
|---|---:|
| Position restante : 5 titres, coût 500 €, valeur 1 000 € | Gain latent 500 € |
| Vente : produit 750 €, coût des titres vendus 500 € | Gain réalisé 250 € |
| Ligne d’achat rendue dans le détail | « Gain total » +1 000 € ; valeur 2 000 € |
| Ligne de vente rendue dans le détail | « Gain total » −250 € ; valeur −1 000 € |

Le −250 € affiché sur la vente est l’écart au cours actuel, pas son gain réalisé. La somme des lignes ne décrit pas le gain latent de la position. Cette incohérence existe même si le gain agrégé est correct.

**Correction attendue :** choisir un contrat explicite : un **historique des mouvements** avec type Achat/Vente, date, courtier, quantité et montant ; puis un résumé distinct de la position actuelle. Si des gains réalisés sont ajoutés, les obtenir du moteur de cession partagé, avec méthode de coût explicitée. Ne pas présenter chaque ancienne transaction comme un lot encore intégralement détenu.

**Acceptation :** exemple ci-dessus, vente totale, rachat et deux courtiers ; titres, signes et totaux compréhensibles. Aucun gain réalisé calculé dans le renderer.

### I03 — P1 — L’identité des actifs disparaît sur mobile

**Reproduit.** Lorsqu’un logo existe, la cellule TICKER contient seulement l’image (`src/investmentsPage.js:344`, `src/logoUtils.js:190`). Le nom est dans la deuxième colonne, masquée sur mobile. La quantité est masquée elle aussi ; le CSS attend un `data-quantity` qui n’est jamais posé sur la première cellule. `investmentsMobile.js` est actuellement un fichier de compatibilité vide.

Résultat à 390 px : la ligne Apple montre un logo, une valeur et une variation, **sans texte Apple, AAPL ni quantité**. Le texte alternatif de l’image ne remplace pas une identité visible lorsque l’image charge. Les ETF d’un même émetteur sont particulièrement difficiles à distinguer.

**Correction attendue :** première cellule commune bureau/mobile contenant logo décoratif + nom + ticker textuel ; quantité accessible immédiatement ou dans un détail explicitement ouvrable. Conserver l’identité quand le logo échoue.

**Acceptation :** deux ETF du même émetteur restent distinguables, même sans image ; noms longs et tickers longs ; identité toujours visible de 360 à 1 920 px.

### I04 — P1 — Certaines cartes sont coupées malgré l’absence apparente de débordement de page

**Reproduit avec le nom d’ETF du jeu de démonstration.** La grille mobile impose `1fr 1fr`, conserve des contraintes de largeur minimale intrinsèque et des textes sans retour (`css/investments-mobile.css:96`, rendu des performances dans `src/ui.js:350`). Les cartes de droite et le cash dépassent la fenêtre à 360/390 px. `overflow-x: hidden` dans le layout masque le défaut : `document.scrollWidth === innerWidth` ne suffit donc pas à valider cette page.

À 1 024 px, le document mesuré atteint 1 188 px. À 1 366 px, plusieurs montants et badges du tableau reviennent à la ligne. Sur mobile, le symbole € du KPI principal passe aussi sur une seconde ligne dans la capture.

**Correction attendue :** colonnes `minmax(0, 1fr)`, minima explicites adaptés, ellipses avec accès au nom complet, montants insécables et tableau contenu dans une zone maîtrisée aux largeurs intermédiaires. Une valeur ne doit pas devenir illisible pour éviter un défilement.

**Acceptation :** vérifier les rectangles de chaque carte et cellule, pas uniquement la largeur du document ; montants élevés, noms longs, six largeurs et texte agrandi.

### I05 — P1 — La promesse de séance et le classement quotidien ne sont pas unifiés

Deux problèmes distincts :

1. **Reproduit :** le tableau et son tri utilisent `displayDayPct` / `displayDayChange` ; les cartes meilleures/pires performances utilisent `dayPct` / `dayChange` via `calculateSummary` (`src/dataManager.js:1280`, `src/ui.js:375`). Avec actions fermées à variation comptable quotidienne nulle, dernière séance positive et crypto active, Apple est première dans le tableau à +1,40 %, mais la carte du jour nomme Bitcoin à +0,80 %.
2. **Code :** le badge de la carte Var Today vient de `MarketStatus.getGlobalStatus` (`src/ui.js:96`, `src/marketStatus.js:15`). Il annonce « En direct » en semaine entre 9 h et 22 h à partir de l’heure locale du navigateur. Il ne prouve ni la fraîcheur des cours ni l’ouverture des instruments filtrés, ne traite pas les jours fériés et indique fermé le week-end même pour une sélection crypto.

**Correction attendue :** définir « jour » versus « dernière séance » pour chaque surface et partager le sélecteur de présentation entre tableau et classements. Utiliser le calendrier partagé et la fraîcheur effective, avec crypto 24/7 et état inconnu. **Ne pas modifier le P&L financier du snapshot pour faire coïncider artificiellement un classement de dernière séance avec le jour courant.**

**Acceptation :** jour ouvré, week-end mixte actions/crypto, portefeuille seulement crypto, férié couvert et données anciennes ; libellés explicites quand les bases temporelles diffèrent.

### I06 — P1 — Le benchmark « Nasdaq 100 » n’a pas été corrigé sur Investment

**Code.** `investments.html:133` associe « Nasdaq 100 » à `^IXIC`, alors que le dashboard utilise désormais `^NDX` (`dashboard.html:175`). Le sélecteur transmet directement la valeur à `currentBenchmark` (`src/app.js:120`). La divergence avec la correction partagée de l’audit Dashboard est donc toujours présente ici.

**Correction attendue :** catalogue commun pour les libellés et identifiants ; `^NDX` pour Nasdaq 100. Ajouter une vérification de concordance entre pages. Afficher dans l’aide de comparaison la devise, la période commune et la nature de la série ; ne pas promettre un benchmark dividendes réinvestis sans série correspondante.

### I07 — P1 — La recherche filtrée peut être présentée comme un portefeuille global

**Reproduit :** avec `currentSearchQuery = 'Apple'`, `getChartTitleConfig()` répond toujours `{ mode: 'global', label: 'Portfolio Global' }`. Le filtrage des transactions tient pourtant compte du texte (`src/investmentsPage.js:165`, `401`). Aucun récapitulatif visible des filtres n’accompagne les KPI.

**Code :** `App.searchQuery` et `InvestmentsPage.currentSearchQuery` sont deux états distincts. Le bouton effacer remet à zéro le second et l’input, mais pas le premier. Un prochain `App.renderCurrentPage()` peut réappliquer l’ancienne recherche (`src/app.js:234`, `592`, `src/investmentsPage.js:503`). Ce retour automatique du filtre reste à exercer dans une session complète ; le défaut de synchronisation est visible dans le code.

Autre incohérence reproduite : le placeholder promet une recherche par date, mais une date présente dans les achats retourne zéro résultat, car ce chemin ne cherche que ticker et nom.

**Correction attendue :** état de filtres partagé ; contexte visible « Sélection : Apple · 1 position », chips des filtres actifs et effacement complet de cet état. Une recherche de positions doit annoncer « Nom ou ticker ». La recherche de dates appartient au registre des mouvements sauf besoin explicite contraire.

**Acceptation :** texte + courtier + type + ticker ; remise à zéro puis événement d’actualisation ; titre/KPI/tableau cohérents ; passage d’une page de résultats à une autre.

### I08 — P1 — Des noms de positions sont interprétés comme du HTML

**Reproduit avec un marqueur HTML inoffensif.** Un nom contenant `<b data-audit-marker="injected">Audit marker</b>` crée un élément dans la ligne plutôt qu’un texte littéral (`src/investmentsPage.js:351`). Autres interpolations : attribut du logo, filtres et noms des gagnants/perdants du jour. Le nom provient notamment d’un champ éditable de transaction (`src/app.js:627`).

Cela établit une **surface d’injection HTML et un risque de XSS persistante**, pas une compromission observée ni une attaque démontrée entre comptes. Aucun script malveillant exécuté et aucun test sur données distantes.

**Correction attendue :** `textContent` pour les données textuelles, attributs construits via le DOM et échappement adapté aux rares templates nécessaires. Éviter les gestionnaires `onerror` assemblés avec des données. Traiter noms et tickers comme des données dans toutes les vues partagées.

**Acceptation :** chevrons, guillemets, apostrophes et esperluettes restent du texte et ne créent ni balise ni attribut actif.

## Ergonomie et présentation

### I09 — P2 — Le tableau arrive trop tard pour la fonction de cette page

**Mesure sur la fixture**, et non promesse de hauteur identique dans un compte réel : première ligne à **1 164 px** sur bureau 1 366/1 920 px et **1 493 px** à 390 px. Sur une fenêtre de 900 px de haut, aucune position n’est visible au premier écran. Les valeurs varient selon les outils du graphique, le nombre de périodes et les textes du compte.

Les trois KPI, les cinq cartes secondaires et le graphique utilisent presque tout le premier parcours vertical. Le tableau, qui distingue réellement Investment du dashboard, arrive après.

**Proposition :** trois KPI compacts, contexte des filtres, puis tableau prioritaire ; graphique complet accessible dans le même espace via une vue « Analyse » ou placé sous les positions. Si le graphique doit rester au-dessus, compacter les espaces et le bloc des extrêmes, ajouter un accès « Positions » et mesurer la présence de premières lignes sur un écran bureau courant. Ne pas dissimuler les statistiques du graphique dans un volet pour gagner artificiellement de la place.

### I10 — P2 — Onze colonnes, mais aucune pondération de position

**Code et captures.** Le tableau sépare logo et nom, P&L et RT %, variation en euros et en pourcentage. Presque tous les chiffres sont gras. Les intitulés AVG PRICE, CURRENT et RT % demandent une interprétation ; aucun poids dans la sélection n’est affiché. La colonne nom large entre en concurrence avec les montants.

**Proposition de vue par défaut :** Actif · Valeur · Poids · Cours € · Gain latent (€ et %) · Séance (€ et %). Quantité, PRU et investi restent disponibles par colonnes configurables et dans le détail. La notion de gain latent devra être confirmée au niveau du contrat moteur, plutôt que renommer aveuglément tous les « Total Return ».

Le poids doit annoncer son dénominateur : **sélection, cash inclus** par exemple. Le calcul vient des données canoniques. Si le total est invalide, afficher une indisponibilité, pas un pourcentage calculé sur les seuls cours connus.

En-tête et identité d’actif fixes dans la zone du tableau, alignements numériques à droite, chiffres tabulaires, symbole monétaire insécable. Mettre d’abord en valeur la valeur détenue et son impact ; cours/PRU plus discrets.

### I11 — P2 — Filtres et tri réinitialisent trop d’éléments

**Reproduit :** sélectionner une case d’actif reconstruit et ferme immédiatement la liste ; le focus revient sur `BODY` (`src/filters.js:86`). Composer une sélection demande plusieurs ouvertures. Le clic mobile sur DAY % bascule vers le gain total sans changer le tri, qui reste `dayPct` (`src/investmentsPage.js:533`). La vue « total » peut donc sembler triée de façon incompréhensible.

**Code et reproduction partielle :** effacer les filtres réinitialise aussi la période à 1 jour et supprime le benchmark. Cela appelle le callback de filtres, le retour portefeuille et un nouveau rendu ; le moteur possède déjà une protection contre les mises à jour concurrentes, mais ces intentions multiples créent du travail et compliquent l’état (`src/investmentsPage.js:493`). Un tri appelle lui aussi `render()` et passe par le graphique ; la recherche le fait à chaque frappe (`src/app.js:592`). Ce n’est pas la preuve d’un appel réseau à chaque caractère : le cache et la déduplication existent.

**Correction attendue :** séparer tri local, filtres, sélection d’actif et période du graphique ; mise à jour locale immédiate pour le tri, temporisation courte de la recherche, liste multisélection maintenue ouverte, bouton explicite « Jour / Total » sur mobile. Conserver période et comparaison lors d’un simple effacement de filtres ; réserver le reset complet à une action nommée.

### I12 — P2 — Navigation clavier, fenêtres et zoom incomplets

**Reproduit :** lignes ouvrables et en-têtes de tri non focusables ; cartes KPI cliquables seulement comme des `div` ; la fenêtre de détail reste ouverte après Échap, ne reçoit pas le focus et ne porte pas de rôle dialog. Le sélecteur d’actifs perd le focus lors de sa reconstruction.

**Code :** viewport `user-scalable=no`, `maximum-scale=1.0` et prévention des gestes de zoom (`investments.html:6`). Champs de recherche/type/courtier sans labels explicites ; canvas sans description accessible dans le HTML. Certaines tailles du détail mobile descendent à 9–11 px. Les contrastes n’ont pas été mesurés : ne pas déclarer la page conforme sur la seule apparence.

**Correction attendue :** vrais boutons d’expansion et de tri (`aria-expanded`, `aria-sort`), labels de formulaires, focus visible, dialogue avec focus initial/confiné/restauré et Échap, zoom autorisé, contenu alternatif utile au graphique. Réutiliser le composant de dialogue accessible pour les KPI et les filtres.

Références : le [W3C sur l’agrandissement du texte](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html) décrit la cible de 200 % sans perte de contenu ou de fonction ; le [modèle de dialogue modal WAI-ARIA](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) décrit le focus et la fermeture clavier. Ces références guident les corrections ; cet audit n’est pas une certification.

### I13 — P2 — Langue, formats et états manquent de cohérence

**Code et captures.** Page française mais Total Value, Total Return, Var Today, Cash Reserve, All Assets/Types/Brokers, Loading, Portfolio Global et périodes 1W/1Y/All. Montants avec virgule, pourcentages souvent avec point (`src/utils.js:29`, `src/ui.js:337`). Des cartes secondaires réagissent visuellement au survol sans action d’ouverture associée dans ce renderer.

**Correction attendue :** vocabulaire commun : Valeur · Gain · Variation du jour ou Dernière séance · Liquidités · Tous les actifs · Tous les courtiers ; PRU expliqué ; 1S/1A/Tout. Formatage français partagé ; signes explicites en complément de la couleur. Garder des libellés courts et placer la méthodologie dans une aide ou un détail, sans multiplier les sous-titres de KPI.

## Points techniques complémentaires

- **Tri des dates fragile, pas un désordre de production démontré :** `a.date - b.date` ne trie pas les dates ISO dans le renderer. La reproduction avec entrées désordonnées le montre. Mais `calculateHoldings` trie déjà les mouvements avec `new Date`, ce qui protège le chemin normal. Corriger la robustesse sans en faire un incident observé sur compte réel.
- **Seuils de petites positions :** le seuil de quantité `0.0001` existe aussi dans le moteur et le sélecteur de tickers ; il n’est pas seulement une règle visuelle. Pour les actifs à prix élevé, quantité minuscule ne signifie pas toujours valeur négligeable. Examiner le contrat global avant de changer ce seuil dans une seule vue. Le second filtre de poussière propre au tableau peut également exclure des centimes présents dans le snapshot.
- **Cycle de vie des filtres :** chaque `updateTickerFilter` ajoute un écouteur `document.click` sans retirer le précédent. Préférer un écouteur durable et une mise à jour des options conservant focus et ouverture.
- **Dépendance graphique :** Chart.js est chargé sans version dans le HTML. Figer la version validée et prévoir un état d’échec CDN. Aucune incompatibilité de version observée dans ce contrôle.
- **Détails massifs :** toutes les sous-lignes des positions de la page sont construites même fermées. La pagination est de 25 positions, pas 25 transactions. Mesurer un actif avec plusieurs centaines de mouvements et construire son détail à l’ouverture si nécessaire ; aucune durée de ralentissement réelle n’est affirmée ici.
- **Actualisations :** conserver la déduplication et les protections du moteur. Mesurer rendu depuis cache, mise à jour de filtre et nombre de requêtes avant d’ajouter un timer ou un mécanisme de cache supplémentaire.

## Cible produit proposée

| Zone | Comportement premium attendu |
|---|---|
| Synthèse | 3 KPI immédiatement lisibles, méthodologie accessible, portée portefeuille/sélection visible à proximité |
| Contexte | Recherche nom/ticker, filtres actifs nommés, nombre de positions ; aucun « global » après une recherche |
| Tableau | Identité textuelle stable, valeur et poids, montants lisibles, tri explicite, vue compacte ou détaillée mémorisée |
| Détail actif | Quantité détenue, coût restant, cours EUR, état/date de cotation, courtiers, mouvements Achat/Vente, accès Graphique/Screener/Transactions |
| Graphique | Fonctionnalités actuelles préservées ; sélection et retour portefeuille visibles ; période et benchmark indépendants du tri |
| Mobile | Nom + ticker, valeur, contrôle Jour/Total ; détail lisible, gestes de zoom possibles et aucune carte coupée |
| États | Chargement initial, actualisation discrète, vide, aucun résultat, données anciennes/partielles, erreur et réessai distincts |

Les cinq cartes secondaires ne doivent pas disparaître sans remplacement de leur information. Leur place est à revoir : regroupement compact, ou informations rattachées à la sélection et au tableau. Une nouvelle rangée de gadgets ne résoudrait pas l’accès tardif aux positions.

**P3 utiles après stabilisation :** vues mémorisées par courtier/type, ordre et visibilité des colonnes, export de la sélection avec devise/date/périmètre, lien partageable de filtres sans données financières dans l’URL. Ces propositions ne nécessitent ni nouveau calcul prédictif ni copie des graphiques d’Analytics.

## Feuille de route

| Lot | Contenu | Critère de sortie |
|---|---|---|
| **1 — Fiabilité** | I01, I02, I05, I06, I07, I08 : erreurs, détail des ventes, séance, benchmark, filtre partagé, données textuelles sûres | Scénarios financiers et de navigation reproduits puis corrigés ; résultat cohérent entre les surfaces |
| **2 — Tableau et mobile** | I03, I04, I09, I10 : identité, grilles, hiérarchie, colonnes et montants | Chaque actif identifiable ; zéro contenu essentiel coupé sur les six largeurs ; accès nettement plus rapide aux positions |
| **3 — Interactions et finition** | I11, I12, I13 : tri local, multisélection, dialogues, zoom, français et formats | Parcours utilisables au clavier et au tactile ; filtres/préférences conservés pendant les actualisations |
| **4 — Confort avancé** | Vues enregistrées, export, personnalisation mesurée | Gain d’usage constaté sans nouvelles divergences de données ni duplication d’Analytics |

Les corrections d’accessibilité doivent accompagner les composants dès les premiers lots ; leur regroupement en lot 3 ne justifie pas de créer de nouveaux contrôles inaccessibles. Recommandation de démarrage : **lot 1, avec l’identité mobile I03 comme correction immédiate de lisibilité**.

## Validation attendue avant livraison

1. Portefeuille vide, seulement cash, une position, plus de 25 positions, noms et montants longs, cours absent et historique invalide.
2. Recherche + courtier + type + ticker ; effacement puis actualisation ; changement rapide de sélection ; aucun retour de filtre invisible.
3. Achat EUR/USD, vente partielle/totale, rachat, deux courtiers ; détail réalisé/latent expliqué ; conversion historique cohérente.
4. Jour ouvré, fermeture, week-end mixte et crypto seule ; distinction entre P&L du jour et dernière séance, fraîcheur visible.
5. Ouverture d’actif, retour portefeuille, période et comparaison ; tri sans recalcul superflu du graphique.
6. Six largeurs, noms longs, montants jusqu’au million et texte agrandi ; vérifier les éléments hors cadre même quand `overflow-x` les masque.
7. Clavier complet : filtres, tri, expansion, fenêtres, fermeture et restitution du focus ; contrôle séparé avec lecteur d’écran et mesure de contraste.
8. Dernière vérification en session authentifiée, en lecture seule, pour les événements Firestore et le portefeuille réel. Elle reste à faire.

## Artefacts et reproduction

- [Capture bureau 1 366 px](investments-preview-1366.png)
- [Capture mobile 390 px](investments-preview-390.png)
- [Détail bureau](investments-detail-1366.png) et [détail mobile](investments-detail-390.png)
- [Mesures et reproductions JSON](investments-preview-results.json)
- [Script navigateur](investments-audit-preview.mjs)

Les captures représentent l’état existant avec des données fictives, **pas une maquette de la future version**. Elles ne doivent pas servir à conclure sur le calcul d’un historique réel. Les images complètes peuvent inclure une largeur hors viewport liée au débordement constaté.

```powershell
node audit/investments-audit-preview.mjs <chemin-vers-le-module-playwright>
npm test -- --reporter=dot
```

Le script exige Chrome et une installation existante de Playwright ; aucune dépendance ajoutée au projet. Il ne charge pas les scripts d’authentification ou d’initialisation de l’application, utilise des données fictives et n’écrit pas dans Firebase. Les polices, icônes, logos et Chart.js sont chargés depuis leurs CDN. Les captures et le JSON sont régénérés à chaque exécution.
