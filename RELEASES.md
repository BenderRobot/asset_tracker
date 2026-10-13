# Historique fonctionnel reconstitué

Le dépôt ne contenait aucun tag avant la mise en place du versionnement. Cette
chronologie reconstitue donc les versions à partir des fonctionnalités visibles
dans l'historique Git. Les nombreux commits intermédiaires de correction ne
sont pas assimilés à de nouvelles fonctionnalités.

| Version | Date | Fonctionnalité de référence | Commit |
|---|---|---|---|
| `1.0.0` | 2026-06-24 | Application initiale importée : portefeuille, transactions, Dashboard, Analytics, Watchlist, Screener, immobilier, actualités et assistant | `f6c497a` |
| `1.1.0` | 2026-06-24 | Catalogue d'indices étendu : VIX, taux et marchés asiatiques | `9d49734` |
| `1.2.0` | 2026-07-06 | Détail d'allocation des actifs dans le Dashboard | `f655ab7` |
| `1.3.0` | 2026-07-06 | Graphiques d'allocation dans Analytics | `8f6bc53` |
| `1.4.0` | 2026-07-10 | Connexion Open Banking | `30dd8e5` |
| `1.5.0` | 2026-07-20 | Module Dépenses | `58231d0` |
| `1.6.0` | 2026-07-27 | Sélection et filtrage par banque dans Dépenses | `2f12f70` |
| `1.7.0` | 2026-07-27 | Détection des dépenses récurrentes | `3257d31` |
| `1.8.0` | 2026-07-27 | Gestion et suppression des charges fixes | `1655337` |
| `1.9.0` | 2026-07-28 | KPI dépenses et revenus | `226c92d` |
| `1.10.0` | 2026-07-28 | Analyse IA des dépenses | `eda61e2` |
| `1.11.0` | 2026-07-28 | Catégorisation enrichie des transactions | `7a6dd86` |
| `1.12.0` | 2026-09-17 | Infobulle de composition de la valeur totale | `9476b20` |
| `1.13.0` | 2026-09-27 | Calcul et affichage ATH | `0548d19` |
| `1.14.0` | 2026-10-02 | Données financières enrichies du Screener | `02cd52b` |
| `1.15.0` | 2026-10-05 | Contexte intraday de l'assistant Gemini | `9bdb302` |
| `1.16.0` | 2026-10-05 | Assistant vocal | `4b9e18a` |
| `1.17.0` | 2026-10-05 | Graphique de performance bicolore | `b59dcf3` |
| `1.17.1` | 2026-10-12 | Version déjà publiée en ligne (build 347) | — |
| `1.17.2` | 2026-10-12 | fix: fiabiliser le versionnement des deploiements | — |
| `1.17.3` | 2026-10-12 | fix modal add indices | — |
| `1.17.4` | 2026-10-12 | fix modal futures badges | — |
| `1.17.5` | 2026-10-12 | fix kpi variation j | — |
| `1.17.6` | 2026-10-12 | fix modal futures badges 1 | — |
| `1.17.7` | 2026-10-12 | fix timesquare | — |
| `1.17.8` | 2026-10-12 | fix alignement div | — |
| `1.17.9` | 2026-10-12 | fix taille text kpi sec | — |
| `1.17.10` | 2026-10-12 | fix chart infos / boutons | — |
| `1.17.11` | 2026-10-12 | fix chart news modal link | — |
| `1.17.12` | 2026-10-12 | fix hoover | — |
| `1.17.13` | 2026-10-12 | fix news | — |
| `1.17.14` | 2026-10-12 | fix perf indices | — |
| `1.17.15` | 2026-10-12 | audit investments | — |
| `1.17.16` | 2026-10-12 | fix codex investments kpi | — |
| `1.17.17` | 2026-10-12 | fix codex style investments kpi | — |
| `1.17.18` | 2026-10-12 | fix codex style investments kpi 1 | — |
| `1.17.19` | 2026-10-12 | fix codex style investments kpi 2 | — |
| `1.17.20` | 2026-10-12 | fix codex style investments kpi 3 | — |
| `1.17.21` | 2026-10-12 | fix codex style investments kpi 4 | — |
| `1.17.22` | 2026-10-12 | fix claude style investments kpi 5 | — |
| `1.17.23` | 2026-10-12 | fix claude visuel chart | — |
| `1.17.24` | 2026-10-12 | fix claude visuel chart 1 | — |
| `1.17.25` | 2026-10-12 | fix claude nom kpi main | — |
| `1.17.26` | 2026-10-12 | fix claude tab | — |
| `1.17.27` | 2026-10-12 | fix claude tab 1 | — |
| `1.17.28` | 2026-10-12 | fix claude tab 2 | — |
| `1.17.29` | 2026-10-12 | fix claude tab 3 | — |
| `1.17.30` | 2026-10-12 | fix claude tab 4 | — |
| `1.17.31` | 2026-10-12 | fix claude tab 5 | — |
| `1.17.32` | 2026-10-12 | fix claude tab ammortissement | — |
| `1.17.33` | 2026-10-12 | fix claude immo visuel | — |
| `1.17.34` | 2026-10-12 | fix claude modal ammo | — |
| `1.17.35` | 2026-10-12 | fix claude modal evo dette | — |
| `1.17.36` | 2026-10-12 | fix claude modal evo dette 1 | — |
| `1.17.37` | 2026-10-12 | fix claude modal evo dette 2 | — |
| `1.17.38` | 2026-10-12 | add transac chart global | — |
| `1.17.39` | 2026-10-13 | add radar cdex | — |

Les messages de commit pilotent les nouvelles versions. Les scripts de
déploiement ajoutent désormais aussi chaque correctif à ce tableau avant les
tests ; un repère `—` désigne une version préparée avant la création de son
commit. Un tag Git pourra être créé à chaque déploiement de production.
