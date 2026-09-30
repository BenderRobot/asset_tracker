// Audit 2026-09-28, point 7 (B3): a failed refresh served from the transport
// cache keeps the old data displayable with its real date, and its failure
// travels transport -> PriceAPI -> quote -> PortfolioSnapshot -> repository.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PriceAPI } from '../src/api.js';
import { DataManager } from '../src/dataManager.js';
import { fetchMarketResponse } from '../src/marketDataTransport.js';
import { createFakeApi, createFakeStorage, purchase } from './helpers.js';

const payload = price => ({ chart: { result: [{
    meta: { currency: 'EUR', regularMarketPrice: price, regularMarketPreviousClose: 95 },
    timestamp: [1, 2], indicators: { quote: [{ close: [95, price] }] }
}], error: null } });
const ok = price => ({ ok: true, status: 200, json: async () => payload(price) });

describe('stale-if-error propagation', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
        localStorage.clear();
    });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it('the transport stale response carries the refresh error and the original fetch date', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ok(100)).mockResolvedValueOnce({ ok: false, status: 502 }));
        const url = 'https://example.test/?symbol=STALE502';
        const first = await fetchMarketResponse(url, 1000, 'live-price', 0);
        vi.setSystemTime(new Date(Date.now() + 86400000));
        const fallback = await fetchMarketResponse(url, 1000, 'live-price', 0);
        expect(first).toMatchObject({ stale: false, error: null });
        expect(fallback).toMatchObject({ stale: true, fetchedAt: first.fetchedAt, error: { status: 502 } });
    });

    it('B3 fixed: PriceAPI keeps the dated quote but reports the failure instead of a success', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ok(100)).mockResolvedValueOnce({ ok: false, status: 502 }));
        const storage = createFakeStorage({ assetTypes: { AAPL: 'Stock' } });
        const api = new PriceAPI(storage);
        expect(await api.fetchPricesViaProxy(['AAPL'], true)).toBe(true);
        const observedAt = storage.getCurrentPrice('AAPL').lastUpdate;
        expect(storage.getCurrentPrice('AAPL').stale).toBeUndefined();

        vi.setSystemTime(new Date(Date.now() + 86400000));
        expect(await api.fetchPricesViaProxy(['AAPL'], true)).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(storage.getCurrentPrice('AAPL')).toMatchObject({ price: 100, lastUpdate: observedAt, stale: true });
        expect(storage.getCurrentPrice('AAPL').refreshError).toContain('502');
        expect(api.liveFailures.get('AAPL')).toMatchObject({ stale: true, status: 502, lastUpdate: observedAt });
    });

    it('never replaces a newer known quote with an older stale payload, and a later success clears the flag', async () => {
        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce(ok(100))
            .mockResolvedValueOnce({ ok: false, status: 502 })
            .mockResolvedValueOnce(ok(110)));
        const storage = createFakeStorage({ assetTypes: { AAPL: 'Stock' } });
        const api = new PriceAPI(storage);
        await api.fetchPricesViaProxy(['AAPL'], true);
        vi.setSystemTime(new Date(Date.now() + 3600000));
        storage.setCurrentPrice('AAPL', { price: 105, previousClose: 95, currency: 'EUR', lastUpdate: Date.now() });
        await api.fetchPricesViaProxy(['AAPL'], true);
        expect(storage.getCurrentPrice('AAPL')).toMatchObject({ price: 105, lastUpdate: Date.now(), stale: true });

        await api.fetchPricesViaProxy(['AAPL'], true);
        expect(storage.getCurrentPrice('AAPL').price).toBe(110);
        expect(storage.getCurrentPrice('AAPL').stale).toBeUndefined();
        expect(api.liveFailures.has('AAPL')).toBe(false);
    });

    function snapshotManager(quote, failure) {
        const history = { [Date.parse('2026-09-24T08:00:00Z')]: 100, [Date.parse('2026-09-24T10:00:00Z')]: 100 };
        const dm = new DataManager(createFakeStorage({ conversionRate: 1, prices: quote ? { HELD: quote } : {} }),
            createFakeApi({ getHistoricalPricesWithRetry: async () => history }));
        dm.api.fetchBatchPrices = vi.fn(async () => false);
        dm.api.liveFailures = new Map(failure ? [['HELD', failure]] : []);
        return dm;
    }

    it('a snapshot built on a kept quote stays displayable but is degraded, dated by the quote', async () => {
        const quoteAt = Date.now() - 86400000;
        const dm = snapshotManager(
            { price: 100, previousClose: 100, currency: 'EUR', lastUpdate: quoteAt, stale: true, refreshError: 'Market HTTP 502' },
            { reason: 'Market HTTP 502', stale: true, status: 502 });
        const result = await dm.repository.getSnapshot([purchase({ ticker: 'HELD', date: '2026-09-01' })], []);
        expect(result.snapshot.portfolioSnapshot).toMatchObject({
            status: 'valid', totalValue: 100, sourceStale: true, staleInstruments: ['HELD'],
            refreshErrors: { HELD: 'Market HTTP 502' }, pricesTimestamp: quoteAt
        });
        expect(result).toMatchObject({ stale: true, degraded: true, sourceStale: true, pricesAsOf: quoteAt });
        expect(result.lastRefreshFailure).toContain('HELD');
    });

    it('a failure without any kept quote still blocks the snapshot', async () => {
        const dm = snapshotManager(null, { reason: 'Market HTTP 502', status: 502 });
        await expect(dm.repository.getSnapshot([purchase({ ticker: 'HELD', date: '2026-09-01' })], []))
            .rejects.toThrow('PRICE_DATA_UNAVAILABLE');
    });
});
