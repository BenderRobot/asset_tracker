// Audit characterization: these assertions document CURRENT defects, not desired
// behavior. Kept outside the regression suite; see audit/chart-generator.md.
// No real network, user data, or deployment is involved.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { HistoryCalculator } from '../src/HistoryCalculator.js';
import { HistoricalChart } from '../src/historicalChart.js';
import { Storage } from '../src/storage.js';
import { PriceAPI, createFailedHistoricalResult } from '../src/api.js';
import { findClosestPrice } from '../src/MarketUtils.js';
import { createFakeStorage, createFakeApi, purchase } from '../tests/helpers.js';

const ts = date => new Date(`${date}T12:00:00Z`).getTime();
const flatHistory = Object.fromEntries(['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'].map(d => [ts(d), 100]));
function manager(history = flatHistory) {
    return new DataManager(createFakeStorage({ conversionRate: 1 }), createFakeApi({
        async getHistoricalPricesWithRetry() { return history; }
    }));
}
function chart(dm = manager()) {
    return new HistoricalChart(dm.storage, dm, null, {
        filterManager: { getSelectedTickers: () => new Set() },
        getFilteredPurchasesFromPage: () => [],
        getChartTitleConfig: () => ({ mode: 'global', label: 'Audit' }),
        renderData: vi.fn()
    });
}

describe('Chart audit — reproducible observations, 2026-09-26', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-26T10:00:00Z'));
        localStorage.clear();
        document.body.innerHTML = '<div class="dashboard-chart-section"><div><canvas id="historical-portfolio-chart"></canvas><div id="chart-loading"></div></div><div id="chart-info"></div><div class="chart-stats-bar"></div></div>';
    });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('A1: rejects the entire series when only the final point is incomplete', () => {
        const view = chart();
        const graph = { labels: ['valid', 'missing'], values: [100, null], twr: [1, null], dataQuality: { valid: true } };
        expect(view._isValidHistoryData(graph)).toBe(false);
        view.destroy();
    });

    it('A1: a fully liquidated portfolio with real cash is rejected after the sale', async () => {
        const dm = manager();
        const graph = await dm.calculateHistory([
            purchase({ date: '2026-09-22', price: 100 }),
            purchase({ date: '2026-09-24', price: 100, quantity: -1 }),
            purchase({ date: '2026-09-24', ticker: 'EUR', assetType: 'Cash', price: 100 })
        ], 'all');
        expect(graph.dataQuality.valid).toBe(true);
        expect(graph.values.at(-1)).toBe(100);
        expect(graph.twr.at(-1)).toBeNull();
        const view = chart(dm);
        expect(view._isValidHistoryData(graph)).toBe(false);
        view.destroy();
    });

    it('A2: the first dividend row suppresses historical requests for an actual stock', async () => {
        const rows = [purchase({ ticker: 'APC', assetType: 'Dividend' }), purchase({ ticker: 'APC', assetType: 'Stock' })];
        const storage = createFakeStorage();
        storage.getAssetType = ticker => Storage.prototype.getAssetType.call({ purchases: rows }, ticker);
        expect(storage.getAssetType('APC')).toBe('Dividend');
        const api = new PriceAPI(storage);
        const fetchHistory = vi.spyOn(api, '_doFetchHistoricalPrices');
        expect(await api.getHistoricalPricesWithRetry('APC', ts('2026-09-22') / 1000, ts('2026-09-25') / 1000, '15m')).toEqual({});
        expect(fetchHistory).not.toHaveBeenCalled();
    });

    it('A3: one unavailable, long-sold instrument invalidates a healthy current week', async () => {
        const dm = new DataManager(createFakeStorage({ conversionRate: 1 }), createFakeApi({
            async getHistoricalPricesWithRetry(ticker) { return ticker === 'OLD' ? createFailedHistoricalResult() : flatHistory; }
        }));
        const graph = await dm.calculateHistory([
            purchase({ ticker: 'OLD', date: '2024-01-01' }),
            purchase({ ticker: 'OLD', date: '2025-01-01', quantity: -1 }),
            purchase({ ticker: 'HELD', date: '2026-09-01' })
        ], 7);
        expect(graph.dataQuality).toMatchObject({ valid: false, failedInstruments: ['OLD'] });
        expect(graph.values.every(v => v === null)).toBe(true);
        expect(graph.twr.some(Number.isFinite)).toBe(true);
    });

    it('A4: calculateHistory discards dividends that calculateGenericHistory handles correctly', async () => {
        const rows = [purchase({ date: '2026-09-22' }), purchase({ date: '2026-09-24', type: 'dividend', assetType: 'Dividend', price: 10 })];
        const dm = manager();
        const direct = await dm.calculateGenericHistory(rows, 'all');
        const routed = await dm.calculateHistory(rows, 'all');
        expect(direct.cash.at(-1)).toBe(10);
        expect(direct.twrWithDividends.at(-1)).toBeCloseTo(1.1);
        expect(routed.cash.at(-1)).toBe(0);
        expect(routed.twrWithDividends.at(-1)).toBe(1);
    });

    it('A5: daily candles are moved to a future end-of-day timestamp', async () => {
        const graph = await manager({ ...flatHistory, [Date.parse('2026-09-26T08:00:00Z')]: 101 })
            .calculateHistory([purchase({ date: '2026-09-01' })], 90);
        expect(graph.timestamps.at(-1)).toBe(Date.parse('2026-09-26T23:59:59.999Z'));
        expect(graph.timestamps.at(-1)).toBeGreaterThan(Date.now());
    });

    it('A6: a crypto valuation can borrow tomorrow\'s price', () => {
        const target = ts('2026-09-24');
        const history = { [target - 23 * 3600000]: 100, [target + 3600000]: 120 };
        expect(findClosestPrice(history, target, '1d', true)).toBe(120);
        expect(findClosestPrice(history, target, '1d', false)).toBe(100);
    });

    it('A7: period euro KPI loses realised gains from partial sales', async () => {
        const dm = manager({ [ts('2026-09-22')]: 100, [ts('2026-09-23')]: 120, [ts('2026-09-24')]: 120, [ts('2026-09-25')]: 132 });
        const graph = await dm.calculateHistory([
            purchase({ date: '2026-09-22', quantity: 2 }),
            purchase({ date: '2026-09-24', quantity: -1, price: 120 })
        ], 'all');
        expect(graph.periodPnl.at(-1)).toBe(52);
        expect(graph.totalReturn.at(-1)).toBe(32);
        const view = chart(dm);
        view.currentPeriod = 'all';
        for (const name of ['_renderChartJs', '_syncViewToggle', '_syncReferenceLineToggles', '_syncDividendToggle', '_renderTitle']) vi.spyOn(view, name).mockImplementation(() => {});
        vi.spyOn(view.kpiManager, 'updateKPIs').mockImplementation(() => {});
        view.renderChart(document.querySelector('canvas'), graph, {}, { mode: 'global' }, null, null, null, {});
        expect(view.kpiManager.updateKPIs.mock.calls[0][0].perfAbs).toBe(32);
        view.destroy();
    });

    it('A8: transaction fallback restores a manual asset but loses its provenance', async () => {
        const dm = manager({});
        const graph = await dm.calculateHistory([purchase({ ticker: 'PRIVATE', date: '2026-09-01', price: 100 })], 7);
        expect(graph.values.every(v => v === 100)).toBe(true);
        expect(graph.dataQuality.valid).toBe(true);
        expect(graph.pointMeta.at(-1).tickerSources.PRIVATE).toBe('valuation');
        expect(graph.pointMeta.some(p => p.tickerSources.PRIVATE === 'transaction')).toBe(false);
    });

    it('A9: an invalid update hides the existing chart despite the conservation message', async () => {
        const dm = manager();
        const view = chart(dm);
        view.currentPeriod = 7;
        const graph = { labels: ['a'], values: [100], twr: [1] };
        vi.spyOn(dm.repository, 'getSnapshot').mockResolvedValue({
            snapshot: { generatedAt: Date.now(), _engine: { todayGraphData: graph, holdings: [], summary: {}, cashReserve: { total: 0 }, portfolioSnapshot: {} } }
        });
        vi.spyOn(dm, 'calculateHistory').mockResolvedValue({ labels: ['a'], values: [null], twr: [null], dataQuality: { valid: false } });
        const existing = { destroy: vi.fn() };
        view.chart = existing;
        await view.update(true, false);
        expect(document.getElementById('chart-info').textContent).toContain('conservé');
        expect(view.chart).toBe(existing);
        expect(document.querySelector('canvas').style.visibility).toBe('hidden');
        view.destroy();
    });

    it('A10: a 2D seed can use today\'s previous close before the historical boundary', () => {
        const calc = new HistoryCalculator(createFakeStorage(), createFakeApi());
        const start = ts('2026-09-24');
        const seeds = calc._seedLastKnownPrices(['AAPL'], new Map([['AAPL', { [start - 3600000]: 100 }]]), { displayStartTs: start }, 2,
            new Map([['AAPL', { previousClose: 120, price: 125 }]]));
        expect(seeds.get('AAPL')).toBe(120);
    });
});
