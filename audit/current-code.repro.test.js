// B1/B2/B3 now assert the corrected behavior (also covered in the normal
// regression suite). B4-B6 still characterize the outstanding audit defects.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { Storage } from '../src/storage.js';
import { PriceAPI } from '../src/api.js';
import { createFakeApi, createFakeStorage, purchase } from '../tests/helpers.js';

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T15:00:00Z'));
    localStorage.clear();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('B1 fixed: USD history and EUR stored quotes have the same EUR valuation', async () => {
    const storage = createFakeStorage({ conversionRate: 0.8 });
    storage.currentData = {};
    storage.priceTimestamps = {};
    storage.savePricesCache = () => {};
    storage.setCurrentPrice = (ticker, data) => Storage.prototype.setCurrentPrice.call(storage, ticker, data);
    storage.getCurrentPrice = ticker => storage.currentData[ticker];
    storage.setCurrentPrice('AAPL', { price: 100, currency: 'USD', previousClose: 100, lastUpdate: Date.now() });
    expect(storage.getCurrentPrice('AAPL')).toMatchObject({ price: 80, currency: 'EUR', originalCurrency: 'USD' });
    const dates = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
    const history = Object.fromEntries(dates.map(d => [Date.parse(`${d}T16:00:00Z`), 100]));
    const dm = new DataManager(storage, createFakeApi({ getHistoricalPricesWithRetry: async () => history }));
    vi.spyOn(dm, 'getHistoricalFxMap').mockResolvedValue(new Map(dates.map(d => [d, 1.25])));
    const rows = [purchase({ date: dates[0], currency: 'USD', price: 100 })];
    const graph = await dm.calculateHistory(rows, 90);
    expect(graph.investedAssetOnly.at(-1)).toBe(80);
    expect(graph.values.at(-1)).toBe(80);
    expect(dm.calculateHoldings(rows, null, await dm.getHistoricalFxMap(rows))[0].currentValue).toBe(80);
});

it('B2 fixed: USD cash is converted before adding it to the EUR reserve', () => {
    const dm = new DataManager(createFakeStorage({ conversionRate: 0.8 }), createFakeApi());
    const cash = dm.calculateCashReserve([purchase({ ticker: 'USD', assetType: 'Cash', currency: 'USD', price: 100 })]);
    expect(cash.total).toBe(80);
});

it('B3 fixed: a failed live refresh served from transport cache keeps its failure state', async () => {
    const payload = { chart: { result: [{
        meta: { currency: 'EUR', regularMarketPrice: 100, regularMarketPreviousClose: 95 },
        timestamp: [1, 2], indicators: { quote: [{ close: [95, 100] }] }
    }], error: null } };
    vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => payload })
        .mockResolvedValueOnce({ ok: false, status: 502 }));
    const storage = createFakeStorage({ assetTypes: { AAPL: 'Stock' } });
    const api = new PriceAPI(storage);
    await api.fetchPricesViaProxy(['AAPL'], true);
    const observedAt = storage.getCurrentPrice('AAPL').lastUpdate;
    vi.setSystemTime(new Date(Date.now() + 86400000));
    api.liveFailures.set('AAPL', { reason: 'previous error' });
    expect(await api.fetchPricesViaProxy(['AAPL'], true)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(storage.getCurrentPrice('AAPL').lastUpdate).toBe(observedAt);
    expect(api.liveFailures.get('AAPL')).toMatchObject({ stale: true, status: 502 });
    expect(storage.getCurrentPrice('AAPL').stale).toBe(true);
});

it('B4: a dividend creates a negative return in the broker detail at a constant price', async () => {
    const history = { [Date.parse('2026-09-28T10:00:00Z')]: 100 };
    const dm = new DataManager(createFakeStorage({ prices: { AAPL: { price: 100, previousClose: 100, currency: 'EUR' } } }),
        createFakeApi({ getHistoricalPricesWithRetry: async () => history }));
    const rows = [purchase({ date: '2026-09-01' }), purchase({ date: '2026-09-02', assetType: 'Dividend', type: 'dividend', price: 10 })];
    const [broker] = await dm.calculateReturnByBroker(rows);
    expect(broker).toMatchObject({ invested: 100, cash: 10, totalValue: 100, totalReturn: -10 });
});

it('B5 fixed: long-period index data preserves timestamps required by date tooltips', async () => {
    const history = { [Date.parse('2026-09-22T16:00:00Z')]: 100, [Date.parse('2026-09-25T16:00:00Z')]: 110 };
    const dm = new DataManager(createFakeStorage(), createFakeApi({ getHistoricalPricesWithRetry: async () => history }));
    const graph = await dm.calculateIndexData('^GSPC', 30);
    expect(graph.values).toEqual([100, 110]);
    expect(graph.timestamps).toEqual(Object.keys(history).map(Number));
});

it('B6: day profit is allocated to the broker that bought today using current quantities', async () => {
    const history = {
        [Date.parse('2026-09-25T16:00:00Z')]: 100,
        [Date.parse('2026-09-28T14:00:00Z')]: 120
    };
    const dm = new DataManager(createFakeStorage({ prices: { AAPL: { price: 120, previousClose: 100, currency: 'EUR' } } }),
        createFakeApi({ getHistoricalPricesWithRetry: async () => history }));
    const rows = [purchase({ date: '2026-09-01', broker: 'OLD-BROKER' }),
        purchase({ date: '2026-09-28T13:00:00Z', broker: 'NEW-BROKER', price: 120 })];
    const result = await dm.calculateDayChangeByBroker(rows);
    expect(result.find(b => b.broker === 'OLD-BROKER').dayChange).toBe(10);
    expect(result.find(b => b.broker === 'NEW-BROKER').dayChange).toBe(10);
    // Under the engine's yesterday-quantity rule: OLD=20, NEW=0.
});
