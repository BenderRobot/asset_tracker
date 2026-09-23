// ========================================
// HistoryCalculator.js — Portfolio historical series engine
// ========================================
//
// Single job: given a list of purchases (buys/sells across tickers, including
// cash movements) and a requested period, reconstruct a time series of the
// portfolio's value and its Time-Weighted Return at regular intervals.
//
// Design rules (kept as rules, not patches, from the first line):
//  1. "Previous close" (the day-change anchor) is resolved through ONE
//     function — _resolvePortfolioCloseBefore — used both for the period's
//     opening anchor and for every day boundary crossed in multi-day views.
//     It is never resolved a second, independent way for the same day: two
//     separate resolutions of "the same" close is exactly what caused the
//     table, the KPIs and the chart to disagree in the past.
//  2. Quantity changes are treated symmetrically when re-scaling the TWR
//     denominator intraday, whether they are buys or sells — a sale must not
//     register as a fake loss any more than a purchase should register as a
//     fake gain.
//  3. Per-ticker market/session questions (is it a trading day, DST-aware
//     open/close, previous/next session) have ONE owner — MarketCalendarEngine
//     (Phase 2/2.5), itself built on MarketUtils' existing DST-aware
//     primitives plus real provider metadata when available (see
//     MarketCalendarEngine's own file-level audit notes). _computeDisplayWindow
//     below routes its Global-1D boundary through TimeRangeEngine.
//     getGlobalWindow (Phase 2.5, section 11); its other branches (2D/1W/…,
//     weekend fallback) still compute their own boundaries directly — not yet
//     routed through the engine, flagged as follow-up work, not silently left
//     inconsistent.
//  4. Stock candles never snap forward across a weekend/holiday gap
//     (findClosestPrice(..., allowForward=false) for non-crypto tickers).
//  5. The Global 1D window is 00:00 → now in the portfolio timezone (see
//     TimeRangeEngine.getGlobalWindow + MarketCalendarEngine.
//     getPortfolioTimezone), never the first exchange's open time — a closed
//     market is valorized at its last real price (lastKnownPrices carry-
//     forward / midnightValuationSeed), never given a fabricated candle.

import { USD_TO_EUR_FALLBACK_RATE } from './config.js';
import { parseDate } from './utils.js';
import { marketCalendarEngine } from './MarketCalendarEngine.js';
import { getGlobalWindow } from './TimeRangeEngine.js';
import { isHistoricalFetchFailure } from './api.js';
import {
    getIntervalForPeriod,
    getLabelFormat,
    isCryptoTicker,
    isMixedPortfolio,
    findClosestPrice,
    formatTicker,
    resolveTickerPreviousClose,
    getCloseCutoffForTicker,
    resolveHistoricalUsdToEurRate
} from './MarketUtils.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyResult() {
    return {
        labels: [], invested: [], investedAssetOnly: [], values: [], yesterdayClose: null,
        dayStartValue: null, todayValueOfYesterdayHoldings: null,
        perTickerYesterdayClose: new Map(), unitPrices: [], purchasePoints: [],
        timestamps: [], twr: [], dailyTwr: [], historicalDataMap: new Map(), isMixed: false,
        cash: [], totalReturn: [], totalReturnPct: [],
        // Aucun achat du tout : rien à valoriser, donc rien qui puisse échouer.
        dataQuality: { valid: true, reason: null, failedInstruments: [] }
    };
}

export class HistoryCalculator {
    constructor(storage, api) {
        this.storage = storage;
        this.api = api;
    }

    async getHistoryWithCache(ticker, startTs, endTs, interval) {
        return this.api.getHistoricalPricesWithRetry(ticker, startTs, endTs, interval);
    }

    // ========================================================
    // Public entry point
    // ========================================================
    // `dynamicRateOverride` : quand fourni par dataManager.buildTodaySnapshot(),
    // remplace la lecture de storage.getConversionRate — pour que ce moteur et
    // calculateHoldings (Total Value) utilisent EXACTEMENT le même taux de
    // change pour le même rendu, jamais deux lectures indépendantes.
    // `debugCapture` (INSTRUMENTATION TEMPORAIRE, diagnostic du -42,16€ /
    // -150€ écarts "22:00 vs dernier point") : optionnel, null par défaut —
    // n'existe QUE pour dataManager.debugLastPointDivergence(). Quand fourni
    // (un tableau), _buildSeries y pousse un enregistrement PAR (ticker,
    // timestamp) documentant le prix/la source/la valeur RÉELLEMENT utilisés
    // par ce calcul — sans jamais changer une seule valeur retournée. Aucun
    // appelant existant ne passe ce paramètre ; comportement strictement
    // inchangé quand il vaut null (voir tests : 102/102 inchangés).
    // `livePriceSnapshotOverride` (Option C — voir dataManager.buildTodaySnapshot
    // et historicalChart.js::update()) : quand fourni, c'est un Map(ticker ->
    // storage.getCurrentPrice(ticker)) déjà capturée par le CALLER, IMMÉDIATEMENT
    // après SON PROPRE fetchBatchPrices, sans aucun await entre les deux — donc
    // antérieure à toute course possible avec un fetch concurrent
    // (dashboardApp.loadPortfolioData appelle aussi fetchBatchPrices, sans
    // coordination — voir l'audit complet dans buildTodaySnapshot). Dans ce cas,
    // AUCUNE lecture de storage.getCurrentPrice() n'est faite nulle part dans ce
    // calcul pour une VALEUR de prix (currency comprise) — on réutilise
    // exclusivement ce qui a été fourni, sans repli silencieux qui masquerait
    // une erreur de plomberie dans ce chemin. Sans override (autres appelants :
    // mode actif single-asset, calculateAssetHistory, calculateIndexData...),
    // le comportement précédent est conservé à l'identique : capture locale ici,
    // au tout début, avant le moindre await de CETTE fonction — toujours mieux
    // qu'une relecture tardive, mais sans la garantie forte que seul l'appelant
    // (avec son propre fetchBatchPrices juste avant) peut offrir.
    async calculateGenericHistory(purchases, days, isSingleAsset = false, historicalFxMap = null, dynamicRateOverride = null, debugCapture = null, livePriceSnapshotOverride = null) {
        const ledger = this._buildLedger(purchases, isSingleAsset);
        if (!ledger.firstPurchaseDate) return emptyResult();

        const dynamicRate = dynamicRateOverride ?? (this.storage.getConversionRate('USD_TO_EUR') || USD_TO_EUR_FALLBACK_RATE);
        const tickers = Array.from(ledger.byTicker.keys());

        const livePriceSnapshot = livePriceSnapshotOverride
            ?? new Map(tickers.filter(t => !t.startsWith('CASH-')).map(t => [t, this.storage.getCurrentPrice(t)]));

        const isCrypto = isSingleAsset
            ? isCryptoTicker(tickers[0] || '')
            : tickers.filter(t => !t.startsWith('CASH-')).some(t => isCryptoTicker(t));
        const isMixed = !isSingleAsset && isMixedPortfolio(tickers);

        console.log(`[HistoryCalc] ${isSingleAsset ? 'Single' : (isMixed ? 'Mixed' : 'Multi')} portfolio, isCrypto=${isCrypto}, isMixed=${isMixed}, days=${days}, tickers=${tickers.join(',')}`);

        const win = this._computeDisplayWindow(days, isCrypto, isMixed, ledger);
        const interval = getIntervalForPeriod(days);
        const labelFormatFunc = getLabelFormat(days);

        const { map: historicalDataMap, failedTickers } = await this._fetchHistoricalData(tickers, win.dataStartTs, win.dataEndTs, interval);
        await this._fillCryptoGapsFromBinance(tickers, historicalDataMap, days);
        await this._recoverFromClosedMarket(tickers, historicalDataMap, win, days, isCrypto, interval);

        // Binance (voir _fillCryptoGapsFromBinance) est une VRAIE source de
        // marché alternative (klines réelles, pas une reconstruction) — un
        // ticker qu'elle a effectivement rempli n'est plus en échec. Ne
        // s'applique jamais à lastKnownPrices/midnightValuationSeed
        // (résolus plus bas) : ceux-là ne sont jamais une vraie donnée
        // HISTORIQUE, ils ne doivent donc jamais retirer un ticker de cette
        // liste (voir dataQuality ci-dessous).
        for (const t of failedTickers) {
            const hist = historicalDataMap.get(t);
            if (hist && Object.keys(hist).length > 0) failedTickers.delete(t);
        }
        const dataQuality = failedTickers.size > 0
            ? { valid: false, reason: 'PRICE_DATA_UNAVAILABLE', failedInstruments: [...failedTickers] }
            : { valid: true, reason: null, failedInstruments: [] };

        const lastKnownPrices = this._seedLastKnownPrices(tickers, historicalDataMap, win, days, livePriceSnapshot);

        // --- THE canonical "portfolio value at close before refDate" resolver ---
        // Reused for the period's own anchor below AND for every day boundary the
        // main loop crosses (see _resolveDailyAnchor) — never a second, parallel
        // implementation of the same question.
        const resolveCloseBefore = (refDate, label, useDedicatedFetch) =>
            this._resolvePortfolioCloseBefore(ledger, refDate, tickers, {
                dynamicRate, isSingleAsset, historicalDataMap, useDedicatedFetch, label, livePriceSnapshot
            });

        // For a 1D view "yesterday" is relative to the day actually displayed
        // (win.displayStart), not to the real calendar date — otherwise, once the
        // market is closed and the chart rolls back to the last trading day, this
        // would resolve to that same day's own close instead of the day before it.
        const yesterdayRefDate = (days === 1) ? win.displayStart : new Date();
        const yesterday = await resolveCloseBefore(yesterdayRefDate, 'yesterdayClose', true);

        const midnightValuationSeed = (days === 1)
            ? this._resolveMidnightValuationSeed(tickers, historicalDataMap, win, yesterday, livePriceSnapshot)
            : null;

        const displayTimestamps = this._buildTimestampGrid(days, historicalDataMap, win, ledger, interval, isCrypto);

        const { perTickerYesterdayClose, todayValueOfYesterdayHoldings } =
            this._valueTodaysHoldingsAtYesterdaysQuantities(tickers, yesterday, dynamicRate, isSingleAsset, livePriceSnapshot);

        const series = await this._buildSeries({
            ledger, tickers, historicalDataMap, displayTimestamps, lastKnownPrices,
            dynamicRate, isSingleAsset, interval, days, labelFormatFunc,
            resolveCloseBefore, initialYesterdayClose: yesterday.total, win, historicalFxMap,
            midnightValuationSeed, debugCapture, livePriceSnapshot
        });

        const purchasePoints = isSingleAsset
            ? this._buildPurchasePoints(ledger, tickers[0], displayTimestamps, series.labels, days, win, dynamicRate, historicalFxMap)
            : [];

        // FAIL-CLOSED (audit incident 2026-09-23) : quand dataQuality.valid ===
        // false, les séries qui DÉPENDENT d'un prix de marché sont remplacées
        // par des points `null` — un graphique affiche alors un trou, jamais un
        // chiffre silencieusement faux (0€ n'est jamais utilisé : c'est une
        // vraie valeur financière). `invested`/`investedAssetOnly` restent
        // réels : ce sont des coûts de revient, jamais dépendants d'un prix.
        const nullSeries = (arr) => Array.isArray(arr) ? arr.map(() => null) : arr;
        const gateOnValidity = (arr) => dataQuality.valid ? arr : nullSeries(arr);

        return {
            labels: series.labels,
            invested: series.invested,
            investedAssetOnly: series.investedAssetOnly,
            values: gateOnValidity(series.values),
            // PortfolioSnapshot historique par point (audit architecture SSOT) —
            // voir _buildSeries : cash[i]/totalReturn[i]/totalReturnPct[i] sont
            // déjà calculés avec la même formule que le snapshot LIVE, jamais à
            // recalculer par un consommateur (historicalChart.js).
            cash: gateOnValidity(series.cash),
            totalReturn: gateOnValidity(series.totalReturn),
            totalReturnPct: gateOnValidity(series.totalReturnPct),
            yesterdayClose: dataQuality.valid ? series.displayedYesterdayClose : null,
            dayStartValue: dataQuality.valid ? series.dayStartValue : null,
            todayValueOfYesterdayHoldings: dataQuality.valid ? todayValueOfYesterdayHoldings : null,
            perTickerYesterdayClose,
            unitPrices: series.unitPrices,
            purchasePoints,
            timestamps: displayTimestamps,
            twr: series.twr,
            dailyTwr: series.dailyTwr,
            historicalDataMap,
            isMixed,
            // SINGLE SOURCE OF TRUTH pour "le prix couramment utilisé, par
            // ticker, au dernier point de CE calcul" — dataManager.
            // buildTodaySnapshot() le réinjecte tel quel dans calculateHoldings
            // pour que Total Value ne puisse jamais lire un prix différent de
            // celui qui a produit le dernier point du graphique.
            resolvedPrices: series.resolvedPrices,
            // FAIL-CLOSED — voir dataManager.buildPortfolioSnapshot, qui
            // traduit ceci en snapshot.status/invalidReason/invalidInstruments.
            dataQuality
        };
    }

    // ========================================================
    // 1. Ledger: purchases -> per-ticker sorted buy/sell lists
    // ========================================================
    _buildLedger(purchases, isSingleAsset) {
        const byTicker = new Map();
        let firstPurchaseDate = null;

        const addEntry = (t, entry) => {
            if (!byTicker.has(t)) byTicker.set(t, []);
            byTicker.get(t).push(entry);
            if (!firstPurchaseDate || entry.date < firstPurchaseDate) firstPurchaseDate = entry.date;
        };

        if (isSingleAsset) {
            const t = purchases[0].ticker.toUpperCase();
            purchases.forEach(p => addEntry(t, {
                date: parseDate(p.date),
                price: parseFloat(p.price),
                quantity: parseFloat(p.quantity),
                currency: p.currency || 'EUR',
                // Same ticker held across two brokers has the same cost-basis
                // isolation need as the portfolio view below — see
                // costBasisByBrokerTicker in _buildSeries.
                broker: p.broker || 'RV-CT'
            }));
        } else {
            purchases.forEach(p => {
                const type = (p.assetType || '').toLowerCase();
                // BUG FOUND (root cause of the 53 226,78€ vs 36 880,78€ report) : cette
                // classification ne reconnaissait QUE `assetType === 'cash'` — pas les
                // dividendes (assetType 'Dividend' / p.type === 'dividend'), alors que
                // dataManager.calculateCashReserve (qui alimente investedAssetOnly/
                // cashReserve — voir buildTodaySnapshot) traite déjà les deux comme
                // équivalents : `type === 'cash' || type === 'dividend' || p.type ===
                // 'dividend'`. Un dividende est enregistré (voir achatsPage.js::
                // handleConfirmDividends/handleManualDividend) avec le TICKER DE
                // L'ACTION SOUS-JACENTE (ex: "AAPL"), `price = montant net reçu`,
                // `quantity = 1` — jamais un vrai achat d'action. Sans ce cas dans
                // `isCash`, chaque dividende tombait dans la branche "achat" ci-dessous :
                // +1 action fantôme d'AAPL, achetée au prix du montant du dividende, et
                // valorisée ensuite au prix COURANT d'AAPL dans _buildSeries — une action
                // fantôme par dividende versé, qui s'accumule indéfiniment (jamais
                // "vendue") et gonfle le dernier point du graphique (Total Value/FIN/
                // tooltip) d'autant de quantité fictive que de dividendes reçus au fil
                // des ans, alors que calculateHoldings (le tableau/les cartes KPI) exclut
                // déjà correctement les lignes dividende de son propre calcul de
                // position. Fix : router un dividende exactement comme un mouvement de
                // cash (même bucket `CASH-{currency}`, même formule `quantity =
                // parseFloat(p.price)` — sûr ici car ces deux types de lignes ont
                // toujours `quantity: 1` à la création, voir app.js/achatsPage.js).
                const isCash = type === 'cash' || type === 'dividend' || p.type === 'dividend'
                    || p.ticker.toUpperCase() === 'CASH' || p.ticker.toUpperCase() === 'EUR';
                const currency = p.currency || 'EUR';
                const t = isCash ? `CASH-${currency}` : p.ticker.toUpperCase();
                const broker = p.broker || 'RV-CT';
                if (isCash) {
                    addEntry(t, { date: parseDate(p.date), price: 1.0, quantity: parseFloat(p.price) || 0, currency, broker });
                } else {
                    addEntry(t, { date: parseDate(p.date), price: parseFloat(p.price), quantity: parseFloat(p.quantity), currency, broker });
                }
            });
        }

        byTicker.forEach(list => list.sort((a, b) => a.date - b.date));
        return { byTicker, firstPurchaseDate };
    }

    // ========================================================
    // 2. Display window per period (DST-aware, weekend-aware)
    // ========================================================
    _computeDisplayWindow(days, isCrypto, isMixed, ledger) {
        const today = new Date();
        let displayStart;
        let bufferDays = 5;
        // Phase 3.5 removed the last branch that ever set this (the stocks-only
        // "weekend -> jump to last trading day" jump, see section B of that
        // phase's audit) — it conflicted with the Phase 2 rule that Global 1D is
        // ALWAYS 00:00 -> now, and that branch ran BEFORE the days===1 branch
        // below due to `if` ordering, so it silently won every weekend for a
        // stocks-only portfolio. A closed weekend now shows a flat line at the
        // last real price (lastKnownPrices carry-forward / midnightValuationSeed)
        // instead of silently substituting Friday's whole trading day — an
        // honest "nothing happened" is not the same as no information (see the
        // audit's own top-level rule). Kept only as a `null` default; nothing
        // below ever sets it again.
        const hardStopTs = null;

        // Phase 3 — toute fenêtre GLOBALE dont la définition ne dépend PAS d'un
        // ajustement marché (2D — voir juste en dessous) passe par
        // TimeRangeEngine.getGlobalWindow — jours civils dans le fuseau du
        // portefeuille, jamais le fuseau système. `days==='all'` n'est
        // délibérément PAS routé ici : sa borne dépend du portefeuille lui-même
        // (première transaction), que TimeRangeEngine ne connaît pas et ne doit pas
        // deviner (voir sa propre doc : startMs=null pour 'all').
        const portfolioTz = marketCalendarEngine.getPortfolioTimezone();
        // Phase 3.6 — 2D ne décide plus lui-même "lundi -> vendredi" : on
        // fournit à TimeRangeEngine la liste réelle des tickers du portefeuille
        // et le moteur de calendrier ; c'est MarketCalendarEngine.
        // hasExchangeTradedReferenceDay() qui détermine le dernier jour de
        // référence pertinent, ticker par ticker, jamais une règle de jour de
        // semaine codée ici (voir getGlobalWindow's propre doc).
        const portfolioTickers = Array.from(ledger.byTicker.keys());

        if (days === 'ytd') {
            displayStart = new Date(getGlobalWindow('ytd', portfolioTz, today).startMs);
            bufferDays = 5;
        } else if (days === 730) {
            displayStart = new Date(getGlobalWindow(730, portfolioTz, today).startMs);
            bufferDays = 14;
        } else if (isCrypto || (typeof days === 'number' && days >= 7)) {
            // 24/7 assets, or a long enough view that weekday gaps don't matter.
            const local = new Date(today);
            if (days === 1) {
                // handled below (TimeRangeEngine.getGlobalWindow — portfolio timezone, not system-local)
            } else if (days === 2) {
                local.setTime(getGlobalWindow(2, portfolioTz, today, { assets: portfolioTickers, calendarEngine: marketCalendarEngine }).startMs);
            } else if (days !== 'all') {
                local.setTime(getGlobalWindow(days, portfolioTz, today).startMs);
            } else {
                local.setTime(ledger.firstPurchaseDate ? ledger.firstPurchaseDate.getTime() : Date.now());
            }
            displayStart = (days === 1)
                ? new Date(getGlobalWindow(1, portfolioTz, today).startMs)
                : local;
            bufferDays = (typeof days === 'number' && days <= 7) ? 2 : 14;
        } else if (days === 1) {
            // Phase 2 — Global 1D MUST be 00:00 → maintenant in the portfolio
            // timezone (see MarketCalendarEngine.getPortfolioTimezone), not the
            // first exchange's open time, WEEKEND INCLUDED (Phase 3.5). Before
            // market open (or all day on a closed weekend), the loop below
            // carries forward each ticker's last known price (yesterday's close —
            // see lastKnownPrices/_resolveMidnightValuationSeed) instead of
            // fabricating a new candle: the flat segment this produces is a
            // genuine PORTFOLIO VALUATION at a real, already-known price, not an
            // invented observation. getCloseCutoffForTicker (used everywhere
            // "yesterday" is resolved for this same 1D view) is unaffected —
            // extending the window's own start earlier does not change what
            // counts as "yesterday" for a given ticker.
            displayStart = new Date(getGlobalWindow(1, portfolioTz, today).startMs);
            bufferDays = 5;
        } else if (days === 2) {
            displayStart = new Date(getGlobalWindow(2, portfolioTz, today, { assets: portfolioTickers, calendarEngine: marketCalendarEngine }).startMs);
            bufferDays = 5;
        } else if (days !== 'all') {
            displayStart = new Date(getGlobalWindow(days, portfolioTz, today).startMs);
            bufferDays = 5;
        } else {
            displayStart = new Date(ledger.firstPurchaseDate);
            bufferDays = 5;
        }

        const dataStart = new Date(displayStart);
        dataStart.setUTCDate(dataStart.getUTCDate() - bufferDays);
        const todayEndUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999));

        const displayStartTs = displayStart.getTime();
        const displayEndTs = hardStopTs ? hardStopTs : (days === 1 ? displayStartTs + DAY_MS : Infinity);

        return {
            displayStart, displayStartTs, displayEndTs, hardStopTs,
            dataStartTs: Math.floor(dataStart.getTime() / 1000),
            dataEndTs: Math.floor(todayEndUTC.getTime() / 1000)
        };
    }

    // ========================================================
    // 3. Fetch (batched) + resilience fallbacks
    // ========================================================
    // FAIL-CLOSED (audit incident 2026-09-23) : `failedTickers` distingue un
    // échec RÉSEAU/HTTP confirmé (proxy en panne, timeout, 5xx — voir
    // api.js::isHistoricalFetchFailure) d'une absence de donnée légitime
    // (marché fermé, aucune bougie pour la période — hist reste `{}` mais
    // SANS ce marqueur). Sert de base à dataQuality dans
    // calculateGenericHistory ci-dessous — jamais recalculé ailleurs.
    async _fetchHistoricalData(tickers, startTs, endTs, interval) {
        const map = new Map();
        const failedTickers = new Set();
        const batchSize = 3;
        for (let i = 0; i < tickers.length; i += batchSize) {
            const batch = tickers.slice(i, i + batchSize);
            await Promise.all(batch.map(async (t) => {
                if (t.startsWith('CASH-')) { map.set(t, {}); return; }
                try {
                    const hist = await this.getHistoryWithCache(formatTicker(t), startTs, endTs, interval);
                    map.set(t, hist || {});
                    if (isHistoricalFetchFailure(hist)) failedTickers.add(t);
                } catch (err) {
                    map.set(t, {});
                    failedTickers.add(t);
                }
            }));
        }
        return { map, failedTickers };
    }

    // Yahoo sometimes has no intraday data for a crypto ticker — Binance is a
    // free, no-auth fallback with real 5m candles for the current day.
    async _fillCryptoGapsFromBinance(tickers, historicalDataMap, days) {
        if (days !== 1) return;
        const midnightMs = new Date().setHours(0, 0, 0, 0);
        const nowMs = Date.now();
        for (const t of tickers) {
            // isCryptoTicker() false-positives on any ticker containing "-EUR"/"-USD",
            // which "CASH-EUR"/"CASH-USD" do — exclude cash explicitly.
            if (t.startsWith('CASH-') || !isCryptoTicker(t)) continue;
            const hist = historicalDataMap.get(t);
            if (hist && Object.keys(hist).length > 0) continue;
            try {
                const binance = await this.api.fetchCryptoKlinesFromBinance(t, midnightMs, nowMs);
                if (binance && Object.keys(binance).length > 0) {
                    historicalDataMap.set(t, binance);
                    console.log(`[HistoryCalc] Binance fallback OK for ${t}: ${Object.keys(binance).length} points`);
                }
            } catch (err) {
                console.warn(`[HistoryCalc] Binance fallback failed for ${t}:`, err.message);
            }
        }
    }

    // Phase 3.5 — DISABLED (kept as a documented no-op, not deleted, so the
    // call site and its history stay traceable). This used to roll the WHOLE
    // window back to the last complete trading day whenever no candle existed
    // yet for "today" (e.g. queried right after midnight, or — as a Phase 3.5
    // test caught — whenever a fetch simply returns nothing). That is exactly
    // the same anti-pattern as the removed isWeekend branch in
    // _computeDisplayWindow (see that method's own comment): it silently
    // substitutes a DIFFERENT day for "today" instead of showing today
    // honestly. Phase 2's own machinery already covers the real need this was
    // trying to serve — _seedLastKnownPrices/_resolveMidnightValuationSeed
    // value "today" at the last known real price when no fresh candle exists
    // yet, without ever pretending a different day is the current one. Left
    // in place only so a future audit doesn't wonder where this went; it must
    // NOT be revived without first re-solving the same problem this Phase
    // fixed (see HistoryCalculator.js's design-rules header, point 5).
    async _recoverFromClosedMarket() {
        return;
    }

    // ========================================================
    // 4. Last-known-price backfill (used before any real candle exists)
    // ========================================================
    // `livePriceSnapshot` : Map ticker -> storage.getCurrentPrice(ticker) capturée
    // UNE FOIS par calculateGenericHistory, avant tout await — voir son propre
    // commentaire ("snapshot non immuable"). Remplace les lectures live
    // directes ci-dessous, qui pouvaient sinon observer un prix écrit par un
    // flux concurrent (ex: dashboardApp.loadPortfolioData) après le fetch de
    // CET appel mais avant que ce calcul n'atteigne ce ticker.
    _seedLastKnownPrices(tickers, historicalDataMap, win, days, livePriceSnapshot) {
        const lastKnown = new Map();

        for (const t of tickers) {
            const isCrypto = isCryptoTicker(t);

            // Short views on stocks: trust storage.previousClose directly rather than
            // a forward-tolerant search, which could snap onto a near-future candle
            // (e.g. Monday's open leaking onto a weekend point) and misrepresent the
            // overnight gap.
            if (!isCrypto && !t.startsWith('CASH-') && typeof days === 'number' && days <= 2) {
                const priceData = livePriceSnapshot.get(t);
                if (priceData && priceData.previousClose > 0) { lastKnown.set(t, priceData.previousClose); continue; }
            }

            const hist = historicalDataMap.get(t);
            if (hist) {
                const ts = Object.keys(hist).map(Number).sort((a, b) => a - b);
                if (ts.length > 0 && hist[ts[0]] > 0) { lastKnown.set(t, hist[ts[0]]); continue; }
            }

            if (!isCrypto) {
                const priceData = livePriceSnapshot.get(t);
                if (priceData?.price > 0) { lastKnown.set(t, priceData.price); continue; }
                if (priceData?.previousClose > 0) { lastKnown.set(t, priceData.previousClose); continue; }
            }
        }

        // Absolute last resort: whatever is currently stored, so a freshly added
        // position is never silently dropped from the total for lack of history.
        for (const t of tickers) {
            if (lastKnown.has(t) || t.startsWith('CASH-')) continue;
            const priceData = livePriceSnapshot.get(t);
            const price = priceData?.price || priceData?.previousClose || 0;
            if (price > 0) lastKnown.set(t, price);
        }

        return lastKnown;
    }

    // ========================================================
    // 5. THE canonical "portfolio close value before refDate" resolver
    // ========================================================
    // useDedicatedFetch=true ignores this view's own historicalDataMap (1D/2D/1W
    // each fetch a slightly different window) and forces resolveTickerPreviousClose
    // to make (or reuse from the shared api cache) its own standardized daily-candle
    // request — otherwise Yahoo can return a marginally different closing candle
    // for "the same" day depending on which view triggered the fetch, and the
    // 1D/2D/1W views would each anchor on a different close for the same day.
    async _resolvePortfolioCloseBefore(ledger, refDate, tickers, { dynamicRate, isSingleAsset, historicalDataMap, useDedicatedFetch, label = '', livePriceSnapshot }) {
        const quantities = new Map();
        const prices = new Map();
        let total = 0, assetsFound = 0;

        // Resolve tickers in small parallel batches rather than one at a time.
        // BUG FOUND: sequential awaits meant a portfolio with many tickers (e.g.
        // "Portfolio Global" unfiltered, 27 tickers) took far longer — and, over
        // that many sequential network round-trips, was measurably more likely to
        // have a late ticker fail to resolve — than the same tickers resolved
        // individually per broker filter (5-12 tickers each). That's what produced
        // a CLÔTURE HIER for the global view lower than the sum of each broker's
        // own CLÔTURE HIER: a few tickers silently dropped out of the global total
        // that were present in every per-broker total. Batching bounds concurrency
        // (kind to the price proxy) while removing the "more tickers = more likely
        // to fail" asymmetry between the global and filtered views.
        const batchSize = 5;
        for (let i = 0; i < tickers.length; i += batchSize) {
            const batch = tickers.slice(i, i + batchSize);
            await Promise.all(batch.map(async (t) => {
                const cutoffTs = getCloseCutoffForTicker(t, refDate);
                let qty = 0;
                for (const entry of ledger.byTicker.get(t) || []) {
                    if (entry.date.getTime() <= cutoffTs) qty += entry.quantity;
                }
                quantities.set(t, qty);

                // BUG FOUND: cash can legitimately sit at a NEGATIVE balance (e.g. a
                // PEA momentarily overdrawn by settlement timing) — the `qty <= 0`
                // skip below is correct for a stock position (nothing to price) but
                // was wrongly applied to cash too, silently dropping it from every
                // close resolution. That made CLOTURE HIER / every day-anchor
                // overstate the portfolio by exactly the negative cash amount,
                // while the curve's own point-by-point loop (which has no such
                // guard) already included it correctly — the two disagreed on the
                // same day's close by that exact amount.
                if (t.startsWith('CASH-')) {
                    total += qty; assetsFound++; prices.set(t, 1.0); return;
                }
                if (qty <= 0) return;

                let closePrice = null;

                if (useDedicatedFetch) {
                    // BUG FOUND (proven with real data): Yahoo's DAILY-interval
                    // history for thin/European-exchange listings can be missing
                    // the most recent trading day entirely — verified for every
                    // EU-listed stock/ETF held (e.g. Tesla via TL0.DE had bars for
                    // 09-08..09-11 then 09-14, silently skipping 09-15, "yesterday"
                    // relative to 09-16 "today"). The cutoff DATE was always right;
                    // the DAILY BAR available for it just didn't exist yet, so the
                    // old code silently fell back to a close from 2 days ago.
                    // Fix: resolve from the dedicated daily fetch AND from the
                    // intraday candles already fetched for the curve, and keep
                    // whichever bar's OWN calendar date is more recent — not
                    // "always the daily one". This also makes the now-removed
                    // _patchOfficialClose obsolete (it used to force-overwrite the
                    // intraday data with this same unreliable daily value).
                    const dailyBars = await this.api.getHistoricalPricesWithRetry(
                        formatTicker(t),
                        Math.floor(cutoffTs / 1000) - 7 * 86400,
                        Math.floor(cutoffTs / 1000),
                        '1d'
                    );
                    let dailyTs = null, dailyPrice = null;
                    if (dailyBars) {
                        const keys = Object.keys(dailyBars).map(Number).sort((a, b) => a - b);
                        for (const k of keys) { if (k <= cutoffTs) { dailyTs = k; dailyPrice = dailyBars[k]; } else break; }
                    }

                    const intraday = historicalDataMap.get(t);
                    let intradayTs = null, intradayPrice = null;
                    if (intraday) {
                        const keys = Object.keys(intraday).map(Number).sort((a, b) => a - b);
                        for (const k of keys) { if (k <= cutoffTs) { intradayTs = Number(k); intradayPrice = intraday[k]; } else break; }
                    }

                    if (dailyPrice > 0 && intradayPrice > 0) {
                        const dailyDay = new Date(dailyTs).toISOString().slice(0, 10);
                        const intradayDay = new Date(intradayTs).toISOString().slice(0, 10);
                        if (intradayDay > dailyDay) {
                            console.log(`[HistoryCalc] ${t}: daily bar stale (${dailyDay}=${dailyPrice}) — using fresher intraday candle (${intradayDay}=${intradayPrice})`);
                            closePrice = intradayPrice;
                        } else {
                            closePrice = dailyPrice;
                        }
                    } else {
                        closePrice = dailyPrice > 0 ? dailyPrice : (intradayPrice > 0 ? intradayPrice : null);
                    }
                }

                if (!closePrice) {
                    const resolved = await resolveTickerPreviousClose(t, {
                        storage: this.storage,
                        refDate,
                        preferLiveClose: false,
                        historicalDataMap: useDedicatedFetch ? null : (historicalDataMap.get(t) || null),
                        allowFetch: false
                    });
                    closePrice = resolved.closePrice;
                }

                if (closePrice > 0) {
                    prices.set(t, closePrice);
                    let rate = 1;
                    if (!isSingleAsset) {
                        const currency = livePriceSnapshot.get(t)?.currency || 'EUR';
                        if (currency === 'USD') rate = dynamicRate;
                    }
                    total += closePrice * rate * qty;
                    assetsFound++;
                }
            }));
        }

        console.log(`[HistoryCalc] closeBefore${label ? ` (${label})` : ''} @ ${refDate.toISOString()}: ${total.toFixed(2)}€, ${assetsFound}/${tickers.length} priced`);
        return { total: assetsFound > 0 ? total : 0, quantities, prices };
    }

    // Phase 2 — OBSERVATION vs VALORISATION (section 10-12 de l'audit) : stocks
    // have no quote before the market opens, but the Global 1D window now
    // starts at 00:00 (see _computeDisplayWindow), so the day's FIRST plotted
    // point can be many hours before any real candle exists for a stock. A
    // portfolio VALUATION at that instant is legitimate (last real known
    // price) — but it must NEVER be written into `historicalDataMap`, which
    // represents actual market OBSERVATIONS (real candles). This used to write
    // directly into `hist[win.displayStartTs]` — a duplicated price under a
    // synthetic timestamp is exactly the "fake observation" pattern the audit
    // bans. Fix: return a separate seed Map that _buildSeries consults ONLY at
    // ts===win.displayStartTs, with the exact same priority a real candle
    // would have had — historicalDataMap itself is never mutated.
    _resolveMidnightValuationSeed(tickers, historicalDataMap, win, yesterday, livePriceSnapshot) {
        const seed = new Map();
        for (const t of tickers) {
            if (t.startsWith('CASH-')) continue;
            const hist = historicalDataMap.get(t);
            if (hist?.[win.displayStartTs] != null) continue; // une vraie bougie existe déjà — rien à faire

            let price = yesterday.prices.get(t) || null;
            if (!price) {
                const pd = livePriceSnapshot.get(t); // voir calculateGenericHistory — snapshot immuable, pas une relecture live
                if (pd?.previousClose > 0) price = pd.previousClose;
                else if (isCryptoTicker(t) && pd?.price > 0) price = pd.price;
            }
            if (!price && hist) price = findClosestPrice(hist, win.displayStartTs - 3600000, '1h', isCryptoTicker(t));

            if (price > 0) seed.set(t, price);
        }
        return seed;
    }

    // ========================================================
    // 6. Timestamp grid to iterate over
    // ========================================================
    _buildTimestampGrid(days, historicalDataMap, win, ledger, interval, isCrypto) {
        const allTs = new Set();
        historicalDataMap.forEach(hist => {
            Object.keys(hist).forEach(k => {
                let ts = parseInt(k);
                if (interval === '1d' || interval === '1wk') {
                    const d = new Date(ts); d.setUTCHours(23, 59, 59, 999); ts = d.getTime();
                }
                allTs.add(ts);
            });
        });
        allTs.add(win.displayStartTs);

        if (days === 1) {
            const dayEnd = win.displayStartTs + DAY_MS;
            for (const list of ledger.byTicker.values()) {
                for (const entry of list) {
                    const ts = entry.date.getTime();
                    if (ts >= win.displayStartTs && ts <= dayEnd) allTs.add(ts);
                }
            }
        }

        let sorted = Array.from(allTs).sort((a, b) => a - b);

        // 1W uses a regular grid (instead of the raw union of available candles) so
        // a ticker with unusually dense data (e.g. crypto trading through the
        // weekend) doesn't distort the shape of the curve relative to the others.
        if (days === 7) {
            const step = { '1h': 3600000, '60m': 3600000, '30m': 1800000, '15m': 900000 }[interval] || 3600000;
            const safeEnd = win.displayEndTs === Infinity ? Date.now() : win.displayEndTs;
            const grid = [];
            for (let ts = Math.ceil(win.displayStartTs / step) * step; ts <= safeEnd; ts += step) {
                if (ts >= win.displayStartTs) grid.push(ts);
            }
            return grid;
        }

        let filtered = sorted.filter(ts => {
            if (ts < win.displayStartTs || ts > win.displayEndTs) return false;
            return true;
        });

        // Stocks-only 1D: hide any stray pre-8am points once real data exists later
        // in the day (keeps the midnight anchor, drops noise between it and open).
        if (days === 1 && !isCrypto) {
            const hasAfter8am = sorted.some(ts => new Date(ts).getHours() >= 8 && ts >= win.displayStartTs && ts <= win.displayEndTs);
            if (hasAfter8am) {
                filtered = filtered.filter(ts => ts === win.displayStartTs || new Date(ts).getHours() >= 8);
            }
        }

        if (days === 1) {
            if (!filtered.includes(win.displayStartTs)) filtered.unshift(win.displayStartTs);
            const nowTs = Math.min(Date.now(), win.displayEndTs);
            if (nowTs > win.displayStartTs && !filtered.includes(nowTs)) filtered.push(nowTs);
            filtered = Array.from(new Set(filtered)).sort((a, b) => a - b);
        }

        return filtered;
    }

    // ========================================================
    // 7. "Today's value of yesterday's holdings" (pure day-change table data)
    // ========================================================
    // `livePriceSnapshot` : voir calculateGenericHistory. Alimente la colonne
    // "Day P&L" du tableau (via dataManager.buildYesterdayCloseMapFromGraphData)
    // — DOIT lire le même prix figé que le reste de ce calcul, sinon le
    // tableau et les cartes KPI (Total Value/Var Today, qui lisent le
    // liveOverride de _buildSeries) peuvent en venir à représenter deux
    // instants différents pour le même ticker.
    _valueTodaysHoldingsAtYesterdaysQuantities(tickers, yesterday, dynamicRate, isSingleAsset, livePriceSnapshot) {
        const map = new Map();
        let total = 0, found = 0;

        for (const t of tickers) {
            if (t.startsWith('CASH-')) continue;
            const qtyYesterday = yesterday.quantities.get(t) || 0;
            if (qtyYesterday <= 0) continue;

            const priceData = livePriceSnapshot.get(t);
            const currency = priceData?.currency || 'EUR';
            let rate = 1;
            if (!isSingleAsset && currency === 'USD') rate = dynamicRate;

            const currentPrice = priceData?.price > 0 ? priceData.price : null;
            const closePrice = yesterday.prices.get(t) || null;
            const yesterdayCloseTotal = closePrice > 0 ? closePrice * qtyYesterday * rate : null;
            const todayValueOfYesterdayHoldingsTotal = currentPrice ? currentPrice * qtyYesterday * rate : null;

            if (currentPrice) { total += currentPrice * qtyYesterday * rate; found++; }

            map.set(t, { yesterdayCloseTotal, todayValueOfYesterdayHoldingsTotal, quantityYesterday: qtyYesterday, currency });
        }

        return { perTickerYesterdayClose: map, todayValueOfYesterdayHoldings: found > 0 ? total : null };
    }

    // ========================================================
    // 8. Main per-timestamp valuation + TWR loop
    // ========================================================
    async _buildSeries({ ledger, tickers, historicalDataMap, displayTimestamps, lastKnownPrices, dynamicRate, isSingleAsset, interval, days, labelFormatFunc, resolveCloseBefore, initialYesterdayClose, win, historicalFxMap = null, midnightValuationSeed = null, debugCapture = null, livePriceSnapshot }) {
        const labels = [], invested = [], investedAssetOnly = [], values = [], unitPrices = [];
        const twr = [], dailyTwr = [];
        // PortfolioSnapshot historique, une entrée par point affiché (audit
        // architecture SSOT) : cash/totalReturn/totalReturnPct calculés ICI,
        // UNE FOIS, avec la même formule que le snapshot LIVE
        // (dataManager.buildPortfolioSnapshot : totalReturn = (totalValue -
        // cash) - investedAssetOnly), jamais recalculés en aval par une vue.
        // `values[i]` inclut déjà le cash (les tickers CASH-* contribuent à
        // totalValue comme n'importe quel autre ticker, prix=1) — `cash[i]`
        // isole la part qui en provient, pour que le tooltip n'ait plus jamais
        // besoin d'aller chercher un cash "courant" ailleurs pour un point
        // historique.
        const cash = [], totalReturn = [], totalReturnPct = [];

        const quantities = new Map(tickers.map(t => [t, 0]));
        const investedByTicker = new Map(tickers.map(t => [t, 0]));
        const resolvedPrices = new Map(); // ticker -> {price, currency, previousClose, lastUpdate} au dernier point

        // SINGLE SOURCE OF TRUTH pour le coût de revient (Total Return), isolé
        // par (courtier, ticker) — même principe que
        // dataManager.js::_buildPositionsByBrokerTicker. NE PAS confondre avec
        // investedByTicker/cashFlow ci-dessus : ceux-ci suivent le flux de CASH
        // NET (achat = +prix×qté, vente = -prix×qté) et alimentent le rescale
        // TWR (periodDenominator/dayDenominator plus bas) — une notion
        // différente et déjà correcte, à laquelle on ne touche pas ici. Le
        // coût de revient, lui, doit être réduit AU PRORATA sur une vente (pas
        // simplement diminué du produit de la vente), et seulement pour LE
        // COURTIER qui a vendu — sinon une vente chez un courtier efface à
        // tort le coût de revient d'un AUTRE courtier détenant le même titre
        // (le même bug architectural déjà corrigé dans calculateHoldings).
        const costBasisByBrokerTicker = new Map(); // "broker::ticker" -> {qty, cost}
        const assetCostBasisByTicker = new Map(tickers.map(t => [t, 0])); // agrégat par ticker, tenu à jour par delta

        // NB: le taux ici est délibérément résolu séparément de `rate` (passé par les
        // appelants ci-dessous pour investedByTicker/cashFlow, qui reste au taux
        // COURANT à dessein — c'est le flux de cash du jour, pas un coût de revient
        // historique). Le coût de revient, lui, doit être figé au taux DE L'ACHAT
        // (invariant 9) — jamais recalculé au taux du jour où le graphique est
        // simplement rouvert. Voir MarketUtils.resolveHistoricalUsdToEurRate,
        // partagée avec dataManager.js::_buildPositionsByBrokerTicker.
        const applyCostBasisEntry = (t, entry) => {
            if (t.startsWith('CASH-')) return; // le cash n'a pas de "coût de revient" à isoler, son solde net suffit
            const key = `${entry.broker || 'RV-CT'}::${t}`;
            if (!costBasisByBrokerTicker.has(key)) costBasisByBrokerTicker.set(key, { qty: 0, cost: 0 });
            const pos = costBasisByBrokerTicker.get(key);
            const before = pos.cost;
            if (entry.quantity > 0) {
                const costRate = entry.currency === 'USD'
                    ? resolveHistoricalUsdToEurRate(entry.date, historicalFxMap, dynamicRate, { ticker: t, broker: entry.broker })
                    : 1;
                pos.qty += entry.quantity;
                pos.cost += entry.price * entry.quantity * costRate;
            } else {
                const sellQty = Math.abs(entry.quantity);
                if (pos.qty > 0) {
                    const ratio = sellQty / pos.qty;
                    pos.cost -= pos.cost * ratio;
                    pos.qty -= sellQty;
                } else {
                    pos.qty -= sellQty;
                }
                if (pos.qty <= 0.0001) { pos.qty = 0; pos.cost = 0; }
            }
            const delta = pos.cost - before;
            assetCostBasisByTicker.set(t, (assetCostBasisByTicker.get(t) || 0) + delta);
        };

        // CRITICAL: seed quantities/invested with every purchase dated BEFORE the
        // displayed window starts — i.e. the entire pre-existing portfolio (bought
        // weeks/months/years ago). Without this, `quantities` starts at 0 and the
        // loop below only ever adds purchases that fall INSIDE the window (today),
        // so every pre-existing holding reads as "0 shares" at every timestamp and
        // gets skipped before its price is even looked up — the whole series comes
        // out null. This is not a purchase happening "during" the window; it's the
        // starting position the window's price movements apply on top of.
        //
        // BUG FOUND: for the 1D view, this used a single cutoff of
        // win.displayStartTs - 1 for every ticker — but for a stocks-only
        // portfolio, win.displayStartTs is the market's OPEN time, not midnight
        // (see _computeDisplayWindow). A cash withdrawal/deposit dated with just
        // a date (defaults to midnight) sits BETWEEN yesterday's close cutoff and
        // market open. Seeding it here baked it into quantities/totalValue from
        // the very first point, while periodDenominator (resolved from
        // yesterday's close via the SAME getCloseCutoffForTicker, which
        // correctly EXCLUDES it) stayed at the pre-flow amount — a permanent fake
        // day P&L equal to the flow, because it never reached the loop's
        // cashFlow detection below and so never got the symmetric rescale that
        // already handles an intraday buy/sell/deposit/withdrawal correctly.
        // Using the same per-ticker cutoff here as for yesterdayClose closes
        // that gap (the flow is instead picked up by the i===0 iteration below).
        // For any other period, displayStart is always midnight-aligned already,
        // so this cutoff is identical to the old win.displayStartTs - 1 — no
        // behavior change there.
        const seedCutoff = (days === 1)
            ? new Map(tickers.map(t => [t, getCloseCutoffForTicker(t, win.displayStart)]))
            : null;
        for (const t of tickers) {
            const cutoff = seedCutoff ? seedCutoff.get(t) : win.displayStartTs - 1;
            for (const entry of ledger.byTicker.get(t) || []) {
                if (entry.date.getTime() <= cutoff) {
                    quantities.set(t, quantities.get(t) + entry.quantity);
                    let rate = 1;
                    if (!isSingleAsset) {
                        const currency = livePriceSnapshot.get(t)?.currency || entry.currency || 'EUR';
                        if (currency === 'USD') rate = dynamicRate;
                    }
                    investedByTicker.set(t, investedByTicker.get(t) + entry.price * entry.quantity * rate);
                    applyCostBasisEntry(t, entry);
                }
            }
        }

        // TWR anchoring: `periodDenominator` is set once, on the very first day
        // encountered, and stays fixed for the whole displayed period ("PÉRIODE").
        // `dayDenominator` resets at every calendar-day boundary crossed and drives
        // the curve itself + its tooltip, always relative to THAT day's own close.
        // Both are resolved through resolveCloseBefore — never re-derived any other
        // way for the same day.
        const shouldAnchorOnClose = (days === 1 || (typeof days === 'number' && days <= 7));
        let periodDenominator = null;
        let dayDenominator = null;
        let dayKeyAnchored = null;
        let displayedYesterdayClose = initialYesterdayClose;
        let dayStartValue = null;

        for (let i = 0; i < displayTimestamps.length; i++) {
            const ts = displayTimestamps[i];
            const prevTs = (i === 0) ? win.displayStartTs - 1 : displayTimestamps[i - 1];

            let cashFlow = 0;
            let quantityChanged = false;
            for (const t of tickers) {
                // Mirrors the seed cutoff above at i===0, so a flow dated between
                // yesterday's close and win.displayStartTs (the pre-market gap on
                // a stocks 1D view) is caught here instead of being silently
                // absorbed into the seed above.
                const lowerBound = (i === 0 && seedCutoff) ? seedCutoff.get(t) : prevTs;
                for (const entry of ledger.byTicker.get(t) || []) {
                    const entryTs = entry.date.getTime();
                    if (entryTs > lowerBound && entryTs <= ts) {
                        quantities.set(t, quantities.get(t) + entry.quantity);
                        let rate = 1;
                        if (!isSingleAsset) {
                            const currency = livePriceSnapshot.get(t)?.currency || entry.currency || 'EUR';
                            if (currency === 'USD') rate = dynamicRate;
                        }
                        const flow = entry.price * entry.quantity * rate;
                        investedByTicker.set(t, investedByTicker.get(t) + flow);
                        cashFlow += flow;
                        quantityChanged = true;
                        applyCostBasisEntry(t, entry);
                    }
                }
            }

            let totalValue = 0, totalInvested = 0, totalInvestedAssetOnly = 0, totalCash = 0, unitPrice = null;
            let hasAnyPrice = false, expected = 0, priced = 0;

            for (const t of tickers) {
                const qty = quantities.get(t);
                const isCash = t.startsWith('CASH-');
                if (Math.abs(qty) <= 0.000001) {
                    totalInvested += isCash ? investedByTicker.get(t) : (assetCostBasisByTicker.get(t) || 0);
                    if (!isCash) totalInvestedAssetOnly += assetCostBasisByTicker.get(t) || 0;
                    continue;
                }
                expected++;

                // INSTRUMENTATION TEMPORAIRE (debugCapture) — trace la PROVENANCE du
                // prix retenu, sans influencer `price` lui-même : chaque branche
                // ci-dessous ne fait qu'étiqueter la décision déjà prise par le code
                // existant.
                let priceSource = isCash ? 'cash' : 'none';

                let price = null;
                if (isCash) {
                    price = 1.0;
                } else {
                    const hist = historicalDataMap.get(t);
                    if (hist?.[ts] != null) { price = hist[ts]; priceSource = 'candle'; }
                    // Valorisation (pas une observation) au tout premier point de la
                    // fenêtre (00:00), uniquement si aucune vraie bougie n'existe déjà
                    // à cet instant précis — voir _resolveMidnightValuationSeed.
                    else if (ts === win.displayStartTs && midnightValuationSeed?.has(t)) { price = midnightValuationSeed.get(t); priceSource = 'midnightSeed'; }
                    else if (hist) { price = findClosestPrice(hist, ts, interval, isCryptoTicker(t)); if (price != null) priceSource = 'closestPrice'; }
                    if (price == null && lastKnownPrices.has(t)) { price = lastKnownPrices.get(t); priceSource = 'lastKnown'; }

                    // On the very last plotted point of the 1D view ("now"), the
                    // intraday candle can be a few minutes behind a freshly-fetched
                    // live price — same principle as the close resolution above
                    // (prefer whichever source is actually more recent), applied
                    // here to the curve's own endpoint instead of the table/KPI
                    // text only. Guarded to the LAST point specifically (not every
                    // point) and to a live price fetched within the last 10
                    // minutes, so this can't reintroduce the old "force the last
                    // point" bug where a stale/wrong live snapshot for an illiquid
                    // ticker created a fake cliff.
                    //
                    // BUG FOUND (Total Value/Var Today changeant entre deux reloads
                    // sans mouvement de marché correspondant) : `live` lisait
                    // storage.getCurrentPrice(t) EN DIRECT, à cet instant précis du
                    // pipeline — potentiellement plusieurs secondes après le début
                    // de calculateGenericHistory (fetch de l'historique, résolution
                    // de la clôture veille...). Pendant cette fenêtre, un autre flux
                    // concurrent (dashboardApp.loadPortfolioData, qui appelle aussi
                    // fetchBatchPrices indépendamment, sans coordination) pouvait
                    // avoir déjà réécrit storage.currentData pour CE ticker — cette
                    // lecture captait alors un prix plus récent que celui que CE
                    // calcul avait lui-même résolu, un "snapshot" pas réellement
                    // figé. `livePriceSnapshot` est capturé une seule fois, tout en
                    // haut de calculateGenericHistory, avant le moindre await — donc
                    // immunisé contre toute écriture concurrente survenant PENDANT
                    // ce calcul (voir son propre commentaire).
                    if (days === 1 && i === displayTimestamps.length - 1) {
                        const live = livePriceSnapshot.get(t);
                        if (live?.price > 0 && live.lastUpdate && (Date.now() - live.lastUpdate) < 10 * 60 * 1000) {
                            price = live.price;
                            priceSource = 'liveOverride';
                        }

                        // DIAGNOSTIC : sur ce tout dernier point (celui qui devient
                        // "Total Value"/"Total Return" en haut de page), signale tout
                        // écart notable entre le prix retenu ici (bougie intraday,
                        // éventuellement remplacé par le live ci-dessus) et le prix
                        // live actuellement en storage — que le remplacement se soit
                        // déclenché ou non. Permet de confirmer si un titre précis a
                        // un prix "figé" dans ce graphique (bougie non rafraîchie ou
                        // live jugé pas assez frais) pendant que calculateHoldings
                        // (le tableau) utilise déjà le bon prix live, sans avoir à
                        // deviner sur le total du portefeuille.
                        if (live?.price > 0 && price != null) {
                            const diffPct = Math.abs(price - live.price) / live.price * 100;
                            if (diffPct > 0.3) {
                                const usedLive = price === live.price;
                                const ageMin = live.lastUpdate ? (Date.now() - live.lastUpdate) / 60000 : null;
                                console.warn(`[HistoryCalc] Écart de prix sur le dernier point pour ${t} : bougie/retenu=${price}, live storage=${live.price} (${diffPct.toFixed(2)}%). Live utilisé=${usedLive} (lastUpdate=${ageMin === null ? 'absent' : ageMin.toFixed(1) + ' min'}). Ce titre contribue à un écart de ${((price - live.price) * qty).toFixed(2)}€ sur Total Value.`);
                            }
                        }
                    }
                }

                let rate = 1;
                let currency = 'EUR';
                if (price != null) {
                    if (!isSingleAsset) {
                        // Lecture "currency" seule (jamais une valeur volatile — voir
                        // l'audit du ticket précédent) : peut rester une lecture live
                        // directe sans risque de course, mais on réutilise déjà
                        // `livePriceSnapshot` ici par cohérence avec la ligne
                        // ci-dessous (même ticker, même objet).
                        currency = livePriceSnapshot.get(t)?.currency || 'EUR';
                        if (currency === 'USD') rate = dynamicRate;
                    }
                    totalValue += price * qty * rate;
                    if (isCash) totalCash += price * qty * rate;
                    hasAnyPrice = true; priced++;
                    if (isSingleAsset) unitPrice = price;
                    lastKnownPrices.set(t, price);

                    // Capture, pour le dernier point SEULEMENT, exactement le prix
                    // que CE calcul vient d'utiliser — voir resolvedPrices dans le
                    // retour de calculateGenericHistory : dataManager.
                    // buildTodaySnapshot() réinjecte cette même Map dans
                    // calculateHoldings, pour que Total Value ne puisse jamais
                    // recalculer "maintenant" avec un prix différent. `stored` vient
                    // du même livePriceSnapshot figé (jamais une relecture tardive).
                    if (!isSingleAsset && i === displayTimestamps.length - 1) {
                        const stored = livePriceSnapshot.get(t);
                        resolvedPrices.set(t, {
                            price,
                            currency,
                            previousClose: stored?.previousClose ?? null,
                            lastUpdate: stored?.lastUpdate ?? null
                        });
                    }
                }
                totalInvested += isCash ? investedByTicker.get(t) : (assetCostBasisByTicker.get(t) || 0);
                if (!isCash) totalInvestedAssetOnly += assetCostBasisByTicker.get(t) || 0;

                // INSTRUMENTATION TEMPORAIRE — voir debugCapture plus haut. Un
                // enregistrement par (ticker, timestamp) réellement traité par CE
                // calcul, jamais une reconstruction a posteriori.
                if (debugCapture) {
                    debugCapture.push({
                        ts, ticker: t, quantity: qty, price, currency, rate,
                        value: price != null ? price * qty * rate : null,
                        source: priceSource, isLastPoint: i === displayTimestamps.length - 1
                    });
                }
            }

            // --- daily anchor: resolve once per calendar day, reusing the SAME
            // resolver used for "yesterdayClose" above (no parallel path). ---
            if (shouldAnchorOnClose) {
                const dayKey = new Date(ts).toDateString();
                if (dayKey !== dayKeyAnchored) {
                    const isFirstAnchor = periodDenominator === null;
                    let resolved = null;

                    if (days === 1 && isFirstAnchor && initialYesterdayClose > 0) {
                        // For the 1D view this IS the close already resolved above —
                        // reuse it verbatim instead of a second network/cache round-trip
                        // that could independently succeed or fail.
                        resolved = initialYesterdayClose;
                    } else {
                        const r = await resolveCloseBefore(new Date(ts), `day ${dayKey}`, true);
                        if (r.total > 0) resolved = r.total;
                    }

                    if (resolved === null) {
                        // Degraded fallback, only if the whole holding set is priced at
                        // this point (otherwise a thin/illiquid line getting its first
                        // price later would look like a fake jump).
                        const isComplete = expected > 0 && priced === expected;
                        if (isComplete && totalValue > 0) resolved = totalValue;
                    }

                    if (resolved !== null) {
                        dayKeyAnchored = dayKey;
                        dayDenominator = resolved;
                        if (isFirstAnchor) {
                            periodDenominator = resolved;
                            displayedYesterdayClose = resolved;
                        }
                    }
                }
            }

            // --- symmetric buy/sell adjustment: a quantity change must not itself
            // register as a gain (buy) or a loss (sell) on the TWR curve. ---
            if (quantityChanged && cashFlow !== 0) {
                const valueBeforeFlow = totalValue - cashFlow;
                if (valueBeforeFlow > 0) {
                    const scale = totalValue / valueBeforeFlow;
                    if (periodDenominator) periodDenominator *= scale;
                    if (dayDenominator) dayDenominator *= scale;
                }
            }

            // --- TWR values for this point ---
            let pointTwr;
            if (!hasAnyPrice && !quantityChanged) {
                pointTwr = null;
            } else if (shouldAnchorOnClose && periodDenominator > 0) {
                pointTwr = totalValue / periodDenominator;
            } else if (totalInvested > 0) {
                pointTwr = 1.0 + (totalValue - totalInvested) / totalInvested;
            } else {
                pointTwr = 1.0;
            }
            twr.push(pointTwr);

            const useDailyTwr = shouldAnchorOnClose && dayDenominator > 0;
            dailyTwr.push((!hasAnyPrice && !quantityChanged) ? null : (useDailyTwr ? totalValue / dayDenominator : null));

            labels.push(labelFormatFunc(ts));
            if (hasAnyPrice || quantityChanged) {
                invested.push(totalInvested);
                investedAssetOnly.push(totalInvestedAssetOnly);
                values.push(totalValue);
                cash.push(totalCash);
                // Même formule EXACTE que dataManager.buildPortfolioSnapshot
                // (totalReturn = (totalValue - cash) - investedAssetOnly, cash
                // exclu) — calculée UNE FOIS ici, jamais recalculée par une vue.
                const pointTotalReturn = (totalValue - totalCash) - totalInvestedAssetOnly;
                totalReturn.push(pointTotalReturn);
                totalReturnPct.push(totalInvestedAssetOnly > 0 ? (pointTotalReturn / totalInvestedAssetOnly) * 100 : 0);
                if (isSingleAsset) unitPrices.push(unitPrice);
            } else {
                invested.push(null);
                investedAssetOnly.push(null);
                values.push(null);
                cash.push(null);
                totalReturn.push(null);
                totalReturnPct.push(null);
                if (isSingleAsset) unitPrices.push(null);
            }
        }

        // dayStartValue used to be resolved independently of the TWR anchor and
        // could therefore drift from it — align it on the same single anchor.
        if (days === 1 && periodDenominator > 0) dayStartValue = periodDenominator;

        return { labels, invested, investedAssetOnly, values, cash, totalReturn, totalReturnPct, unitPrices, twr, dailyTwr, displayedYesterdayClose, dayStartValue, resolvedPrices };
    }

    // ========================================================
    // 9. Purchase markers (single-asset unit-price view)
    // ========================================================
    _buildPurchasePoints(ledger, ticker, displayTimestamps, labels, days, win, dynamicRate, historicalFxMap = null) {
        const points = [];
        const entries = ledger.byTicker.get(ticker) || [];
        const endTs = (win.displayEndTs === Infinity) ? Date.now() : win.displayEndTs;
        const tolerance = (days === 1) ? 2 * 3600000 : 4 * DAY_MS;

        for (const entry of entries) {
            const buyTs = entry.date.getTime();
            if (buyTs < win.displayStartTs || buyTs > endTs) continue;

            let closestIdx = -1, minDiff = Infinity;
            for (let i = 0; i < displayTimestamps.length; i++) {
                const diff = Math.abs(displayTimestamps[i] - buyTs);
                if (diff < minDiff) { minDiff = diff; closestIdx = i; }
            }
            if (closestIdx !== -1 && minDiff <= tolerance) {
                const rate = entry.currency === 'USD'
                    ? resolveHistoricalUsdToEurRate(entry.date, historicalFxMap, dynamicRate, { ticker, broker: entry.broker })
                    : 1;
                points.push({ x: labels[closestIdx], y: entry.price * rate, quantity: entry.quantity, date: entry.date });
            }
        }
        return points;
    }
}
