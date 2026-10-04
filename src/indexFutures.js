export const FUTURE_ACCENT_COLOR = '#a855f7';

// Only contracts currently returned successfully by the project's Yahoo proxy
// belong here. An unavailable contract must never replace a valid cash index.
export const INDEX_FUTURES = Object.freeze({
    '^GSPC': Object.freeze({ ticker: 'ES=F', code: 'ES', name: 'E-mini S&P 500' }),
    '^IXIC': Object.freeze({ ticker: 'NQ=F', code: 'NQ', name: 'E-mini Nasdaq 100' }),
    '^DJI': Object.freeze({ ticker: 'YM=F', code: 'YM', name: 'E-mini Dow Jones' }),
    '^RUT': Object.freeze({ ticker: 'RTY=F', code: 'RTY', name: 'E-mini Russell 2000' }),
    '^N225': Object.freeze({ ticker: 'NKD=F', code: 'NKD', name: 'Nikkei 225 Futures' })
});

export function getIndexFuture(ticker) {
    return INDEX_FUTURES[String(ticker || '').toUpperCase()] || null;
}

// Approximate Globex availability in the timezone already used by the
// dashboard market-status logic. The quote fetch remains authoritative: if a
// contract is unavailable, the caller falls back to the cash index.
export function isFutureSessionAvailable(at = new Date()) {
    const day = at.getDay();
    const hour = at.getHours();
    if (day === 6) return false;
    if (day === 0) return hour >= 23;
    if (day === 5) return hour < 23;
    return true;
}

export function selectIndexDisplayInstrument(indexTicker, marketStatus, at = new Date()) {
    const future = getIndexFuture(indexTicker);
    const useFuture = !!future
        && marketStatus !== 'MARKET_OPEN'
        && isFutureSessionAvailable(at);

    return useFuture
        ? { ticker: future.ticker, isFuture: true, future }
        : { ticker: indexTicker, isFuture: false, future: null };
}
