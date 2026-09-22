// ========================================
// MarketUtils.js - Helper functions from DataManager
// ========================================

import { YAHOO_MAP } from './config.js';

/**
 * Returns the appropriate interval for a given number of days.
 * @param {number} days
 * @returns {string}
 */
export function getIntervalForPeriod(days) {
    // Cas spéciaux string en premier
    if (days === 'ytd') return '1d';   // YTD: journalier depuis le 1er janvier
    if (days === 'all') return '1wk';  // All: hebdomadaire
    // Cas numériques
    if (days === 1) return '5m';
    if (days === 2) return '5m';
    if (days <= 7) return '15m';
    if (days <= 30) return '90m';
    if (days <= 365) return '1d';
    if (days <= 730) return '1wk';  // 2Y
    return '1wk';                   // > 2 ans
}

/**
 * Returns the date format string for charts.
 * @param {number} days
 * @returns {Object} { unit, displayFormats }
 */
export function getLabelFormat(days) {
    return (dateUTC) => {
        const local = new Date(dateUTC);
        if (days === 1) return local.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        if (days <= 7) return local.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
        return local.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });
    };
}

/**
 * Returns the last trading day (skipping weekends).
 * @param {Date} date
 * @returns {Date}
 */
export function getLastTradingDay(date) {
    let d = new Date(date);
    d.setDate(d.getDate() - 1);
    // 0 = Sunday, 6 = Saturday
    while (d.getDay() === 0 || d.getDay() === 6) {
        d.setDate(d.getDate() - 1);
    }
    return d;
}

/**
 * SINGLE SOURCE OF TRUTH pour convertir un montant USD ACHETÉ à une date donnée en
 * EUR — utilisée à la fois par dataManager.js (positions, transactions) et
 * HistoryCalculator.js (coût de revient du graphique), pour ne jamais avoir deux
 * implémentations indépendantes de la même règle.
 *
 * `historicalFxMap` est une Map date('YYYY-MM-DD') -> taux EUR->USD (ex: fournie par
 * dataManager.fetchHistoricalFxRateMap('EURUSD=X', ...), càd "1 EUR = X USD" — on
 * inverse pour obtenir USD->EUR).
 *
 * Invariant 9 : une variation du taux COURANT ne doit jamais modifier rétroactivement
 * un montant EUR déjà investi. Ne fabrique jamais un taux silencieusement : si aucune
 * cotation n'existe à la date exacte ni dans une fenêtre de ±7 jours (weekend/jour
 * férié FX), retombe explicitement sur `fallbackRate` (le taux courant) et LOG le
 * repli, avec le contexte (ticker/broker) pour permettre de diagnostiquer précisément
 * quelle transaction reste approximée tant que la donnée historique n'est pas dispo.
 *
 * @param {string|Date} dateInput
 * @param {Map<string, number>|null} historicalFxMap
 * @param {number} fallbackRate
 * @param {{ticker?: string, broker?: string}} context
 * @returns {number} taux USD->EUR à appliquer
 */
export function resolveHistoricalUsdToEurRate(dateInput, historicalFxMap, fallbackRate, context = {}) {
    const label = `${context.ticker || '?'} / ${context.broker || '?'}`;

    if (!historicalFxMap || historicalFxMap.size === 0) {
        console.warn(`[FX] Aucun taux historique EUR/USD chargé — repli explicite sur le taux courant (${fallbackRate}) pour ${label} du ${dateInput}.`);
        return fallbackRate;
    }

    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return fallbackRate;

    const toKey = (dd) => dd.toISOString().split('T')[0];
    let eurUsdRate = historicalFxMap.get(toKey(d));

    if (!eurUsdRate) {
        for (let i = 1; i <= 7 && !eurUsdRate; i++) {
            const back = new Date(d); back.setDate(d.getDate() - i);
            eurUsdRate = historicalFxMap.get(toKey(back));
        }
    }
    if (!eurUsdRate) {
        for (let i = 1; i <= 7 && !eurUsdRate; i++) {
            const fwd = new Date(d); fwd.setDate(d.getDate() + i);
            eurUsdRate = historicalFxMap.get(toKey(fwd));
        }
    }

    if (!eurUsdRate) {
        console.warn(`[FX] Taux historique EUR/USD introuvable (±7j) pour ${label} du ${toKey(d)} — repli explicite sur le taux courant (${fallbackRate}).`);
        return fallbackRate;
    }

    return 1 / eurUsdRate;
}

/**
 * Checks if a ticker is a crypto.
 * @param {string} ticker
 * @returns {boolean}
 */
export function isCryptoTicker(ticker) {
    const cryptoList = ['BTC', 'ETH', 'SOL', 'ADA', 'DOT', 'LINK', 'LTC', 'XRP', 'XLM', 'BNB', 'AVAX', 'DOGE', 'SHIB', 'MATIC', 'UNI', 'AAVE'];
    if (!ticker) return false;
    ticker = ticker.toUpperCase();
    return cryptoList.includes(ticker) || ticker.includes('-EUR') || ticker.includes('-USD') || ticker === 'BTC-EUR';
}

/**
 * True when the portfolio holds both crypto (24/7) and exchange-traded assets.
 * @param {Iterable<string>} tickers
 * @returns {boolean}
 */
export function isMixedPortfolio(tickers) {
    let hasCrypto = false;
    let hasStock = false;
    for (const t of tickers) {
        if (!t || t.startsWith('CASH-')) continue;
        if (isCryptoTicker(t)) hasCrypto = true;
        else hasStock = true;
        if (hasCrypto && hasStock) return true;
    }
    return false;
}

/**
 * End of the previous calendar day (23:59:59.999 local).
 * @param {Date} [from]
 * @returns {Date}
 */
export function getCalendarYesterdayClose(from = new Date()) {
    const d = new Date(from);
    d.setDate(d.getDate() - 1);
    d.setHours(23, 59, 59, 999);
    return d;
}

/** Or / Forex : cotent en semaine hors horaires actions. */
export function is245Ticker(ticker) {
    if (!ticker) return false;
    const t = ticker.toUpperCase();
    return t === 'EURUSD=X' || t === 'GC=F';
}

/**
 * Séance régulière uniquement (heure de Paris), sans pré/post marché.
 * Évite les sauts fictifs (ex. clôture after-hours US vers 02h00 Paris).
 */
export function isStockRegularSession(ticker, timestamp, currency = 'EUR') {
    if (!ticker || ticker.startsWith('CASH-') || isCryptoTicker(ticker) || is245Ticker(ticker)) {
        return true;
    }

    const d = new Date(timestamp);
    const day = d.getDay();
    if (day === 0 || day === 6) return false;

    const mins = d.getHours() * 60 + d.getMinutes();
    const t = ticker.toUpperCase();

    // Bourses EU : suffixe d'échange (aligné sur dataManager.getAssetCategory)
    const isEU =
        t.endsWith('.PA') ||
        t.endsWith('.DE') ||
        t.endsWith('.AS') ||
        t.endsWith('.L') ||
        t.endsWith('.BR') ||
        t.endsWith('.MI') ||
        t.endsWith('.HE') ||
        t.endsWith('.SW');

    if (isEU) {
        return mins >= 9 * 60 && mins < 17 * 60 + 30;
    }

    // Sans suffixe (.PA etc.) → marché US par défaut (ASTS, NVDA, etc.)
    return mins >= 15 * 60 + 30 && mins < 22 * 60;
}

/**
 * Timestamp (ms) of the "previous close" cutoff for a given ticker/refDate.
 * Crypto/cash trade 24/7 so their reference is the calendar day boundary
 * (refDate - 1 day, 23:59:59.999); stocks have no weekend quotes so their
 * reference stays the last trading day. SINGLE SOURCE OF TRUTH for this rule —
 * used by every previousClose resolver in the app (portfolio holdings, index
 * cards, dashboard market cards).
 * @param {string} ticker
 * @param {Date} [refDate]
 * @returns {number}
 */
export function getCloseCutoffForTicker(ticker, refDate = new Date()) {
    if (ticker.startsWith('CASH-') || isCryptoTicker(ticker)) {
        return getCalendarYesterdayClose(refDate).getTime();
    }
    const d = getLastTradingDay(refDate);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
}

/**
 * Resolves a single ticker's "previous close" price (native currency, unit
 * price — no quantity/FX applied). SINGLE SOURCE OF TRUTH: previously
 * duplicated across HistoryCalculator's portfolio resolver, the index-card
 * fetcher and the dashboard market-card fetcher — now the one implementation
 * all three call.
 *
 * Priority: live storage.previousClose (if preferLiveClose, non-crypto) →
 * last candle in `historicalDataMap` at/before the cutoff → an optional short
 * fetch of daily candles (only if `allowFetch` and no map was supplied) →
 * storage.previousClose → storage.price (last-resort, never returns 0/null
 * for a ticker that has ANY price data).
 *
 * @param {string} ticker
 * @param {Object} opts
 * @param {Object} opts.storage - app Storage instance (getCurrentPrice)
 * @param {Object} [opts.api] - app Api instance (getHistoricalPricesWithRetry), required if allowFetch
 * @param {Date} [opts.refDate]
 * @param {boolean} [opts.preferLiveClose]
 * @param {Object|null} [opts.historicalDataMap] - {timestampMs: price} for this ticker, already fetched by the caller
 * @param {boolean} [opts.allowFetch] - if true and no historicalDataMap, fetch ~7d of daily candles
 * @returns {Promise<{closePrice: number|null, cutoffTs: number}>}
 */
export async function resolveTickerPreviousClose(ticker, {
    storage,
    api = null,
    refDate = new Date(),
    preferLiveClose = false,
    historicalDataMap = null,
    allowFetch = false
} = {}) {
    const cutoffTs = getCloseCutoffForTicker(ticker, refDate);
    let closePrice = null;

    const findLastAtOrBefore = (hist, cutoff) => {
        if (!hist) return null;
        const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
        let bestTs = null;
        for (const ts of keys) {
            if (ts <= cutoff) bestTs = ts; else break;
        }
        return bestTs !== null ? hist[bestTs] : null;
    };

    if (preferLiveClose && !isCryptoTicker(ticker)) {
        const priceData = storage.getCurrentPrice(ticker);
        if (priceData && priceData.previousClose > 0) closePrice = priceData.previousClose;
    }

    if ((!closePrice || closePrice <= 0) && historicalDataMap) {
        const found = findLastAtOrBefore(historicalDataMap, cutoffTs);
        if (found !== null) closePrice = found;
    }

    if ((!closePrice || closePrice <= 0) && allowFetch && !historicalDataMap && api) {
        const hist = await api.getHistoricalPricesWithRetry(
            formatTicker(ticker),
            Math.floor(cutoffTs / 1000) - 7 * 86400,
            Math.floor(cutoffTs / 1000),
            '1d'
        );
        const found = findLastAtOrBefore(hist, cutoffTs);
        if (found !== null) closePrice = found;
    }

    if (!closePrice || closePrice <= 0) {
        const priceData = storage.getCurrentPrice(ticker);
        if (priceData && priceData.previousClose > 0) closePrice = priceData.previousClose;
    }
    if (!closePrice || closePrice <= 0) {
        const priceData = storage.getCurrentPrice(ticker);
        if (priceData && priceData.price > 0) closePrice = priceData.price;
    }

    return { closePrice: closePrice || null, cutoffTs };
}

/**
 * Sums signed quantities for one ticker up to (and including) a cutoff date.
 * Buys are positive, sells negative — pure "as of a past date" query.
 * NOT the same question as "current quantity" (calculateHoldings' ledger walk,
 * which also handles cost-basis) or HistoryCalculator's per-timestamp running
 * totals (a different, incrementally-updated computation for performance
 * reasons on the chart's hot path) — this is for one-off, sparse lookups
 * (e.g. dividend quantity-held-at-ex-date).
 * @param {Array} purchases
 * @param {string} ticker
 * @param {Date|string} cutoffDate
 * @returns {number}
 */
export function getQuantityAtDate(purchases, ticker, cutoffDate) {
    const cutoffTs = (cutoffDate instanceof Date ? cutoffDate : new Date(cutoffDate)).getTime();
    return purchases
        .filter(p => p.ticker === ticker && p.type !== 'dividend')
        .filter(p => new Date(p.date).getTime() <= cutoffTs)
        .reduce((qty, p) => qty + parseFloat(p.quantity), 0);
}

/**
 * Current UTC offset (hours, DST-aware) of an IANA timezone at a given date.
 * Unlike a hardcoded constant, this automatically reflects CET/CEST, EST/EDT, etc.
 * @param {string} timeZone - IANA timezone, e.g. 'Europe/Paris', 'America/New_York'
 * @param {Date} [refDate]
 * @returns {number}
 */
export function getUTCOffsetHours(timeZone, refDate = new Date()) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const parts = dtf.formatToParts(refDate).reduce((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
    }, {});
    const hour = parts.hour === '24' ? 0 : Number(parts.hour);
    const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
    return (asUTC - refDate.getTime()) / 3600000;
}

/**
 * UTC hour (may be fractional, e.g. 13.5) at which a market's local open time
 * falls TODAY, DST-aware. Replaces hardcoded "08:00 UTC (09:00 Paris Winter)"-style
 * assumptions, which silently become wrong by exactly one hour every year during
 * CEST/EDT (late March-late October) — causing the 1D view's day-start reference
 * to be computed an hour after the real market open, missing the true opening
 * print (which then gets masked by the synthetic "yesterday's close" injection).
 * @param {number} localOpenHour - market open hour in local time (e.g. 9 for Paris, 9.5 for NYSE)
 * @param {string} timeZone - IANA timezone, e.g. 'Europe/Paris', 'America/New_York'
 * @param {Date} [refDate]
 * @returns {number}
 */
export function getMarketOpenUTCHour(localOpenHour, timeZone, refDate = new Date()) {
    return localOpenHour - getUTCOffsetHours(timeZone, refDate);
}

/**
 * Formats ticker for display (removes suffix).
 * @param {string} ticker
 * @returns {string}
 */
export function formatTicker(ticker) {
    ticker = ticker.toUpperCase().trim();
    if (YAHOO_MAP[ticker]) return YAHOO_MAP[ticker];
    const cryptos = ['BTC', 'ETH', 'SOL', 'ADA', 'DOT', 'LINK', 'LTC', 'XRP', 'XLM', 'BNB', 'AVAX'];
    return cryptos.includes(ticker) ? ticker + '-EUR' : ticker;
}

/**
 * Finds the price closest to a target timestamp in history.
 * @param {Object} hist - Map or Array of prices
 * @param {number} targetTs
 * @param {string} interval
 * @param {boolean} [allowForward=true] - allow snapping to a future candle within
 *   tolerance. Needed for crypto (sparse weekend data on a dense grid) — but for
 *   stocks it lets a Monday-morning candle (often a thin/illiquid pre-market print)
 *   leak backward onto Saturday/Sunday grid points, producing a fake cliff right at
 *   the weekend boundary on any 1W+ view (the "bug lundi" already fixed for 1D/2D
 *   elsewhere, but this generic distance search had no ticker-type awareness).
 *   Callers should pass false for non-crypto tickers.
 * @returns {number|null}
 */
export function findClosestPrice(hist, targetTs, interval, allowForward = true) {
    if (!hist) return null;
    const timestamps = Object.keys(hist).map(k => parseInt(k)).sort((a, b) => a - b);
    if (timestamps.length === 0) return null;

    // REWRITTEN LOGIC: Robust Distance-Based Search
    // Goal: Find the 'best' price for the target timestamp.
    // 1. If we have a future point within tolerance, it's a good candidate (snap forward).
    // 2. We always have past points (last known).
    // We want the closest one overall, but biasing towards 'valid' data.

    // Define forward tolerance based on interval
    // CRITICAL: For 1W view (15m interval), we need MUCH larger tolerance because crypto weekend data
    // is sparse (1 point every 2-3 hours) but our uniform grid generates points every 15 minutes.
    // If tolerance is too strict, grid points can't find nearby data → fallback to Friday close → flatline!
    let forwardTolerance = allowForward ? 3600000 : 0; // Default 1h (0 = never snap forward)
    if (allowForward) {
        if (interval === '5m') forwardTolerance = 300000;        // 5 min (intraday, dense data)
        else if (interval === '15m') forwardTolerance = 10800000; // 3 HOURS (for sparse weekend crypto on 1W grid)
        else if (interval === '30m') forwardTolerance = 10800000; // 3 hours
        else if (interval === '1h' || interval === '60m' || interval === '90m') forwardTolerance = 14400000; // 4 hours
        else if (interval === '1d') forwardTolerance = 172800000; // 2 days
        else if (interval === '1wk') forwardTolerance = 604800000; // 1 week
    }

    let bestTs = null;
    let minDiff = Infinity;

    // First pass: Find closest timestamp globally (with constraints)
    for (const ts of timestamps) {
        const diff = ts - targetTs;
        const absDiff = Math.abs(diff);

        if (diff > 0) {
            // Future point: Must be within tolerance
            if (diff <= forwardTolerance) {
                if (absDiff < minDiff) {
                    minDiff = absDiff;
                    bestTs = ts;
                }
            }
        } else {
            // Past point: Always valid candidates, but we want the one closest to target (i.e. latest possible past)
            if (absDiff < minDiff) {
                minDiff = absDiff;
                bestTs = ts;
            }
        }
    }

    // Safety fallback: If nothing found (e.g. only future points > tolerance),
    // find the absolute latest past point to avoid null gaps.
    if (bestTs === null) {
        for (let i = timestamps.length - 1; i >= 0; i--) {
            if (timestamps[i] <= targetTs) {
                bestTs = timestamps[i];
                break;
            }
        }
    }

    if (bestTs !== null) return hist[bestTs];
    return null;
}
