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

À partir de `1.17.0`, les messages de commit pilotent automatiquement la
version. Un tag Git pourra être créé à chaque déploiement de production afin
de figer l'historique sans avoir à le recalculer.
