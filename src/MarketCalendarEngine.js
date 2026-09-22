// ========================================
// MarketCalendarEngine.js — SINGLE SOURCE OF TRUTH for "is this asset's market
// open?", "what session is it?", "what's the previous/next session?" (Phase 2
// / 2.5).
// ========================================
//
// PHASE 2.5 AUDIT — real Yahoo payload actually received by this project
// (fetched live from this app's own Cloudflare proxy, not assumed):
//
//   curl "$PRICE_PROXY_URL?symbol=AAPL&type=STOCK&range=2d&interval=1d"
//   meta: {
//     exchangeName: "NMS", fullExchangeName: "NasdaqGS",
//     exchangeTimezoneName: "America/New_York",   <- REAL, IANA, reliable
//     instrumentType: "EQUITY",
//     currentTradingPeriod: { pre: {start,end,gmtoffset}, regular: {...}, post: {...} },
//     hasPrePostMarketData: true,
//     gmtoffset, timezone (abbreviated, e.g. "EDT"), regularMarketTime, ...
//     // NO `marketState` field at all in this endpoint's response.
//   }
//   curl "...symbol=SU.PA..."     -> exchangeTimezoneName: "Europe/Paris", exchangeName: "PAR"
//   curl "...symbol=BTC-EUR..."   -> exchangeTimezoneName: "UTC", exchangeName: "CCC",
//                                    instrumentType: "CRYPTOCURRENCY",
//                                    regular session spans ~24h (Yahoo's own way of saying "always open")
//   curl "...interval=5m..."     -> ALSO returns `tradingPeriods` (plural, one entry
//                                    per day covered by the intraday range) alongside
//                                    `currentTradingPeriod` (singular, "today" only).
//
// CRITICAL FINDING: api.js currently reads `meta.marketState || 'CLOSED'`
// (see api.js's index-fetch path) — but `marketState` is simply ABSENT from
// every real response above. That read has therefore always silently
// defaulted to `'CLOSED'` — not a working signal today, whatever its
// original intent. This engine does NOT use `meta.marketState`; it derives
// open/closed from `currentTradingPeriod.regular` (start/end, real Unix
// seconds) compared against "now", which the real payload DOES support
// reliably. This substitution is deliberate and documented here, not a
// silent claim that "marketState" itself works.
//
// NO HOLIDAY SOURCE: confirmed by inspecting package.json (only dependency:
// unused `yahoo-finance2`, never imported anywhere in src/) and node_modules
// — no calendar/holiday library anywhere in this project. `tradingPeriods`
// COULD, in principle, let a caller infer past closures empirically (a
// weekday absent from a multi-day intraday fetch's tradingPeriods = market
// was closed), but that requires a multi-day intraday fetch this engine
// doesn't make on its own — not implemented, see getTradingDayStatus's
// HOLIDAY_UNKNOWN result and the file-level limitation list below.
//
// CONFIDENCE HIERARCHY (section 3 of the brief), most to least trusted:
//   1. 'provider'          — real metadata ingested from a Yahoo chart response
//                             for THIS ticker, for THIS exact civil day.
//   2. (asset-config)       — NOT IMPLEMENTED: no per-asset config table exists
//                             anywhere in this project (checked before writing
//                             this file). Skipped, not faked.
//   3. (explicit config)    — NOT IMPLEMENTED: same reason.
//   4. 'heuristic-fallback' — ticker-suffix guess (.PA/.DE/... = Europe,
//                             else US), last resort, always labeled as such.
// Every method that can return provider-backed OR heuristic data exposes
// which one it used (see *Source() methods / getTradingDayStatus).
//
// HONEST LIMITATIONS still standing after Phase 2.5:
//   1. Only ingested metadata is trusted — a ticker never fetched this
//      session has no provider record yet and falls back to the heuristic.
//      The cache is in-memory/per-session (not persisted), by design: it
//      must never survive as stale "truth" across days.
//   2. Real holiday detection is NOT implemented (see above) — a holiday
//      that isn't also a weekend reports HOLIDAY_UNKNOWN, never a fabricated
//      TRADING_DAY *or* HOLIDAY_CONFIRMED.
//   3. Exchanges beyond what this project's own tickers actually use (US via
//      NMS/NasdaqGS-style codes, Europe via Euronext-style .PA/.DE/etc.,
//      crypto) have never been observed in a real response fetched for this
//      audit — the architecture (see `exchange`/`exchangeTimezone` fields
//      below) does not hardcode "EU or US only" the way Phase 2 did, but no
//      claim is made about correctness for a market never actually seen.

import {
    isCryptoTicker,
    isStockRegularSession,
    getMarketOpenUTCHour,
    getLastTradingDay
} from './MarketUtils.js';

const EU_SUFFIXES = ['.PA', '.DE', '.AS', '.L', '.BR', '.MI', '.HE', '.SW'];
const DAY_MS = 24 * 3600000;

function isEuTicker(ticker) {
    const t = (ticker || '').toUpperCase();
    return EU_SUFFIXES.some(suffix => t.endsWith(suffix));
}

function isSameCivilDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export class MarketCalendarEngine {
    constructor() {
        // ticker -> normalized provider metadata (see ingestProviderMetadata).
        // In-memory/per-session ONLY — see limitation #1 above.
        this._providerMetadata = new Map();
    }

    /**
     * Feed this engine a REAL Yahoo chart `meta` object (see api.js's
     * getHistoricalPricesWithRetry, the call site closest to the actual
     * network response). Never called with anything synthetic — if `meta` is
     * missing a field, that field is simply absent here too, never guessed.
     * @param {string} ticker
     * @param {object|null|undefined} meta - `data.chart.result[0].meta` as returned by Yahoo
     * @returns {object|null} the normalized record just stored, or null if `meta` was unusable
     */
    ingestProviderMetadata(ticker, meta) {
        if (!ticker || !meta) return null;
        const t = ticker.toUpperCase();
        const regular = meta.currentTradingPeriod?.regular;
        const hasRegular = regular && typeof regular.start === 'number' && typeof regular.end === 'number';

        const normalized = {
            ticker: t,
            exchange: meta.exchangeName || null,
            fullExchangeName: meta.fullExchangeName || null,
            // Le champ qui compte le plus : IANA réel, jamais deviné quand présent.
            exchangeTimezone: meta.exchangeTimezoneName || null,
            instrumentType: meta.instrumentType || null,
            regularSession: hasRegular ? { startMs: regular.start * 1000, endMs: regular.end * 1000 } : null,
            // Informationnel uniquement : le proxy Cloudflare demande
            // includePrePost=false (voir cloudflare-workers/prices-worker/worker.js),
            // donc aucune bougie pre/post n'est jamais récupérée — ce champ ne doit
            // JAMAIS servir à valoriser une position en dehors de la session régulière.
            hasPrePostMarketData: meta.hasPrePostMarketData ?? null,
            source: 'provider',
            fetchedAt: Date.now()
        };
        this._providerMetadata.set(t, normalized);
        return normalized;
    }

    getProviderMetadata(ticker) {
        return this._providerMetadata.get((ticker || '').toUpperCase()) || null;
    }

    /**
     * @param {string} ticker
     * @returns {'crypto_24_7'|'exchange_eu'|'exchange_us'}
     */
    getTradingModel(ticker) {
        if (!ticker || ticker.startsWith('CASH-')) return 'crypto_24_7';
        // Hiérarchie #1 : instrumentType réel du provider bat la liste de tickers
        // crypto codée en dur dès qu'on l'a.
        const meta = this.getProviderMetadata(ticker);
        if (meta?.instrumentType === 'CRYPTOCURRENCY') return 'crypto_24_7';
        if (isCryptoTicker(ticker)) return 'crypto_24_7';
        return isEuTicker(ticker) ? 'exchange_eu' : 'exchange_us';
    }

    /**
     * IANA timezone. Real provider value when known (hiérarchie #1), heuristic
     * fallback otherwise (see getTimezoneSource to know which one you got).
     * @returns {string}
     */
    getTimezone(ticker) {
        const meta = this.getProviderMetadata(ticker);
        if (meta?.exchangeTimezone) return meta.exchangeTimezone;
        const model = this.getTradingModel(ticker);
        if (model === 'crypto_24_7') return 'UTC';
        return model === 'exchange_eu' ? 'Europe/Paris' : 'America/New_York';
    }

    /** @returns {'provider'|'heuristic-fallback'} which source getTimezone() actually used. */
    getTimezoneSource(ticker) {
        return this.getProviderMetadata(ticker)?.exchangeTimezone ? 'provider' : 'heuristic-fallback';
    }

    /**
     * Timezone used to define the GLOBAL portfolio's "00:00 → 00:00" 1D window.
     * No user preference exists in this product today — Europe/Paris matches
     * the app's existing default locale (fr-FR UI). Documented assumption.
     */
    getPortfolioTimezone() {
        return 'Europe/Paris';
    }

    /**
     * TRADING_DAY / HOLIDAY_CONFIRMED / HOLIDAY_UNKNOWN — never collapses an
     * unknown into a guessed boolean (see section 9/10/32 of the brief). Use
     * isTradingDay() when you just need the historically-accepted boolean
     * behavior (weekday fallback baked in); use this when the distinction
     * between "we know" and "we're guessing" actually matters.
     */
    getTradingDayStatus(ticker, date = new Date()) {
        if (this.getTradingModel(ticker) === 'crypto_24_7') return 'TRADING_DAY';

        const day = date.getDay();
        if (day === 0 || day === 6) return 'HOLIDAY_CONFIRMED'; // weekend : certain, source = calendrier civil

        const meta = this.getProviderMetadata(ticker);
        if (meta?.regularSession) {
            const sessionDate = new Date(meta.regularSession.startMs);
            if (isSameCivilDay(sessionDate, date)) return 'TRADING_DAY'; // confirmé par le provider POUR CE JOUR
            // Le provider a répondu, mais pour un jour différent de celui demandé —
            // impossible de dire honnêtement si `date` était un jour férié ou si on
            // n'a simplement pas encore interrogé le provider pour ce jour-là.
            return 'HOLIDAY_UNKNOWN';
        }
        return 'HOLIDAY_UNKNOWN'; // pas de métadonnée provider du tout pour ce ticker
    }

    /**
     * Boolean convenience wrapper — see getTradingDayStatus for the honest,
     * three-way answer. HOLIDAY_UNKNOWN degrades to the historical
     * weekday-only heuristic (a real holiday can still read as `true` here —
     * documented limitation, not silently fixed).
     */
    isTradingDay(ticker, date = new Date()) {
        const status = this.getTradingDayStatus(ticker, date);
        if (status === 'TRADING_DAY') return true;
        if (status === 'HOLIDAY_CONFIRMED') return false;
        const day = date.getDay();
        return day !== 0 && day !== 6;
    }

    /**
     * Phase 3.6 — the calendar-domain primitive behind Global 2D's "previous
     * day with a real closing reference for this portfolio" (see
     * TimeRangeEngine.getGlobalWindow). True if `date` is a trading day for AT
     * LEAST ONE of the EXCHANGE-TRADED (non-24/7) tickers in `tickers` —
     * deliberately ignores any 24/7 asset's own permissiveness, so a mixed
     * portfolio's reference day still respects its exchange-traded assets'
     * calendar, not BTC's (which would trivially say "yes" to every day and
     * defeat the whole point of asking). A portfolio with NO exchange-traded
     * asset at all has no such reference — returns false unconditionally, and
     * the caller (which knows it's looking at a pure-24/7 portfolio) decides
     * what that means (see TimeRangeEngine: it never even asks in that case).
     *
     * No day-of-week rule is hardcoded here or in the caller: this delegates
     * to isTradingDay() per ticker, the SAME single source of truth every
     * other calendar decision in this engine already uses.
     *
     * @param {string[]} tickers
     * @param {Date} date
     * @returns {boolean}
     */
    hasExchangeTradedReferenceDay(tickers, date) {
        const exchangeTraded = (tickers || []).filter(t => this.getTradingModel(t) !== 'crypto_24_7');
        if (exchangeTraded.length === 0) return false;
        return exchangeTraded.some(t => this.isTradingDay(t, date));
    }

    /**
     * Real session boundaries (provider) if we have them for THIS exact civil
     * day, heuristic session hours otherwise.
     *
     * BTC DAILY BOUNDARY = UTC MIDNIGHT (Phase 3.5, section 5) — an explicit,
     * single convention, applied everywhere a crypto "day" needs a boundary.
     * Previously this floored to the CALLING PROCESS's system-local midnight
     * (`date.setHours(0,0,0,0)`), so the exact same instant produced a
     * different BTC "today" depending on the browser/server's own timezone —
     * a genuine bug (BTC evolving identically everywhere must be sliced into
     * "days" identically everywhere too), not merely a style choice. UTC was
     * chosen because it's what Yahoo itself reports for crypto's own
     * `exchangeTimezoneName` (see MarketCalendarEngine's file-level audit: the
     * real BTC-EUR payload has `exchangeTimezoneName: "UTC"`) — reusing the
     * provider's own convention rather than inventing a different one.
     * @returns {{openUTCMs:number, closeUTCMs:number, tradingModel:string, source:'provider'|'heuristic-fallback'}|null}
     */
    getSession(ticker, date = new Date()) {
        const model = this.getTradingModel(ticker);
        if (model === 'crypto_24_7') {
            const openUTCMs = Math.floor(date.getTime() / DAY_MS) * DAY_MS;
            return { openUTCMs, closeUTCMs: openUTCMs + DAY_MS, tradingModel: model, source: 'crypto-24-7-utc' };
        }

        const meta = this.getProviderMetadata(ticker);
        if (meta?.regularSession) {
            const sessionDate = new Date(meta.regularSession.startMs);
            if (isSameCivilDay(sessionDate, date)) {
                return { openUTCMs: meta.regularSession.startMs, closeUTCMs: meta.regularSession.endMs, tradingModel: model, source: 'provider' };
            }
        }

        if (!this.isTradingDay(ticker, date)) return null;

        // Repli heuristique — mêmes horaires que MarketUtils.isStockRegularSession,
        // résolus en UTC de façon DST-aware (getMarketOpenUTCHour, réutilisée, pas
        // dupliquée).
        const tz = this.getTimezone(ticker);
        const isEu = model === 'exchange_eu';
        const localOpenHour = isEu ? 9 : 9.5;
        const localCloseHour = isEu ? 17.5 : 16;
        const dayStartUTC = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
        const toMs = (localHour) => dayStartUTC + getMarketOpenUTCHour(localHour, tz, date) * 3600000;
        return { openUTCMs: toMs(localOpenHour), closeUTCMs: toMs(localCloseHour), tradingModel: model, source: 'heuristic-fallback' };
    }

    getSessionOpen(ticker, date = new Date()) {
        return this.getSession(ticker, date)?.openUTCMs ?? null;
    }

    getSessionClose(ticker, date = new Date()) {
        return this.getSession(ticker, date)?.closeUTCMs ?? null;
    }

    /**
     * Real-time open/closed. Prefers the real session window for TODAY when we
     * have it (section 7's "provider state" — substituted by session bounds
     * since this app's provider never actually returns a marketState string,
     * see file-level audit note); falls back to the ticker-suffix hour
     * heuristic (MarketUtils.isStockRegularSession) otherwise.
     */
    isMarketOpen(ticker, timestamp = Date.now()) {
        if (this.getTradingModel(ticker) === 'crypto_24_7') return true;
        const session = this.getSession(ticker, new Date(timestamp));
        if (session) return timestamp >= session.openUTCMs && timestamp < session.closeUTCMs;
        return isStockRegularSession(ticker, timestamp);
    }

    /**
     * Previous trading session (skips weekends via getLastTradingDay; a real
     * holiday is not detected — see HOLIDAY_UNKNOWN above).
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
     * Next trading session (skips weekends; a real holiday is not detected).
     * Bounded loop guards against an infinite scan if isTradingDay were ever
     * wrongly false for a whole week.
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
