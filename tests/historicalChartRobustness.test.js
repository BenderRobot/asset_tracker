// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HistoricalChart } from '../src/historicalChart.js';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';
import { getIntervalForPeriod } from '../src/MarketUtils.js';

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
        document.body.innerHTML = `
            <div id="view-toggle"><button class="toggle-btn active" data-view="performance"></button></div>
            <div class="chart-title"><span id="chart-title-text"></span><span id="chart-title-icon"></span></div>
            <div class="dashboard-chart-section">
                <div class="chart-wrapper"><canvas id="historical-portfolio-chart"></canvas><div id="chart-loading"></div></div>
                <div class="chart-stats-bar"></div>
            </div>`;
    });
    afterEach(() => vi.restoreAllMocks());

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
            { labels: ['empty', 'start', 'end'], timestamps: [1, 2, 3], values: [0, 100, 120], invested: [0, 100, 100], twr: [1, 1, 1.2] },
            {}, { mode: 'global', label: 'Portfolio' }, null, null, null,
            { portfolioSnapshot: snapshot, snapshotStartedAt: 1, varTodayAbs: 0, varTodayPct: 0 }
        );

        const config = chart.kpiManager.updateKPIs.mock.calls[0][0];
        expect(config).toMatchObject({ priceStart: 100, priceEnd: 120, priceHigh: 120, priceLow: 100 });
        expect(config.perfAbs).toBeCloseTo(20, 8);
        expect(config.perfPct).toBeCloseTo(20, 8);
    });

    it('coalesces concurrent builds and reuses a completed long-period series', async () => {
        const chart = makeChart();
        const producer = vi.fn(async () => ({ labels: ['x'], values: [1] }));
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

    it('rejects a label-only or fail-closed series instead of painting a zero chart', () => {
        const chart = makeChart();
        chart.currentPeriod = 2;

        expect(chart._hasRenderableFinancialSeries({
            labels: ['a', 'b'], values: [null, null], dataQuality: { valid: true }
        })).toBe(false);
        expect(chart._hasRenderableFinancialSeries({
            labels: ['a', 'b'], values: [100, 101], dataQuality: { valid: false }
        })).toBe(false);
        expect(chart._hasRenderableFinancialSeries({
            labels: ['a', 'b'], values: [100, 101], dataQuality: { valid: true }
        })).toBe(true);
    });

    it('uses 15-minute candles for 2D to keep the request volume bounded', () => {
        expect(getIntervalForPeriod(1)).toBe('5m');
        expect(getIntervalForPeriod(2)).toBe('15m');
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
});

describe('Long-period request plan', () => {
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

        expect(intervals).toEqual(['1wk', '1wk']);
    });
});
