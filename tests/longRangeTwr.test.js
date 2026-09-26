import { describe, expect, it } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { HistoryCalculator } from '../src/HistoryCalculator.js?v=14';
import { createFakeApi, createFakeStorage, purchase } from './helpers.js';

const utcNoon = (isoDate) => new Date(`${isoDate}T12:00:00.000Z`).getTime();

describe('Long-range portfolio performance', () => {
    it('never seeds a long-range valuation with a future candle or a live quote', () => {
        const calc = new HistoryCalculator(createFakeStorage(), createFakeApi());
        const start = utcNoon('2026-01-05');
        const past = utcNoon('2026-01-04');
        const future = utcNoon('2026-01-06');
        const live = new Map([['AAPL', { price: 500, previousClose: 490 }]]);

        const futureOnly = calc._seedLastKnownPrices(
            ['AAPL'], new Map([['AAPL', { [future]: 100 }]]),
            { displayStartTs: start }, 'all', live
        );
        expect(futureOnly.has('AAPL')).toBe(false);

        const withPast = calc._seedLastKnownPrices(
            ['AAPL'], new Map([['AAPL', { [past]: 90, [future]: 100 }]]),
            { displayStartTs: start }, 'all', live
        );
        expect(withPast.get('AAPL')).toBe(90);
    });

    it.each([2, 7, 30, 90, 180, 'ytd', 365, 730, 'all'])(
        'keeps period %s usable when a manual asset has no market history',
        async (period) => {
            const now = Date.now();
            const day = 86400000;
            const marketHistory = {
                [now - 800 * day]: 100,
                [now - 730 * day]: 101,
                [now - 365 * day]: 105,
                [now - 180 * day]: 106,
                [now - 90 * day]: 107,
                [now - 30 * day]: 108,
                [now - 7 * day]: 109,
                [now - 2 * day]: 110,
                [now - 60 * 60 * 1000]: 111
            };
            const storage = createFakeStorage({
                prices: {
                    AAPL: { price: 111, previousClose: 110, currency: 'EUR', lastUpdate: now },
                    PRIVATE: { price: 125, previousClose: 125, currency: 'EUR', lastUpdate: now }
                },
                conversionRate: 1
            });
            const dm = new DataManager(storage, createFakeApi({
                async getHistoricalPricesWithRetry(ticker) {
                    return ticker === 'AAPL' ? marketHistory : {};
                }
            }));

            const graph = await dm.calculateGenericHistory([
                purchase({ ticker: 'AAPL', price: 100, quantity: 1, date: '2024-01-01' }),
                purchase({ ticker: 'PRIVATE', price: 100, quantity: 1, date: '2024-01-01' })
            ], period, false);

            expect(graph.twr.filter(Number.isFinite).length).toBeGreaterThan(0);
            expect(graph.values.filter(Number.isFinite).length).toBeGreaterThan(0);
        }
    );

    it('uses daily observations for 2Y and All so transactions are not shifted to a later week', () => {
        // Official broker TWR statements are daily. Weekly candles assign a
        // transaction to the next weekly point and create artificial jumps.
        expect(new DataManager(createFakeStorage(), createFakeApi()).getIntervalForPeriod('all')).toBe('1d');
        expect(new DataManager(createFakeStorage(), createFakeApi()).getIntervalForPeriod(730)).toBe('1d');
    });

    it('chains market returns and neutralises a later purchase on All', async () => {
        const prices = {
            [utcNoon('2026-01-05')]: 100,
            [utcNoon('2026-01-06')]: 110,
            [utcNoon('2026-01-07')]: 110,
            [utcNoon('2026-01-08')]: 121
        };
        const storage = createFakeStorage({
            prices: { AAPL: { price: 121, previousClose: 121, currency: 'EUR', lastUpdate: Date.now() } },
            conversionRate: 1
        });
        const dm = new DataManager(storage, createFakeApi({
            async getHistoricalPricesWithRetry(ticker) {
                return ticker === 'AAPL' ? prices : {};
            }
        }));

        const graph = await dm.calculateGenericHistory([
            purchase({ ticker: 'AAPL', price: 100, quantity: 1, date: '2026-01-05' }),
            // New capital at the unchanged 110 price must not create performance.
            purchase({ ticker: 'AAPL', price: 110, quantity: 1, date: '2026-01-07' })
        ], 'all', false);

        const validTwr = graph.twr.filter(Number.isFinite);
        expect(validTwr[0]).toBeCloseTo(1, 8);
        expect(validTwr.at(-1)).toBeCloseTo(1.21, 8);
        expect(graph.periodPnl.at(-1)).toBeCloseTo(32, 8);

        // The current-cost-basis ratio is 242 / 210 = 1.15238.  It is a valid
        // total-return KPI, but must never be used as the historical curve.
        expect(validTwr.at(-1)).not.toBeCloseTo(242 / 210, 4);
    });

    it('neutralises a partial sale without erasing prior performance', async () => {
        const prices = {
            [utcNoon('2026-02-02')]: 100,
            [utcNoon('2026-02-03')]: 120,
            [utcNoon('2026-02-04')]: 120,
            [utcNoon('2026-02-05')]: 132
        };
        const storage = createFakeStorage({
            prices: { AAPL: { price: 132, previousClose: 132, currency: 'EUR', lastUpdate: Date.now() } },
            conversionRate: 1
        });
        const dm = new DataManager(storage, createFakeApi({
            async getHistoricalPricesWithRetry() { return prices; }
        }));

        const graph = await dm.calculateGenericHistory([
            purchase({ ticker: 'AAPL', price: 100, quantity: 2, date: '2026-02-02' }),
            purchase({ ticker: 'AAPL', price: 120, quantity: -1, date: '2026-02-04' })
        ], 'all', false);

        const validTwr = graph.twr.filter(Number.isFinite);
        // +20%, sale at unchanged price, then +10% = +32%.
        expect(validTwr.at(-1)).toBeCloseTo(1.32, 8);
        expect(graph.periodPnl.at(-1)).toBeCloseTo(52, 8);
    });

    it('counts dividends as performance instead of neutralising them as deposits', async () => {
        const prices = {
            [utcNoon('2026-03-02')]: 100,
            [utcNoon('2026-03-03')]: 100
        };
        const storage = createFakeStorage({
            prices: { AAPL: { price: 100, previousClose: 100, currency: 'EUR', lastUpdate: Date.now() } },
            conversionRate: 1
        });
        const dm = new DataManager(storage, createFakeApi({
            async getHistoricalPricesWithRetry() { return prices; }
        }));

        const graph = await dm.calculateGenericHistory([
            purchase({ ticker: 'AAPL', price: 100, quantity: 1, date: '2026-03-02' }),
            purchase({ ticker: 'AAPL', assetType: 'Dividend', type: 'dividend', price: 10, quantity: 1, date: '2026-03-03' })
        ], 'all', false);

        expect(graph.twr.filter(Number.isFinite).at(-1)).toBeCloseTo(1.00, 8);
        expect(graph.twrWithDividends.filter(Number.isFinite).at(-1)).toBeCloseTo(1.10, 8);
        expect(graph.totalReturnPct.filter(Number.isFinite).at(-1)).toBeCloseTo(0, 8);
        expect(graph.totalReturnPctWithDividends.filter(Number.isFinite).at(-1)).toBeCloseTo(10, 8);
    });

    it('values USD holdings with historical daily FX instead of today’s FX', async () => {
        const prices = {
            [utcNoon('2026-04-01')]: 100,
            [utcNoon('2026-04-02')]: 100
        };
        const storage = createFakeStorage({
            prices: { AAPL: { price: 100, previousClose: 100, currency: 'USD', lastUpdate: Date.now() } },
            conversionRate: 1
        });
        const dm = new DataManager(storage, createFakeApi({
            async getHistoricalPricesWithRetry() { return prices; }
        }));
        const fx = new Map([
            ['2026-04-01', 1 / 0.90],
            ['2026-04-02', 1 / 1.00]
        ]);

        const graph = await dm.calculateGenericHistory([
            purchase({ ticker: 'AAPL', currency: 'USD', price: 100, quantity: 1, date: '2026-04-01' })
        ], 'all', false, 1, fx);

        const validValues = graph.values.filter(Number.isFinite);
        expect(validValues[0]).toBeCloseTo(90, 8);
        expect(validValues.at(-1)).toBeCloseTo(100, 8);
        expect(graph.twr.filter(Number.isFinite).at(-1)).toBeCloseTo(100 / 90, 8);
    });

    it('converts only USD instruments and leaves every EUR instrument unchanged', async () => {
        const ts = utcNoon('2026-05-04');
        const storage = createFakeStorage({
            prices: {
                EURASSET: { price: 100, previousClose: 100, currency: 'EUR', lastUpdate: Date.now() },
                USDASSET: { price: 100, previousClose: 100, currency: 'USD', lastUpdate: Date.now() }
            },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi({
            async getHistoricalPricesWithRetry() { return { [ts]: 100 }; }
        }));
        const fx = new Map([['2026-05-04', 1 / 0.9]]);

        const graph = await dm.calculateGenericHistory([
            purchase({ ticker: 'EURASSET', currency: 'EUR', price: 100, quantity: 1, date: '2026-05-04' }),
            purchase({ ticker: 'USDASSET', currency: 'USD', price: 100, quantity: 1, date: '2026-05-04' })
        ], 'all', false, 0.9, fx);

        // 100 EUR unchanged + (100 USD × 0.90) = 190 EUR.
        expect(graph.values.filter(Number.isFinite).at(-1)).toBeCloseTo(190, 8);
    });

    it('produces the same price TWR whether a trade has a cash counterpart or not', async () => {
        const prices = {
            [utcNoon('2026-06-01')]: 100,
            [utcNoon('2026-06-02')]: 110,
            [utcNoon('2026-06-03')]: 121
        };
        const storage = createFakeStorage({
            prices: { AAPL: { price: 121, previousClose: 121, currency: 'EUR', lastUpdate: Date.now() } },
            conversionRate: 1
        });
        const api = createFakeApi({ async getHistoricalPricesWithRetry() { return prices; } });
        const trades = [
            purchase({ ticker: 'AAPL', price: 100, quantity: 1, date: '2026-06-01' }),
            purchase({ ticker: 'AAPL', price: 110, quantity: 1, date: '2026-06-02' })
        ];
        const cashCounterparts = [
            purchase({ ticker: 'EUR', assetType: 'Cash', currency: 'EUR', price: -100, quantity: 1, date: '2026-06-01' }),
            purchase({ ticker: 'EUR', assetType: 'Cash', currency: 'EUR', price: -110, quantity: 1, date: '2026-06-02' })
        ];

        const withoutCash = await new DataManager(storage, api).calculateGenericHistory(trades, 'all', false);
        const withCash = await new DataManager(storage, api).calculateGenericHistory([...trades, ...cashCounterparts], 'all', false);

        expect(withCash.twr).toEqual(withoutCash.twr);
        expect(withCash.twrWithDividends).toEqual(withoutCash.twrWithDividends);
    });
});
