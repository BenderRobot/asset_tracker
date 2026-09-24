// Provenance pointMeta — historical_candle UNIQUEMENT si hist[ts] exact.
// closestPrice / lastKnown / midnightSeed = valuation (carry-forward).
// Classification seule : les prix eux-mêmes ne sont pas modifiés.
import { describe, it, expect } from 'vitest';
import { HistoryCalculator } from '../src/HistoryCalculator.js';
import { createFakeStorage, createFakeApi } from './helpers.js';

const TS_0935 = Date.parse('2024-06-14T09:35:00Z');
const TS_0940 = Date.parse('2024-06-14T09:40:00Z');
const DAY_MS_SAFE = 24 * 60 * 60 * 1000;

function buildMinimalSeriesArgs(overrides = {}) {
    const livePriceSnapshot = new Map([['AAPL', {
        price: 110, currency: 'EUR', previousClose: 95, lastUpdate: Date.now()
    }]]);
    return {
        ledger: {
            byTicker: new Map([['AAPL', [{
                date: new Date('2024-01-01T00:00:00Z'),
                price: 80,
                quantity: 1,
                currency: 'EUR',
                broker: 'RV-CT'
            }]]]),
            firstPurchaseDate: new Date('2024-01-01T00:00:00Z')
        },
        tickers: ['AAPL'],
        historicalDataMap: new Map([['AAPL', { [TS_0935]: 100 }]]),
        displayTimestamps: [TS_0935, TS_0940],
        lastKnownPrices: new Map(),
        dynamicRate: 0.9,
        isSingleAsset: false,
        interval: '5m',
        days: 1,
        labelFormatFunc: () => '',
        resolveCloseBefore: async () => ({ total: 95, prices: new Map([['AAPL', 95]]) }),
        initialYesterdayClose: 95,
        win: {
            displayStartTs: TS_0935 - 3600000,
            displayStart: new Date(TS_0935 - 3600000),
            displayEndTs: TS_0940 + 3600000
        },
        midnightValuationSeed: null,
        livePriceSnapshot,
        ...overrides
    };
}

describe('pointMeta provenance — historical_candle vs valuation', () => {
    it('bougie exacte à 09:35 → historical_candle ; point 09:40 via closestPrice → valuation', async () => {
        const calc = new HistoryCalculator(createFakeStorage({ conversionRate: 0.9 }), createFakeApi());
        const result = await calc._buildSeries(buildMinimalSeriesArgs());

        expect(result.pointMeta).toHaveLength(2);

        expect(result.pointMeta[0].timestamp).toBe(TS_0935);
        expect(result.pointMeta[0].tickerSources.AAPL).toBe('historical_candle');
        expect(result.pointMeta[0].source).toBe('historical_candle');
        expect(result.pointMeta[0].isHistoricalObservation).toBe(true);
        expect(result.pointMeta[0].isValuation).toBe(false);

        expect(result.pointMeta[1].timestamp).toBe(TS_0940);
        expect(result.pointMeta[1].tickerSources.AAPL).toBe('valuation');
        expect(result.pointMeta[1].source).toBe('valuation');
        expect(result.pointMeta[1].isHistoricalObservation).toBe(false);
        expect(result.pointMeta[1].isValuation).toBe(true);

        // Classification seule : le prix 100 € (bougie 09:35) est réutilisé à 09:40 sans altération.
        expect(result.values[0]).toBe(100);
        expect(result.values[1]).toBe(100);
    });

    it('midnightSeed au premier timestamp → valuation, pas historical_candle', async () => {
        const calc = new HistoryCalculator(createFakeStorage({ conversionRate: 0.9 }), createFakeApi());
        const midnightTs = TS_0935 - 3600000;
        const result = await calc._buildSeries(buildMinimalSeriesArgs({
            historicalDataMap: new Map([['AAPL', {}]]),
            displayTimestamps: [midnightTs],
            win: {
                displayStartTs: midnightTs,
                displayStart: new Date(midnightTs),
                displayEndTs: midnightTs + DAY_MS_SAFE
            },
            midnightValuationSeed: new Map([['AAPL', 95]])
        }));

        expect(result.pointMeta[0].tickerSources.AAPL).toBe('valuation');
        expect(result.pointMeta[0].source).toBe('valuation');
        expect(result.pointMeta[0].isHistoricalObservation).toBe(false);
        expect(result.values[0]).toBe(95);
    });

    it('lastKnown sans hist → valuation', async () => {
        const calc = new HistoryCalculator(createFakeStorage({ conversionRate: 0.9 }), createFakeApi());
        const result = await calc._buildSeries(buildMinimalSeriesArgs({
            historicalDataMap: new Map([['AAPL', {}]]),
            displayTimestamps: [TS_0935],
            lastKnownPrices: new Map([['AAPL', 97]]),
            midnightValuationSeed: null
        }));

        expect(result.pointMeta[0].tickerSources.AAPL).toBe('valuation');
        expect(result.pointMeta[0].source).toBe('valuation');
        expect(result.values[0]).toBe(97);
    });
});
