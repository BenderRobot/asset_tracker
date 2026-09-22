// ========================================
// MarketCalendarEngine.js — SINGLE SOURCE OF TRUTH for "is this asset's market
// open?", "what session is it?", "what's the previous/next session?" (Phase 2).
// ========================================
//
// AUDIT DONE BEFORE WRITING THIS FILE (see Phase 2 report) — reused, not
// duplicated:
//   - isCryptoTicker / isMixedPortfolio           (24/7 detection)
//   - getUTCOffsetHours / getMarketOpenUTCHour    (real, DST-aware IANA tz math)
//   - isStockRegularSession                       (EU-suffix vs US session hours)
//   - getLastTradingDay / getCloseCutoffForTicker (weekend-only "last trading day")
// None of the above is reimplemented here. This file gives them ONE call
// surface (so HistoricalChart/DataManager/dashboardApp stop each making their
// own ad-hoc "is it a weekday" checks) and adds what didn't exist yet:
// isTradingDay/getSession/getPreviousTradingSession/getNextTradingSession.
//
// HONEST LIMITATIONS (do not invent what this project doesn't actually have —
// see the audit brief's explicit ban on fabricated calendars):
//
// 1. Exchange/timezone resolution is a TICKER-SUFFIX HEURISTIC (.PA/.DE/.AS/…
//    = "European hours", anything else = "US hours"), same one already used
//    by MarketUtils.isStockRegularSession. It is NOT real per-asset exchange
//    metadata. Real metadata DOES exist in the Yahoo chart response this app
//    already fetches (`meta.exchangeTimezoneName`, `meta.gmtoffset`,
//    `meta.exchangeName`, `meta.currentTradingPeriod`) but api.js does not
//    currently extract it (only regularMarketPrice/previousClose/currency/
//    marketState are read — see api.js:148-166,297-298,439-445). Wiring that
//    real metadata in is future work, not done in this pass — flagged here so
//    it isn't silently forgotten, not pretended to be solved.
//
// 2. NO HOLIDAY CALENDAR. There is no holiday library or provider anywhere in
//    this project (confirmed by search before writing this file). isTradingDay
//    below can only rule out weekends — a real holiday (Thanksgiving, Christmas…)
//    will incorrectly read as "trading day" here. This is a known, accepted gap,
//    not a fabricated calendar: better an honest "we don't know" than an
//    invented list of dates nobody maintains. It is possible to derive PAST
//    closures empirically (a weekday with no fetched candle at all = market was
//    closed that day) once real historical data is available — not implemented
//    here (needs access to historicalDataMap, which lives in HistoryCalculator,
//    not this module) but documented as the natural next step.
//
// 3. Only two "exchange families" are distinguished (EU-suffix vs everything
//    else treated as US) — matches what the rest of this codebase already
//    assumes (see isStockRegularSession, YAHOO_MAP). A real Asian/other
//    exchange ticker would silently be treated as "US hours", which is wrong;
//    flagged, not solved, in this pass.

import {
    isCryptoTicker,
    isStockRegularSession,
    getMarketOpenUTCHour,
    getLastTradingDay
} from './MarketUtils.js';

const EU_SUFFIXES = ['.PA', '.DE', '.AS', '.L', '.BR', '.MI', '.HE', '.SW'];

function isEuTicker(ticker) {
    const t = (ticker || '').toUpperCase();
    return EU_SUFFIXES.some(suffix => t.endsWith(suffix));
}

export class MarketCalendarEngine {
    /**
     * @param {string} ticker
     * @returns {'crypto_24_7'|'exchange_eu'|'exchange_us'}
     */
    getTradingModel(ticker) {
        if (!ticker || ticker.startsWith('CASH-') || isCryptoTicker(ticker)) return 'crypto_24_7';
        return isEuTicker(ticker) ? 'exchange_eu' : 'exchange_us';
    }

    /**
     * IANA timezone for this ticker's market. Heuristic fallback (see file-level
     * limitation #1) — not real per-asset metadata.
     * @returns {string}
     */
    getTimezone(ticker) {
        const model = this.getTradingModel(ticker);
        if (model === 'crypto_24_7') return 'UTC';
        return model === 'exchange_eu' ? 'Europe/Paris' : 'America/New_York';
    }

    /**
     * Timezone used to define the GLOBAL portfolio's "00:00 → 00:00" 1D window.
     * No user preference exists in this product today — Europe/Paris matches
     * the app's existing default locale (fr-FR UI) and was already the
     * implicit assumption in HistoryCalculator's EU/US branch before Phase 2.
     * Documented assumption, not silently invented; revisit if the product
     * ever supports a user-configurable "home" timezone.
     */
    getPortfolioTimezone() {
        return 'Europe/Paris';
    }

    /**
     * Weekend-only check (see file-level limitation #2 — no holiday calendar).
     */
    isTradingDay(ticker, date = new Date()) {
        if (this.getTradingModel(ticker) === 'crypto_24_7') return true;
        const day = date.getDay();
        return day !== 0 && day !== 6;
    }

    isMarketOpen(ticker, timestamp = Date.now()) {
        if (this.getTradingModel(ticker) === 'crypto_24_7') return true;
        return isStockRegularSession(ticker, timestamp);
    }

    /**
     * Regular session bounds (UTC ms) for the given ticker on the civil day of
     * `date` — null if that day isn't a trading day for this ticker (weekend;
     * a real holiday will be missed, see limitation #2). Crypto returns the
     * full 00:00→24:00 UTC calendar day (24/7, no "session" in the exchange
     * sense).
     * @returns {{openUTCMs:number, closeUTCMs:number, tradingModel:string}|null}
     */
    getSession(ticker, date = new Date()) {
        const model = this.getTradingModel(ticker);
        if (model === 'crypto_24_7') {
            const start = new Date(date); start.setHours(0, 0, 0, 0);
            return { openUTCMs: start.getTime(), closeUTCMs: start.getTime() + 24 * 3600000, tradingModel: model };
        }
        if (!this.isTradingDay(ticker, date)) return null;

        const tz = this.getTimezone(ticker);
        const isEu = model === 'exchange_eu';
        const localOpenHour = isEu ? 9 : 9.5;   // Euronext-style 09:00 / Nasdaq-NYSE 09:30
        const localCloseHour = isEu ? 17.5 : 16; // 17:30 / 16:00

        // Same DST-aware "local hour -> today's UTC hour" resolution already
        // used by HistoryCalculator's 1D window (getMarketOpenUTCHour) — reused,
        // not reimplemented, and inherits its precision (fractional UTC hour
        // anchored on `date`'s own Y/M/D).
        const dayStartUTC = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
        const toMs = (localHour) => dayStartUTC + getMarketOpenUTCHour(localHour, tz, date) * 3600000;

        return { openUTCMs: toMs(localOpenHour), closeUTCMs: toMs(localCloseHour), tradingModel: model };
    }

    getSessionOpen(ticker, date = new Date()) {
        return this.getSession(ticker, date)?.openUTCMs ?? null;
    }

    getSessionClose(ticker, date = new Date()) {
        return this.getSession(ticker, date)?.closeUTCMs ?? null;
    }

    /**
     * Previous trading session (skips weekends via getLastTradingDay; a real
     * holiday is not detected — see limitation #2).
     */
    getPreviousTradingSession(ticker, date = new Date()) {
        if (this.getTradingModel(ticker) === 'crypto_24_7') {
            const prevDay = new Date(date);
            prevDay.setDate(prevDay.getDate() - 1);
            return this.getSession(ticker, prevDay);
        }
        return this.getSession(ticker, getLastTradingDay(date));
    }

    /**
     * Next trading session (skips weekends; a real holiday is not detected —
     * see limitation #2). Bounded loop guards against an infinite scan if
     * isTradingDay were ever wrongly false for a whole week.
     */
    getNextTradingSession(ticker, date = new Date()) {
        const next = new Date(date);
        next.setDate(next.getDate() + 1);
        if (this.getTradingModel(ticker) === 'crypto_24_7') return this.getSession(ticker, next);

        let guard = 0;
        while (!this.isTradingDay(ticker, next) && guard < 10) {
            next.setDate(next.getDate() + 1);
            guard++;
        }
        return this.getSession(ticker, next);
    }
}

export const marketCalendarEngine = new MarketCalendarEngine();
