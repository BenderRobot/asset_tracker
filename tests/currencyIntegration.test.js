import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../src/storage.js';
import { DataManager } from '../src/dataManager.js';
import { PriceAPI } from '../src/api.js';
import { HistoricalPointStore } from '../src/historicalPointStore.js';
import { quoteInEur, withHistoryCurrency } from '../src/currency.js';
import { createFakeApi, createFakeStorage, purchase } from './helpers.js';

const dates = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28'];
const at = day => Date.parse(`${day}T14:00:00Z`);
function realQuoteStorage(rate = 0.8) {
    const storage = createFakeStorage({ conversionRate: rate, assetTypes: { AAPL: 'Stock' } });
    storage.currentData = {};
    storage.priceTimestamps = {};
    storage.savePricesCache = vi.fn();
    storage.setCurrentPrice = (ticker, quote) => Storage.prototype.setCurrentPrice.call(storage, ticker, quote);
    storage.getCurrentPrice = ticker => Storage.prototype.getCurrentPrice.call(storage, ticker);
    return storage;
}
function engine({ rate = 0.8, quoteCurrency = 'USD', historyCurrency = 'USD', historyFx = 0.8 } = {}) {
    const storage = realQuoteStorage(rate);
    storage.setCurrentPrice('AAPL', { price: 100, previousClose: 100, currency: quoteCurrency, lastUpdate: Date.now() });
    const history = withHistoryCurrency(Object.fromEntries(dates.map(d => [at(d), 100])), historyCurrency);
    const api = createFakeApi({ getHistoricalPricesWithRetry: async () => history });
    const dm = new DataManager(storage, api);
    vi.spyOn(dm, 'getHistoricalFxMap').mockResolvedValue(historyFx ? new Map(dates.map(d => [d, 1 / historyFx])) : new Map());
    return { dm, storage, history, api };
}
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T15:00:00Z'));
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network call'); }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('USD/EUR boundaries using the real quote storage', () => {
    it.each([1, 7, 90, 'all'])('converts USD history exactly once for period %s', async period => {
        const { dm, history } = engine();
        const rows = [purchase({ date: dates[0], currency: 'USD' })];
        const graph = await dm.calculateHistory(rows, period);
        expect(graph.values.at(-1)).toBeCloseTo(80);
        expect(graph.investedAssetOnly.at(-1)).toBeCloseTo(80);
        expect(graph.totalReturn.at(-1)).toBeCloseTo(0);
        expect(history[at(dates[0])]).toBe(100); // shared native cache is untouched
        expect(history.currency).toBe('USD');
        const snapshot = await dm.buildTodaySnapshot(rows);
        expect(snapshot.portfolioSnapshot.totalValue).toBeCloseTo(80);
        expect(snapshot.portfolioSnapshot.dayPnl).toBeCloseTo(0);
    });

    it('uses EUR for single-asset prices, cost basis and transaction markers', async () => {
        const { dm } = engine();
        const graph = await dm.calculateGenericHistory([purchase({ date: dates[0], currency: 'USD' })], 'all', true);
        expect(graph.unitPrices.at(-1)).toBeCloseTo(80);
        expect(graph.totalReturn.at(-1)).toBeCloseTo(0);
        expect(graph.purchasePoints[0].y).toBeCloseTo(80);
    });

    it('uses the history currency, independently of the transaction and live quote currencies', async () => {
        const { dm } = engine({ quoteCurrency: 'EUR', historyCurrency: 'USD' });
        const graph = await dm.calculateHistory([purchase({ date: dates[0], currency: 'EUR', price: 80 })], 'all');
        expect(graph.values.at(-1)).toBeCloseTo(80);
        const eur = engine({ quoteCurrency: 'USD', historyCurrency: 'EUR' });
        expect((await eur.dm.calculateHistory([purchase({ date: dates[0], currency: 'USD' })], 'all')).values.at(-1)).toBe(100);
    });

    it('keeps historical FX separate from current FX and revalues native cached quotes', async () => {
        const { dm, storage } = engine({ historyFx: 0.7 });
        const rows = [purchase({ date: dates[0], currency: 'USD' })];
        expect((await dm.calculateHistory(rows, 'all')).values.at(-1)).toBeCloseTo(70);
        storage.getConversionRate = () => 0.9;
        const holdings = dm.calculateHoldings(rows, null, await dm.getHistoricalFxMap(rows));
        expect(holdings[0].currentValue).toBeCloseTo(90);
        expect(holdings[0].invested).toBeCloseTo(70);
        expect(storage.getCurrentPrice('AAPL').nativeQuote.price).toBe(100);
        expect(quoteInEur(storage.getCurrentPrice('AAPL'), 0.9).price).toBeCloseTo(90);
        storage.setCurrentPrice('AAPL', storage.getCurrentPrice('AAPL'));
        expect(storage.getCurrentPrice('AAPL').price).toBeCloseTo(90);
    });

    it('does not invent EUR values when neither current nor historical FX exists', async () => {
        const { dm } = engine({ rate: null, historyFx: null });
        const snapshot = await dm.buildTodaySnapshot([purchase({ date: dates[0], currency: 'USD' })]);
        expect(snapshot.portfolioSnapshot.status).toBe('invalid');
        expect(snapshot.portfolioSnapshot.totalValue).toBeNull();
        expect(snapshot.todayGraphData.values.every(v => v === null)).toBe(true);
    });

    it('converts transaction-price fallbacks with the transaction currency', async () => {
        const { dm, api } = engine();
        api.getHistoricalPricesWithRetry = async () => ({});
        const graph = await dm.calculateHistory([purchase({ date: dates[0], currency: 'USD' })], 7);
        expect(graph.values.at(-1)).toBeCloseTo(80);
    });

    it('preserves history currency through provider parsing and daily cache reuse', async () => {
        const storage = realQuoteStorage();
        const api = new PriceAPI(storage);
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({
            chart: { result: [{ meta: { currency: 'USD', regularMarketPrice: 100 },
                timestamp: dates.slice(0, 4).map(d => at(d) / 1000), indicators: { quote: [{ close: [100, 100, 100, 100] }] } }], error: null }
        }) })));
        const start = at(dates[0]) / 1000, end = at(dates[3]) / 1000;
        const first = await api.getHistoricalPricesWithRetry('AAPL', start, end, '1d');
        expect(first.currency).toBe('USD');
        const second = await api.getHistoricalPricesWithRetry('AAPL', start, end, '1d');
        expect(second.currency).toBe('USD');
        expect(second[at(dates[0])]).toBe(100);
        expect(fetch).toHaveBeenCalledTimes(1);
        const store = new HistoricalPointStore();
        store.merge('CURRENCY-TEST', '1d', first, { startTs: start, endTs: end });
        const reloaded = new HistoricalPointStore();
        expect(reloaded.getKnownPoints('CURRENCY-TEST', '1d', start, end).currency).toBe('USD');
    });
});

describe('Cash balances retain their units', () => {
    const cash = (currency, price, broker = 'A', quantity = 1) => purchase({ ticker: currency, assetType: 'Cash', currency, price, broker, quantity, date: dates[0] });

    it('values mixed deposits, withdrawals, dividends and sale proceeds per broker', () => {
        const { dm } = engine();
        const rows = [cash('USD', 100), cash('USD', -20), cash('EUR', 10), cash('USD', 50, 'B', 2),
            { ...cash('USD', 10), ticker: 'AAPL', assetType: 'Dividend', type: 'dividend' }];
        const result = dm.calculateCashReserve(rows);
        expect(result.byCurrency).toEqual({ USD: 190, EUR: 10 });
        expect(result.byBroker).toEqual({ A: 82, B: 80 });
        expect(result.total).toBeCloseTo(162);
        expect(dm.calculateCashReserve([cash('USD', 100, 'A', 0)]).total).toBe(0);
    });

    it('includes USD cash in both the snapshot and the historical value', async () => {
        const { dm } = engine();
        const assets = [purchase({ date: dates[0], currency: 'USD' })];
        const snapshot = await dm.buildTodaySnapshot(assets, [cash('USD', 100), cash('EUR', 10)]);
        expect(snapshot.cashReserve.total).toBeCloseTo(90);
        expect(snapshot.portfolioSnapshot.totalValue).toBeCloseTo(170);
        expect(snapshot.todayGraphData.cash.at(-1)).toBeCloseTo(90);
        expect(snapshot.todayGraphData.values.at(-1)).toBeCloseTo(170);
    });

    it('cash-only USD snapshots request FX and preserve missing-FX as unavailable', async () => {
        const { dm, api } = engine({ rate: null, historyFx: null });
        api.ensureConversionRate = vi.fn(async () => {});
        const result = await dm.repository.getSnapshot([], [cash('USD', 100)]);
        expect(api.ensureConversionRate).toHaveBeenCalled();
        expect(result.snapshot.portfolioSnapshot.status).toBe('invalid');
        expect(result.snapshot.portfolioSnapshot.cash).toBeNull();
        expect(result.snapshot.portfolioSnapshot.totalValue).toBeNull();
        expect(result.snapshot.portfolioSnapshot.invalidReason).toBe('FX_DATA_UNAVAILABLE');
    });

    it('does not require FX when the USD balance nets to zero', () => {
        const { dm } = engine({ rate: null, historyFx: null });
        expect(dm.calculateCashReserve([cash('USD', 100), cash('USD', -100), cash('EUR', 20)]).total).toBe(20);
    });

    it('cash ledger entries keep their original currency and show historical EUR amounts', () => {
        const { dm } = engine();
        const [entry] = dm.calculateEnrichedPurchases([cash('USD', 100)], new Map([[dates[0], 1 / 0.7]]));
        expect(entry.currency).toBe('USD');
        expect(entry.buyPriceOriginal).toBe(100);
        expect(entry.gainEUR).toBeCloseTo(70);
    });

    it('USD sale proceeds preserve value when a security becomes cash', async () => {
        const { dm } = engine();
        const assets = [purchase({ date: dates[0], currency: 'USD' }),
            purchase({ date: '2026-09-28T13:00:00Z', currency: 'USD', quantity: -1 })];
        const proceeds = { ...cash('USD', 100), date: '2026-09-28T13:00:00Z' };
        const snapshot = await dm.buildTodaySnapshot(assets, [proceeds]);
        expect(snapshot.cashReserve.total).toBeCloseTo(80);
        expect(snapshot.portfolioSnapshot.totalValue).toBeCloseTo(80);
        expect(snapshot.todayGraphData.values.at(-1)).toBeCloseTo(80);
    });

    it('filtering a snapshot cannot turn missing cash FX into a zero balance', async () => {
        const { dm } = engine({ rate: null, quoteCurrency: 'EUR', historyCurrency: 'EUR', historyFx: null });
        const snapshot = await dm.buildTodaySnapshot([purchase({ date: dates[0] })], [cash('USD', 100)]);
        const filtered = dm.deriveFilteredPortfolioSnapshot(snapshot.portfolioSnapshot, new Set(['AAPL']));
        expect(filtered.status).toBe('invalid');
        expect(filtered.cash).toBeNull();
        expect(filtered.totalValue).toBeNull();
    });
});
