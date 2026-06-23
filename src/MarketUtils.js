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
 * @returns {number|null}
 */
export function findClosestPrice(hist, targetTs, interval) {
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
    let forwardTolerance = 3600000; // Default 1h
    if (interval === '5m') forwardTolerance = 300000;        // 5 min (intraday, dense data)
    else if (interval === '15m') forwardTolerance = 10800000; // 3 HOURS (for sparse weekend crypto on 1W grid)
    else if (interval === '30m') forwardTolerance = 10800000; // 3 hours
    else if (interval === '1h' || interval === '60m' || interval === '90m') forwardTolerance = 14400000; // 4 hours
    else if (interval === '1d') forwardTolerance = 172800000; // 2 days
    else if (interval === '1wk') forwardTolerance = 604800000; // 1 week

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
