// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HistoricalChart } from '../src/historicalChart.js';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';
import { getIntervalForPeriod } from '../src/MarketUtils.js';
import { createFailedHistoricalResult } from '../src/api.js';

function makeChart() {
    const storage = createFakeStorage();
    const dm = new DataManager(storage, createFakeApi());
    const page = {
        filterManager: { getSelectedTickers: () => new Set() },
        getFilteredPurchasesFromPage: () => [],
        getChartTitleConfig: () => ({ mode: 'global', label: 'Portfolio' }),
        renderData: vi.fn()
    };
    return new HistoricalChart(storage, dm, null, page);
}

describe('Historical chart robustness and cache', () => {
    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = `
            <div id="view-toggle"><button class="toggle-btn active" data-view="performance"></button></div>
            <div class="chart-title"><span id="chart-title-text"></span><span id="chart-title-icon"></span></div>
            <div class="dashboard-chart-section">
                <div class="chart-wrapper"><canvas id="historical-portfolio-chart"></canvas><div id="chart-loading"></div></div>
                <div class="chart-stats-bar"></div>
            </div>
            <div id="chart-info"></div>`;
    });
    afterEach(() => vi.restoreAllMocks());

    function renderPortfolioKpis(chart, graphData, snapshot) {
        chart._renderChartJs = vi.fn();
        chart._syncViewToggle = vi.fn();
        chart._syncReferenceLineToggles = vi.fn();
        chart._renderTitle = vi.fn();
        chart.kpiManager.updateKPIs = vi.fn();
        chart.renderChart(
            document.querySelector('canvas'), graphData,
            {}, { mode: 'global', label: 'Portfolio' }, null, null, null,
            { portfolioSnapshot: snapshot, snapshotStartedAt: 1, varTodayAbs: 0, varTodayPct: 0 }
        );
        return chart.kpiManager.updateKPIs.mock.calls[0][0];
    }

    // HistoryCalculator marks a point before the first investment with null
    // (no valuation), never 0: 0 € is a real value (e.g. a fully sold
    // portfolio without cash) and must count as Start/End when it occurs.
    it('ignores the empty pre-investment point when computing Start/End/High/Low', () => {
        const chart = makeChart();
        chart.currentPeriod = 'all';
        chart._renderChartJs = vi.fn();
        chart._syncViewToggle = vi.fn();
        chart._syncReferenceLineToggles = vi.fn();
        chart._renderTitle = vi.fn();
        chart.kpiManager.updateKPIs = vi.fn();
        const snapshot = {
            status: 'valid', snapshotId: 'test', snapshotStartedAt: 1,
            totalValue: 120, invested: 100, cash: 0, totalReturn: 20,
            totalReturnPct: 20, dayPnl: 0, dayPnlPct: 0, positions: []
        };

        chart.renderChart(
            document.querySelector('canvas'),
            { labels: ['empty', 'start', 'end'], timestamps: [1, 2, 3], values: [null, 100, 120], invested: [null, 100, 100], totalReturn: [null, 0, 20], totalReturnPct: [null, 0, 20], periodPnl: [null, 0, 20], twr: [null, 1, 1.2] },
            {}, { mode: 'global', label: 'Portfolio' }, null, null, null,
            { portfolioSnapshot: snapshot, snapshotStartedAt: 1, varTodayAbs: 0, varTodayPct: 0 }
        );

        const config = chart.kpiManager.updateKPIs.mock.calls[0][0];
        expect(config).toMatchObject({ priceStart: 100, priceEnd: 120, priceHigh: 120, priceLow: 100 });
        expect(config.perfAbs).toBeCloseTo(20, 8);
        expect(config.perfPct).toBeCloseTo(20, 8);
    });

    it('keeps a real 0 € valuation as the End of a fully sold portfolio', () => {
        const config = renderPortfolioKpis(makeChart(), {
            labels: ['start', 'peak', 'sold'], timestamps: [1, 2, 3], values: [100, 120, 0],
            invested: [100, 100, 0], totalReturn: [0, 20, 0], totalReturnPct: [0, 20, 0], twr: [1, 1.2, 1.2]
        }, {
            status: 'valid', snapshotId: 'sold', snapshotStartedAt: 1, totalValue: 0, invested: 0, cash: 0,
            totalReturn: 0, totalReturnPct: 0, dayPnl: 0, dayPnlPct: 0, positions: []
        });
        expect(config).toMatchObject({ priceStart: 100, priceHigh: 120, priceLow: 0 });
        expect(config.priceEnd).toBe(0);
    });

    it('keeps a fully liquidated portfolio with real cash valid end to end', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-26T10:00:00Z'));
        try {
            const timestamp = date => new Date(`${date}T12:00:00Z`).getTime();
            const flatHistory = Object.fromEntries(
                ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'].map(date => [timestamp(date), 100])
            );
            const storage = createFakeStorage({ conversionRate: 1 });
            const dm = new DataManager(storage, createFakeApi({
                async getHistoricalPricesWithRetry() { return flatHistory; }
            }));
            const graph = await dm.calculateHistory([
                purchase({ date: '2026-09-22', price: 100 }),
                purchase({ date: '2026-09-24', price: 100, quantity: -1 }),
                purchase({ date: '2026-09-24', ticker: 'EUR', assetType: 'Cash', price: 100 })
            ], 'all');
            const view = new HistoricalChart(storage, dm, null, {
                filterManager: { getSelectedTickers: () => new Set() },
                getFilteredPurchasesFromPage: () => [],
                getChartTitleConfig: () => ({ mode: 'global', label: 'Portfolio' }),
                renderData: vi.fn()
            });

            expect(graph.dataQuality.valid).toBe(true);
            expect(graph.values.at(-1)).toBe(100);
            expect(graph.twr.at(-1)).toBe(1);
            expect(view._isValidHistoryData(graph)).toBe(true);
            view.destroy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses the portfolio timestamps as the exact benchmark request window', () => {
        const chart = makeChart();
        const startMs = Date.parse('2026-09-01T00:00:00Z');
        const endMs = Date.parse('2026-09-30T12:34:56.250Z');

        expect(chart._getBenchmarkWindow({ timestamps: [startMs, endMs] })).toEqual({
            startTs: Math.floor(startMs / 1000),
            endTs: Math.ceil(endMs / 1000) + 1
        });
        expect(chart._getBenchmarkWindow({ timestamps: [] })).toBeNull();
    });

    it('leaves a gap before the first real benchmark observation', () => {
        const chart = makeChart();
        const day = 86400000;
        const start = Date.parse('2026-09-01T00:00:00Z');
        const timestamps = [start, start + day, start + 2 * day, start + 3 * day];
        const benchmark = {
            [start + 2 * day]: 100,
            [start + 3 * day]: 110
        };

        expect(chart._buildBenchmarkPerformanceSeries(benchmark, timestamps, 0)).toEqual([
            null, null, 0, 10
        ]);
    });

    it('carries only past benchmark observations forward after a causal baseline', () => {
        const chart = makeChart();
        const day = 86400000;
        const start = Date.parse('2026-09-01T00:00:00Z');
        const timestamps = [start, start + day, start + 2 * day];
        const benchmark = {
            [start]: 100,
            [start + 2 * day]: 120
        };

        const series = chart._buildBenchmarkPerformanceSeries(benchmark, timestamps, 0);
        expect(series[0]).toBe(0);
        expect(series[1]).toBe(0);
        expect(series[2]).toBeCloseTo(20, 8);
    });

    it('coalesces concurrent builds and reuses a completed long-period series', async () => {
        const chart = makeChart();
        const producer = vi.fn(async () => ({ labels: ['x'], values: [1], twr: [1] }));
        const rows = [purchase({ ticker: 'AAPL' })];

        const [a, b] = await Promise.all([
            chart._getCachedHistory('portfolio', rows, 'all', producer),
            chart._getCachedHistory('portfolio', rows, 'all', producer)
        ]);
        const c = await chart._getCachedHistory('portfolio', rows, 'all', producer);

        expect(producer).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
        expect(c).toBe(a);
    });

    it('rejects a truncated portfolio series whose final valuation is missing', () => {
        const chart = makeChart();
        expect(chart._isValidHistoryData({
            labels: ['start', 'end'], values: [100, null], twr: [1, null],
            dataQuality: { valid: true }
        })).toBe(false);
        expect(chart._isValidHistoryData({
            labels: ['start', 'end'], values: [100, 110], twr: [1, 1.1],
            dataQuality: { valid: true }
        })).toBe(true);
    });

    it('defaults to price-only return and enables dividends only through the explicit toggle', () => {
        const chart = makeChart();
        chart.update = vi.fn();
        chart._syncViewToggle(false, false);
        chart._syncDividendToggle(false, false);

        const button = document.querySelector('#dividend-return-toggle [data-option="dividends"]');
        expect(chart.includeDividends).toBe(false);
        expect(button.classList.contains('active')).toBe(false);

        button.click();
        expect(chart.includeDividends).toBe(true);
        expect(button.classList.contains('active')).toBe(true);
        expect(localStorage.getItem('chart_include_dividends')).toBe('1');
    });

    it('plots broker-comparable TWR while keeping the position return in its own KPI', () => {
        const chart = makeChart();
        chart.currentPeriod = 'all';
        const graphData = {
            totalReturn: [0, -93.24, 8238.02],
            totalReturnPct: [0, -0.57, 29.23],
            totalReturnWithDividends: [0, -80, 8300],
            totalReturnPctWithDividends: [0, -0.49, 29.45],
            twr: [1, 0.94, 1.35],
            twrWithDividends: [1, 0.95, 1.36]
        };

        const priceOnly = chart._getPortfolioPerformanceSeries(graphData);
        expect(priceOnly[0]).toBe(0);
        expect(priceOnly[1]).toBeCloseTo(-6, 8);
        expect(priceOnly[2]).toBeCloseTo(35, 8);
        expect(chart._getPortfolioReturnSeries(graphData)).toEqual([0, -93.24, 8238.02]);
        expect(chart._getPortfolioPerformanceSeries(graphData).at(-1)).not.toBe(29.23);

        // The dividend toggle changes the period performance only. Total
        // Return stays the unrealised gain of the positions, the same
        // definition as the live KPI (audit 2026-09-28, points 3 and 5).
        chart.includeDividends = true;
        expect(chart._getPortfolioPerformanceSeries(graphData).at(-1)).toBeCloseTo(36, 8);
        expect(chart._getPortfolioReturnSeries(graphData)).toEqual([0, -93.24, 8238.02]);
    });

    it('persists a validated complete graph and restores it without rebuilding', async () => {
        const rows = [purchase({ ticker: 'AAPL' })];
        const data = {
            labels: ['a', 'b'], timestamps: [1, 2], values: [100, 110], twr: [1, 1.1],
            dataQuality: { valid: true, failedInstruments: [] }
        };
        const first = makeChart();
        const firstProducer = vi.fn(async () => data);
        await first._getCachedHistory('portfolio', rows, 180, firstProducer);

        const restored = makeChart();
        const secondProducer = vi.fn(async () => { throw new Error('must not rebuild'); });
        const result = await restored._getCachedHistory('portfolio', rows, 180, secondProducer);

        expect(firstProducer).toHaveBeenCalledTimes(1);
        expect(secondProducer).not.toHaveBeenCalled();
        expect(result.values).toEqual([100, 110]);
    });

    it('serves a stale validated graph immediately and swaps only after a complete refresh', async () => {
        const rows = [purchase({ ticker: 'AAPL' })];
        const oldData = {
            labels: ['old-a', 'old-b'], timestamps: [1, 2], values: [100, 105], twr: [1, 1.05],
            dataQuality: { valid: true, failedInstruments: [] }
        };
        const newData = {
            labels: ['new-a', 'new-b'], timestamps: [3, 4], values: [110, 120], twr: [1, 1.09],
            dataQuality: { valid: true, failedInstruments: [] }
        };
        const seed = makeChart();
        await seed._getCachedHistory('portfolio', rows, 2, async () => oldData);
        const storageKey = seed._historyStorageKey();
        const persisted = JSON.parse(localStorage.getItem(storageKey));
        // Built on a previous civil day: stale whatever the market hours are
        // (within the same day, freshness also depends on market sessions).
        Object.values(persisted)[0].createdAt = Date.now() - 2 * 86_400_000;
        localStorage.setItem(storageKey, JSON.stringify(persisted));

        let release;
        const refresh = new Promise(resolve => { release = () => resolve(newData); });
        const restored = makeChart();
        restored.currentPeriod = 2;
        restored.update = vi.fn();
        const immediate = await restored._getCachedHistory('portfolio', rows, 2, () => refresh);
        expect(immediate.values).toEqual([100, 105]);
        expect(restored.update).not.toHaveBeenCalled();

        release();
        await vi.waitFor(() => expect(restored.update).toHaveBeenCalledTimes(1));
        const refreshed = await restored._getCachedHistory('portfolio', rows, 2, vi.fn());
        expect(refreshed.values).toEqual([110, 120]);
    });

    it('keeps 2D on the existing five-minute cache family', () => {
        expect(getIntervalForPeriod(1)).toBe('5m');
        expect(getIntervalForPeriod(2)).toBe('5m');
    });

    it('keeps the loader visible and never paints a superseded period', async () => {
        const chart = makeChart();
        const dm = chart.dataManager;
        let releaseFirst;
        const first = new Promise(resolve => { releaseFirst = resolve; });
        const portfolioSnapshot = {
            status: 'valid', snapshotId: 'snap', snapshotStartedAt: 1, generatedAt: 1,
            totalValue: 100, invested: 100, cash: 0, totalReturn: 0,
            totalReturnPct: 0, dayPnl: 0, dayPnlPct: 0, positions: []
        };
        const engine = {
            todayGraphData: { labels: ['today'], timestamps: [1], values: [100], invested: [100], twr: [1] },
            holdings: [], summary: {}, cashReserve: { total: 0 }, portfolioSnapshot
        };
        dm.repository.getSnapshot = vi.fn()
            .mockImplementationOnce(() => first)
            .mockResolvedValue({ snapshot: { generatedAt: 1, portfolioSnapshot, _engine: engine }, previousSession: false });
        dm.calculateHistory = vi.fn().mockResolvedValue({
            labels: ['6m-a', '6m-b'], timestamps: [2, 3], values: [110, 120], invested: [100, 100], twr: [1.1, 1.2], dataQuality: { valid: true }
        });
        chart.renderChart = vi.fn();

        const initialUpdate = chart.update(true, false);
        await chart.changePeriod(180);
        expect(document.getElementById('chart-loading').style.display).toBe('flex');
        expect(document.querySelector('canvas').style.visibility).toBe('hidden');

        releaseFirst({ snapshot: { generatedAt: 1, portfolioSnapshot, _engine: engine }, previousSession: false });
        await initialUpdate;
        await vi.waitFor(() => expect(chart.renderChart).toHaveBeenCalledTimes(1));

        expect(chart.currentPeriod).toBe(180);
        expect(chart.renderChart.mock.calls[0][1].labels).toEqual(['6m-a', '6m-b']);
        expect(document.getElementById('chart-loading').style.display).toBe('none');
        expect(document.querySelector('canvas').style.visibility).toBe('visible');
    });

    it('keeps the last validated chart visible when a refresh is invalid', async () => {
        const chart = makeChart();
        const dm = chart.dataManager;
        chart.currentPeriod = 7;
        const todayGraphData = { labels: ['today'], timestamps: [1], values: [100], twr: [1] };
        dm.repository.getSnapshot = vi.fn().mockResolvedValue({
            snapshot: {
                generatedAt: Date.now(),
                _engine: {
                    todayGraphData,
                    holdings: [],
                    summary: {},
                    cashReserve: { total: 0 },
                    portfolioSnapshot: {}
                }
            },
            previousSession: false
        });
        dm.calculateHistory = vi.fn().mockResolvedValue({
            labels: ['missing'], values: [null], twr: [null],
            dataQuality: { valid: false }
        });
        const existing = { destroy: vi.fn() };
        chart.chart = existing;

        await chart.update(true, false);

        expect(chart.chart).toBe(existing);
        expect(document.getElementById('chart-info').textContent).toContain('est conservé');
        expect(document.querySelector('canvas').style.visibility).toBe('visible');
        expect(document.querySelector('.chart-stats-bar').style.visibility).toBe('visible');
    });
});

describe('Long-period request plan', () => {
    it.each([
        [2, 2], [180, 180], [730, 730], ['all', 3650]
    ])('requests the real index horizon for %s', async (period, expectedDays) => {
        let request = null;
        const api = createFakeApi({
            async getHistoricalPricesWithRetry(_ticker, start, end, interval) {
                request = { start, end, interval };
                return {};
            }
        });
        const dm = new DataManager(createFakeStorage(), api);
        await dm.calculateIndexData('^GSPC', period);

        const actualDays = (request.end - request.start) / 86400;
        expect(actualDays).toBeCloseTo(expectedDays, period === 2 ? 0 : 1);
        expect(request.interval).toBe(getIntervalForPeriod(period));
    });

    it('keeps index timestamps aligned with long-period values', async () => {
        const timestamps = [
            Date.parse('2026-09-22T16:00:00Z'),
            Date.parse('2026-09-25T16:00:00Z')
        ];
        const history = Object.fromEntries(timestamps.map((timestamp, index) => [timestamp, 100 + index * 10]));
        const dm = new DataManager(createFakeStorage(), createFakeApi({
            async getHistoricalPricesWithRetry() { return history; }
        }));

        const graph = await dm.calculateIndexData('^GSPC', 30);

        expect(graph.timestamps).toEqual(timestamps);
        expect(graph.values).toEqual([100, 110]);
        expect(graph.labels).toHaveLength(graph.timestamps.length);
    });

    it('recovers a failed 90m ticker with real daily candles without invalidating the portfolio', async () => {
        const calls = [];
        const now = Date.now();
        const api = createFakeApi({
            async getHistoricalPricesWithRetry(ticker, start, end, interval) {
                calls.push([ticker, interval]);
                if (ticker === 'AAPL' && interval === '90m') return createFailedHistoricalResult();
                return { [now - 86400000]: ticker === 'AAPL' ? 100 : 50, [now]: ticker === 'AAPL' ? 101 : 51 };
            }
        });
        const storage = createFakeStorage({
            prices: {
                AAPL: { price: 101, previousClose: 100, currency: 'EUR', lastUpdate: now },
                MSFT: { price: 51, previousClose: 50, currency: 'EUR', lastUpdate: now }
            }
        });
        const dm = new DataManager(storage, api);

        const result = await dm.calculateHistory([
            purchase({ ticker: 'AAPL', date: '2024-01-01' }),
            purchase({ ticker: 'MSFT', date: '2024-01-01' })
        ], 30);

        expect(calls).toContainEqual(['AAPL', '90m']);
        expect(calls).toContainEqual(['AAPL', '1d']);
        expect(result.dataQuality.valid).toBe(true);
        expect(result.dataQuality.recoveredInstruments).toEqual({ AAPL: '1d' });
        expect(result.values.some(Number.isFinite)).toBe(true);
    });

    it('does not multiply requests with an interval fallback after a 429', async () => {
        const calls = [];
        const api = createFakeApi({
            async getHistoricalPricesWithRetry(ticker, _start, _end, interval) {
                calls.push([ticker, interval]);
                return createFailedHistoricalResult({ status: 429, retryAfterMs: 61_000 });
            }
        });
        const dm = new DataManager(createFakeStorage({ conversionRate: 1 }), api);

        const result = await dm.calculateHistory([
            purchase({ ticker: 'AAPL', date: '2024-01-01' })
        ], 30);

        expect(calls).toEqual([['AAPL', '90m']]);
        expect(result.dataQuality).toMatchObject({
            valid: false,
            reason: 'RATE_LIMITED',
            retryable: true,
            retryAfterMs: 61_000,
            failedInstruments: ['AAPL']
        });
    });

    it('reuses the buffered intraday candles for 2D anchors without daily refetches', async () => {
        const intervals = [];
        const api = createFakeApi({
            async getHistoricalPricesWithRetry(ticker, start, end, interval) {
                intervals.push(interval);
                const now = Date.now();
                return { [now - 86400000]: ticker === 'AAPL' ? 100 : 50, [now]: ticker === 'AAPL' ? 101 : 51 };
            }
        });
        const storage = createFakeStorage({
            prices: {
                AAPL: { price: 101, previousClose: 100, currency: 'EUR', lastUpdate: Date.now() },
                MSFT: { price: 51, previousClose: 50, currency: 'EUR', lastUpdate: Date.now() }
            }
        });
        const dm = new DataManager(storage, api);

        await dm.calculateHistory([
            purchase({ ticker: 'AAPL', date: '2024-01-01' }),
            purchase({ ticker: 'MSFT', date: '2024-01-01' })
        ], 2);

        expect(intervals).toEqual(['5m', '5m']);
    });

    it('does not issue per-ticker daily close requests for All', async () => {
        const intervals = [];
        const api = createFakeApi({
            async getHistoricalPricesWithRetry(ticker, start, end, interval) {
                intervals.push(interval);
                const ts = Date.now() - 7 * 86400000;
                return { [ts]: ticker === 'AAPL' ? 120 : 60 };
            }
        });
        const storage = createFakeStorage({
            prices: {
                AAPL: { price: 120, previousClose: 118, currency: 'EUR', lastUpdate: Date.now() },
                MSFT: { price: 60, previousClose: 59, currency: 'EUR', lastUpdate: Date.now() }
            }
        });
        const dm = new DataManager(storage, api);

        await dm.calculateHistory([
            purchase({ ticker: 'AAPL', date: '2024-01-01' }),
            purchase({ ticker: 'MSFT', date: '2024-01-01' })
        ], 'all');

        expect(intervals).toEqual(['1d', '1d']);
    });
});
