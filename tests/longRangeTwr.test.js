import { describe, expect, it } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeApi, createFakeStorage, purchase } from './helpers.js';

const utcNoon = (isoDate) => new Date(`${isoDate}T12:00:00.000Z`).getTime();

describe('Long-range portfolio performance', () => {
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
});
