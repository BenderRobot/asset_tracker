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
        const tableRows = Object.fromEntries(result.holdings.map(position => [position.ticker, position]));

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
        // Le KPI quotidien reste pilote uniquement par le BTC, tandis que les
        // colonnes DAY du tableau montrent la derniere seance cotee (vendredi
        // contre jeudi) pour les instruments fermes.
        expect(tableRows.AAPL.dayChange).toBe(0);
        expect(tableRows.AAPL.displayDayChange).toBeCloseTo(10, 8);
        expect(tableRows.AAPL.displayDayPct).toBeCloseTo(12.5, 8);
        expect(tableRows['CSPX.L'].dayChange).toBe(0);
        expect(tableRows['CSPX.L'].displayDayChange).toBeCloseTo(5, 8);
        expect(tableRows['CSPX.L'].displayDayPct).toBeCloseTo((5 / 45) * 100, 8);
        expect(positions.AAPL.displayDayPnl).toBeCloseTo(10, 8);
        expect(positions['CSPX.L'].displayDayPnl).toBeCloseTo(5, 8);
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
        expect(result.todayGraphData.dayPnl[0]).toBeCloseTo(0, 8);
        expect(result.todayGraphData.dayPnl.at(-1)).toBeCloseTo(5, 8);
        expect(result.todayGraphData.dayPnlPct.at(-1)).toBeCloseTo((5 / 240) * 100, 8);
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

    it('la vue 1W charge la clôture du vendredi avant son premier lundi', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-27T12:00:00+02:00'));

        const fridayBeforeWindow = new Date('2026-09-18T19:55:00Z').getTime();
        const mondayOpen = new Date('2026-09-21T08:00:00Z').getTime();
        const requestedRanges = [];
        const candles = {
            'BTC-EUR': {
                [new Date('2026-09-20T21:45:00Z').getTime()]: 100,
                [new Date('2026-09-21T08:00:00Z').getTime()]: 100,
                [new Date('2026-09-27T09:45:00Z').getTime()]: 105
            },
            AAPL: {
                [fridayBeforeWindow]: 90,
                [new Date('2026-09-21T14:30:00Z').getTime()]: 90
            },
            'CSPX.L': {
                [new Date('2026-09-18T15:25:00Z').getTime()]: 50,
                [mondayOpen]: 50
            }
        };
        const storage = createFakeStorage({
            prices: {
                'BTC-EUR': { price: 105, previousClose: 100, currency: 'EUR', lastUpdate: Date.now() },
                AAPL: { price: 90, previousClose: 90, currency: 'EUR', lastUpdate: Date.now() },
                'CSPX.L': { price: 50, previousClose: 50, currency: 'EUR', lastUpdate: Date.now() }
            },
            conversionRate: 1
        });
        const api = createFakeApi({
            async getHistoricalPricesWithRetry(ticker, startSec, endSec, interval) {
                requestedRanges.push({ ticker, startSec, endSec, interval });
                return Object.fromEntries(Object.entries(candles[ticker] || {}).filter(([ts]) => {
                    const time = Number(ts);
                    return time >= startSec * 1000 && time <= endSec * 1000;
                }));
            }
        });
        const dm = new DataManager(storage, api);
        const trace = [];

        const graph = await dm.calculateGenericHistory(mixedPurchases(), 7, false, 1, new Map(), trace);
        const aaplRequest = requestedRanges.find(request => request.ticker === 'AAPL' && request.interval === '15m');
        const firstCompleteIndex = graph.values.findIndex(Number.isFinite);
        const beforeMondayOpen = trace.filter(row => row.ts < mondayOpen && ['AAPL', 'CSPX.L'].includes(row.ticker));

        expect(aaplRequest.startSec * 1000).toBeLessThanOrEqual(fridayBeforeWindow);
        expect(firstCompleteIndex).toBe(0);
        expect(graph.values[0]).toBeCloseTo(240, 8);
        expect(beforeMondayOpen.length).toBeGreaterThan(0);
        expect(beforeMondayOpen.every(row => row.source === 'closestPrice')).toBe(true);
        expect(beforeMondayOpen.filter(row => row.ticker === 'AAPL').every(row => row.price === 90)).toBe(true);
        expect(beforeMondayOpen.filter(row => row.ticker === 'CSPX.L').every(row => row.price === 50)).toBe(true);
    });

    it('le dimanche, un actif coté seul conserve son graphique et son Day P&L du vendredi', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-27T12:00:00+02:00'));

        const thursdayClose = new Date('2026-09-24T15:25:00Z').getTime();
        const fridayOpen = new Date('2026-09-25T07:00:00Z').getTime();
        const fridayClose = new Date('2026-09-25T15:25:00Z').getTime();
        const purchases = [purchase({
            ticker: 'STEC', name: 'iShares STOXX Europe 600 Tech', assetType: 'ETF',
            broker: 'PEA', price: 5.8987, quantity: 300, date: '2024-01-01'
        })];
        const candles = { [thursdayClose]: 7.5, [fridayOpen]: 7.6, [fridayClose]: 7.752 };
        const storage = createFakeStorage({
            prices: { STEC: { price: 7.752, previousClose: 7.5, currency: 'EUR', lastUpdate: Date.now() } },
            conversionRate: 1
        });
        const api = createFakeApi({
            async getHistoricalPricesWithRetry(ticker, startSec, endSec) {
                if (ticker !== 'STEC') return {};
                return Object.fromEntries(Object.entries(candles).filter(([ts]) => {
                    const time = Number(ts);
                    return time >= startSec * 1000 && time <= endSec * 1000;
                }));
            }
        });
        const dm = new DataManager(storage, api);
        const trace = [];

        const graph = await dm.calculateGenericHistory(purchases, 1, true, 1, new Map(), trace);
        const snapshot = dm.buildAssetPortfolioSnapshot('STEC', purchases, graph, new Map());
        const displayedDate = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(graph.timestamps[0]);

        expect(displayedDate).toBe('2026-09-25');
        expect(graph.unitPrices[0]).toBeCloseTo(7.5, 8);
        expect(graph.unitPrices.at(-1)).toBeCloseTo(7.752, 8);
        expect(snapshot.holdings[0].currentPrice).toBeCloseTo(7.752, 8);
        expect(snapshot.holdings[0].dayChange).toBeCloseTo((7.752 - 7.5) * 300, 8);
        expect(snapshot.holdings[0].dayPct).toBeCloseTo(((7.752 - 7.5) / 7.5) * 100, 8);
    });

    it('le samedi, un broker sans crypto conserve la valorisation et le tableau du vendredi', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-26T12:00:00+02:00'));

        const candles = {
            AAPL: {
                [new Date('2026-09-24T19:55:00Z').getTime()]: 100,
                [new Date('2026-09-25T14:30:00Z').getTime()]: 105,
                [new Date('2026-09-25T19:55:00Z').getTime()]: 110
            },
            'CSPX.L': {
                [new Date('2026-09-24T15:25:00Z').getTime()]: 50,
                [new Date('2026-09-25T08:00:00Z').getTime()]: 52,
                [new Date('2026-09-25T15:25:00Z').getTime()]: 55
            }
        };
        const purchases = [
            purchase({ ticker: 'AAPL', broker: 'PEA', price: 80, quantity: 2, date: '2024-01-01' }),
            purchase({ ticker: 'CSPX.L', broker: 'PEA', assetType: 'ETF', price: 40, quantity: 3, date: '2024-01-01' })
        ];
        const storage = createFakeStorage({
            prices: {
                AAPL: { price: 110, previousClose: 100, currency: 'EUR', lastUpdate: Date.now() },
                'CSPX.L': { price: 55, previousClose: 50, currency: 'EUR', lastUpdate: Date.now() }
            },
            conversionRate: 1
        });
        const api = createFakeApi({
            async getHistoricalPricesWithRetry(ticker, startSec, endSec) {
                return Object.fromEntries(Object.entries(candles[ticker] || {}).filter(([ts]) => {
                    const time = Number(ts);
                    return time >= startSec * 1000 && time <= endSec * 1000;
                }));
            }
        });
        const dm = new DataManager(storage, api);

        const result = await dm.buildTodaySnapshot(purchases, []);
        const positions = Object.fromEntries(result.holdings.map(position => [position.ticker, position]));
        const displayedDate = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(result.todayGraphData.timestamps[0]);

        expect(displayedDate).toBe('2026-09-25');
        expect(result.todayGraphData.values[0]).toBeCloseTo(350, 8);
        expect(result.todayGraphData.values.at(-1)).toBeCloseTo(385, 8);
        expect(positions.AAPL.dayChange).toBeCloseTo(20, 8);
        expect(positions['CSPX.L'].dayChange).toBeCloseTo(15, 8);
        expect(result.portfolioSnapshot.dayPnl).toBeCloseTo(35, 8);
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
