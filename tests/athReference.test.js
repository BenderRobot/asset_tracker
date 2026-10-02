// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HistoricalChart } from '../src/historicalChart.js';
import { DataManager, computeAthReference } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

describe('computeAthReference (engine)', () => {
    it('price: all-time maximum of the unit price', () => {
        const ath = computeAthReference({
            kind: 'price',
            allHistory: { unitPrices: [10, 42, 30] },
            visibleHistory: { unitPrices: [30, 31] }
        });
        expect(ath).toEqual({ kind: 'price', value: 42, at: { source: 'all', index: 1 }, fromAthPct: expect.closeTo((31 / 42 - 1) * 100, 8) });
    });

    it('price: an intraday/live high above every daily close becomes the ATH', () => {
        const ath = computeAthReference({
            kind: 'price',
            allHistory: { unitPrices: [10, 42, 40] },
            visibleHistory: { unitPrices: [40, 43.5, null] }
        });
        expect(ath.value).toBe(43.5);
    });

    it('fails closed on a series rejected by data quality', () => {
        expect(computeAthReference({
            kind: 'price',
            allHistory: { unitPrices: [10, 99], dataQuality: { valid: false } },
            visibleHistory: { unitPrices: [10] }
        })).toBeNull();
    });

    it('never computes an ATH on a € value series', () => {
        expect(computeAthReference({
            kind: 'value',
            allHistory: { values: [100, 200] },
            visibleHistory: { values: [200] }
        })).toBeNull();
    });

    it('performance: rebases the all-time TWR high from the two terminal observations', () => {
        // All-time: +50 % peak, then back to +20 %, then +32 %.
        // Visible window starts at ts=3 (index 1.2), so its curve reads 0 % → +10 %.
        const ath = computeAthReference({
            kind: 'performance',
            allHistory: { timestamps: [1, 2, 3, 4], twr: [1, 1.5, 1.2, 1.32] },
            visibleHistory: { timestamps: [3, 4], twr: [1, 1.1] }
        });
        // 1.5 / 1.2 - 1 = +25 % in the visible window's frame.
        expect(ath.value).toBeCloseTo(25, 8);
    });

    it('performance: follows the dividends toggle', () => {
        const history = {
            allHistory: { timestamps: [1, 2], twr: [1, 1.1], twrWithDividends: [1, 1.3] },
            visibleHistory: { timestamps: [1, 2], twr: [1, 1.1], twrWithDividends: [1, 1.3] }
        };
        expect(computeAthReference({ kind: 'performance', ...history }).value).toBeCloseTo(10, 8);
        expect(computeAthReference({ kind: 'performance', ...history, includeDividends: true }).value).toBeCloseTo(30, 8);
    });

    it('performance: intraday window without a shared timestamp preserves the canonical ATH gap', () => {
        const ath = computeAthReference({
            kind: 'performance',
            allHistory: { timestamps: [100, 200, 300], twr: [1, 1.5, 1.2] },
            visibleHistory: { timestamps: [350, 360], twr: [1, 1.02] }
        });
        expect(ath.value).toBeCloseTo(27.5, 8);
        expect(ath.fromAthPct).toBeCloseTo(-20, 8);
    });

    it('performance: locates the ATH point and the gap of the last point', () => {
        const ath = computeAthReference({
            kind: 'performance',
            allHistory: { timestamps: [1, 2, 3, 4], twr: [1, 1.5, 1.2, 1.32] },
            visibleHistory: { timestamps: [3, 4], twr: [1, 1.1] }
        });
        expect(ath.at).toEqual({ source: 'all', index: 1 });
        // Last point is index 1.32 vs peak 1.5 → -12 %.
        expect(ath.fromAthPct).toBeCloseTo((1.32 / 1.5 - 1) * 100, 8);
    });

    it('performance: the refreshed 1D session immediately crosses a stale cached ATH', () => {
        const ath = computeAthReference({
            kind: 'performance',
            // The cached All series still ends on a provisional +49.5% point.
            // Yesterday's canonical close was +49%; today then gains 2%.
            allHistory: {
                // The normalized previous daily bar can be timestamped after
                // portfolio-local midnight, so sessionDates owns the boundary.
                timestamps: [0, 50, 210, 250],
                sessionDates: ['2026-09-30', '2026-10-01', '2026-10-01', '2026-10-02'],
                twr: [1, 1.5, 1.49, 1.495]
            },
            visibleHistory: {
                timestamps: [200, 300],
                twr: [1, 1.02]
            },
            stitchLiveSession: true,
            liveSessionDate: '2026-10-02'
        });

        // 1.49 * 1.02 = 1.5198: today's live point is the new canonical ATH.
        expect(ath.value).toBeCloseTo(2, 8);
        expect(ath.fromAthPct).toBeCloseTo(0, 8);
        expect(ath.at).toEqual({ source: 'visible', index: 1 });
    });

    it('performance: keeps an intraday ATH after the live session pulls back', () => {
        const ath = computeAthReference({
            kind: 'performance',
            allHistory: {
                timestamps: [0, 100, 250],
                sessionDates: ['2026-09-30', '2026-10-01', '2026-10-02'],
                twr: [1, 1.49, 1.495]
            },
            visibleHistory: {
                timestamps: [200, 260, 300],
                twr: [1, 1.03, 1.02]
            },
            stitchLiveSession: true,
            liveSessionDate: '2026-10-02'
        });

        expect(ath.at).toEqual({ source: 'visible', index: 1 });
        expect(ath.fromAthPct).toBeCloseTo((1.02 / 1.03 - 1) * 100, 8);
    });

    it('price: an intraday high is located in the visible series', () => {
        const ath = computeAthReference({
            kind: 'price',
            allHistory: { unitPrices: [10, 42, 40] },
            visibleHistory: { unitPrices: [40, 43.5, 43.5] }
        });
        expect(ath.at).toEqual({ source: 'visible', index: 1 });
        expect(ath.fromAthPct).toBeCloseTo(0, 8);
    });

    it('performance: a short-window local high never replaces the canonical all-time point', () => {
        const ath = computeAthReference({
            kind: 'performance',
            // Canonical peak at timestamp 200. The 1M/intraday series has a
            // slightly higher local maximum after rebasing, but it must not
            // change the ATH date/value shown in the stats bar.
            allHistory: { timestamps: [100, 200, 300], twr: [1, 1.5, 1.2] },
            visibleHistory: { timestamps: [300, 400], twr: [1, 1.3] }
        });
        expect(ath.value).toBeCloseTo(62.5, 8);
        expect(ath.at).toEqual({ source: 'all', index: 1 });
        expect(ath.fromAthPct).toBeCloseTo((1.2 / 1.5 - 1) * 100, 8);
    });

    it('performance: 1M rounding drift cannot put the ATH line below the current point', () => {
        const ath = computeAthReference({
            kind: 'performance',
            // Values matching the reported case: All is +38.62% now with an
            // ATH at +39.91%, while the 1M curve ends at +3.83%.
            allHistory: { timestamps: [1, 2, 3], twr: [1, 1.3991, 1.3862] },
            visibleHistory: { timestamps: [10, 11, 12], twr: [1, 1.0417, 1.0383] }
        });
        expect(ath.value).toBeCloseTo(4.7962436878, 8);
        expect(ath.value).toBeGreaterThan(3.83);
        expect(ath.at).toEqual({ source: 'all', index: 1 });
        expect(ath.fromAthPct).toBeCloseTo(-0.9220212994, 8);
    });
});

function makeChart() {
    const storage = createFakeStorage();
    const dm = new DataManager(storage, createFakeApi());
    const page = {
        filterManager: { getSelectedTickers: () => new Set() },
        getFilteredPurchasesFromPage: () => [],
        getChartTitleConfig: () => ({ mode: 'global', label: 'Portfolio' }),
        renderData: vi.fn()
    };
    const chart = new HistoricalChart(storage, dm, null, page);
    chart._renderChartJs = vi.fn();
    chart._syncViewToggle = vi.fn();
    chart._renderTitle = vi.fn();
    chart.kpiManager.updateKPIs = vi.fn();
    return chart;
}

const snapshot = {
    status: 'valid', snapshotId: 'ath', snapshotStartedAt: 1,
    totalValue: 120, invested: 100, cash: 0, totalReturn: 20,
    totalReturnPct: 20, dayPnl: 0, dayPnlPct: 0, positions: []
};
const kpiData = { portfolioSnapshot: snapshot, snapshotStartedAt: 1, varTodayAbs: 0, varTodayPct: 0 };
const graph = () => ({
    labels: ['a', 'b', 'c'], timestamps: [1, 2, 3], values: [100, 150, 120],
    invested: [100, 100, 100], totalReturn: [0, 50, 20], totalReturnPct: [0, 50, 20], twr: [1, 1.5, 1.2]
});
const render = (chart, graphData, athSource) => chart.renderChart(
    document.querySelector('canvas'), graphData, {}, { mode: 'global', label: 'Portfolio' },
    null, null, null, kpiData, athSource
);
const athArg = (chart) => chart._renderChartJs.mock.calls.at(-1)[15];
const athButton = () => document.querySelector('[data-refline="ath"]');

describe('HistoricalChart ATH line', () => {
    beforeEach(() => {
        localStorage.clear();
        localStorage.setItem('chart_refline_ath', '1');
        document.body.innerHTML = `
            <div><div id="view-toggle"><button class="toggle-btn active" data-view="performance"></button></div></div>
            <div class="dashboard-chart-section">
                <div class="chart-wrapper"><canvas id="historical-portfolio-chart"></canvas><div id="chart-loading"></div></div>
                <div class="chart-stats-bar"></div>
            </div>`;
    });
    afterEach(() => vi.restoreAllMocks());

    it('is hidden and never resolved in the € value view', () => {
        document.querySelector('#view-toggle .toggle-btn').dataset.view = 'global';
        const chart = makeChart();
        chart.currentPeriod = 30;
        const producer = vi.fn();

        render(chart, graph(), { scope: 'portfolio', purchases: [], producer });

        expect(athButton().style.display).toBe('none');
        expect(athArg(chart)).toBeNull();
        expect(producer).not.toHaveBeenCalled();
    });

    it('performance view on "all": uses the displayed series directly', () => {
        const chart = makeChart();
        chart.currentPeriod = 'all';
        const producer = vi.fn();

        render(chart, graph(), { scope: 'portfolio', purchases: [], producer });

        expect(athButton().style.display).toBe('');
        expect(athArg(chart)).toMatchObject({ value: expect.closeTo(50, 8), label: 'ATH +50.00%' });
        // Stats bar: values read at the ATH point (index 1 of the displayed series).
        expect(athArg(chart).details).toMatchObject({
            kind: 'performance', timestamp: 2, totalValue: 150, totalReturn: 50, totalReturnPct: 50,
            fromAthPct: expect.closeTo((1.2 / 1.5 - 1) * 100, 8)
        });
        expect(producer).not.toHaveBeenCalled();
    });

    it('cold cache: renders immediately without ATH, then repaints once the all-time history is committed', async () => {
        const chart = makeChart();
        chart.currentPeriod = 30;
        chart.update = vi.fn();
        let resolveAll;
        const producer = vi.fn(() => new Promise(r => { resolveAll = r; }));
        const source = { scope: 'portfolio', purchases: [purchase({ ticker: 'AAPL' })], producer };

        render(chart, graph(), source);
        expect(athArg(chart)).toBeNull();
        expect(producer).toHaveBeenCalledTimes(1);

        resolveAll({ labels: ['x', 'y', 'z'], timestamps: [0, 1, 3], values: [50, 60, 120], twr: [1, 2, 1.2] });
        await vi.waitFor(() => expect(chart.update).toHaveBeenCalledWith(false, false));

        render(chart, graph(), source);
        // All-time peak 2.0 seen from a window where ts=3 is 1.2 → 2 / 1.2 * 1.2 - 1 = +100 %.
        expect(athArg(chart).value).toBeCloseTo(100, 8);
        expect(producer).toHaveBeenCalledTimes(1);
    });

    it('a market refresh rebuilds a fresh cached ATH and detects a new live high', async () => {
        const chart = makeChart();
        chart.currentPeriod = 1;
        chart.update = vi.fn();
        const rows = [purchase({ ticker: 'AAPL' })];
        const key = chart._historyKey('portfolio', rows, 'all');
        const oldAll = {
            labels: ['x', 'y', 'z'], timestamps: [1, 2, 3],
            values: [100, 150, 120], totalReturn: [0, 50, 20], totalReturnPct: [0, 50, 20],
            twr: [1, 1.5, 1.2]
        };
        chart._commitHistory(key, oldAll, 'all');

        const freshAll = {
            labels: ['x', 'y', 'now'], timestamps: [1, 2, 4],
            values: [100, 150, 160], totalReturn: [0, 50, 60], totalReturnPct: [0, 50, 60],
            twr: [1, 1.5, 1.53]
        };
        const producer = vi.fn(async () => freshAll);
        const source = { scope: 'portfolio', purchases: rows, producer };
        const liveGraph = {
            labels: ['open', 'now'], timestamps: [3, 4], values: [120, 160],
            invested: [100, 100], totalReturn: [20, 60], totalReturnPct: [20, 60],
            twr: [1, 1.02]
        };

        render(chart, liveGraph, source);
        expect(athArg(chart).details).toMatchObject({
            timestamp: 4, totalValue: 160,
            fromAthPct: expect.closeTo(0, 8)
        });

        await chart._refreshAthHistory(source);
        await Promise.resolve();
        render(chart, liveGraph, source);

        expect(producer).toHaveBeenCalledTimes(1);
        expect(chart.update).toHaveBeenCalledWith(false, false);
        expect(athArg(chart).details).toMatchObject({
            timestamp: 4, totalValue: 160, totalReturn: 60,
            fromAthPct: expect.closeTo(0, 8)
        });
    });

    it('an invalid all-time history is neither drawn nor retried in a loop', async () => {
        const chart = makeChart();
        chart.currentPeriod = 30;
        chart.update = vi.fn();
        const producer = vi.fn(async () => ({ labels: ['x'], values: [1], twr: [1], dataQuality: { valid: false } }));
        const source = { scope: 'portfolio', purchases: [], producer };

        render(chart, graph(), source);
        await vi.waitFor(() => expect(chart._athFailedAt.size).toBe(1));
        render(chart, graph(), source);

        // One repaint to clear the waiting render's loading block — no loop.
        expect(chart.update).toHaveBeenCalledTimes(1);
        expect(athArg(chart)).toBeNull();
        expect(producer).toHaveBeenCalledTimes(1);
    });

    it('prefetch starts the all-time build before any render, and a render that finds it ready needs no repaint', async () => {
        const chart = makeChart();
        chart.currentPeriod = 30;
        chart.update = vi.fn();
        const producer = vi.fn(async () => ({ labels: ['x', 'y', 'z'], timestamps: [0, 1, 3], values: [50, 60, 120], twr: [1, 2, 1.2] }));
        const source = { scope: 'portfolio', purchases: [purchase({ ticker: 'AAPL' })], producer };

        chart._prefetchAthHistory(source);
        expect(producer).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(chart._athPending.size).toBe(0));

        render(chart, graph(), source);
        expect(athArg(chart).value).toBeCloseTo(100, 8);
        expect(chart.update).not.toHaveBeenCalled();
        expect(producer).toHaveBeenCalledTimes(1);
    });

    it('prefetch is skipped in the € value view', () => {
        document.querySelector('#view-toggle .toggle-btn').dataset.view = 'global';
        const chart = makeChart();
        chart.currentPeriod = 30;
        const producer = vi.fn();

        chart._prefetchAthHistory({ scope: 'portfolio', purchases: [], producer });
        expect(producer).not.toHaveBeenCalled();
    });

    it('a render during the prefetch shows a loading ATH block, then repaints exactly once', async () => {
        const chart = makeChart();
        chart.currentPeriod = 30;
        chart.update = vi.fn();
        chart.kpiManager.updateAthStats = vi.fn();
        let resolveAll;
        const producer = vi.fn(() => new Promise(r => { resolveAll = r; }));
        const source = { scope: 'portfolio', purchases: [purchase({ ticker: 'AAPL' })], producer };

        chart._prefetchAthHistory(source);
        render(chart, graph(), source);
        expect(chart.kpiManager.updateAthStats).toHaveBeenLastCalledWith({ loading: true });

        resolveAll({ labels: ['x', 'y', 'z'], timestamps: [0, 1, 3], values: [50, 60, 120], twr: [1, 2, 1.2] });
        await vi.waitFor(() => expect(chart.update).toHaveBeenCalledTimes(1));
        expect(producer).toHaveBeenCalledTimes(1);
    });
});
