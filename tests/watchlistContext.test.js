import { describe, expect, it } from 'vitest';
import { buildWatchlistContext } from '../src/watchlistContext.js';

describe('watchlist assistant context', () => {
    it('exposes quote, target gap, fundamentals, groups and freshness without inventing zeros', () => {
        const now = Date.parse('2026-10-05T10:00:00Z');
        const [row] = buildWatchlistContext([{
            ticker: 'AAPL', name: 'Apple', targetPrice: 250,
            priceData: {
                regularMarketPrice: { raw: 200 },
                regularMarketChangePercent: { raw: -0.0125 },
                currency: 'USD'
            },
            detail: { trailingPE: { raw: 30 }, dividendYield: { raw: 0.004 } },
            score: 16.2, sector: 'Technology', industry: 'Consumer Electronics',
            lastFetched: now - 5 * 60 * 1000
        }], [{ name: 'Qualité', tickers: ['AAPL'] }], { now });

        expect(row).toMatchObject({
            currentPrice: 200, targetGapAmount: 50, targetGapPct: 25,
            dailyChangePct: -1.25, trailingPE: 30, dividendYieldPct: 0.4,
            sector: 'Technology', groups: ['Qualité']
        });
        expect(row.quality.status).toBe('fresh');
    });

    it('accepts ETF composition only when both source and date are present', () => {
        const base = {
            ticker: 'ETF', composition: [{ ticker: 'AAPL', weightPct: 7 }],
            compositionAsOf: '2026-10-01'
        };
        expect(buildWatchlistContext([base])[0].verifiedComposition).toBeNull();
        expect(buildWatchlistContext([{ ...base, compositionSource: 'issuer.example' }])[0].verifiedComposition)
            .toMatchObject({ source: 'issuer.example', holdings: [{ ticker: 'AAPL', weightPct: 7 }] });
    });
});
