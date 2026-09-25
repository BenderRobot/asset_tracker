// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HistoricalChart } from '../src/historicalChart.js';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

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
            <canvas id="historical-portfolio-chart"></canvas>`;
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
