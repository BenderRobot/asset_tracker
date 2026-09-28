import { marketDataMetrics } from './marketDataMetrics.js';
import { quoteInEur } from './currency.js';
import { splitTransactions, assetHistoryTransactions, transactionKind } from './financialTransactions.js';
import { periodPerformance } from './financialSeries.js';
import { fetchMarketResponse } from './marketDataTransport.js?v=3';
// ========================================
// dataManager.js - (v8 - Ajout support Indices)
// ========================================

import { YAHOO_MAP, PRICE_PROXY_URL } from './config.js';
import { parseDate } from './utils.js';
import { HistoryCalculator } from './HistoryCalculator.js?v=22';
import { MarketDataRepository } from './marketDataRepository.js?v=8';
import {
    getIntervalForPeriod,
    getLabelFormat,
    getLastTradingDay,
    isCryptoTicker,
    formatTicker,
    findClosestPrice,
    resolveHistoricalUsdToEurRate
} from './MarketUtils.js';

export class DataManager {
    constructor(storage, api) {
        this.storage = storage;
        this.api = api;
        this.historyCalculator = new HistoryCalculator(storage, api);
        // MarketDataRepository (validation architecture 2026-09-24) : façade
        // cache-first/SWR/coalescing au-dessus de buildTodaySnapshot() ci-
        // dessous — voir marketDataRepository.js. Un seul par DataManager,
        // donc partagé par tout ce qui tient une référence à CE dataManager
        // (dashboardApp.js, historicalChart.js) sur la durée de vie de la page.
        this.repository = new MarketDataRepository(this);
        // Compteur monotone pour snapshotId — voir buildPortfolioSnapshot.
        this._snapshotSeq = 0;
        // Coalescing (audit dédup 2026-09-23, même mécanisme que
        // api.js::_inFlightHistoricalRequests) : getHistoricalFxMap ci-dessous
        // ne mémoïse qu'APRÈS résolution — dashboardApp.js l'appelle depuis 3
        // chemins non attendus les uns par rapport aux autres (init), qui
        // peuvent tous manquer ce cache avant qu'aucun n'ait résolu.
        this._historicalFxMapInFlight = null;
        // Ancien cache portefeuille (loadCachedData/saveCacheSnapshot, retirés) :
        // clé non liée à l'utilisateur, remplacée par MarketDataRepository.
        try { globalThis.localStorage?.removeItem('portfolio_snapshot_cache'); } catch { /* best effort */ }
    }

    // ============================================================
    // PORTFOLIOSNAPSHOT — LE SEUL PRODUCTEUR DE MÉTRIQUES FINANCIÈRES
    // CANONIQUES DE L'APPLICATION (audit architecture SSOT)
    // ============================================================
    //
    // Règle : UNE métrique financière = UNE formule = UN producteur (ce
    // fichier) = UNE source canonique (l'objet retourné ici, immuable). Les
    // vues (historicalChart.js, investmentsPage.js, dashboardApp.js,
    // chartKPIManager.js) ne DOIVENT plus jamais recalculer totalValue,
    // totalReturn, dayPnl/Var Today ou dayPct — uniquement lire ces champs sur
    // le PortfolioSnapshot qu'on leur transmet. Un test statique
    // (tests/architectureFinancialSsot.test.js) fait échouer la suite si un de
    // ces fichiers réintroduit un tel calcul.
    //
    // Ce mapper est délibérément PUR et SYNCHRONE : il ne fait plus aucune
    // résolution de prix/taux — ce travail est déjà fait par le moteur
    // (buildTodaySnapshot pour le portefeuille, buildAssetTodaySnapshot pour
    // un actif seul, buildIndexSnapshot pour un indice). Il ne fait
    // qu'agréger/canonicaliser un résultat de moteur DÉJÀ résolu, une seule
    // fois, dans une forme figée (Object.freeze) que rien en aval ne peut
    // modifier silencieusement.
    //
    // TWR (voir HistoryCalculator/todayGraphData.dailyTwr) est explicitement
    // HORS de cet objet : c'est une métrique d'ANALYSE de performance
    // (HistoricalAnalytics), pas une métrique de snapshot financier — voir
    // historicalChart.js, qui ne lit plus jamais dailyTwr pour produire Var
    // Today/Total Value/Total Return. Le sens de dépendance est strictement
    // PortfolioSnapshot → TWR Analytics, jamais l'inverse.
    _nextSnapshotId() {
        this._snapshotSeq += 1;
        return `snap-${Date.now()}-${this._snapshotSeq}`;
    }

    // Position canonique pour UNE ligne (un ticker) — mappe le vocabulaire
    // interne historique de calculateHoldings (dayChange/gainEUR/gainPct) vers
    // le vocabulaire canonique du PortfolioSnapshot (dayPnl/totalReturn/
    // totalReturnPct) demandé par l'architecture SSOT, sans dupliquer le
    // calcul : chaque champ ici est une simple RE-LECTURE d'un champ déjà
    // produit par _enrichAggregatedPosition, jamais une nouvelle formule.
    // `quantity` reste la valeur EXACTE (pleine précision flottante) telle que
    // calculée par _buildPositionsByBrokerTicker — jamais arrondie ici (voir
    // invariant "arrondi = affichage seulement", app.js pour le bug historique
    // inverse).
    _mapHoldingToPosition(holding) {
        return Object.freeze({
            ticker: holding.ticker,
            name: holding.name,
            assetType: holding.assetType,
            quantity: holding.quantity,               // rawQuantity — pleine précision
            avgPrice: holding.avgPrice,
            currentPrice: holding.currentPrice,
            previousClose: holding.previousClose ?? null,
            currentValue: holding.currentValue,
            invested: holding.invested,
            totalReturn: holding.gainEUR,
            totalReturnPct: holding.gainPct,
            yesterdayQuantity: holding.yesterdayQuantity ?? null,
            dayPnl: holding.dayChange,
            dayPnlPct: holding.dayPct,
            displayDayPnl: holding.displayDayChange ?? holding.dayChange,
            displayDayPnlPct: holding.displayDayPct ?? holding.dayPct,
            weight: holding.weight,
            purchases: Object.freeze([...(holding.purchases || [])]),
            // FAIL-CLOSED (audit incident 2026-09-23) — voir
            // _enrichAggregatedPosition : true uniquement pour un échec
            // RÉSEAU/HTTP confirmé de récupération du prix, jamais une simple
            // absence de donnée par ailleurs déjà gérée.
            priceDataUnavailable: !!holding.priceDataUnavailable
        });
    }

    // LE canonicalizer : transforme le résultat déjà résolu d'un moteur
    // (buildTodaySnapshot / buildAssetTodaySnapshot / buildIndexSnapshot) en
    // PortfolioSnapshot figé. `holdings`/`summary`/`cashReserve` sont
    // EXACTEMENT ce que calculateHoldings/calculateSummary/calculateCashReserve
    // ont produit — cette fonction ne fait qu'assembler et figer, jamais
    // recalculer une métrique de marché.
    //
    //     snapshot.dayPnl        === Σ snapshot.positions[].dayPnl   (par construction : summary.totalDayChangeEUR est DÉJÀ cette somme — voir calculateSummary)
    //     snapshot.totalValue    === Σ positions[].currentValue + snapshot.cash
    //     snapshot.totalReturn   === Σ positions[].totalReturn        (= totalValue des actifs - invested, cash exclu — définition actuelle de gainTotal)
    buildPortfolioSnapshot({ holdings, summary, cashReserve, snapshotStartedAt = null, pricesTimestamp = null, priceStatus = null, meta = null }) {
        const cash = cashReserve?.total ?? (cashReserve?.fxUnavailable ? null : 0);
        const invested = summary.totalInvestedEUR || 0;

        // FAIL-CLOSED (audit incident 2026-09-23) : summary.dataQuality vient de
        // calculateSummary — absent uniquement pour les appelants qui construisent
        // leur propre `summary` à la main sans jamais passer par calculateHoldings/
        // calculateSummary (mode indice, voir buildIndexSnapshot) : dans ce cas il
        // n'y a pas de "prix historique manquant" à représenter, valid=true par défaut.
        const dataQuality = cashReserve?.fxUnavailable
            ? { valid: false, reason: 'FX_DATA_UNAVAILABLE', failedInstruments: ['CASH-USD', ...(summary.dataQuality?.failedInstruments || [])] }
            : summary.dataQuality || { valid: true, reason: null, failedInstruments: [] };
        const isValid = dataQuality.valid !== false;

        // Un snapshot INVALID ne publie AUCUN nombre calculé à partir d'un prix —
        // jamais 0€ (qui est une vraie valeur financière), toujours `null`
        // ("indisponible", déjà le langage commun de tout le reste du moteur —
        // voir _enrichAggregatedPosition/formatCurrency). `cash`/`invested` restent
        // réels : ni l'un ni l'autre ne dépend d'un prix de marché.
        const totalValue = isValid ? (summary.totalCurrentEUR || 0) + cash : null;
        const totalReturn = isValid ? (summary.gainTotal || 0) : null;
        const totalReturnPct = isValid ? (invested > 0 ? (totalReturn / invested) * 100 : 0) : null;
        const dayPnl = isValid ? (summary.totalDayChangeEUR ?? 0) : null;
        const dayPnlPct = isValid ? (summary.dayChangePct ?? 0) : null;

        const positions = Object.freeze(holdings.map(h => this._mapHoldingToPosition(h)));

        return Object.freeze({
            snapshotId: this._nextSnapshotId(),
            generatedAt: Date.now(),
            snapshotStartedAt,
            // Fraîcheur des prix utilisés — par défaut égale à l'instant où la
            // résolution a démarré (snapshotStartedAt) faute de mieux ; un
            // appelant qui connaît l'âge réel des prix (ex: dernier
            // lastUpdate résolu) peut le préciser.
            pricesTimestamp: pricesTimestamp ?? snapshotStartedAt,
            // Fraîcheur de la SOURCE (audit 2026-09-28, B3) : cotations
            // conservées après un rafraîchissement en échec. Le snapshot reste
            // valide et affichable (données réelles, datées par
            // pricesTimestamp), mais n'est jamais présenté comme à jour.
            sourceStale: !!priceStatus?.staleInstruments?.length,
            staleInstruments: Object.freeze([...(priceStatus?.staleInstruments || [])]),
            refreshErrors: Object.freeze({ ...(priceStatus?.refreshErrors || {}) }),
            // FAIL-CLOSED — voir règle ci-dessus. 'valid' | 'invalid'.
            status: isValid ? 'valid' : 'invalid',
            invalidReason: isValid ? null : dataQuality.reason,
            invalidInstruments: Object.freeze([...(dataQuality.failedInstruments || [])]),
            totalValue,
            cash,
            invested,
            totalReturn,
            totalReturnPct,
            dayPnl,
            dayPnlPct,
            positions,
            // Traçabilité (ex: {mode:'portfolio'|'asset'|'index', ticker, filtered:bool}) —
            // jamais lu pour produire une métrique, uniquement pour le debug/logs.
            meta: meta ? Object.freeze({ ...meta }) : null
        });
    }

    // Dérive un PortfolioSnapshot FILTRÉ (sous-ensemble de tickers) à partir
    // d'un snapshot déjà canonique — jamais en relisant des prix ou en
    // recalculant depuis les achats bruts. Réutilise EXACTEMENT la même
    // formule d'agrégation que buildPortfolioSnapshot (Σ positions), sur un
    // sous-ensemble de positions déjà résolues. Porte `filteredFrom` vers le
    // snapshotId parent (invariant H : traçabilité de lignage), pour qu'on
    // puisse toujours vérifier qu'une vue "filtrée" descend bien du même
    // instant de résolution que le snapshot global affiché ailleurs à l'écran.
    deriveFilteredPortfolioSnapshot(snapshot, tickerFilterSet) {
        const positions = (!tickerFilterSet || tickerFilterSet.size === 0)
            ? snapshot.positions
            : snapshot.positions.filter(p => tickerFilterSet.has(p.ticker.toUpperCase()));

        // FAIL-CLOSED (audit incident 2026-09-23) : un sous-ensemble filtré peut
        // très bien redevenir VALIDE si le(s) ticker(s) en échec ont été
        // exclus par le filtre — on réévalue sur LES POSITIONS FILTRÉES,
        // jamais en héritant aveuglément du statut du snapshot parent.
        const invalidInFilter = positions.filter(p => p.priceDataUnavailable).map(p => p.ticker);
        if (snapshot.cash === null) invalidInFilter.push('CASH-USD');
        const isValid = invalidInFilter.length === 0;

        // Même formule EXACTE que calculateSummary (celle qui produit
        // summary.dayChangePct au niveau non-filtré) : dénominateur = valeur
        // des ACTIFS SEULS à la clôture d'hier, cash exclu — pour que
        // dayPnlPct d'un snapshot filtré et non-filtré restent calculés de la
        // même manière.
        const validPositions = isValid ? positions : positions.filter(p => !p.priceDataUnavailable);
        const assetValue = validPositions.reduce((s, p) => s + (p.currentValue || 0), 0);
        const invested = positions.reduce((s, p) => s + (p.invested || 0), 0); // coût de revient : jamais dépendant d'un prix
        const totalReturn = isValid ? validPositions.reduce((s, p) => s + (p.totalReturn || 0), 0) : null;
        const totalReturnPct = isValid ? (invested > 0 ? (totalReturn / invested) * 100 : 0) : null;
        const dayPnl = isValid ? validPositions.reduce((s, p) => s + (p.dayPnl || 0), 0) : null;
        const previousCloseAssetValue = isValid ? assetValue - dayPnl : null;
        const dayPnlPct = isValid ? (previousCloseAssetValue > 0 ? (dayPnl / previousCloseAssetValue) * 100 : 0) : null;
        const totalValue = isValid ? assetValue + snapshot.cash : null;

        return Object.freeze({
            snapshotId: `${snapshot.snapshotId}:filtered`,
            filteredFrom: snapshot.snapshotId,
            generatedAt: snapshot.generatedAt,
            snapshotStartedAt: snapshot.snapshotStartedAt,
            pricesTimestamp: snapshot.pricesTimestamp,
            sourceStale: snapshot.sourceStale ?? false,
            staleInstruments: snapshot.staleInstruments ?? Object.freeze([]),
            refreshErrors: snapshot.refreshErrors ?? Object.freeze({}),
            status: isValid ? 'valid' : 'invalid',
            invalidReason: isValid ? null : (snapshot.cash === null ? 'FX_DATA_UNAVAILABLE' : 'PRICE_DATA_UNAVAILABLE'),
            invalidInstruments: Object.freeze(invalidInFilter),
            totalValue,
            cash: snapshot.cash,
            invested,
            totalReturn,
            totalReturnPct,
            dayPnl,
            dayPnlPct,
            positions: Object.freeze(positions),
            meta: snapshot.meta
        });
    }

    // alignLastPointToLiveSnapshot() supprimée (validation architecture
    // 2026-09-24, Phase 4 — "Financial Truth over KPI Reconciliation") : cette
    // méthode forçait le dernier point de N'IMPORTE QUELLE série affichée
    // (values/cash/investedAssetOnly/totalReturn/totalReturnPct, plus
    // dayPnl/dayPnlPct fabriqués de toutes pièces pour l'occasion) à être
    // remplacé par le PortfolioSnapshot live — l'égalité
    // `graphData.values[last] === portfolioSnapshot.totalValue` n'est PLUS un
    // invariant imposé par le code. Le graphique représente désormais
    // uniquement la vérité des observations disponibles (voir
    // HistoryCalculator._buildSeries, pointMeta) ; le KPI (portfolioKPIs, via
    // _computeAggregateKPIs) reste une valorisation live INDÉPENDANTE, lue
    // directement sur portfolioSnapshot — les deux PEUVENT légitimement
    // différer (ils ne l'ont d'ailleurs jamais nécessité : _computeAggregateKPIs
    // ne lit pas graphData, cette suppression ne touche donc AUCUN KPI affiché,
    // seulement le dernier point du graphique et son tooltip).
    //
    // === HELPERS DELEGATION (Compatibilité Legacy) ===
    isCryptoTicker(ticker) { return isCryptoTicker(ticker); }
    formatTicker(ticker) { return formatTicker(ticker); }
    getIntervalForPeriod(days) { return getIntervalForPeriod(days); }
    getLastTradingDay(date) { return getLastTradingDay(date); }

    // SINGLE SOURCE OF TRUTH : convertit le détail par ticker calculé par le moteur du
    // graphique (HistoryCalculator.calculateGenericHistory) en la map attendue par
    // calculateHoldings ({ yesterdayClose, todayValueOfYesterdayHoldings, currency }).
    // Fonction pure, pas d'I/O : ne fait que réexposer des valeurs déjà résolues.
    buildYesterdayCloseMapFromGraphData(graphData) {
        const map = new Map();
        const perTicker = graphData && graphData.perTickerYesterdayClose;
        const lastSession = graphData && graphData.perTickerLastSessionPerformance;
        const tickers = new Set([
            ...(perTicker ? perTicker.keys() : []),
            ...(lastSession ? lastSession.keys() : [])
        ]);
        tickers.forEach(ticker => {
            const entry = perTicker?.get(ticker);
            const display = lastSession?.get(ticker);
            if ((!entry || entry.yesterdayCloseTotal === null || entry.yesterdayCloseTotal === undefined) && !display) return;
            map.set(ticker, {
                yesterdayClose: entry?.yesterdayCloseTotal ?? null,
                todayValueOfYesterdayHoldings: entry?.todayValueOfYesterdayHoldingsTotal ?? null,
                quantityYesterday: entry?.quantityYesterday ?? null,
                currency: entry?.currency ?? display?.currency,
                displayDayChange: display?.dayChange ?? null,
                displayDayPct: display?.dayPct ?? null
            });
        });
        return map;
    }

    // Calcule yesterdayClose de tous les actifs en passant par le même moteur que le
    // graphique (calculateGenericHistory), pour garantir la cohérence avec le KPI "VAR TODAY".
    async calculateAllAssetsYesterdayClose(assetPurchases) {
        if (!assetPurchases || assetPurchases.length === 0) return new Map();
        console.log(`[calculateAllAssetsYesterdayClose] Calculating via graph engine for ${assetPurchases.length} purchases`);
        const graphData = await this.calculateGenericHistory(assetPurchases, 1, false);
        const yesterdayCloseMap = this.buildYesterdayCloseMapFromGraphData(graphData);
        console.log(`[calculateAllAssetsYesterdayClose] Completed. Map size: ${yesterdayCloseMap.size}`);
        return yesterdayCloseMap;
    }

    calculateCashReserve(allPurchases, dynamicRate = this.storage.getConversionRate('USD_TO_EUR')) {
        const { cash: cashMovements } = this.splitCanonicalPurchases(allPurchases);

        const byBroker = {};
        const byCurrency = {};
        const byBrokerCurrency = {};
        cashMovements.forEach(move => {
            // Même valeur par défaut que _buildPositionsByBrokerTicker ('RV-CT', pas
            // 'Unknown') : sinon un mouvement de cash sans broker explicite (ex: import
            // manuel) atterrit sous une clé différente de celle utilisée pour agréger
            // les positions du même courtier par défaut, et validatePortfolioConsistency
            // ne peut plus faire correspondre son cash à son broker.
            const broker = move.broker || 'RV-CT';
            const currency = move.currency || 'EUR';
            const amount = Number(move.price || 0) * Number(move.quantity ?? 1);
            byCurrency[currency] = (byCurrency[currency] || 0) + amount;
            const balances = byBrokerCurrency[broker] ||= {};
            balances[currency] = (balances[currency] || 0) + amount;
        });
        let total = 0;
        let fxUnavailable = false;
        for (const [broker, balances] of Object.entries(byBrokerCurrency)) {
            let value = 0;
            for (const [currency, amount] of Object.entries(balances)) {
                if (amount === 0) continue;
                const rate = currency === 'EUR' ? 1 : (currency === 'USD' ? dynamicRate : null);
                if (!Number.isFinite(rate) || rate <= 0) { value = null; fxUnavailable = true; break; }
                value += amount * rate;
            }
            byBroker[broker] = value;
            if (value !== null) total += value;
        }
        return { total: fxUnavailable ? null : total, byBroker, byCurrency, byBrokerCurrency, fxUnavailable };
    }

    // SINGLE SOURCE OF TRUTH pour un taux de change HISTORIQUE (date -> taux),
    // par opposition à getConversionRate() qui ne donne que le taux courant.
    // Ne pas fusionner les deux : un dividende versé il y a 6 mois doit être
    // converti au taux de CE jour-là, pas au taux d'aujourd'hui.
    // Utilisé par DividendManager pour convertir les dividendes USD -> EUR.
    async fetchHistoricalFxRateMap(pair = 'EURUSD=X', rangeYears = 5) {
        const rates = new Map();
        try {
            const ctrl = new AbortController();
            const timeoutId = setTimeout(() => ctrl.abort(), 15000);
            const url = `${PRICE_PROXY_URL}?symbol=${encodeURIComponent(pair)}&type=STOCK&range=${rangeYears}y&interval=1d`;
            const res = await fetchMarketResponse(url, 15000, 'fx-history', 86400000).finally(() => clearTimeout(timeoutId));
            if (!res.ok) return rates;

            const data = await res.json();
            const result = data.chart?.result?.[0];
            const timestamps = result?.timestamp;
            const quotes = result?.indicators?.quote?.[0]?.close;

            if (timestamps && quotes) {
                timestamps.forEach((ts, i) => {
                    if (Number.isFinite(quotes[i]) && quotes[i] > 0) {
                        const date = new Date(ts * 1000).toISOString().split('T')[0];
                        rates.set(date, quotes[i]);
                    }
                });
            }
        } catch (e) {
            console.warn('[fetchHistoricalFxRateMap] Rate fetch failed:', e.name === 'AbortError' ? 'timeout' : e.message);
        }
        return rates;
    }

    // SINGLE SOURCE OF TRUTH pour la map de taux USD/EUR HISTORIQUES utilisée pour
    // figer le coût EUR d'un ACHAT USD à SA date de transaction (jamais au taux
    // courant — voir _resolveHistoricalUsdToEurRate ci-dessous et invariant 9 :
    // une variation du taux courant ne doit jamais modifier rétroactivement
    // l'investi historique). Mémoïsée par plage d'années couverte (1h de cache) ;
    // Inclut les mouvements de cash et les titres cotés en USD même lorsque
    // leur transaction a été réglée en EUR.
    async getHistoricalFxMap(purchases, priceSnapshot = null) {
        const usdBuyDates = (purchases || [])
            .filter(p => {
                const quote = p.ticker ? (priceSnapshot ? priceSnapshot.get(p.ticker.toUpperCase()) : this.storage.getCurrentPrice(p.ticker)) : null;
                return p.date && (p.currency === 'USD' || quote?.currency === 'USD'
                    || quote?.originalCurrency === 'USD' || quote?.nativeQuote?.currency === 'USD');
            })
            .map(p => new Date(p.date))
            .filter(d => !isNaN(d.getTime()));

        if (usdBuyDates.length === 0) return new Map();

        const oldest = new Date(Math.min(...usdBuyDates.map(d => d.getTime())));
        const yearsNeeded = Math.min(20, Math.max(1, Math.ceil((Date.now() - oldest.getTime()) / (365 * 86400 * 1000)) + 1));

        if (this._historicalFxMapCache
            && this._historicalFxMapCache.rangeYears >= yearsNeeded
            && (Date.now() - this._historicalFxMapCache.fetchedAt) < 3600000) {
            return this._historicalFxMapCache.map;
        }

        // Coalescing : une requête déjà en vol qui couvre au moins autant
        // d'années est réutilisée telle quelle plutôt que d'en relancer une
        // seconde en parallèle (voir commentaire du constructeur).
        if (this._historicalFxMapInFlight && this._historicalFxMapInFlight.rangeYears >= yearsNeeded) {
            return this._historicalFxMapInFlight.promise;
        }

        const promise = this.fetchHistoricalFxRateMap('EURUSD=X', yearsNeeded).then(map => {
            if (map.size) this._historicalFxMapCache = { map, rangeYears: yearsNeeded, fetchedAt: Date.now() };
            return map;
        }).finally(() => { this._historicalFxMapInFlight = null; });
        this._historicalFxMapInFlight = { rangeYears: yearsNeeded, promise };
        return promise;
    }

    // Lecture SYNCHRONE de la dernière map FX historique déjà résolue (voir
    // getHistoricalFxMap ci-dessus) — pour les rendus synchrones (ex: sous-lignes
    // d'achat d'investmentsPage.js) qui ne peuvent pas attendre un nouvel appel
    // réseau. Retourne une Map vide tant qu'aucun appel async n'a encore résolu de
    // map pour cette session : le taux courant reste alors utilisé en repli
    // explicite (voir resolveHistoricalUsdToEurRate), jamais un taux inventé.
    getCachedHistoricalFxMap() {
        return this._historicalFxMapCache?.map || new Map();
    }

    // Thin wrapper — la logique elle-même vit dans MarketUtils.js
    // (resolveHistoricalUsdToEurRate) pour être partagée avec HistoryCalculator.js
    // sans deux implémentations indépendantes de la même règle.
    _resolveHistoricalUsdToEurRate(dateInput, historicalFxMap, fallbackRate, context = {}) {
        return resolveHistoricalUsdToEurRate(dateInput, historicalFxMap, fallbackRate, context);
    }

    // SINGLE SOURCE OF TRUTH pour l'accroissement immobilier (intérêts simples),
    // utilisé par calculateHoldings, calculateEnrichedPurchases et realEstateApp.js.
    // Formule : Investi * (Taux/100) * (Jours détenus / 365).
    calculateRealEstateAccrual(purchase, asOfDate = new Date()) {
        const yieldPct = purchase.yield || 0;
        const startDate = new Date(purchase.date);
        const daysHeld = Math.max(0, (asOfDate - startDate) / (1000 * 60 * 60 * 24));
        const invested = purchase.price * purchase.quantity;
        const accrued = invested * (yieldPct / 100) * (daysHeld / 365);
        return { invested, accrued, currentValue: invested + accrued, daysHeld };
    }

    // SINGLE SOURCE OF TRUTH pour le ledger de positions : construit des
    // positions ISOLÉES par (courtier, ticker) — jamais fusionnées entre
    // courtiers avant qu'une vente ne s'applique.
    //
    // BUG FOUND (architectural, confirmé) : l'ancien calculateHoldings
    // fusionnait directement par ticker seul. Une vente chez UN courtier
    // réduisait alors le coût de revient au prorata de la quantité FUSIONNÉE
    // (tous courtiers confondus), pas seulement celle de ce courtier. Exemple
    // réel : 10 AAPL @100€ chez A + 10 AAPL @200€ chez B (30€/action de coût
    // moyen fusionné sur 20 titres = 3000€), puis vente des 10 AAPL de A. Le
    // modèle fusionné réduisait l'investi de 50% (ratio = 10 vendus / 20
    // détenus) → 1500€ restants, alors que les 10 actions RÉELLEMENT encore
    // détenues (chez B, jamais touchées) avaient coûté 2000€ — un écart de
    // 500€ sur ce seul exemple, qui se répercutait autant sur le total
    // portefeuille que sur la ventilation par courtier (elles partagent la
    // même erreur, donc "les sommes tombaient juste" n'aurait rien prouvé).
    //
    // Fix : chaque (courtier, ticker) a sa propre quantité et son propre coût
    // de revient, mis à jour uniquement par LES ACHATS/VENTES DE CE COURTIER.
    // calculateHoldings (vue par ticker) et calculateByBroker (vue par
    // courtier) sont désormais deux agrégations DIFFÉRENTES des MÊMES
    // positions — jamais deux calculs indépendants — donc la somme des
    // courtiers égale le total du portefeuille par construction algébrique,
    // et le coût de revient de chaque courtier est réellement le sien.
    _buildPositionsByBrokerTicker(assetPurchases, dynamicRate, historicalFxMap = null) {
        const sorted = assetPurchases.filter(p => ['asset', 'realEstate'].includes(transactionKind(p)))
            .sort((a, b) => new Date(a.date) - new Date(b.date));
        const positions = new Map(); // key: `${broker}::${ticker}`

        sorted.forEach(p => {
            const ticker = p.ticker.toUpperCase();
            const broker = p.broker || 'RV-CT';
            const key = `${broker}::${ticker}`;
            if (!positions.has(key)) {
                positions.set(key, {
                    ticker, broker,
                    name: p.name,
                    assetType: p.assetType || 'Stock',
                    quantity: 0,
                    invested: 0,
                    purchases: []
                });
            }
            const pos = positions.get(key);
            const currency = p.currency || 'EUR';

            if (p.quantity > 0) {
                // ACHAT — le coût EUR est figé au taux du JOUR DE L'ACHAT (invariant 9),
                // jamais au taux courant : voir _resolveHistoricalUsdToEurRate.
                // FAIL-CLOSED : si aucun taux historique NI live valide → pas d'investi
                // inventé (fxUnavailable) ; la quantité est suivie pour diagnostic.
                const rate = currency === 'USD'
                    ? this._resolveHistoricalUsdToEurRate(p.date, historicalFxMap, dynamicRate, { ticker, broker })
                    : 1;
                if (currency === 'USD' && !(rate > 0)) {
                    console.warn(`[FX] Taux USD→EUR indisponible pour achat ${ticker}/${broker} du ${p.date} — fail-closed.`);
                    pos.fxUnavailable = true;
                    pos.quantity += p.quantity;
                    pos.purchases.push(p);
                    return;
                }
                pos.quantity += p.quantity;
                pos.invested += p.price * p.quantity * rate;
            } else {
                // VENTE — n'impacte QUE la position de ce courtier pour ce ticker
                const sellQty = Math.abs(p.quantity);
                const currentQty = pos.quantity;

                if (currentQty > 0) {
                    const ratio = sellQty / currentQty;
                    pos.invested -= (pos.invested * ratio);
                    pos.quantity -= sellQty;
                } else {
                    pos.quantity -= sellQty;
                }

                if (pos.quantity <= 0.0001) {
                    pos.quantity = 0;
                    pos.invested = 0;
                }
            }
            pos.purchases.push(p);
        });

        return [...positions.values()];
    }

    // Enrichit une position déjà agrégée (quantité + coût de revient) avec le
    // prix de marché courant : currentValue, gainEUR, gainPct, avgPrice,
    // dayChange. SEULE implémentation de cette logique — réutilisée à la fois
    // pour la vue par ticker (calculateHoldings, ci-dessous) et par courtier
    // (calculateByBroker), pour que les deux restent cohérentes par
    // construction plutôt que deux copies de la même formule.
    // `resolvedPrices` (optionnel) : Map ticker -> {price, currency, previousClose,
    // lastUpdate} déjà résolue par HistoryCalculator pour CE MÊME instant (voir
    // buildTodaySnapshot ci-dessous). Quand elle est fournie, on l'utilise à la
    // place d'une nouvelle lecture de storage.getCurrentPrice — sinon Total Value
    // (ici) et le dernier point du graphique (HistoryCalculator) peuvent lire le
    // prix "courant" à deux instants légèrement différents et donc deux valeurs
    // différentes pour le même ticker au même instant affiché (c'est la cause
    // racine de l'incohérence Fin/Total Value/tooltip — voir audit).
    // `invalidTickers` (optionnel, Set<ticker>) : audit "fail-closed" (incident
    // 2026-09-23, panne du proxy prix) — tickers pour lesquels le moteur
    // graphique (HistoryCalculator) a constaté un ÉCHEC RÉSEAU/HTTP de
    // récupération de l'historique (voir dataQuality.failedInstruments), pas
    // une simple absence de donnée. Pour CES tickers précisément, cette
    // fonction n'essaie même pas resolvedPrices/storage.getCurrentPrice : un
    // prix live PEUT très bien être disponible (les deux fetch — historique
    // et live — sont indépendants) mais l'utiliser ici reviendrait à combler
    // silencieusement un trou de donnée HISTORIQUE avec une donnée COURANTE —
    // exactement interdit par l'audit. currentValue/gainEUR/gainPct/dayChange/
    // dayPct restent `null` ("indisponible", déjà rendu comme tel par
    // formatCurrency/formatPercent) plutôt qu'une valeur plausible mais fausse.
    _enrichAggregatedPosition(ticker, data, dynamicRate, yesterdayCloseMap, resolvedPrices = null, invalidTickers = null) {
        if (invalidTickers && invalidTickers.has(ticker)) {
            const avgPriceEUR = (data.quantity > 0) ? data.invested / data.quantity : 0;
            return {
                ticker, name: data.name, assetType: data.assetType, quantity: data.quantity,
                avgPrice: avgPriceEUR, invested: data.invested,
                currentPrice: null, previousClose: null, currentValue: null,
                gainEUR: null, gainPct: null, dayChange: null, dayPct: null,
                displayDayChange: null, displayDayPct: null,
                yesterdayQuantity: null, weight: 0, purchases: data.purchases,
                priceDataUnavailable: true
            };
        }

        const d = quoteInEur(resolvedPrices?.get(ticker) || this.storage.getCurrentPrice(ticker) || {}, dynamicRate);
        const currency = d.currency || 'EUR';

        // FAIL-CLOSED FX : un prix encore en USD sans taux réel valide ne doit
        // jamais être multiplié par un taux inventé — même chemin que
        // priceDataUnavailable (agrégats portefeuille invalidés). Idem si le
        // coût de revient USD n'a pas pu être converti (fxUnavailable).
        if (data.fxUnavailable || d.fxUnavailable || (currency === 'USD' && !(dynamicRate > 0))) {
            const avgPriceEUR = (data.quantity > 0 && data.invested > 0) ? data.invested / data.quantity : 0;
            console.warn(`[FX] USD_TO_EUR indisponible pour ${ticker} — position marquée priceDataUnavailable.`);
            return {
                ticker, name: data.name, assetType: data.assetType, quantity: data.quantity,
                avgPrice: avgPriceEUR, invested: data.invested,
                currentPrice: null, previousClose: null, currentValue: null,
                gainEUR: null, gainPct: null, dayChange: null, dayPct: null,
                displayDayChange: null, displayDayPct: null,
                yesterdayQuantity: null, weight: 0, purchases: data.purchases,
                priceDataUnavailable: true
            };
        }

        // currentRate convertit le prix de marché courant pour les actifs USD
        // (ex: BKSY) — data.invested est déjà en EUR (converti achat par achat).
        const currentRate = (currency === 'USD') ? dynamicRate : 1;
        const previousClose = d.previousClose;

        let currentPrice = d.price;
        let currentValue = null;
        let investedEUR = data.invested;

        // DIAGNOSTIC — deux cas distincts, le premier bien plus grave que le
        // second :
        //
        // 1. AUCUN prix du tout (currentPrice absent) : ce titre est compté
        //    dans investedEUR (ci-dessous, inconditionnel) mais contribue 0 à
        //    currentValue/gainEUR — son Total Return est donc amputé de la
        //    TOTALITÉ de son montant investi, pas juste de son gain. C'est
        //    exactement ce qui arrive à un projet immobilier/crowdfunding mal
        //    étiqueté (assetType ≠ "Real Estate" exactement, ex. après un
        //    import CSV — voir csvWorker.js) dont le nom de projet se
        //    retrouve traité comme un ticker boursier introuvable (aucun prix
        //    ne pourra jamais se résoudre pour "Foncière Redland").
        // 2. Prix présent mais pas "frais" au sens de HistoryCalculator.js
        //    (qui ne réutilise le prix live pour le dernier point du jour que
        //    s'il a moins de 10 minutes, sinon retombe sur la bougie intraday
        //    la plus récente — cette fonction-ci n'a pas accès aux bougies,
        //    elle ne PEUT PAS appliquer la même règle) : écart plus faible,
        //    de l'ordre du prix, pas de l'investi entier.
        //
        // Permet d'identifier PRÉCISÉMENT quel(s) titre(s) expliquent un
        // écart entre une page utilisant calculateHoldings (Analytics,
        // Achats) et le Dashboard/Investments (moteur graphique), au lieu de
        // deviner sur le total global.
        if (data.assetType !== 'Real Estate') {
            if (!(currentPrice > 0)) {
                console.error(`[calculateHoldings] AUCUN PRIX pour "${ticker}" (assetType="${data.assetType}") — ${investedEUR.toFixed(2)}€ investis comptés dans le total mais 0€ de valeur de marché : le Total Return de cette page est amputé de ${investedEUR.toFixed(2)}€ à cause de ce seul titre. Si "${ticker}" est en réalité un projet immobilier/crowdfunding, corrige son Type d'actif (page Achats) sur exactement "Real Estate".`);
            } else {
                const ageMin = d.lastUpdate ? (Date.now() - d.lastUpdate) / 60000 : null;
                if (ageMin === null || ageMin > 10) {
                    console.warn(`[calculateHoldings] Prix possiblement périmé pour ${ticker} : ${ageMin === null ? 'jamais mis à jour' : ageMin.toFixed(1) + ' min'} — le Dashboard (moteur graphique) peut avoir choisi un prix différent pour ce même titre à cet instant.`);
                }
            }
        }

        // === SPECIAL LOGIC: REAL ESTATE ===
        // Real Estate assets don't have a market price. We calculate value based on linear interest.
        if (data.assetType === 'Real Estate') {
            let totalREValue = 0;
            let totalREInvested = 0;

            data.purchases.forEach(p => {
                // BUG DE CONCEPTION DOCUMENTÉ (audit invariants, non corrigé faute de
                // spécification produit) : contrairement aux actions/ETF/crypto, une
                // "vente" (quantité négative) sur une ligne Real Estate n'est PAS
                // réduite proportionnellement au coût de revient (voir
                // _buildPositionsByBrokerTicker) — calculateRealEstateAccrual applique
                // sa formule d'intérêts simples telle quelle à une quantité négative.
                // Le résultat n'est pas garanti cohérent avec l'invariant
                // currentValue - invested = return pour ce ticker. Un projet
                // immobilier n'est normalement jamais revendu par fraction dans ce
                // produit (durée figée, pas de marché secondaire) — ce garde-fou sert
                // à détecter le cas s'il survient plutôt que d'afficher un chiffre
                // silencieusement faux.
                if (p.quantity < 0) {
                    console.warn(`[RealEstate] Vente détectée sur "${ticker}" (broker ${p.broker}) — le modèle Real Estate ne réduit pas proportionnellement le coût de revient comme pour un actif coté. Vérifier manuellement "Investi"/"Valeur actuelle" pour ce ticker.`);
                }
                const { invested: pInvested, currentValue: pCurrentValue } = this.calculateRealEstateAccrual(p);
                totalREInvested += pInvested;
                totalREValue += pCurrentValue;
            });

            investedEUR = totalREInvested;
            currentValue = totalREValue;
            if (data.quantity > 0) {
                currentPrice = currentValue / data.quantity;
            }
        } else {
            currentValue = currentPrice ? currentPrice * data.quantity * currentRate : null;
        }

        const avgPriceEUR = (data.quantity > 0) ? investedEUR / data.quantity : 0;

        const currentValueEUR = currentValue ?? null;
        const gainEUR = currentValueEUR !== null ? currentValueEUR - investedEUR : null;
        const gainPct = investedEUR > 0 && gainEUR !== null ? (gainEUR / investedEUR) * 100 : null;

        let dayChange = null;
        let dayPct = null;
        let usedYesterdayCloseMap = false;
        // Quantité de référence effectivement utilisée pour dayChange — exposée
        // telle quelle (voir PortfolioSnapshot.positions[].yesterdayQuantity) pour
        // que le canonicalizer n'ait jamais à la redeviner : `null` tant qu'aucun
        // des deux chemins ci-dessous n'a pu la déterminer.
        let yesterdayQuantity = null;

        // LOGIQUE CORRIGÉE : Utiliser yesterdayCloseMap en priorité.
        // HistoryCalculator calcule finement la vraie clôture de la veille (ou le prix à minuit pour les cryptos)
        // en gérant les fallbacks Binance. yesterdayCloseMap contient la VALEUR TOTALE (prix * qty).
        if (yesterdayCloseMap && yesterdayCloseMap.has(ticker) && yesterdayCloseMap.get(ticker) !== null) {
            const mapEntry = yesterdayCloseMap.get(ticker);
            const yesterdayTotal = (typeof mapEntry === 'object') ? mapEntry.yesterdayClose : mapEntry;
            const todayYestQty = (typeof mapEntry === 'object') ? mapEntry.todayValueOfYesterdayHoldings : null;
            if (typeof mapEntry === 'object' && mapEntry.quantityYesterday != null) {
                yesterdayQuantity = mapEntry.quantityYesterday;
            }

            if (yesterdayTotal > 0 && currentValueEUR !== null) {
                const referenceCurrentValue = (todayYestQty !== null && todayYestQty > 0)
                    ? todayYestQty
                    : currentValueEUR;
                dayChange = referenceCurrentValue - yesterdayTotal;
                dayPct = (dayChange / yesterdayTotal) * 100;
                usedYesterdayCloseMap = true;
            } else if (yesterdayTotal === 0) {
                dayChange = 0;
                dayPct = 0;
                usedYesterdayCloseMap = true;
            }
        }

        // FALLBACK : Si yesterdayCloseMap n'a rien trouvé, on utilise storage.previousClose
        //
        // SECURITY/INTEGRITY FIX (audit P1) : cette branche défaultait
        // silencieusement `effectivePreviousClose` à `currentPrice` quand
        // `previousClose` était absent — produisant un Day P&L de 0,00€/0,00%
        // affiché comme un FAIT ("le titre n'a pas bougé") alors que la vraie
        // situation est "on ne sait pas". Depuis le fix de api.js
        // (previousCloseUnavailable), `previousClose` est désormais `null`
        // (pas `currentPrice`) exactement dans ce cas — donc `dayChange`/
        // `dayPct` restent à leur valeur initiale `null` ("indisponible",
        // déjà rendu comme tel par formatCurrency/formatPercent dans
        // investmentsPage.js) au lieu d'une fausse valeur plausible.
        if (!usedYesterdayCloseMap && currentPrice && currentPrice > 0 && previousClose && previousClose > 0) {
            // Repli MOINS précis (voir doc ci-dessus) : faute de connaître la
            // quantité réellement détenue hier, on retombe sur la quantité totale
            // d'aujourd'hui — un achat/vente intra-journée sur ce ticker précis
            // gonflera alors dayChange (voir buildTodaySnapshot/buildAssetTodaySnapshot,
            // qui fournissent tous deux désormais un yesterdayCloseMap précisément
            // pour éviter d'emprunter ce chemin en pratique).
            yesterdayQuantity = data.quantity;
            if (previousClose !== currentPrice) {
                dayPct = ((currentPrice - previousClose) / previousClose) * 100;
                dayChange = (currentPrice - previousClose) * data.quantity * currentRate;
            } else {
                dayChange = 0;
                dayPct = 0;
            }
        }

        // Metrique de presentation du tableau : pendant un jour ferme, le
        // moteur historique fournit la derniere seance cotee. La metrique
        // canonique dayChange reste intacte et continue seule d'alimenter la
        // Var Today et les agregats du portefeuille.
        const displayEntry = yesterdayCloseMap?.get(ticker);
        const displayDayChange = Number.isFinite(displayEntry?.displayDayChange)
            ? displayEntry.displayDayChange
            : dayChange;
        const displayDayPct = Number.isFinite(displayEntry?.displayDayPct)
            ? displayEntry.displayDayPct
            : dayPct;

        return {
            ticker,
            name: data.name,
            assetType: data.assetType,
            quantity: data.quantity,
            avgPrice: avgPriceEUR,
            invested: investedEUR,
            currentPrice: currentPrice ? currentPrice * currentRate : null,
            previousClose: previousClose ? previousClose * currentRate : null,
            currentValue: currentValueEUR,
            gainEUR,
            gainPct,
            dayChange,
            dayPct,
            displayDayChange,
            displayDayPct,
            yesterdayQuantity,
            weight: 0,
            purchases: data.purchases,
            priceDataUnavailable: false
        };
    }

    // SINGLE SOURCE OF TRUTH pour l'investi par courtier SANS valeur de marché
    // (pas d'appel réseau) — agrège les MÊMES positions (broker,ticker) que
    // calculateHoldings, jamais une resommation indépendante des transactions
    // brutes. Utilisée par assistantApp.js à la place de son ancienne boucle
    // `+= p.price * p.quantity` qui ne gérait ni la conversion FX, ni la
    // réduction proportionnelle du coût de revient sur une vente (voir audit).
    getInvestedByBroker(assetPurchases, historicalFxMap = null) {
        const dynamicRate = this.storage.getConversionRate('USD_TO_EUR'); // null = FX indisponible
        const positions = this._buildPositionsByBrokerTicker(assetPurchases, dynamicRate, historicalFxMap)
            .filter(pos => (pos.quantity || 0) > 0.0001);

        const byBroker = new Map();
        positions.forEach(pos => {
            if (!byBroker.has(pos.broker)) {
                byBroker.set(pos.broker, { broker: pos.broker, invested: 0, transactionsCount: 0, assets: new Set() });
            }
            const entry = byBroker.get(pos.broker);
            entry.invested += pos.invested;
            entry.transactionsCount += pos.purchases.length;
            entry.assets.add(pos.ticker);
        });
        return [...byBroker.values()];
    }

    // `priceSnapshot` (optionnel) : { dynamicRate, prices } déjà résolu par
    // buildTodaySnapshot() ci-dessous, pour que Total Value (ici) et le dernier
    // point du graphique (HistoryCalculator) partagent EXACTEMENT le même taux de
    // change et les mêmes prix "courants" — jamais deux lectures indépendantes de
    // storage à deux instants différents pour le même rendu. Sans snapshot fourni
    // (compatibilité des appelants existants), le comportement est inchangé :
    // lecture directe de storage à l'instant de l'appel.
    // `invalidTickers` (optionnel, Set<ticker>) : voir _enrichAggregatedPosition —
    // propagé tel quel, jamais recalculé ici.
    calculateHoldings(assetPurchases, yesterdayCloseMap = null, historicalFxMap = null, priceSnapshot = null, invalidTickers = null) {
        // FAIL-CLOSED FX : jamais de taux hardcodé — null si indisponible.
        const dynamicRate = priceSnapshot?.dynamicRate ?? this.storage.getConversionRate('USD_TO_EUR');
        const positions = this._buildPositionsByBrokerTicker(assetPurchases, dynamicRate, historicalFxMap);

        // Agrégation par TICKER (une ligne par actif, tous courtiers
        // confondus) — même vue qu'avant pour le tableau/les résumés, mais
        // calculée en sommant des positions par courtier déjà correctement
        // isolées, au lieu de fusionner dès le départ.
        const byTicker = new Map();
        positions.forEach(pos => {
            if (!byTicker.has(pos.ticker)) {
                byTicker.set(pos.ticker, { name: pos.name, assetType: pos.assetType, quantity: 0, invested: 0, purchases: [], fxUnavailable: false });
            }
            const agg = byTicker.get(pos.ticker);
            agg.quantity += pos.quantity;
            agg.invested += pos.invested;
            agg.purchases.push(...pos.purchases);
            if (pos.fxUnavailable) agg.fxUnavailable = true;
        });
        byTicker.forEach(agg => agg.purchases.sort((a, b) => new Date(a.date) - new Date(b.date)));

        return Array.from(byTicker.entries()).map(([ticker, data]) =>
            this._enrichAggregatedPosition(ticker, data, dynamicRate, yesterdayCloseMap, priceSnapshot?.prices, invalidTickers)
        );
    }

    calculateSummary(holdings) {
        let totalInvestedEUR = 0;
        let totalCurrentEUR = 0;
        let totalDayChangeEUR = 0;
        const assetTotalPerformances = [];
        const assetDayPerformances = [];
        // FAIL-CLOSED (audit incident 2026-09-23) : tickers dont le prix
        // n'a PAS pu être résolu à cause d'un échec RÉSEAU/HTTP confirmé (voir
        // _enrichAggregatedPosition/invalidTickers) — jamais une simple absence
        // de donnée par ailleurs déjà gérée (previousCloseUnavailable etc.).
        // Un seul suffit à invalider les AGRÉGATS portefeuille : une somme à
        // laquelle il manque un terme n'est pas "presque juste", elle est
        // fausse — jamais silencieusement traitée comme si ce terme valait 0.
        const unavailableInstruments = [];

        const sectorStats = {};

        holdings.forEach(asset => {
            totalInvestedEUR += asset.invested || 0; // coût de revient : jamais dépendant d'un prix, toujours fiable

            if (asset.priceDataUnavailable) {
                unavailableInstruments.push(asset.ticker);
            } else {
                totalCurrentEUR += asset.currentValue || 0;
                totalDayChangeEUR += asset.dayChange || 0;

                const type = asset.assetType || 'Other';
                if (!sectorStats[type]) {
                    sectorStats[type] = { value: 0, name: type };
                }
                sectorStats[type].value += (asset.currentValue || 0);
            }

            if (asset.currentValue !== null) {
                assetTotalPerformances.push({
                    ticker: asset.ticker,
                    name: asset.name,
                    gainPct: asset.gainPct || 0,
                    gain: asset.gainEUR || 0,
                    currentValue: asset.currentValue,
                    currentPrice: asset.currentPrice
                });

                assetDayPerformances.push({
                    ticker: asset.ticker,
                    name: asset.name,
                    dayPct: asset.dayPct || 0,
                    dayChange: asset.dayChange || 0
                });
            }
        });

        const hasUnavailableData = unavailableInstruments.length > 0;

        let bestSector = { name: '-', value: 0, pct: 0 };
        if (totalCurrentEUR > 0) {
            let maxVal = -1;
            Object.values(sectorStats).forEach(s => {
                if (s.value > maxVal) {
                    maxVal = s.value;
                    bestSector = {
                        name: s.name,
                        value: s.value,
                        pct: (s.value / totalCurrentEUR) * 100
                    };
                }
            });
        }

        const gainTotal = hasUnavailableData ? null : (totalCurrentEUR - totalInvestedEUR);
        const gainPct = hasUnavailableData ? null : (totalInvestedEUR > 0 ? (gainTotal / totalInvestedEUR) * 100 : 0);

        const totalPreviousCloseEUR = totalCurrentEUR - totalDayChangeEUR;
        const dayChangePct = hasUnavailableData ? null : (totalPreviousCloseEUR > 0
            ? (totalDayChangeEUR / totalPreviousCloseEUR) * 100
            : 0);

        const sortedTotal = assetTotalPerformances.sort((a, b) => b.gainPct - a.gainPct);
        const bestAsset = sortedTotal.length > 0 ? sortedTotal[0] : null;
        const worstAsset = sortedTotal.length > 0 ? sortedTotal[sortedTotal.length - 1] : null;

        const sortedDay = assetDayPerformances.sort((a, b) => b.dayPct - a.dayPct);
        const bestDayAsset = sortedDay.length > 0 ? sortedDay[0] : null;
        const worstDayAsset = sortedDay.length > 0 ? sortedDay[sortedDay.length - 1] : null;

        return {
            totalInvestedEUR,
            totalCurrentEUR: hasUnavailableData ? null : totalCurrentEUR,
            totalDayChangeEUR: hasUnavailableData ? null : totalDayChangeEUR,
            gainTotal,
            gainPct,
            dayChangePct,
            bestAsset,
            worstAsset,
            bestDayAsset,
            worstDayAsset,
            // SINGLE SOURCE OF TRUTH pour les cartes "Top Gainer/Top Loser" (top/bottom
            // 3), pour que dashboardApp.js n'ait plus besoin de re-trier holdings lui-même.
            topPerformers: sortedTotal.slice(0, 3),
            worstPerformers: sortedTotal.slice(-3).reverse(),
            topSector: bestSector,
            assetsCount: holdings.length,
            movementsCount: holdings.reduce((sum, h) => sum + h.purchases.length, 0),
            // FAIL-CLOSED — voir buildPortfolioSnapshot, qui traduit ceci en
            // snapshot.status/invalidReason/invalidInstruments.
            dataQuality: {
                valid: !hasUnavailableData,
                reason: hasUnavailableData ? 'PRICE_DATA_UNAVAILABLE' : null,
                failedInstruments: unavailableInstruments
            }
        };
    }

    calculateEnrichedPurchases(filteredPurchases, historicalFxMap = null) {
        const dynamicRate = this.storage.getConversionRate('USD_TO_EUR'); // null = FX indisponible

        return filteredPurchases.map(p => {
            if (p.assetType === 'Cash') {
                const rate = p.currency === 'USD'
                    ? this._resolveHistoricalUsdToEurRate(p.date, historicalFxMap, dynamicRate, { ticker: p.ticker, broker: p.broker }) : 1;
                return {
                    ...p,
                    currency: p.currency || 'EUR',
                    currentPriceOriginal: null,
                    buyPriceOriginal: p.price,
                    currentPriceEUR: null,
                    investedEUR: null,
                    currentValueEUR: null,
                    gainEUR: rate > 0 ? p.price * (p.quantity ?? 1) * rate : null,
                    gainPct: null
                };
            }

            // === SPECIAL LOGIC: REAL ESTATE ===
            if (p.assetType === 'Real Estate') {
                const { invested, accrued, currentValue: currentVal } = this.calculateRealEstateAccrual(p);

                return {
                    ...p,
                    assetType: 'Real Estate',
                    broker: p.broker,
                    currency: p.currency || 'EUR',
                    currentPriceOriginal: currentVal / p.quantity, // Simulated unit price
                    buyPriceOriginal: p.price,
                    currentPriceEUR: currentVal / p.quantity,
                    investedEUR: invested,
                    currentValueEUR: currentVal,
                    gainEUR: accrued,
                    gainPct: (accrued / invested) * 100
                };
            }

            const t = p.ticker.toUpperCase();
            const d = quoteInEur(this.storage.getCurrentPrice(t) || {}, dynamicRate);
            const assetCurrency = p.currency || 'EUR';
            const currentPriceOriginal = assetCurrency === 'USD'
                ? (d.nativeQuote?.price ?? (dynamicRate > 0 && d.price != null ? d.price / dynamicRate : null)) : d.price ?? null;
            const buyPriceOriginal = p.price;

            // The display price retains the transaction's units; valuation is EUR.
            const currentPriceEUR = d.price ?? null;
            // buyPriceOriginal is in p.currency (original purchase currency, never converted by storage).
            // Figé au taux DE CETTE TRANSACTION (invariant 9) — jamais au taux courant,
            // sinon "Investi" bouge tout seul quand le taux change sans nouvelle transaction.
            const buyRate = p.currency === 'USD'
                ? this._resolveHistoricalUsdToEurRate(p.date, historicalFxMap, dynamicRate, { ticker: t, broker: p.broker })
                : 1;
            // FAIL-CLOSED FX : pas d'investi EUR inventé.
            if (d.fxUnavailable || (p.currency === 'USD' && !(buyRate > 0))) {
                return {
                    ...p,
                    assetType: p.assetType || 'Stock',
                    broker: p.broker || 'RV-CT',
                    currency: assetCurrency,
                    currentPriceOriginal,
                    buyPriceOriginal,
                    currentPriceEUR: null,
                    investedEUR: null,
                    currentValueEUR: null,
                    gainEUR: null,
                    gainPct: null,
                    fxUnavailable: true
                };
            }
            const buyPriceEUR = buyPriceOriginal * buyRate;

            const investedEUR = buyPriceEUR * p.quantity;
            const currentValueEUR = currentPriceEUR ? currentPriceEUR * p.quantity : null;
            const gainEUR = currentValueEUR !== null ? currentValueEUR - investedEUR : null;
            const gainPct = investedEUR > 0 && gainEUR !== null ? (gainEUR / investedEUR) * 100 : null;

            return {
                ...p,
                assetType: p.assetType || 'Stock',
                broker: p.broker || 'RV-CT',
                currency: assetCurrency,
                currentPriceOriginal,
                buyPriceOriginal,
                currentPriceEUR,
                investedEUR,
                currentValueEUR,
                gainEUR,
                gainPct
            };
        });
    }

    generateFullReport(purchases, yesterdayCloseMap = null, historicalFxMap = null) {
        // Exclude Dividends from Asset Holdings
        const assetPurchases = purchases.filter(p => {
            const type = (p.assetType || 'Stock').toLowerCase();
            return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend';
        });
        // Include Dividends in Cash Purchases (so they appear in Cash Reserve, if logic supports it)
        const cashPurchases = purchases.filter(p => {
            const type = (p.assetType || 'Stock').toLowerCase();
            return type === 'cash' || type === 'dividend' || p.type === 'dividend';
        });

        let holdings = this.calculateHoldings(assetPurchases, yesterdayCloseMap, historicalFxMap);

        // CRITICAL FIX: Filter out zero-quantity holdings (fully sold assets)
        // This prevents sold assets from appearing in analytics and causing errors
        holdings = holdings.filter(h => (h.quantity || 0) > 0.0001);

        // Analytics deliberately includes Real Estate in its headline Total
        // Return (unlike Dashboard/Investments) — it's the one page meant to
        // show the WHOLE portfolio in one number. Reverted the exclusion I
        // added here earlier; see calculateHoldings's diagnostic logging
        // instead for the actual ~285-300€ gap this page can still show vs
        // Dashboard's own Total Return (a stock-side price-source difference,
        // not a Real Estate scope issue — see notes in _enrichAggregatedPosition).
        const summary = this.calculateSummary(holdings);
        const cashReserve = this.calculateCashReserve(cashPurchases);

        const dividendsReceived = cashPurchases
            .filter(p => (p.assetType || '').toLowerCase() === 'dividend' || p.type === 'dividend')
            .reduce((sum, p) => sum + (p.price || 0) * (p.quantity || 1), 0);

        return this.generateReportFromResolvedState(holdings, summary, cashReserve, dividendsReceived);
    }

    generateReportFromResolvedState(holdings, summary, cashReserve, dividendsReceived = 0) {
        // Reporting metadata must never mutate the repository's cached snapshot.
        const reportHoldings = holdings.map(asset => ({
            ...asset,
            weight: summary.totalCurrentEUR > 0 ? (asset.currentValue / summary.totalCurrentEUR) * 100 : 0
        }));
        const performance = this.analyzePerformance(reportHoldings);
        return {
            summary: {
                totalValue: summary.totalCurrentEUR,
                totalInvested: summary.totalInvestedEUR,
                totalGain: summary.gainTotal,
                totalGainPct: summary.gainPct,
                dayChange: summary.totalDayChangeEUR,
                dayChangePct: summary.dayChangePct,
                cashReserve: cashReserve.total,
                dividendsReceived,
                winRate: performance.winRate  // Add winRate to summary
            },
            diversification: this.calculateDiversification(reportHoldings),
            performance: performance,  // Use already calculated performance
            risk: this.calculateRisk(reportHoldings),
            assets: reportHoldings,
            generatedAt: new Date().toISOString()
        };
    }

    splitCanonicalPurchases(purchases) {
        return splitTransactions(purchases);
    }

    getAssetHistoryPurchases(purchases, ticker) {
        return assetHistoryTransactions(purchases, ticker);
    }

    getPeriodPerformance(graph, options) {
        return periodPerformance(graph, options);
    }

    getCanonicalMarketSnapshot(purchases, options = {}) {
        const { assets, cash } = this.splitCanonicalPurchases(purchases);
        return this.repository.getSnapshot(assets, cash, options);
    }

    async buildAnalyticsSnapshot(purchases, marketResult) {
        const { realEstate } = this.splitCanonicalPurchases(purchases);
        const marketEngine = marketResult.snapshot._engine;
        const realEstateFx = realEstate.length ? await this.getHistoricalFxMap(realEstate) : new Map();
        const realEstateHoldings = realEstate.length
            ? this.calculateHoldings(realEstate, null, realEstateFx).filter(h => (h.quantity || 0) > 0.0001)
            : [];
        const holdings = [...marketEngine.holdings, ...realEstateHoldings];
        const summary = this.calculateSummary(holdings);
        const cashReserve = marketEngine.cashReserve;
        const portfolioSnapshot = this.buildPortfolioSnapshot({
            holdings, summary, cashReserve,
            snapshotStartedAt: marketResult.snapshot.portfolioSnapshot.snapshotStartedAt,
            pricesTimestamp: marketResult.snapshot.portfolioSnapshot.pricesTimestamp,
            priceStatus: {
                staleInstruments: marketResult.snapshot.portfolioSnapshot.staleInstruments,
                refreshErrors: marketResult.snapshot.portfolioSnapshot.refreshErrors
            },
            meta: { mode: 'analytics', includesRealEstate: true, marketSnapshotId: marketResult.snapshot.snapshotId }
        });
        return { holdings, summary, cashReserve, portfolioSnapshot, realEstateHoldings };
    }

    async _buildBrokerSnapshots(purchases) {
        const { assets } = this.splitCanonicalPurchases(purchases);
        const prices = new Map([...new Set(assets.map(p => p.ticker.toUpperCase()))]
            .map(ticker => [ticker, this.storage.getCurrentPrice(ticker)]));
        const brokers = [...new Set(purchases.map(p => p.broker || 'RV-CT'))];
        return Promise.all(brokers.map(async broker => {
            const rows = purchases.filter(p => (p.broker || 'RV-CT') === broker);
            const { assets, cash } = this.splitCanonicalPurchases(rows);
            const result = await this.buildTodaySnapshot(assets, cash, prices);
            return { broker, snapshot: result.portfolioSnapshot };
        }));
    }

    // Broker details select the same live metrics as the portfolio cards.
    // Period returns belong to getPeriodPerformance, never to this snapshot.
    async calculateReturnByBroker(purchases) {
        const results = await this._buildBrokerSnapshots(purchases);
        return results.map(({ broker, snapshot }) => ({
            broker, invested: snapshot.invested, totalReturn: snapshot.totalReturn,
            totalReturnPct: snapshot.totalReturnPct, totalValue: snapshot.totalValue, cash: snapshot.cash
        })).sort((a, b) => (b.totalValue ?? -Infinity) - (a.totalValue ?? -Infinity));
    }

    async calculateDayChangeByBroker(purchases) {
        const results = await this._buildBrokerSnapshots(purchases);
        return results.map(({ broker, snapshot }) => ({
            broker, dayChange: snapshot.dayPnl, dayChangePct: snapshot.dayPnlPct
        }));
    }

    calculateDiversification(holdings) {
        const herfindahl = holdings.reduce((sum, asset) => sum + Math.pow(asset.weight / 100, 2), 0);
        const effectiveAssets = herfindahl > 0 ? 1 / herfindahl : 0;
        const maxDiversity = holdings.length;
        const diversityScore = maxDiversity > 0 ? (effectiveAssets / maxDiversity) * 100 : 0;
        return { herfindahl: herfindahl.toFixed(4), effectiveAssets: effectiveAssets.toFixed(2), diversityScore: diversityScore.toFixed(1), totalAssets: holdings.length, recommendation: this.getDiversificationAdvice(diversityScore, holdings.length) };
    }
    getDiversificationAdvice(score, assetCount) {
        if (assetCount < 5) return 'Portfolio très concentré.';
        if (score < 30) return 'Diversification faible.';
        if (score < 60) return 'Diversification moyenne.';
        if (score < 80) return 'Bonne diversification.';
        return 'Excellente diversification.';
    }
    analyzePerformance(holdings) {
        const sorted = [...holdings].sort((a, b) => b.gainPct - a.gainPct);
        const winners = sorted.filter(a => a.gainPct > 0);
        const losers = sorted.filter(a => a.gainPct < 0);
        const avgGain = holdings.length > 0 ? holdings.reduce((sum, a) => sum + (a.gainPct || 0), 0) / holdings.length : 0;
        const winRate = holdings.length > 0 ? (winners.length / holdings.length) * 100 : 0;
        return { topPerformers: sorted.slice(0, 3), worstPerformers: sorted.slice(-3).reverse(), winners: winners.length, losers: losers.length, avgGain: avgGain.toFixed(2), winRate: winRate.toFixed(1), summary: 'Performance analysée' };
    }
    calculateRisk(holdings) {
        if (holdings.length === 0) return { volatility: '0.00', maxDrawdown: '0.00', riskLevel: 'N/A', recommendation: 'Aucune donnée.' };
        const returns = holdings.map(a => a.gainPct || 0);
        const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
        const volatility = Math.sqrt(variance);
        const maxDrawdown = Math.min(...returns.map(r => Math.min(r, 0)));
        return { volatility: volatility.toFixed(2), maxDrawdown: maxDrawdown.toFixed(2), riskLevel: volatility < 15 ? 'Faible' : 'Élevé', recommendation: 'Risque calculé' };
    }

    // === DIAGNOSTIC — LECTURE SEULE, NE MODIFIE JAMAIS LES DONNÉES ===
    //
    // Vérifie les invariants comptables du cahier des charges à partir des MÊMES
    // positions (broker,ticker) que calculateHoldings/calculateSummary — jamais un
    // recalcul séparé. Permet de diagnostiquer immédiatement un futur écart plutôt
    // que de deviner sur les totaux affichés. `assetPurchases`/`cashPurchases` sont
    // déjà le sous-ensemble pertinent (après filtres broker/ticker/type éventuels —
    // voir investmentsPage.getFilteredPurchasesFromPage) : le retour reflète alors
    // les invariants POUR CE SOUS-ENSEMBLE, pas nécessairement le portefeuille entier.
    validatePortfolioConsistency(assetPurchases, cashPurchases = [], historicalFxMap = null, tolerance = 0.01) {
        const dynamicRate = this.storage.getConversionRate('USD_TO_EUR'); // null = FX indisponible

        const holdings = this.calculateHoldings(assetPurchases, null, historicalFxMap)
            .filter(h => (h.quantity || 0) > 0.0001);
        const summary = this.calculateSummary(holdings);
        const cashReserve = this.calculateCashReserve(cashPurchases || []);

        // Ventilation par courtier : ré-agrège les positions déjà isolées par
        // _buildPositionsByBrokerTicker (même source que calculateHoldings), jamais
        // un second calcul indépendant — la valeur de marché de chaque position
        // vient de _enrichAggregatedPosition, la MÊME fonction que calculateHoldings
        // utilise pour la vue par ticker.
        const positions = this._buildPositionsByBrokerTicker(assetPurchases, dynamicRate, historicalFxMap)
            .filter(pos => (pos.quantity || 0) > 0.0001);

        const byBrokerMap = new Map();
        positions.forEach(pos => {
            if (!byBrokerMap.has(pos.broker)) {
                byBrokerMap.set(pos.broker, { broker: pos.broker, invested: 0, currentValue: 0, return: 0, cash: 0 });
            }
            const entry = byBrokerMap.get(pos.broker);
            const enriched = this._enrichAggregatedPosition(pos.ticker, pos, dynamicRate, null);
            entry.invested += pos.invested || 0;
            entry.currentValue += enriched.currentValue || 0;
            entry.return += (enriched.currentValue || 0) - (pos.invested || 0);
        });

        // Inclut les courtiers qui ne détiennent QUE du cash (aucune position actif).
        Object.keys(cashReserve.byBroker || {}).forEach(broker => {
            if (!byBrokerMap.has(broker)) {
                byBrokerMap.set(broker, { broker, invested: 0, currentValue: 0, return: 0, cash: 0 });
            }
        });
        byBrokerMap.forEach((entry, broker) => {
            entry.cash = (cashReserve.byBroker || {})[broker] || 0;
            entry.totalValue = entry.currentValue + entry.cash;
        });

        const byBroker = [...byBrokerMap.values()];
        const sum = (key) => byBroker.reduce((s, b) => s + (b[key] || 0), 0);

        const global = {
            invested: summary.totalInvestedEUR || 0,
            currentValue: summary.totalCurrentEUR || 0,
            return: summary.gainTotal || 0,
            cash: cashReserve.total || 0,
            totalValue: (summary.totalCurrentEUR || 0) + (cashReserve.total || 0)
        };

        const differences = {
            // Invariants 1-3 : global vs somme des courtiers.
            invested: global.invested - sum('invested'),
            currentValue: global.currentValue - sum('currentValue'),
            return: global.return - sum('return'),
            cash: global.cash - sum('cash'),
            totalValue: global.totalValue - sum('totalValue'),
            // Invariant 4 : return === currentValue - invested.
            returnVsValueMinusInvested: global.return - (global.currentValue - global.invested),
            // Invariant 6 : totalValue === invested + return + cash.
            totalValueVsInvestedPlusReturnPlusCash: global.totalValue - (global.invested + global.return + global.cash)
        };

        const valid = Object.values(differences).every(d => Math.abs(d) <= tolerance);

        return { global, byBroker, differences, valid };
    }

    async calculateHistory(purchases, days) {
        const { assets, cash } = this.splitCanonicalPurchases(purchases);
        return this.calculateGenericHistory([...assets, ...cash], days, false);
    }

    async calculateAssetHistory(ticker, days) {
        const purchases = this.getAssetHistoryPurchases(this.storage.getPurchases(), ticker);
        if (purchases.length === 0) return { labels: [], invested: [], values: [], yesterdayClose: null, unitPrices: [], purchasePoints: [], twr: [] };
        return this.calculateGenericHistory(purchases, days, true);
    }

    // === NOUVEAU : Calcul pour un Indice pur (Pour le Dashboard) ===
    async calculateIndexData(ticker, days) {
        const interval = getIntervalForPeriod(days);

        const today = new Date();
        const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999));
        const endTs = Math.floor(todayUTC.getTime() / 1000);

        let startTs;
        if (days === 'ytd') {
            startTs = Math.floor(Date.UTC(today.getUTCFullYear(), 0, 1) / 1000);
        } else if (days === 'all') {
            // An index has no portfolio opening transaction to define "All".
            // Ten years is the explicit product horizon instead of the former
            // silent one-year fallback.
            startTs = endTs - (10 * 365 * 24 * 60 * 60);
        } else {
            const numericDays = Number(days);
            const safeDays = Number.isFinite(numericDays) && numericDays > 0 ? numericDays : 365;
            startTs = endTs - (safeDays * 24 * 60 * 60);
            if (safeDays === 1) startTs -= 2 * 60 * 60;
        }

        const hist = await this.getHistoryWithCache(ticker, startTs, endTs, interval);

        const sortedTs = Object.keys(hist).map(Number).sort((a, b) => a - b);
        const labels = [];
        const values = [];
        const labelFn = getLabelFormat(days);

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const startOfDayTs = startOfDay.getTime();

        const filteredTs = (days === 1)
            ? sortedTs.filter(ts => ts >= startOfDayTs)
            : sortedTs;

        filteredTs.forEach(ts => {
            labels.push(labelFn(ts));
            values.push(hist[ts]);
        });

        const priceData = this.storage.getCurrentPrice(ticker);
        const trueYesterdayClose = priceData?.previousClose || null;

        return {
            labels: labels,
            values: values,
            invested: [],
            unitPrices: values,
            purchasePoints: [],
            truePreviousClose: trueYesterdayClose // IMPORTANT : Exposed for ChartKPIManager
        }
    }

    // Freshness of the prices actually used for "now" (resolvedPrices of the
    // engine's last point): the oldest real quote date and the instruments
    // whose refresh failed while an older validated quote was kept.
    resolvePriceStatus(resolvedPrices) {
        const staleInstruments = [];
        const refreshErrors = {};
        let oldestQuoteAt = null;
        for (const [ticker, quote] of resolvedPrices || []) {
            if (Number.isFinite(quote?.lastUpdate)) oldestQuoteAt = Math.min(oldestQuoteAt ?? Infinity, quote.lastUpdate);
            if (quote?.stale) {
                staleInstruments.push(ticker);
                refreshErrors[ticker] = quote.refreshError || 'Market refresh failed';
            }
        }
        return { oldestQuoteAt, staleInstruments, refreshErrors };
    }

    // Instruments to price for a period: held at its reference close or traded
    // since (see HistoryCalculator._selectHeldTickers). Same ledger split as
    // buildTodaySnapshot, so the snapshot fetches exactly what it values.
    requiredMarketTickers(purchases, days = 1) {
        const { assets, cash } = this.splitCanonicalPurchases(purchases);
        return this.historyCalculator.requiredMarketTickers([...assets, ...cash], days);
    }

    // === SMART SYNC (Délégué) ===
    async getHistoryWithCache(ticker, startTs, endTs, interval) {
        return this.historyCalculator.getHistoryWithCache(ticker, startTs, endTs, interval);
    }

    // `dynamicRateOverride`/`historicalFxMapOverride` : quand fournis (voir
    // buildTodaySnapshot ci-dessous), on saute la résolution habituelle et on
    // utilise EXACTEMENT le taux déjà figé par l'appelant pour ce rendu — pour
    // que le graphique et calculateHoldings ne puissent jamais lire le taux
    // courant à deux instants différents.
    // `debugCapture` (INSTRUMENTATION TEMPORAIRE) : passthrough vers
    // HistoryCalculator.calculateGenericHistory — voir sa propre doc. null par
    // défaut, aucun appelant existant ne le fournit, comportement inchangé.
    // `livePriceSnapshot` (Option C, voir buildTodaySnapshot) : passthrough pur
    // — si fourni, HistoryCalculator ne fait plus AUCUNE lecture de
    // storage.getCurrentPrice() pour une valeur de prix ; sinon (autres
    // appelants : mode actif, calculateAssetHistory, calculateIndexData...),
    // HistoryCalculator capture lui-même son propre snapshot, comme avant.
    async calculateGenericHistory(purchases, days, isSingleAsset = false, dynamicRateOverride = null, historicalFxMapOverride = null, debugCapture = null, livePriceSnapshot = null) {
        dynamicRateOverride ??= this.storage.getConversionRate('USD_TO_EUR');
        livePriceSnapshot ??= new Map([...new Set(purchases.map(p => p.ticker.toUpperCase()))]
            .map(t => [t, this.storage.getCurrentPrice(t)]));
        // Le coût de revient du graphique (tooltip "Investi") doit être figé au même
        // taux historique que calculateHoldings pour la même transaction — sinon le
        // tooltip peut afficher un "Investi" différent du KPI "Investi" affiché juste
        // au-dessus, pour la même date, à cause du seul taux de change (invariant 9).
        const historicalFxMap = historicalFxMapOverride ?? await this.getHistoricalFxMap(purchases, livePriceSnapshot);
        const finish = marketDataMetrics.startCalculation();
        return this.historyCalculator.calculateGenericHistory(purchases, days, isSingleAsset, historicalFxMap, dynamicRateOverride, debugCapture, livePriceSnapshot).finally(finish);
    }

    // ============================================================
    // SINGLE SOURCE OF TRUTH — SNAPSHOT FINANCIER "MAINTENANT"
    // ============================================================
    //
    // Cause racine (audit) : Total Value/Fin du graphique/tooltip du dernier
    // point/Clôture hier/Var Today étaient chacun capables de lire
    // storage.getCurrentPrice()/getConversionRate() à un instant légèrement
    // différent — HistoryCalculator (le graphique) et calculateHoldings (Total
    // Value) sont deux moteurs distincts qui, jusqu'ici, résolvaient chacun sa
    // propre idée de "maintenant". Un prix live rafraîchi entre les deux
    // lectures (ou un ticker dont le live est périmé >10min pour l'un mais pas
    // pour l'autre) produisait deux valorisations différentes du MÊME instant —
    // c'est ce qui rendait "Fin"/le tooltip du dernier point incohérents avec
    // la carte "Total Value"/"Var Today", même si chaque nombre pris
    // isolément était calculé correctement.
    //
    // Fix structurel : UNE seule fonction construit "l'état financier
    // maintenant" pour toute l'UI. Elle résout le graphique EN PREMIER — lui
    // seul sait retomber sur la dernière bougie si le prix live d'un ticker
    // est périmé (>10min), au lieu de fabriquer un faux dernier point — PUIS
    // réutilise EXACTEMENT les prix et le taux de change que le graphique
    // vient de résoudre (HistoryCalculator expose son propre "resolvedPrices",
    // construit à partir de ce qu'il a réellement utilisé pour son dernier
    // point) pour calculer holdings/summary/cash. Il n'existe plus de second
    // jeu de données pour le même instant : Total Value EST, par construction
    // algébrique, la valeur du dernier point du graphique "aujourd'hui".
    //
    // `snapshotStartedAt` est capturé AVANT tout await : un appelant peut s'en
    // servir pour ignorer un résultat plus ancien arrivé après un plus récent
    // (voir portfolioKPIs.updateFromGraph et historicalChart.js::update()).
    //
    // `livePriceSnapshot` (Option C — course entre historicalChart.update() et
    // dashboardApp.loadPortfolioData(), tous deux appelant fetchBatchPrices()
    // indépendamment) : quand fourni par le caller, il a été capturé
    // IMMÉDIATEMENT après SON PROPRE fetchBatchPrices, sans aucun await entre
    // les deux (voir historicalChart.js::update()) — c'est la source de vérité
    // pour ce rendu, transmise telle quelle jusqu'à HistoryCalculator sans
    // repasser par storage.getCurrentPrice() ici. Sans lui (autres appelants),
    // le comportement précédent est conservé à l'identique.
    async buildTodaySnapshot(assetPurchases, cashPurchases = [], livePriceSnapshot = null) {
        const snapshotStartedAt = Date.now();
        ({ assets: assetPurchases, cash: cashPurchases } = this.splitCanonicalPurchases([...assetPurchases, ...cashPurchases]));
        livePriceSnapshot ??= new Map([...new Set(assetPurchases.map(p => p.ticker.toUpperCase()))]
            .map(t => [t, this.storage.getCurrentPrice(t)]));
        // FAIL-CLOSED FX : jamais de taux hardcodé (ex. ancien 0.925).
        const dynamicRate = this.storage.getConversionRate('USD_TO_EUR');
        const historicalFxMap = await this.getHistoricalFxMap([...assetPurchases, ...cashPurchases], livePriceSnapshot);

        const todayGraphData = await this.calculateGenericHistory(
            [...assetPurchases, ...cashPurchases], 1, false, dynamicRate, historicalFxMap, null, livePriceSnapshot
        );

        // BUG FOUND (audit cohérence KPI/tableau, root cause) : ce `null` faisait
        // retomber CHAQUE ligne du tableau (mode portefeuille — le chemin
        // réellement utilisé au quotidien) sur le repli de _enrichAggregatedPosition
        // qui valorise (currentPrice - previousClose) × la quantité TOTALE
        // D'AUJOURD'HUI, jamais celle détenue hier. Un achat/vente survenu dans
        // la journée sur UN SEUL ticker gonflait alors le "DAY P&L" de CE ticker
        // (et donc Σ totalDayChangeEUR, donc Var Today) de (variation de prix) ×
        // (quantité achetée/vendue aujourd'hui) — un cash-flow transformé en P&L
        // apparent, exactement l'invariant 4 de l'audit. yesterdayCloseMap
        // (calculé ci-dessous, PUR — perTickerYesterdayClose est déjà résolu
        // dans todayGraphData, aucun appel réseau supplémentaire) porte la
        // quantité réellement DÉTENUE HIER par ticker et fait déjà emprunter le
        // chemin cash-flow-immune de _enrichAggregatedPosition (voir
        // HistoryCalculator, qtyYesterday) — c'est déjà ce qu'utilise le mode
        // actif unique (historicalChart.js) ; buildTodaySnapshot, qui alimente
        // le mode portefeuille, était le seul appelant à ne pas le brancher.
        const yesterdayCloseMap = this.buildYesterdayCloseMapFromGraphData(todayGraphData);
        // FAIL-CLOSED (audit incident 2026-09-23) : tickers pour lesquels
        // todayGraphData a constaté un échec réseau/HTTP confirmé (voir
        // HistoryCalculator::calculateGenericHistory, dataQuality) — jamais
        // resolvedPrices/storage.getCurrentPrice pour EUX, voir
        // _enrichAggregatedPosition.
        const invalidTickers = new Set(todayGraphData.dataQuality?.failedInstruments || []);
        const holdings = this.calculateHoldings(assetPurchases, yesterdayCloseMap, historicalFxMap, {
            dynamicRate, prices: todayGraphData.resolvedPrices
        }, invalidTickers);
        const summary = this.calculateSummary(holdings);
        const cashReserve = this.calculateCashReserve(cashPurchases, dynamicRate);

        // PortfolioSnapshot canonique (audit architecture SSOT) — ajouté en
        // plus des champs existants (jamais en remplacement : tous les
        // appelants/tests déjà écrits contre todayGraphData/holdings/summary/
        // cashReserve continuent de fonctionner à l'identique). C'est CE
        // champ que historicalChart.js doit désormais lire pour produire ses
        // KPI — voir _computeAggregateKPIs.
        const priceStatus = this.resolvePriceStatus(todayGraphData.resolvedPrices);
        const portfolioSnapshot = this.buildPortfolioSnapshot({
            holdings, summary, cashReserve, snapshotStartedAt,
            pricesTimestamp: priceStatus.oldestQuoteAt, priceStatus,
            meta: { mode: 'portfolio' }
        });

        return { snapshotStartedAt, dynamicRate, historicalFxMap, todayGraphData, holdings, summary, cashReserve, portfolioSnapshot };
    }

    // ============================================================
    // MODE ACTIF UNIQUE — extrait de historicalChart.js (audit architecture :
    // un fichier de VUE ne doit pas produire lui-même un résumé/PortfolioSnapshot
    // — voir section 4 de l'audit). Prend en entrée un `todayGraphData` DÉJÀ
    // résolu par l'appelant (via _resolveTodayData, dont la logique de choix
    // d'appel réseau selon la période affichée n'a PAS été rapatriée ici —
    // c'est de l'orchestration de fetch, pas un calcul financier, et la
    // dupliquer ici aurait risqué de subtilement changer son comportement
    // pour les périodes ≠ 1 jour). Ne fait que canonicaliser :
    // yesterdayCloseMap (déjà cash-flow-immune, comme pour le portefeuille) →
    // calculateHoldings → calculateSummary → PortfolioSnapshot (cash toujours
    // 0 : un actif seul n'a pas de réserve de cash à lui).
    buildAssetPortfolioSnapshot(ticker, assetPurchases, todayGraphData, historicalFxMap) {
        const { assets, cash } = this.splitCanonicalPurchases(assetPurchases);
        const yesterdayCloseMap = this.buildYesterdayCloseMapFromGraphData(todayGraphData);
        const invalidTickers = new Set(todayGraphData.dataQuality?.failedInstruments || []);
        const holdings = this.calculateHoldings(assets, yesterdayCloseMap, historicalFxMap, null, invalidTickers);
        const summary = this.calculateSummary(holdings);
        const cashReserve = this.calculateCashReserve(cash);

        const resolvedTicker = ticker || assetPurchases[0]?.ticker || null;
        const portfolioSnapshot = this.buildPortfolioSnapshot({
            holdings, summary, cashReserve, snapshotStartedAt: Date.now(),
            meta: { mode: 'asset', ticker: resolvedTicker }
        });

        return { holdings, summary, cashReserve, portfolioSnapshot };
    }

    // Ligne de référence ATH du graphique — voir computeAthReference plus bas.
    computeAthReference(params) {
        return computeAthReference(params);
    }

    // ============================================================
    // MODE INDICE — extrait de historicalChart.js. Un indice n'a ni position
    // au sens portefeuille ni "invested" réel ; on le modélise comme une
    // unique position synthétique (quantité=1) pour qu'il traverse EXACTEMENT
    // le même canonicalizer (buildPortfolioSnapshot) que les deux autres
    // modes — jamais une 3e formule ad hoc pour "Var Today d'un indice".
    // `graphCurrentPrice`/`startPrice` : bornes de la série affichée (utilisées
    // pour "Total Return" — la période affichée, comme avant). `livePrice` :
    // prix live résolu séparément (storage.getCurrentPrice) — utilisé pour Var
    // Today comme avant (les deux pouvaient déjà différer légèrement dans le
    // code d'origine ; formule reprise à l'identique, pas une nouvelle règle).
    buildIndexSnapshot(ticker, { graphCurrentPrice, startPrice, previousClose, livePrice }) {
        const diff = (graphCurrentPrice != null && startPrice != null) ? graphCurrentPrice - startPrice : null;
        const gainPct = (startPrice > 0 && diff != null) ? (diff / startPrice) * 100 : 0;
        const dayPnl = (previousClose && livePrice != null) ? livePrice - previousClose : diff;
        const dayPnlPct = (previousClose > 0 && livePrice != null) ? ((livePrice - previousClose) / previousClose) * 100 : 0;

        const holdings = [{
            ticker, name: ticker, assetType: 'Index', quantity: 1,
            avgPrice: startPrice ?? 0, invested: 0, currentPrice: graphCurrentPrice, previousClose,
            currentValue: graphCurrentPrice, gainEUR: diff, gainPct,
            dayChange: dayPnl, dayPct: dayPnlPct, yesterdayQuantity: 1,
            weight: 100, purchases: []
        }];
        const summary = {
            totalCurrentEUR: graphCurrentPrice ?? 0, totalInvestedEUR: 0, gainTotal: diff ?? 0, gainPct,
            totalDayChangeEUR: dayPnl ?? 0, dayChangePct: dayPnlPct
        };
        const cashReserve = { total: 0, byBroker: {} };
        const portfolioSnapshot = this.buildPortfolioSnapshot({
            holdings, summary, cashReserve, snapshotStartedAt: Date.now(),
            meta: { mode: 'index', ticker }
        });

        return { summary, portfolioSnapshot };
    }

    // debugDividendPhantomGap() déplacée hors du moteur (audit 2026-09-28) :
    // outil de diagnostic chargé à la demande, voir
    // audit/tools/debugDividendPhantomGap.js.

    // debugLastPointDivergence() supprimée (validation architecture
    // 2026-09-24, Phase 4) — ce diagnostic existait pour investiguer un écart
    // causé PAR le mécanisme "liveOverride" de HistoryCalculator._buildSeries
    // (substitution du prix live au dernier point du graphique 1D), lui-même
    // supprimé dans cette même passe : le graphique ne fait plus jamais cette
    // substitution, donc il n'y a plus de divergence de ce type à diagnostiquer.
    // Voir HistoryCalculator.js (pointMeta) pour la provenance de chaque point.
}

// ============================================================
// ATH (plus haut historique) de la vue courante — calcul pur. La vue
// (historicalChart.js) ne fait que formater et dessiner le résultat.
//
// - kind 'price'       : max du prix unitaire (€) sur l'historique complet du
//                        scope ET sur la série visible (un plus haut intraday
//                        ou le point live peut dépasser les clôtures
//                        journalières de l'historique complet).
// - kind 'performance' : max de l'indice TWR chaîné sur l'historique complet,
//                        exprimé dans le repère de la courbe % affichée
//                        (qui vaut 0 % au début de la fenêtre visible).
//
// Jamais sur une valeur € de portefeuille/position : ce total intègre les
// apports, chaque versement y créerait un faux « plus haut ».
//
// Retourne { kind, value, at, fromAthPct } ou null (données absentes/
// invalides : fail-closed).
//   at         : { source: 'all' | 'visible', index } — le point où l'ATH a été
//                atteint, pour que la vue y LISE date/Total Value/Total Return
//                (sélecteur pur, aucun recalcul).
//   fromAthPct : écart du dernier point visible par rapport à l'ATH (≤ 0),
//                en % de prix (price) ou de performance TWR (performance).
// ============================================================
export function computeAthReference({ kind, allHistory, visibleHistory, firstIndex = 0, lastIndex = null, includeDividends = false }) {
    if (!allHistory || !visibleHistory) return null;
    if (allHistory.dataQuality?.valid === false || visibleHistory.dataQuality?.valid === false) return null;

    const isFinitePoint = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
    // Highest finite point in [from, to] (first occurrence on ties) and the
    // last finite point of that range.
    const scan = (series, from = 0, to = Infinity) => {
        const result = { max: -Infinity, maxIndex: -1, last: null };
        if (!Array.isArray(series)) return result;
        const end = Math.min(to, series.length - 1);
        for (let i = Math.max(0, from); i <= end; i++) {
            if (!isFinitePoint(series[i])) continue;
            const v = Number(series[i]);
            if (v > result.max) { result.max = v; result.maxIndex = i; }
            result.last = v;
        }
        return result;
    };
    const visibleEnd = lastIndex ?? Infinity;

    if (kind === 'price') {
        const all = scan(allHistory.unitPrices);
        const visible = scan(visibleHistory.unitPrices, firstIndex, visibleEnd);
        const fromVisible = visible.max > all.max;
        const value = fromVisible ? visible.max : all.max;
        if (!Number.isFinite(value) || value <= 0) return null;
        return {
            kind, value,
            at: fromVisible ? { source: 'visible', index: visible.maxIndex } : { source: 'all', index: all.maxIndex },
            fromAthPct: visible.last !== null ? (visible.last / value - 1) * 100 : null
        };
    }
    if (kind !== 'performance') return null;

    const pickTwr = (h) => includeDividends && Array.isArray(h.twrWithDividends) ? h.twrWithDividends : h.twr;
    const allTwr = pickTwr(allHistory);
    const visibleTwr = pickTwr(visibleHistory);
    if (!Array.isArray(allTwr) || !Array.isArray(visibleTwr)) return null;

    const all = scan(allTwr);
    if (!(all.max > 0)) return null;

    // Passage du repère « historique complet » au repère « fenêtre visible » :
    // le TWR étant chaîné, visibleTwr[j] / allTwr[i] est constant pour tout
    // couple (i, j) désignant la même observation. On prend l'observation
    // commune la plus récente (timestamp identique dans les deux séries), qui
    // est exacte. Repli (fenêtres intraday sans point commun) : dernier point
    // de l'historique complet antérieur au début de la fenêtre, base 1.
    const allTs = Array.isArray(allHistory.timestamps) ? allHistory.timestamps : [];
    const visibleTs = Array.isArray(visibleHistory.timestamps) ? visibleHistory.timestamps : [];
    const allIndexByTs = new Map();
    allTs.forEach((ts, i) => {
        const point = Number(allTwr[i]);
        if (Number.isFinite(Number(ts)) && Number.isFinite(point) && point > 0) allIndexByTs.set(Number(ts), point);
    });

    let scale = null;
    const lastVisible = Math.min(visibleEnd, visibleTwr.length - 1);
    for (let j = lastVisible; j >= firstIndex && scale === null; j--) {
        const anchor = allIndexByTs.get(Number(visibleTs[j]));
        const point = Number(visibleTwr[j]);
        if (anchor !== undefined && Number.isFinite(point) && point > 0) scale = point / anchor;
    }
    if (scale === null) {
        const visibleStartTs = Number(visibleTs[firstIndex]);
        let base = null;
        if (Number.isFinite(visibleStartTs)) {
            for (let i = 0; i < allTs.length; i++) {
                const ts = Number(allTs[i]);
                if (!Number.isFinite(ts)) continue;
                if (ts > visibleStartTs) break;
                const point = Number(allTwr[i]);
                if (Number.isFinite(point) && point > 0) base = point;
            }
        }
        if (base === null) return null;
        scale = 1 / base;
    }

    const visible = scan(visibleTwr, firstIndex, visibleEnd);
    const rebasedAthPct = (all.max * scale - 1) * 100;
    const visibleMaxPct = (visible.max - 1) * 100;
    const fromVisible = visibleMaxPct > rebasedAthPct;
    const value = fromVisible ? visibleMaxPct : rebasedAthPct;
    if (!Number.isFinite(value)) return null;
    const lastPct = visible.last !== null ? (visible.last - 1) * 100 : null;
    return {
        kind, value,
        at: fromVisible ? { source: 'visible', index: visible.maxIndex } : { source: 'all', index: all.maxIndex },
        fromAthPct: lastPct !== null ? ((1 + lastPct / 100) / (1 + value / 100) - 1) * 100 : null
    };
}
