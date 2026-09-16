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
//  3. Market-open times are DST-aware (MarketUtils.getMarketOpenUTCHour), not
//     a hardcoded UTC offset that silently drifts by an hour every summer.
//  4. Stock candles never snap forward across a weekend/holiday gap
//     (findClosestPrice(..., allowForward=false) for non-crypto tickers).

import { USD_TO_EUR_FALLBACK_RATE } from './config.js';
import { parseDate } from './utils.js';
import {
    getIntervalForPeriod,
    getLabelFormat,
    getLastTradingDay,
    isCryptoTicker,
    isMixedPortfolio,
    findClosestPrice,
    formatTicker,
    resolveTickerPreviousClose,
    getCloseCutoffForTicker,
    getMarketOpenUTCHour
} from './MarketUtils.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyResult() {
    return {
        labels: [], invested: [], investedAssetOnly: [], values: [], yesterdayClose: null,
        dayStartValue: null, todayValueOfYesterdayHoldings: null,
        perTickerYesterdayClose: new Map(), unitPrices: [], purchasePoints: [],
        timestamps: [], twr: [], dailyTwr: [], historicalDataMap: new Map(), isMixed: false
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
    async calculateGenericHistory(purchases, days, isSingleAsset = false) {
        const ledger = this._buildLedger(purchases, isSingleAsset);
        if (!ledger.firstPurchaseDate) return emptyResult();

        const dynamicRate = this.storage.getConversionRate('USD_TO_EUR') || USD_TO_EUR_FALLBACK_RATE;
        const tickers = Array.from(ledger.byTicker.keys());
        const isCrypto = isSingleAsset
            ? isCryptoTicker(tickers[0] || '')
            : tickers.filter(t => !t.startsWith('CASH-')).some(t => isCryptoTicker(t));
        const isMixed = !isSingleAsset && isMixedPortfolio(tickers);

        console.log(`[HistoryCalc] ${isSingleAsset ? 'Single' : (isMixed ? 'Mixed' : 'Multi')} portfolio, isCrypto=${isCrypto}, isMixed=${isMixed}, days=${days}`, tickers);

        const win = this._computeDisplayWindow(days, isCrypto, isMixed, ledger);
        const interval = getIntervalForPeriod(days);
        const labelFormatFunc = getLabelFormat(days);

        const historicalDataMap = await this._fetchHistoricalData(tickers, win.dataStartTs, win.dataEndTs, interval);
        await this._fillCryptoGapsFromBinance(tickers, historicalDataMap, days);
        await this._recoverFromClosedMarket(tickers, historicalDataMap, win, days, isCrypto, interval);

        const lastKnownPrices = this._seedLastKnownPrices(tickers, historicalDataMap, win, days);

        // --- THE canonical "portfolio value at close before refDate" resolver ---
        // Reused for the period's own anchor below AND for every day boundary the
        // main loop crosses (see _resolveDailyAnchor) — never a second, parallel
        // implementation of the same question.
        const resolveCloseBefore = (refDate, label, useDedicatedFetch) =>
            this._resolvePortfolioCloseBefore(ledger, refDate, tickers, {
                dynamicRate, isSingleAsset, historicalDataMap, useDedicatedFetch, label
            });

        // For a 1D view "yesterday" is relative to the day actually displayed
        // (win.displayStart), not to the real calendar date — otherwise, once the
        // market is closed and the chart rolls back to the last trading day, this
        // would resolve to that same day's own close instead of the day before it.
        const yesterdayRefDate = (days === 1) ? win.displayStart : new Date();
        const yesterday = await resolveCloseBefore(yesterdayRefDate, 'yesterdayClose', true);

        this._patchOfficialClose(tickers, historicalDataMap, yesterday, yesterdayRefDate);

        if (days === 1) {
            this._injectMidnightPrices(tickers, historicalDataMap, win, yesterday);
        }

        const displayTimestamps = this._buildTimestampGrid(days, historicalDataMap, win, ledger, interval, isCrypto);

        const { perTickerYesterdayClose, todayValueOfYesterdayHoldings } =
            this._valueTodaysHoldingsAtYesterdaysQuantities(tickers, yesterday, dynamicRate, isSingleAsset);

        const series = await this._buildSeries({
            ledger, tickers, historicalDataMap, displayTimestamps, lastKnownPrices,
            dynamicRate, isSingleAsset, interval, days, labelFormatFunc,
            resolveCloseBefore, initialYesterdayClose: yesterday.total, win
        });

        const purchasePoints = isSingleAsset
            ? this._buildPurchasePoints(ledger, tickers[0], displayTimestamps, series.labels, days, win, dynamicRate)
            : [];

        return {
            labels: series.labels,
            invested: series.invested,
            investedAssetOnly: series.investedAssetOnly,
            values: series.values,
            yesterdayClose: series.displayedYesterdayClose,
            dayStartValue: series.dayStartValue,
            todayValueOfYesterdayHoldings,
            perTickerYesterdayClose,
            unitPrices: series.unitPrices,
            purchasePoints,
            timestamps: displayTimestamps,
            twr: series.twr,
            dailyTwr: series.dailyTwr,
            historicalDataMap,
            isMixed
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
                currency: p.currency || 'EUR'
            }));
        } else {
            purchases.forEach(p => {
                const type = (p.assetType || '').toLowerCase();
                const isCash = type === 'cash' || p.ticker.toUpperCase() === 'CASH' || p.ticker.toUpperCase() === 'EUR';
                const currency = p.currency || 'EUR';
                const t = isCash ? `CASH-${currency}` : p.ticker.toUpperCase();
                if (isCash) {
                    addEntry(t, { date: parseDate(p.date), price: 1.0, quantity: parseFloat(p.price) || 0, currency });
                } else {
                    addEntry(t, { date: parseDate(p.date), price: parseFloat(p.price), quantity: parseFloat(p.quantity), currency });
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
        const isWeekend = today.getDay() === 0 || today.getDay() === 6;
        let displayStart;
        let bufferDays = 5;
        let hardStopTs = null;

        if (days === 'ytd') {
            displayStart = new Date(today.getFullYear(), 0, 1, 0, 0, 0);
            bufferDays = 5;
        } else if (days === 730) {
            displayStart = new Date(today); displayStart.setHours(0, 0, 0, 0);
            displayStart.setDate(displayStart.getDate() - 729);
            bufferDays = 14;
        } else if (isCrypto || (typeof days === 'number' && days >= 7)) {
            // 24/7 assets, or a long enough view that weekday gaps don't matter.
            const local = new Date(today); local.setHours(0, 0, 0, 0);
            if (days === 1) {
                // handled below
            } else if (days === 2) {
                // A mixed (crypto+stocks) portfolio viewed on a Monday: "yesterday" in
                // market terms is Friday, not Sunday (stocks don't trade there) — start
                // the window on Friday so this 2D view anchors on the same close as 1D.
                if (isMixed && today.getDay() === 1) local.setDate(local.getDate() - 3);
                else local.setDate(local.getDate() - 1);
            } else if (days !== 'all') {
                local.setDate(local.getDate() - (days - 1));
            } else {
                local.setTime(ledger.firstPurchaseDate ? ledger.firstPurchaseDate.getTime() : Date.now());
            }
            displayStart = (days === 1) ? (() => { const d = new Date(today); d.setHours(0, 0, 0, 0); return d; })() : local;
            bufferDays = (typeof days === 'number' && days <= 7) ? 2 : 14;
        } else if (isWeekend && (days === 1 || days === 2)) {
            // Stocks-only, weekend: show the last trading day instead of an empty one.
            const daysBack = today.getDay() === 0 ? 2 : 1;
            const lastTradingDay = new Date(today);
            lastTradingDay.setDate(today.getDate() - daysBack);
            lastTradingDay.setHours(23, 59, 59, 999);
            hardStopTs = lastTradingDay.getTime();
            const start = new Date(lastTradingDay); start.setHours(0, 0, 0, 0);
            if (days === 2) start.setDate(start.getDate() - 1);
            displayStart = start;
            bufferDays = 5;
        } else if (days === 1) {
            // Stocks, weekday: the window opens at the market's real open time
            // today, DST-aware, so an overnight/pre-market gap is never hidden
            // behind a synthetic "yesterday close" point that starts too late.
            const tickers = Array.from(ledger.byTicker.keys());
            const hasEU = tickers.some(t => t.endsWith('.PA') || t.endsWith('.DE') || t.includes('EUR') ||
                (ledger.byTicker.get(t)?.[0]?.currency === 'EUR'));
            const openUTCHour = hasEU
                ? getMarketOpenUTCHour(9, 'Europe/Paris', today)
                : getMarketOpenUTCHour(9.5, 'America/New_York', today);
            const h = Math.floor(openUTCHour);
            const m = Math.round((openUTCHour - h) * 60);
            displayStart = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), h, m, 0));
            bufferDays = 5;
        } else if (days === 2) {
            const start = new Date(today); start.setHours(0, 0, 0, 0);
            if (today.getDay() === 1) start.setDate(start.getDate() - 3); // Monday -> Friday
            else start.setDate(start.getDate() - 1);
            displayStart = start;
            bufferDays = 5;
        } else if (days !== 'all') {
            const start = new Date(today); start.setHours(0, 0, 0, 0);
            start.setDate(start.getDate() - (days - 1));
            displayStart = start;
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
    async _fetchHistoricalData(tickers, startTs, endTs, interval) {
        const map = new Map();
        const batchSize = 3;
        for (let i = 0; i < tickers.length; i += batchSize) {
            const batch = tickers.slice(i, i + batchSize);
            await Promise.all(batch.map(async (t) => {
                if (t.startsWith('CASH-')) { map.set(t, {}); return; }
                try {
                    const hist = await this.getHistoryWithCache(formatTicker(t), startTs, endTs, interval);
                    map.set(t, hist || {});
                } catch (err) {
                    map.set(t, {});
                }
            }));
        }
        return map;
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

    // Stocks-only 1D view, but the market is closed and nothing was fetched for
    // "today" (e.g. requested right after midnight, before any candle exists):
    // roll the whole window back to the last complete trading day.
    async _recoverFromClosedMarket(tickers, historicalDataMap, win, days, isCrypto, interval) {
        if (days !== 1 || isCrypto) return;
        const hasToday = tickers.some(t => {
            const hist = historicalDataMap.get(t);
            return hist && Object.keys(hist).map(Number).some(ts => ts >= win.displayStartTs);
        });
        if (hasToday) return;

        let lastTradingDay = getLastTradingDay(new Date());
        if (lastTradingDay.toDateString() === new Date().toDateString()) {
            lastTradingDay.setDate(lastTradingDay.getDate() - 1);
            lastTradingDay = getLastTradingDay(lastTradingDay);
        }
        lastTradingDay.setHours(0, 0, 0, 0);
        win.displayStart = lastTradingDay;
        win.displayStartTs = lastTradingDay.getTime();

        const fallbackEnd = new Date(lastTradingDay); fallbackEnd.setHours(23, 59, 59, 999);
        win.displayEndTs = win.hardStopTs = fallbackEnd.getTime();

        const fallbackDataStart = new Date(lastTradingDay);
        fallbackDataStart.setUTCDate(fallbackDataStart.getUTCDate() - 5);
        const startTs = Math.floor(fallbackDataStart.getTime() / 1000);
        const endTs = Math.floor(fallbackEnd.getTime() / 1000);

        const fresh = await this._fetchHistoricalData(tickers, startTs, endTs, interval);
        fresh.forEach((hist, t) => historicalDataMap.set(t, hist));
    }

    // ========================================================
    // 4. Last-known-price backfill (used before any real candle exists)
    // ========================================================
    _seedLastKnownPrices(tickers, historicalDataMap, win, days) {
        const lastKnown = new Map();

        for (const t of tickers) {
            const isCrypto = isCryptoTicker(t);

            // Short views on stocks: trust storage.previousClose directly rather than
            // a forward-tolerant search, which could snap onto a near-future candle
            // (e.g. Monday's open leaking onto a weekend point) and misrepresent the
            // overnight gap.
            if (!isCrypto && !t.startsWith('CASH-') && typeof days === 'number' && days <= 2) {
                const priceData = this.storage.getCurrentPrice(t);
                if (priceData && priceData.previousClose > 0) { lastKnown.set(t, priceData.previousClose); continue; }
            }

            const hist = historicalDataMap.get(t);
            if (hist) {
                const ts = Object.keys(hist).map(Number).sort((a, b) => a - b);
                if (ts.length > 0 && hist[ts[0]] > 0) { lastKnown.set(t, hist[ts[0]]); continue; }
            }

            if (!isCrypto) {
                const priceData = this.storage.getCurrentPrice(t);
                if (priceData?.price > 0) { lastKnown.set(t, priceData.price); continue; }
                if (priceData?.previousClose > 0) { lastKnown.set(t, priceData.previousClose); continue; }
            }
        }

        // Absolute last resort: whatever is currently stored, so a freshly added
        // position is never silently dropped from the total for lack of history.
        for (const t of tickers) {
            if (lastKnown.has(t) || t.startsWith('CASH-')) continue;
            const priceData = this.storage.getCurrentPrice(t);
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
    async _resolvePortfolioCloseBefore(ledger, refDate, tickers, { dynamicRate, isSingleAsset, historicalDataMap, useDedicatedFetch, label = '' }) {
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
                if (qty <= 0) return;

                if (t.startsWith('CASH-')) {
                    total += qty; assetsFound++; prices.set(t, 1.0); return;
                }

                const { closePrice } = await resolveTickerPreviousClose(t, {
                    storage: this.storage,
                    api: useDedicatedFetch ? this.api : undefined,
                    refDate,
                    preferLiveClose: false,
                    historicalDataMap: useDedicatedFetch ? null : (historicalDataMap.get(t) || null),
                    allowFetch: useDedicatedFetch
                });

                if (closePrice > 0) {
                    prices.set(t, closePrice);
                    let rate = 1;
                    if (!isSingleAsset) {
                        const currency = this.storage.getCurrentPrice(t)?.currency || 'EUR';
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

    // The last intraday candle (5m/15m) of a finished trading day can differ from
    // its true official close (e.g. a closing auction on some EU stocks the last
    // intraday tick doesn't capture) — verified as a several-hundred-euro gap for
    // some tickers. Left uncorrected, the curve itself would tell a different story
    // than "CLÔTURE HIER"/VAR TODAY (both built from the official close resolved
    // above), so the last pre-cutoff candle is forced to match it exactly.
    _patchOfficialClose(tickers, historicalDataMap, resolution, refDate) {
        for (const t of tickers) {
            if (t.startsWith('CASH-') || isCryptoTicker(t)) continue;
            const officialClose = resolution.prices.get(t);
            if (!officialClose || officialClose <= 0) continue;
            const hist = historicalDataMap.get(t);
            if (!hist) continue;
            const cutoffTs = getCloseCutoffForTicker(t, refDate);
            const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
            let lastBeforeCutoff = null;
            for (const ts of keys) { if (ts <= cutoffTs) lastBeforeCutoff = ts; else break; }
            if (lastBeforeCutoff !== null && hist[lastBeforeCutoff] !== officialClose) {
                hist[lastBeforeCutoff] = officialClose;
            }
        }
    }

    // The first plotted point of a 1D view (00:00) must be pinned to the SAME
    // resolved "yesterday close" used as the day's anchor (dayDenominator),
    // for every ticker without exception — stocks AND crypto alike.
    //
    // Stocks have no quote before the market opens, so without this they'd
    // simply be missing at 00:00. But crypto trades continuously, so it
    // already HAS a real price at 00:00 in the fetched candles — and that real
    // price is not guaranteed to equal the ticker's own resolved previous
    // close (different resolution path: live candle lookup vs
    // resolveTickerPreviousClose's cutoff-aware chain). Left alone, that
    // mismatch shows up as a fake gap at the very start of the curve for any
    // portfolio holding crypto — verified: BTC's real 00:00 price differed
    // from its resolved previous close by several percent, creating a portfolio-
    // wide dip visible before the stock market had even opened, with no real
    // price move behind it. Always overwriting the 00:00 point with the exact
    // same per-ticker close used for the anchor removes this class of bug
    // entirely: the curve and its own anchor can no longer disagree about
    // where "today" starts, for any asset type.
    _injectMidnightPrices(tickers, historicalDataMap, win, yesterday) {
        for (const t of tickers) {
            if (t.startsWith('CASH-')) continue;
            const hist = historicalDataMap.get(t);
            if (!hist) continue;

            let price = yesterday.prices.get(t) || null;
            if (!price) {
                const pd = this.storage.getCurrentPrice(t);
                if (pd?.previousClose > 0) price = pd.previousClose;
                else if (isCryptoTicker(t) && pd?.price > 0) price = pd.price;
            }
            if (!price) price = findClosestPrice(hist, win.displayStartTs - 3600000, '1h', isCryptoTicker(t));

            if (price > 0) hist[win.displayStartTs] = price;
        }
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
    _valueTodaysHoldingsAtYesterdaysQuantities(tickers, yesterday, dynamicRate, isSingleAsset) {
        const map = new Map();
        let total = 0, found = 0;

        for (const t of tickers) {
            if (t.startsWith('CASH-')) continue;
            const qtyYesterday = yesterday.quantities.get(t) || 0;
            if (qtyYesterday <= 0) continue;

            const priceData = this.storage.getCurrentPrice(t);
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
    async _buildSeries({ ledger, tickers, historicalDataMap, displayTimestamps, lastKnownPrices, dynamicRate, isSingleAsset, interval, days, labelFormatFunc, resolveCloseBefore, initialYesterdayClose, win }) {
        const labels = [], invested = [], investedAssetOnly = [], values = [], unitPrices = [];
        const twr = [], dailyTwr = [];

        const quantities = new Map(tickers.map(t => [t, 0]));
        const investedByTicker = new Map(tickers.map(t => [t, 0]));

        // CRITICAL: seed quantities/invested with every purchase dated BEFORE the
        // displayed window starts — i.e. the entire pre-existing portfolio (bought
        // weeks/months/years ago). Without this, `quantities` starts at 0 and the
        // loop below only ever adds purchases that fall INSIDE the window (today),
        // so every pre-existing holding reads as "0 shares" at every timestamp and
        // gets skipped before its price is even looked up — the whole series comes
        // out null. This is not a purchase happening "during" the window; it's the
        // starting position the window's price movements apply on top of.
        for (const t of tickers) {
            for (const entry of ledger.byTicker.get(t) || []) {
                if (entry.date.getTime() <= win.displayStartTs - 1) {
                    quantities.set(t, quantities.get(t) + entry.quantity);
                    let rate = 1;
                    if (!isSingleAsset) {
                        const currency = this.storage.getCurrentPrice(t)?.currency || entry.currency || 'EUR';
                        if (currency === 'USD') rate = dynamicRate;
                    }
                    investedByTicker.set(t, investedByTicker.get(t) + entry.price * entry.quantity * rate);
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
                for (const entry of ledger.byTicker.get(t) || []) {
                    const entryTs = entry.date.getTime();
                    if (entryTs > prevTs && entryTs <= ts) {
                        quantities.set(t, quantities.get(t) + entry.quantity);
                        let rate = 1;
                        if (!isSingleAsset) {
                            const currency = this.storage.getCurrentPrice(t)?.currency || entry.currency || 'EUR';
                            if (currency === 'USD') rate = dynamicRate;
                        }
                        const flow = entry.price * entry.quantity * rate;
                        investedByTicker.set(t, investedByTicker.get(t) + flow);
                        cashFlow += flow;
                        quantityChanged = true;
                    }
                }
            }

            let totalValue = 0, totalInvested = 0, totalInvestedAssetOnly = 0, unitPrice = null;
            let hasAnyPrice = false, expected = 0, priced = 0;

            for (const t of tickers) {
                const qty = quantities.get(t);
                const isCash = t.startsWith('CASH-');
                if (Math.abs(qty) <= 0.000001) {
                    totalInvested += investedByTicker.get(t);
                    if (!isCash) totalInvestedAssetOnly += investedByTicker.get(t);
                    continue;
                }
                expected++;

                let price = null;
                if (isCash) {
                    price = 1.0;
                } else {
                    const hist = historicalDataMap.get(t);
                    if (hist?.[ts] != null) price = hist[ts];
                    else if (hist) price = findClosestPrice(hist, ts, interval, isCryptoTicker(t));
                    if (price == null && lastKnownPrices.has(t)) price = lastKnownPrices.get(t);
                }

                if (price != null) {
                    let rate = 1;
                    if (!isSingleAsset) {
                        const currency = this.storage.getCurrentPrice(t)?.currency || 'EUR';
                        if (currency === 'USD') rate = dynamicRate;
                    }
                    totalValue += price * qty * rate;
                    hasAnyPrice = true; priced++;
                    if (isSingleAsset) unitPrice = price;
                    lastKnownPrices.set(t, price);
                }
                totalInvested += investedByTicker.get(t);
                if (!isCash) totalInvestedAssetOnly += investedByTicker.get(t);
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
                if (isSingleAsset) unitPrices.push(unitPrice);
            } else {
                invested.push(null);
                investedAssetOnly.push(null);
                values.push(null);
                if (isSingleAsset) unitPrices.push(null);
            }
        }

        // dayStartValue used to be resolved independently of the TWR anchor and
        // could therefore drift from it — align it on the same single anchor.
        if (days === 1 && periodDenominator > 0) dayStartValue = periodDenominator;

        return { labels, invested, investedAssetOnly, values, unitPrices, twr, dailyTwr, displayedYesterdayClose, dayStartValue };
    }

    // ========================================================
    // 9. Purchase markers (single-asset unit-price view)
    // ========================================================
    _buildPurchasePoints(ledger, ticker, displayTimestamps, labels, days, win, dynamicRate) {
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
                const rate = entry.currency === 'USD' ? dynamicRate : 1;
                points.push({ x: labels[closestIdx], y: entry.price * rate, quantity: entry.quantity, date: entry.date });
            }
        }
        return points;
    }
}
