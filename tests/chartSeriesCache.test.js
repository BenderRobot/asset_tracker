// @vitest-environment jsdom
// Chart series shared across pages/sessions: IndexedDB persistence, legacy
// localStorage migration and market-session-aware freshness.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const idb = vi.hoisted(() => ({ available: true, store: new Map() }));
vi.mock('../src/persistentCache.js', () => ({
    isPersistentCacheAvailable: () => idb.available,
    cacheGet: async key => (idb.store.has(key) ? structuredClone(idb.store.get(key)) : null),
    cacheSet: async (key, value) => { idb.store.set(key, structuredClone(value)); return true; },
    cacheDelete: async key => { idb.store.delete(key); return true; }
}));

import { HistoricalChart } from '../src/historicalChart.js';
import { HistoricalPointStore } from '../src/historicalPointStore.js';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

function makeChart() {
    const storage = createFakeStorage();
    const page = {
        filterManager: { getSelectedTickers: () => new Set() },
        getFilteredPurchasesFromPage: () => [],
        getChartTitleConfig: () => ({ mode: 'global', label: 'Portfolio' }),
        renderData: vi.fn()
    };
    return new HistoricalChart(storage, new DataManager(storage, createFakeApi()), null, page);
}

const series = values => ({
    labels: values.map((_, i) => `p${i}`), timestamps: values.map((_, i) => i + 1),
    values, twr: values.map(v => v / values[0]), dataQuality: { valid: true, failedInstruments: [] }
});

describe('Chart series persistence (IndexedDB)', () => {
    beforeEach(() => {
        idb.available = true;
        idb.store.clear();
        localStorage.clear();
    });

    it('reuses a series built by another page without rebuilding it', async () => {
        const rows = [purchase({ ticker: 'AAPL' })];
        const dashboard = makeChart();
        await dashboard._getCachedHistory('portfolio', rows, 365, async () => series([100, 110]));
        await dashboard._persistQueue;

        const investments = makeChart();
        const producer = vi.fn(async () => { throw new Error('must not rebuild'); });
        const result = await investments._getCachedHistory('portfolio', rows, 365, producer);

        expect(producer).not.toHaveBeenCalled();
        expect(result.values).toEqual([100, 110]);
        expect(localStorage.getItem(dashboard._historyStorageKey())).toBeNull();
    });

    it('never persists the volatile 1D series', async () => {
        const chart = makeChart();
        await chart._getCachedHistory('portfolio', [purchase({ ticker: 'AAPL' })], 1, async () => series([1, 2]));
        await chart._persistQueue;
        expect(idb.store.size).toBe(0);
    });

    it('migrates series persisted in localStorage by the previous version, then frees it', async () => {
        const rows = [purchase({ ticker: 'AAPL' })];
        idb.available = false;
        const legacy = makeChart();
        await legacy._getCachedHistory('portfolio', rows, 180, async () => series([100, 120]));
        const storageKey = legacy._historyStorageKey();
        expect(localStorage.getItem(storageKey)).not.toBeNull();

        idb.available = true;
        const migrated = makeChart();
        const producer = vi.fn();
        const result = await migrated._getCachedHistory('portfolio', rows, 180, producer);

        expect(producer).not.toHaveBeenCalled();
        expect(result.values).toEqual([100, 120]);
        expect(localStorage.getItem(storageKey)).toBeNull();
    });

    it('evicts the oldest series beyond the persistent bound', async () => {
        const chart = makeChart();
        for (let i = 0; i < 50; i++) {
            await chart._getCachedHistory('portfolio', [purchase({ ticker: `T${i}` })], 365, async () => series([100, 100 + i]));
        }
        await chart._persistQueue;
        const index = idb.store.get(`${chart._historyStorageKey()}:index`);
        expect(Object.keys(index)).toHaveLength(48);
        expect([...idb.store.keys()].filter(k => !k.endsWith(':index'))).toHaveLength(48);
    });
});

describe('Market-session-aware freshness', () => {
    beforeEach(() => { idb.available = true; idb.store.clear(); });
    const key = (chart, ticker) => chart._historyKey('portfolio', [purchase({ ticker })], 365);
    const at = iso => Date.parse(iso);

    it('keeps a series built after the last close while the market stays closed', () => {
        const chart = makeChart();
        // Saturday: no session between build and read, same civil day.
        const entry = { createdAt: at('2026-09-26T08:00:00Z') };
        expect(chart._isHistoryStale(key(chart, 'MC.PA'), entry, 365, at('2026-09-26T16:00:00Z'))).toBe(false);
        // Tuesday: built after the Paris close + settle delay, read in the evening.
        const evening = { createdAt: at('2026-09-22T16:30:00Z') };
        expect(chart._isHistoryStale(key(chart, 'MC.PA'), evening, 365, at('2026-09-22T21:00:00Z'))).toBe(false);
    });

    it('rebuilds once a session produced (or settled) new points', () => {
        const chart = makeChart();
        const monthKey = chart._historyKey('portfolio', [purchase({ ticker: 'MC.PA' })], 30);
        const beforeClose = { createdAt: at('2026-09-22T10:00:00Z') };
        expect(chart._isHistoryStale(monthKey, beforeClose, 30, at('2026-09-22T10:10:00Z'))).toBe(false); // within TTL
        expect(chart._isHistoryStale(monthKey, beforeClose, 30, at('2026-09-22T12:00:00Z'))).toBe(true);
        expect(chart._isHistoryStale(monthKey, beforeClose, 30, at('2026-09-22T21:00:00Z'))).toBe(true);
        const unsettled = { createdAt: at('2026-09-22T15:40:00Z') };
        expect(chart._isHistoryStale(monthKey, unsettled, 30, at('2026-09-22T21:00:00Z'))).toBe(true);
    });

    it('treats 24/7 assets with the regular TTL and a new civil day as stale', () => {
        const chart = makeChart();
        const entry = { createdAt: at('2026-09-26T08:00:00Z') };
        expect(chart._isHistoryStale(key(chart, 'BTC-EUR'), entry, 365, at('2026-09-26T16:00:00Z'))).toBe(true);
        expect(chart._isHistoryStale(key(chart, 'BTC-EUR'), entry, 365, at('2026-09-26T09:00:00Z'))).toBe(false);
        expect(chart._isHistoryStale(key(chart, 'MC.PA'), entry, 365, at('2026-09-28T08:00:00Z'))).toBe(true);
    });
});

describe('Daily point store persistence (IndexedDB)', () => {
    beforeEach(() => { idb.available = true; idb.store.clear(); localStorage.clear(); });

    it('hydrates points written by another page and migrates the localStorage copy', async () => {
        const legacy = { 'AAPL|1d': { points: { 1000: 10 }, fetchedAt: 1, coverage: { startTs: 0, endTs: 2 } } };
        localStorage.setItem('historicalPointStore_v2', JSON.stringify(legacy));
        idb.store.set('historicalPointStore_v2', {
            'MSFT|1d': { points: { 2000: 20 }, fetchedAt: 2, coverage: { startTs: 1, endTs: 3 } }
        });

        const store = new HistoricalPointStore();
        await store.ready;
        expect(store.getKnownPoints('AAPL', '1d', 0, 2)).toEqual({ 1000: 10 });
        expect(store.getKnownPoints('MSFT', '1d', 1, 3)).toEqual({ 2000: 20 });
        expect(localStorage.getItem('historicalPointStore_v2')).toBeNull();

        store.flush();
        await vi.waitFor(() => expect(Object.keys(idb.store.get('historicalPointStore_v2'))).toEqual(
            expect.arrayContaining(['AAPL|1d', 'MSFT|1d'])));
    });
});
