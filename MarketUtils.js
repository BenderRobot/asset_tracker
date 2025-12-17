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
    if (days === 1) return '5m';
    if (days === 2) return '5m'; // Force 5m pour 2 jours pour éviter gaps et avoir haute résolution
    if (days <= 7) return '15m'; // or 30m? 1h?
    if (days <= 30) return '90m'; // 1h
    if (days <= 90) return '1d';
    if (days <= 365) return '1d';
    return '1wk'; // > 1 year
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
    // hist keys are strings or numbers
    const timestamps = Object.keys(hist).map(k => parseInt(k)).sort((a, b) => a - b);
    if (timestamps.length === 0) return null;

    // Binary search or simple check? Simple linear for now or find closest
    // We want price AT or BEFORE targetTs
    let closestTs = null;
    for (let i = timestamps.length - 1; i >= 0; i--) {
        if (timestamps[i] <= targetTs) {
            closestTs = timestamps[i];
            break;
        }
    }

    // Optimization: if interval is 1d, and gap is > 4 days, maybe invalid?
    // keeping it simple
    if (closestTs) return hist[closestTs];
    return null;
}
