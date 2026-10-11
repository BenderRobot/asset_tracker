export const FUTURE_ACCENT_COLOR = '#a855f7';

// Only contracts currently returned successfully by the project's Yahoo proxy
// belong here. An unavailable contract must never replace a valid cash index.
export const INDEX_FUTURES = Object.freeze({
    '^GSPC': Object.freeze({ ticker: 'ES=F', code: 'ES', name: 'E-mini S&P 500' }),
    '^NDX': Object.freeze({ ticker: 'NQ=F', code: 'NQ', name: 'E-mini Nasdaq 100' }),
    '^DJI': Object.freeze({ ticker: 'YM=F', code: 'YM', name: 'E-mini Dow Jones' }),
    '^RUT': Object.freeze({ ticker: 'RTY=F', code: 'RTY', name: 'E-mini Russell 2000' }),
    '^N225': Object.freeze({ ticker: 'NKD=F', code: 'NKD', name: 'Nikkei 225 Futures' })
});

export function getIndexFuture(ticker) {
    return INDEX_FUTURES[String(ticker || '').toUpperCase()] || null;
}

// Selection hint in exchange time, including the daily maintenance break.
// Provider session metadata remains authoritative for the displayed status.
export function isFutureSessionAvailable(at = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(at).map(p => [p.type, p.value]));
    const hour = Number(parts.hour);
    if (parts.weekday === 'Sat') return false;
    if (parts.weekday === 'Sun') return hour >= 17;
    if (parts.weekday === 'Fri') return hour < 16;
    return hour < 16 || hour >= 17;
}

export function selectIndexDisplayInstrument(indexTicker, marketStatus, at = new Date()) {
    const future = getIndexFuture(indexTicker);
    const useFuture = !!future
        && marketStatus !== 'MARKET_OPEN'
        && marketStatus !== 'UNKNOWN'
        && isFutureSessionAvailable(at);

    return useFuture
        ? { ticker: future.ticker, isFuture: true, future }
        : { ticker: indexTicker, isFuture: false, future: null };
}
