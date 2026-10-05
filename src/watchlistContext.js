import { buildDataQuality } from './dataQualityContext.js';

function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value?.raw ?? value);
    return Number.isFinite(number) ? number : null;
}

function verifiedComposition(item) {
    const rows = Array.isArray(item?.composition) ? item.composition
        : Array.isArray(item?.topHoldings) ? item.topHoldings
            : [];
    const source = String(item?.compositionSource || '').trim();
    const asOf = item?.compositionAsOf || null;
    if (!rows.length || !source || !asOf || !Number.isFinite(Date.parse(String(asOf)))) return null;

    const holdings = rows.map(row => ({
        ticker: String(row?.ticker || row?.symbol || '').trim().toUpperCase() || null,
        name: String(row?.name || '').trim() || null,
        weightPct: numberOrNull(row?.weightPct ?? row?.weight)
    })).filter(row => (row.ticker || row.name) && row.weightPct !== null && row.weightPct >= 0);
    return holdings.length ? { source, asOf: new Date(asOf).toISOString(), holdings } : null;
}

export function buildWatchlistContext(items = [], groups = [], { now = Date.now() } = {}) {
    const groupNamesByTicker = new Map();
    for (const group of groups || []) {
        for (const ticker of group?.tickers || []) {
            const key = String(ticker).toUpperCase();
            const names = groupNamesByTicker.get(key) || [];
            names.push(group.name || 'Sans nom');
            groupNamesByTicker.set(key, names);
        }
    }

    return (items || []).map(item => {
        const currentPrice = numberOrNull(item?.priceData?.regularMarketPrice);
        const targetPrice = numberOrNull(item?.targetPrice);
        const lastFetched = numberOrNull(item?.lastFetched);
        const unavailable = [];
        if (currentPrice === null) unavailable.push('currentPrice');
        if (numberOrNull(item?.priceData?.regularMarketChangePercent) === null) unavailable.push('dailyChangePct');

        return {
            ticker: String(item?.ticker || '').toUpperCase(),
            name: item?.name || item?.priceData?.longName || item?.priceData?.shortName || null,
            currentPrice,
            currency: item?.priceData?.currency || null,
            targetPrice,
            targetGapAmount: currentPrice !== null && targetPrice !== null ? targetPrice - currentPrice : null,
            targetGapPct: currentPrice !== null && currentPrice !== 0 && targetPrice !== null
                ? ((targetPrice / currentPrice) - 1) * 100
                : null,
            dailyChangePct: numberOrNull(item?.priceData?.regularMarketChangePercent) !== null
                ? numberOrNull(item.priceData.regularMarketChangePercent) * 100
                : null,
            score: numberOrNull(item?.score),
            trailingPE: numberOrNull(item?.detail?.trailingPE ?? item?.stats?.trailingPE),
            dividendYieldPct: numberOrNull(item?.detail?.dividendYield) !== null
                ? numberOrNull(item.detail.dividendYield) * 100
                : null,
            sector: item?.sector || item?.assetProfile?.sector || null,
            industry: item?.industry || item?.assetProfile?.industry || null,
            groups: groupNamesByTicker.get(String(item?.ticker || '').toUpperCase()) || [],
            addedAt: item?.addedAt || null,
            lastFetched,
            verifiedComposition: verifiedComposition(item),
            quality: buildDataQuality({
                asOf: lastFetched,
                source: 'watchlist_quote_summary',
                unavailable,
                now
            })
        };
    });
}
