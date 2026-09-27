import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeApi, createFakeStorage, purchase } from './helpers.js';

function mixedPurchases() {
    return [
        purchase({ ticker: 'BTC-EUR', name: 'Bitcoin', assetType: 'Crypto', price: 80, quantity: 1 }),
        purchase({ ticker: 'AAPL', name: 'Apple', assetType: 'Stock', price: 70, quantity: 1 }),
        purchase({ ticker: 'CSPX.L', name: 'iShares Core S&P 500', assetType: 'ETF', price: 40, quantity: 1 })
    ];
}

afterEach(() => vi.useRealTimers());

describe('Portefeuille mixte pendant le week-end', () => {
    it('le dimanche, seul le BTC modifie la valorisation et le Day P&L', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-27T12:00:00+02:00'));

        const storage = createFakeStorage({
            prices: {
                'BTC-EUR': { price: 105, previousClose: 100, currency: 'EUR', lastUpdate: Date.now() },
                AAPL: { price: 90, previousClose: 80, currency: 'EUR', lastUpdate: Date.now() },
                'CSPX.L': { price: 50, previousClose: 45, currency: 'EUR', lastUpdate: Date.now() }
            },
            conversionRate: 1
        });
        const dm = new DataManager(storage, createFakeApi());

        const result = await dm.buildTodaySnapshot(mixedPurchases(), []);
        const positions = Object.fromEntries(result.portfolioSnapshot.positions.map(position => [position.ticker, position]));

        expect(positions.AAPL).toMatchObject({
            currentPrice: 90,
            previousClose: 90,
            dayPnl: 0,
            dayPnlPct: 0,
            yesterdayQuantity: 1
        });
        expect(positions['CSPX.L']).toMatchObject({
            currentPrice: 50,
            previousClose: 50,
            dayPnl: 0,
            dayPnlPct: 0,
            yesterdayQuantity: 1
        });
        expect(positions['BTC-EUR'].dayPnl).toBeCloseTo(5, 8);
        expect(result.portfolioSnapshot.totalValue).toBeCloseTo(245, 8);
        expect(result.todayGraphData.yesterdayClose).toBeCloseTo(240, 8);
        expect(result.portfolioSnapshot.dayPnl).toBeCloseTo(5, 8);
        expect(result.portfolioSnapshot.dayPnl).toBeCloseTo(
            result.portfolioSnapshot.positions.reduce((sum, position) => sum + position.dayPnl, 0),
            8
        );
    });

    it('avec des bougies BTC réelles, la Période 1J et la Var Today ont la même variation', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-27T12:00:00+02:00'));

        const btcBeforeParisMidnight = new Date('2026-09-26T21:55:00Z').getTime();
        const btcCandleStampedAtParisMidnight = new Date('2026-09-26T22:00:00Z').getTime();
        const btcCurrentCandle = new Date('2026-09-27T09:55:00Z').getTime();
        const aaplFridayIntraday = new Date('2026-09-25T19:55:00Z').getTime();
        const cspxFridayIntraday = new Date('2026-09-25T15:25:00Z').getTime();
        const storage = createFakeStorage({
            prices: {
                'BTC-EUR': { price: 105, previousClose: 999, currency: 'EUR', lastUpdate: Date.now() },
                AAPL: { price: 90, previousClose: 80, currency: 'EUR', lastUpdate: Date.now() },
                'CSPX.L': { price: 50, previousClose: 45, currency: 'EUR', lastUpdate: Date.now() }
            },
            conversionRate: 1
        });
        const api = createFakeApi({
            async getHistoricalPricesWithRetry(ticker) {
                if (ticker === 'BTC-EUR') {
                    return {
                        [btcBeforeParisMidnight]: 100,
                        // Cette clôture appartient déjà à l'intervalle qui commence
                        // à minuit : elle ne doit jamais remplacer le point frontière.
                        [btcCandleStampedAtParisMidnight]: 104,
                        [btcCurrentCandle]: 105
                    };
                }
                // Ces dernières bougies intraday sont volontairement différentes
                // des clôtures officielles live (AAPL=90, CSPX=50). Elles ne
                // doivent jamais réapparaître au premier point BTC du dimanche.
                if (ticker === 'AAPL') return { [aaplFridayIntraday]: 80 };
                if (ticker === 'CSPX.L') return { [cspxFridayIntraday]: 45 };
                return {};
            }
        });
        const dm = new DataManager(storage, api);

        const result = await dm.buildTodaySnapshot(mixedPurchases(), []);
        const values = result.todayGraphData.values.filter(value => value != null);
        const periodPnl = values.at(-1) - values[0];

        // Le previousClose=999 volontairement faux prouve que la référence BTC
        // vient bien de la dernière bougie avant minuit Paris (100), pas du
        // champ live indépendant qui causait l'écart observé.
        expect(result.todayGraphData.yesterdayClose).toBeCloseTo(240, 8);
        expect(values[0]).toBeCloseTo(240, 8);
        expect(values.at(-1)).toBeCloseTo(245, 8);
        expect(result.todayGraphData.pointMeta[0].tickerSources['BTC-EUR']).toBe('valuation');
        expect(result.todayGraphData.pointMeta.at(-1).tickerSources.AAPL).toBe('valuation');
        expect(result.todayGraphData.pointMeta.at(-1).tickerSources['CSPX.L']).toBe('valuation');
        expect(periodPnl).toBeCloseTo(5, 8);
        expect(result.portfolioSnapshot.dayPnl).toBeCloseTo(periodPnl, 8);
    });

    it('la vue 2J conserve les clôtures officielles des actions pendant tout samedi et dimanche', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-27T12:00:00+02:00'));

        const saturdayMidnight = new Date('2026-09-25T22:00:00Z').getTime();
        const candles = {
            'BTC-EUR': {
                [new Date('2026-09-25T12:00:00Z').getTime()]: 97,
                [saturdayMidnight]: 98,
                [new Date('2026-09-26T10:00:00Z').getTime()]: 99,
                [new Date('2026-09-26T22:00:00Z').getTime()]: 100,
                [new Date('2026-09-27T09:55:00Z').getTime()]: 105
            },
            AAPL: {
                [new Date('2026-09-25T14:00:00Z').getTime()]: 80,
                [new Date('2026-09-25T19:55:00Z').getTime()]: 85
            },
            'CSPX.L': {
                [new Date('2026-09-25T08:00:00Z').getTime()]: 45,
                [new Date('2026-09-25T15:25:00Z').getTime()]: 48
            }
        };
        const storage = createFakeStorage({
            prices: {
                'BTC-EUR': { price: 105, previousClose: 100, currency: 'EUR', lastUpdate: Date.now() },
                AAPL: { price: 90, previousClose: 80, currency: 'EUR', lastUpdate: Date.now() },
                'CSPX.L': { price: 50, previousClose: 45, currency: 'EUR', lastUpdate: Date.now() }
            },
            conversionRate: 1
        });
        const dm = new DataManager(storage, createFakeApi({
            async getHistoricalPricesWithRetry(ticker) { return candles[ticker] || {}; }
        }));
        const trace = [];

        const graph = await dm.calculateGenericHistory(mixedPurchases(), 2, false, 1, new Map(), trace);
        const weekendRows = trace.filter(row => {
            const day = new Date(row.ts).getDay();
            return day === 0 || day === 6;
        });

        expect(weekendRows.filter(row => row.ticker === 'AAPL').every(row => row.price === 90 && row.source === 'closedMarketClose')).toBe(true);
        expect(weekendRows.filter(row => row.ticker === 'CSPX.L').every(row => row.price === 50 && row.source === 'closedMarketClose')).toBe(true);

        const saturdayIndex = graph.timestamps.indexOf(saturdayMidnight);
        expect(saturdayIndex).toBeGreaterThanOrEqual(0);
        // De samedi 00:00 jusqu'au dernier point du dimanche, seule la hausse
        // BTC 98 -> 105 doit modifier le portefeuille : exactement +7.
        expect(graph.values.at(-1) - graph.values[saturdayIndex]).toBeCloseTo(7, 8);
    });

    it('le lundi repart de la clôture de vendredi pour les marchés et de la valeur BTC de dimanche soir', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-28T22:00:00+02:00'));

        const candles = {
            'BTC-EUR': {
                [new Date('2026-09-27T21:55:00Z').getTime()]: 105,
                [new Date('2026-09-28T19:55:00Z').getTime()]: 110
            },
            AAPL: {
                [new Date('2026-09-25T19:55:00Z').getTime()]: 90,
                [new Date('2026-09-28T19:55:00Z').getTime()]: 95
            },
            'CSPX.L': {
                [new Date('2026-09-25T15:25:00Z').getTime()]: 50,
                [new Date('2026-09-28T15:25:00Z').getTime()]: 52
            }
        };
        const storage = createFakeStorage({
            prices: {
                'BTC-EUR': { price: 110, previousClose: 105, currency: 'EUR', lastUpdate: Date.now() },
                AAPL: { price: 95, previousClose: 90, currency: 'EUR', lastUpdate: Date.now() },
                'CSPX.L': { price: 52, previousClose: 50, currency: 'EUR', lastUpdate: Date.now() }
            },
            conversionRate: 1
        });
        const api = createFakeApi({
            async getHistoricalPricesWithRetry(ticker) {
                return candles[ticker] || {};
            }
        });
        const dm = new DataManager(storage, api);

        const result = await dm.buildTodaySnapshot(mixedPurchases(), []);
        const positions = Object.fromEntries(result.portfolioSnapshot.positions.map(position => [position.ticker, position]));

        expect(positions['BTC-EUR'].dayPnl).toBeCloseTo(5, 8);
        expect(positions.AAPL.dayPnl).toBeCloseTo(5, 8);
        expect(positions['CSPX.L'].dayPnl).toBeCloseTo(2, 8);
        expect(result.todayGraphData.yesterdayClose).toBeCloseTo(245, 8);
        expect(result.portfolioSnapshot.totalValue).toBeCloseTo(257, 8);
        expect(result.portfolioSnapshot.dayPnl).toBeCloseTo(12, 8);
        expect(result.portfolioSnapshot.dayPnl).toBeCloseTo(
            result.portfolioSnapshot.positions.reduce((sum, position) => sum + position.dayPnl, 0),
            8
        );
    });
});
