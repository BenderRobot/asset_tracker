import { marketCalendarEngine } from './MarketCalendarEngine.js';

const DAY = 86400000;
const positive = value => Number.isFinite(value) && value > 0;
const civilDay = (at, timezone) => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at)); }
    catch { return null; }
};

// Only migrate the old, incorrectly labelled Nasdaq 100. An intentionally
// followed Composite keeps its identity; notification rules are never retargeted.
export function normalizeDashboardIndices(indices) {
    const seen = new Set();
    return (Array.isArray(indices) ? indices : []).flatMap(item => {
        if (!item || typeof item.ticker !== 'string' || typeof item.name !== 'string') return [];
        const row = item.ticker === '^IXIC' && /nasdaq\s*[- ]?\s*100/i.test(item.name)
            ? { ...item, ticker: '^NDX', name: 'Nasdaq 100' } : { ...item };
        if (seen.has(row.ticker)) return [];
        seen.add(row.ticker);
        return [row];
    });
}

export function instrumentUnit(symbol, currency) {
    if (['^TNX', '^TYX', '^FVX', '^IRX'].includes(symbol)) return '%';
    if (symbol.startsWith('^') || ['ES=F', 'NQ=F', 'YM=F', 'RTY=F', 'NKD=F'].includes(symbol)) return 'pts';
    if (symbol.endsWith('=X')) return currency ? `${currency} / ${symbol.slice(0, 3)}` : 'taux';
    // Contract quantities vary: don't invent an ounce/barrel unit from currency.
    return currency || 'devise inconnue';
}

export function quoteSession(symbol, quote, now = Date.now()) {
    if (/^[A-Z0-9]+-[A-Z]{3}$/.test(symbol)) return 'CONTINUOUS';
    const session = quote?.regularSession;
    const timezone = quote?.exchangeTimezone;
    if (session && now >= session.startMs && now < session.endMs) return 'OPEN';
    if (session && timezone && (civilDay(now, timezone) === civilDay(session.startMs, timezone)
        || civilDay(now, timezone) === civilDay(session.endMs, timezone))) return 'CLOSED';
    // Weekend closure is only asserted for cash indices/equities, not futures/FX.
    if (timezone && !symbol.endsWith('=F') && !symbol.endsWith('=X')) {
        try {
            const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(now);
            if (weekday === 'Sat' || weekday === 'Sun') return 'CLOSED';
        } catch { /* unknown timezone */ }
    }
    return 'UNKNOWN';
}

// Selection hint only, never used as evidence of a live quote or a holiday.
// Provider sessions are shared with the portfolio calendar; fallback schedules
// use exchange timezones rather than the user's computer timezone.
export function scheduledMarketStatus(symbol, at = new Date()) {
    const meta = marketCalendarEngine.getProviderMetadata(symbol);
    const observed = quoteSession(symbol, { regularSession: meta?.regularSession, exchangeTimezone: meta?.exchangeTimezone }, +at);
    if (observed === 'CONTINUOUS') return '24_7';
    if (observed === 'OPEN') return 'MARKET_OPEN';
    if (observed === 'CLOSED') return 'POST_MARKET';
    const us = ['^GSPC', '^NDX', '^IXIC', '^DJI', '^RUT'];
    const eu = ['^FCHI', '^STOXX50E', '^GDAXI', '^IBEX'];
    const timezone = us.includes(symbol) ? 'America/New_York' : eu.includes(symbol) ? 'Europe/Paris' : null;
    if (!timezone) return 'UNKNOWN';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(at).map(p => [p.type, p.value]));
    if (['Sat', 'Sun'].includes(parts.weekday)) return 'WEEKEND';
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    const open = us.includes(symbol) ? 570 : 540;
    const close = us.includes(symbol) ? 960 : 1050;
    return minute < open ? 'PRE_MARKET' : minute < close ? 'MARKET_OPEN' : 'POST_MARKET';
}

// Input is a daily Yahoo chart in native units. chartPreviousClose is the
// beginning of the requested range, NOT necessarily yesterday's close.
export function normalizeDashboardQuote(symbol, chart, now = Date.now()) {
    const meta = chart?.meta || {};
    const price = positive(meta.regularMarketPrice) ? meta.regularMarketPrice : null;
    if (price === null) return null;
    const quoteAsOf = positive(meta.regularMarketTime) && meta.regularMarketTime * 1000 <= now
        ? meta.regularMarketTime * 1000 : null;
    const timezone = meta.exchangeTimezoneName || null;
    const crypto = meta.instrumentType === 'CRYPTOCURRENCY' || /^[A-Z0-9]+-[A-Z]{3}$/.test(symbol);
    const regular = meta.currentTradingPeriod?.regular;
    const regularSession = positive(regular?.start) && positive(regular?.end) && regular.end > regular.start
        ? { startMs: regular.start * 1000, endMs: regular.end * 1000 } : null;
    const closes = chart?.indicators?.quote?.[0]?.close || [];
    const daily = (chart?.timestamp || []).flatMap((t, i) => positive(t) && positive(closes[i]) && t * 1000 <= now
        ? [{ at: t * 1000, price: closes[i] }] : []).sort((a, b) => b.at - a.at);
    let previousClose = null;
    let referenceAsOf = null;
    let referenceSessionDate = null;
    let changeBasis = 'Référence indisponible';
    if (crypto) {
        const midnight = Math.floor(now / DAY) * DAY;
        // A daily crypto candle closes at the following UTC midnight. Require
        // yesterday's candle and a current-day quote, not a stale older anchor.
        const previous = daily.find(p => p.at === midnight - DAY);
        if (previous && quoteAsOf >= midnight) {
            previousClose = previous.price;
            referenceAsOf = midnight;
            changeBasis = 'Depuis 00:00 UTC';
        }
    } else {
        // Explicit provider previousClose is session-relative; never use a
        // price cache from another session to manufacture a zero variation.
        previousClose = positive(meta.previousClose) ? meta.previousClose : null;
        const sessionAnchor = regularSession && quoteAsOf >= regularSession.startMs && quoteAsOf <= regularSession.endMs
            ? regularSession.startMs : quoteAsOf;
        const quoteDay = sessionAnchor && timezone ? civilDay(sessionAnchor, timezone) : null;
        const prior = quoteDay ? daily.find(p => civilDay(p.at, timezone) < quoteDay) : null;
        if (previousClose === null && prior) previousClose = prior.price;
        if (prior && prior.price === previousClose) referenceSessionDate = civilDay(prior.at, timezone);
        // Daily timestamps mark the candle opening, so retain a session date,
        // rather than misrepresenting them as an exact closing time.
        if (previousClose !== null) changeBasis = symbol.endsWith('=F') || symbol.endsWith('=X')
            ? 'Référence de séance fournisseur' : 'Clôture de la séance précédente';
    }
    const currency = typeof meta.currency === 'string' ? meta.currency : null;
    const quote = {
        symbol, price, previousClose, referencePrice: previousClose, referenceAsOf, referenceSessionDate,
        currency, unit: instrumentUnit(symbol, currency), quoteAsOf, lastQuoteTime: quoteAsOf,
        fetchedAt: now, exchangeTimezone: timezone, regularSession, changeBasis,
        source: 'Yahoo Finance', dashboardQuoteVersion: 1, stale: false,
        delayMinutes: Number.isFinite(meta.exchangeDataDelayedBy) && meta.exchangeDataDelayedBy >= 0 ? meta.exchangeDataDelayedBy : null
    };
    quote.marketState = quoteSession(symbol, quote, now);
    return quote;
}

export function presentDashboardQuote(symbol, quote, now = Date.now()) {
    const valid = positive(quote?.price);
    const reference = positive(quote?.previousClose) ? quote.previousClose : null;
    const pct = valid && reference !== null ? (quote.price / reference - 1) * 100 : null;
    const session = quoteSession(symbol, quote, now);
    const at = quote?.quoteAsOf ?? quote?.lastQuoteTime;
    const knownTime = positive(at) && at <= now;
    const old = knownTime && ['OPEN', 'CONTINUOUS'].includes(session) && now - at > 30 * 60000;
    const status = !valid ? 'Indisponible' : quote?.stale ? 'Actualisation indisponible' : old ? 'Cours ancien'
        : session === 'CLOSED' ? 'Dernière séance' : session === 'OPEN' ? 'Séance ouverte'
        : session === 'CONTINUOUS' ? 'Marché 24/7' : 'Séance non confirmée';
    const time = knownTime ? new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(at) + ' Paris' : 'Heure du cours inconnue';
    const unit = quote?.unit || instrumentUnit(symbol, quote?.currency);
    const decimals = symbol.endsWith('=X') || (valid && quote.price < 1) ? 4 : 2;
    const priceText = valid ? `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(quote.price)} ${unit}` : '—';
    const pctText = pct === null ? '—' : `${pct > 0 ? '▲ +' : pct < 0 ? '▼ ' : ''}${pct.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
    const referenceLabel = `${quote?.changeBasis || 'Référence indisponible'}${quote?.referenceSessionDate ? ` (${quote.referenceSessionDate})` : ''}`;
    const delay = quote?.delayMinutes > 0 ? `Différé annoncé : ${quote.delayMinutes} min` : 'Délai du flux non garanti';
    return { priceText, pctText, pct, status, time, session,
        tone: pct > 0 ? 'stat-positive' : pct < 0 ? 'stat-negative' : 'stat-neutral',
        detail: `${symbol.endsWith('=F') ? `Contrat à terme ${symbol} · ` : ''}${status} · ${time} · ${referenceLabel} · ${quote?.source || 'Source inconnue'} · ${delay}` };
}
