// ========================================
// TimeRangeEngine.js — SINGLE SOURCE OF TRUTH for "which UTC range does this
// period button mean, right now" (Phase 2.5, section 11).
// ========================================
//
// Two distinct questions, kept explicitly separate (section 14 of the brief —
// "Global et Asset ne doivent plus être implicitement mélangés"):
//   - getGlobalWindow(period, timezone, now)   -> the PORTFOLIO's own window,
//     always civil-date based in `timezone` (see MarketCalendarEngine.
//     getPortfolioTimezone()), 1D = 00:00 → now, NEVER an exchange's open time.
//   - getAssetWindow(ticker, period, calendarEngine, now) -> a SINGLE ASSET's
//     window, 1D = that asset's own trading session (crypto: 24h; exchange
//     asset: MarketCalendarEngine.getSession()'s real-or-heuristic bounds).
//
// Neither computes `period * 86400000` blindly (section 13/18): every
// multi-day window is built by walking CIVIL days in the relevant timezone
// (addCivilDays below), so month/DST boundaries land on the right wall-clock
// midnight instead of drifting by whatever the elapsed-ms shortcut would give.
//
// Reuses MarketUtils.getUTCOffsetHours (already DST-aware) — does not
// reimplement timezone math.

import { getUTCOffsetHours } from './MarketUtils.js';

const DAY_MS = 24 * 3600000;

function civilDateParts(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date).reduce((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
    }, {});
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/**
 * UTC ms of local midnight (00:00:00 in `timezone`) on the civil day `date`
 * falls on, as seen in that timezone. DST-aware.
 */
export function localMidnightUTCMs(date, timezone) {
    const { year, month, day } = civilDateParts(date, timezone);
    const naiveUTC = Date.UTC(year, month - 1, day);
    const offsetHours = getUTCOffsetHours(timezone, new Date(naiveUTC));
    return naiveUTC - offsetHours * 3600000;
}

/**
 * `date` shifted by `n` CIVIL days (n may be negative) — used only to land on
 * the right calendar date before re-anchoring to local midnight, never
 * returned as a precise instant itself, so the +/-24h*n approximation used
 * here cannot leak a DST-drifted timestamp downstream.
 */
function addCivilDays(date, n) {
    return new Date(date.getTime() + n * DAY_MS);
}

// Phase 3.6 — Global 2D's "previous reference day" no longer hardcodes a
// day-of-week rule here (the old `isMonday ? -3 : -1` — see git history for
// Phase 3.5's version of this file). It walks backward one civil day at a
// time and asks MarketCalendarEngine.hasExchangeTradedReferenceDay() whether
// THAT day is valid for this portfolio's actual exchange-traded assets —
// TimeRangeEngine never decides "Monday means Friday" itself, it just keeps
// asking the calendar until it gets a yes. Bounded to 7 lookback days as a
// safety net (never an infinite loop even if the calendar somehow never
// confirms a trading day) — not a calendar assumption, a guard rail.
function resolvePreviousExchangeReferenceDay(now, timezone, assets, calendarEngine) {
    let probe = addCivilDays(now, -1);
    for (let i = 0; i < 7; i++) {
        if (calendarEngine.hasExchangeTradedReferenceDay(assets, probe)) return probe;
        probe = addCivilDays(probe, -1);
    }
    return probe; // repli après 7 jours sans confirmation — jamais un blocage
}

/**
 * The GLOBAL portfolio's window for `period`. 1D is ALWAYS 00:00 → now in
 * `timezone` (section 12) — never the first exchange's open time. Multi-day
 * periods count CIVIL days back in `timezone` (crypto trades through
 * weekends, so calendar days — not trading days — are the right unit for a
 * mixed portfolio's own window; see section 12/13) — WITH ONE NAMED
 * EXCEPTION, documented and tested (Phase 3.5/3.6):
 *
 * 2D's DEFINITION (determined from the product's actual prior behavior, not
 * assumed): "today" + "the previous day that has a real closing reference for
 * this portfolio" — the same anchor 1D's own yesterdayClose resolution uses
 * (MarketUtils.getCloseCutoffForTicker: crypto -> calendar day boundary,
 * exchange asset -> last TRADING day). A pure-crypto 2D window is genuinely
 * "2 civil days back" (crypto has a real observation every day — no
 * `assets`/`calendarEngine` needed to know that). The moment the portfolio
 * holds ANY exchange-traded (non-24/7) asset, the previous reference day is
 * whatever MarketCalendarEngine.hasExchangeTradedReferenceDay() confirms for
 * THOSE specific tickers (Phase 3.6) — not a hardcoded "Monday -> Friday".
 * Pass the portfolio's own ticker list as `assets` to get that behavior;
 * without it (or for a portfolio with none of them exchange-traded), 2D
 * degrades to the plain civil-day-back rule, identical to every other period.
 *
 * `period === 'all'` has no calendar-derivable start (it depends on the
 * portfolio's own first transaction) — returns `startMs: null` and leaves
 * that decision to the caller, who actually knows the ledger.
 *
 * @param {number|'ytd'|'all'} period
 * @param {string} timezone - IANA, e.g. MarketCalendarEngine.getPortfolioTimezone()
 * @param {Date} [now]
 * @param {{assets?: string[], calendarEngine?: import('./MarketCalendarEngine.js').MarketCalendarEngine}} [opts]
 * @returns {{startMs:number|null, endMs:number, timezone:string, scope:'global', period:*}}
 */
export function getGlobalWindow(period, timezone, now = new Date(), { assets = [], calendarEngine = null } = {}) {
    let startMs;

    const hasExchangeTradedAssets = !!(calendarEngine && assets.length > 0
        && assets.some(t => calendarEngine.getTradingModel(t) !== 'crypto_24_7'));

    if (period === 'all') {
        startMs = null;
    } else if (period === 'ytd') {
        const { year } = civilDateParts(now, timezone);
        startMs = localMidnightUTCMs(new Date(Date.UTC(year, 0, 1, 12)), timezone);
    } else if (period === 2 && hasExchangeTradedAssets) {
        startMs = localMidnightUTCMs(resolvePreviousExchangeReferenceDay(now, timezone, assets, calendarEngine), timezone);
    } else if (typeof period === 'number') {
        startMs = localMidnightUTCMs(addCivilDays(now, -(period - 1)), timezone);
    } else {
        startMs = localMidnightUTCMs(now, timezone);
    }

    return { startMs, endMs: now.getTime(), timezone, scope: 'global', period };
}

/**
 * A SINGLE ASSET's window for `period` — respects that asset's OWN session
 * (section 14), never the portfolio's 00:00→00:00 rule. 1D uses the asset's
 * current session if one exists today; otherwise (weekend, or an unconfirmed
 * holiday — see MarketCalendarEngine.getTradingDayStatus) falls back to its
 * most recent known session so a Friday-afternoon view doesn't come back
 * empty. Multi-day periods count civil days back in the ASSET's own timezone.
 *
 * @param {string} ticker
 * @param {number|'ytd'|'all'} period
 * @param {import('./MarketCalendarEngine.js').MarketCalendarEngine} calendarEngine
 * @param {Date} [now]
 * @returns {{startMs:number|null, endMs:number, timezone:string, scope:'asset', period:*, session:object|null}|null}
 */
export function getAssetWindow(ticker, period, calendarEngine, now = new Date()) {
    const timezone = calendarEngine.getTimezone(ticker);

    if (period === 1) {
        const session = calendarEngine.getSession(ticker, now);
        if (session) {
            return { startMs: session.openUTCMs, endMs: Math.min(now.getTime(), session.closeUTCMs), timezone, scope: 'asset', period, session };
        }
        const prev = calendarEngine.getPreviousTradingSession(ticker, now);
        if (!prev) return null;
        return { startMs: prev.openUTCMs, endMs: prev.closeUTCMs, timezone, scope: 'asset', period, session: prev };
    }

    if (period === 'all') {
        return { startMs: null, endMs: now.getTime(), timezone, scope: 'asset', period, session: null };
    }
    if (period === 'ytd') {
        const { year } = civilDateParts(now, timezone);
        return { startMs: localMidnightUTCMs(new Date(Date.UTC(year, 0, 1, 12)), timezone), endMs: now.getTime(), timezone, scope: 'asset', period, session: null };
    }

    // 2D : "la session actuelle/la plus récente" + "la session TRADÉE juste
    // avant elle" (jamais dimanche pour une action un lundi) — délègue
    // entièrement à MarketCalendarEngine.getPreviousTradingSession, qui gère
    // déjà le saut de weekend ; aucune règle de calendrier réimplémentée ici.
    // Fonctionne identiquement pour la crypto (previousTradingSession = hier,
    // sans saut) sans branche spéciale.
    if (period === 2) {
        const anchor = getAssetWindow(ticker, 1, calendarEngine, now);
        if (!anchor) return null;
        const prev = calendarEngine.getPreviousTradingSession(ticker, new Date(anchor.startMs));
        const startMs = prev ? prev.openUTCMs : anchor.startMs;
        return { startMs, endMs: now.getTime(), timezone, scope: 'asset', period, session: anchor.session };
    }

    const startMs = localMidnightUTCMs(addCivilDays(now, -(period - 1)), timezone);
    return { startMs, endMs: now.getTime(), timezone, scope: 'asset', period, session: null };
}
