// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HistoricalChart } from '../src/historicalChart.js';
import { DataManager, computeAthReference, mergeAthIntradayHistory } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

describe('computeAthReference (engine)', () => {
    it('portfolio: the ATH is the visible Total Value high, with its exact plotted percentage', () => {
        const allHistory = {
            timestamps: [Date.parse('2026-10-04T20:00:00Z'), Date.parse('2026-10-05T08:15:00Z')],
            sessionDates: ['2026-10-04', '2026-10-05'],
            values: [37580.49, 37709.73], twr: [1.3, 1.304], twrWithDividends: [1.3, 1.304]
        };
        const visibleHistory = {
            timestamps: [Date.parse('2026-10-05T00:00:00+02:00'),
                Date.parse('2026-10-05T10:15:00+02:00'), Date.parse('2026-10-05T10:29:00+02:00')],
            values: [37603.26, 37715.93, 37714.86],
            twr: [1, 1.003, 1.00297], twrWithDividends: [1, 1.003, 1.00297]
        };
        const reference = computeAthReference({ kind: 'performance', allHistory, visibleHistory,
            includeDividends: true, intraday: true, sessionDate,
            portfolioValue: true });
        expect(reference.at).toEqual({ source: 'visible', index: 1 });
        expect(reference.value).toBeCloseTo(0.3, 8);
        expect(reference.fromAthPct).toBeCloseTo((37714.86 / 37715.93 - 1) * 100, 8);
        expect(reference.atAth).toBe(false);
    });

    it('portfolio: a cash contribution may raise value without creating a return peak', () => {
        const history = { timestamps: [1, 2, 3], values: [100, 150, 200], twr: [1, 1.2, 1.1] };
        const reference = computeAthReference({ kind: 'performance', allHistory: history,
            visibleHistory: history, portfolioValue: true });
        expect(reference.at).toEqual({ source: 'visible', index: 2 });
        expect(reference.value).toBeCloseTo(10, 8);
        expect(reference.atAth).toBe(true);
    });

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
        const allHistory = {
            // The cached All series still ends on a provisional +49.5% point.
            // Yesterday's canonical close was +49%; today then gains 2%.
            // The normalized previous daily bar can be timestamped after
            // portfolio-local midnight, so sessionDates owns the boundary.
            timestamps: [0, 50, 210, 250],
            sessionDates: ['2026-09-30', '2026-10-01', '2026-10-01', '2026-10-02'],
            twr: [1, 1.5, 1.49, 1.495]
        };
        const visibleHistory = { timestamps: [200, 300], values: [149, 151.98], twr: [1, 1.02] };
        const ath = computeAthReference({
            kind: 'performance', visibleHistory,
            allHistory: mergeAthIntradayHistory(allHistory, visibleHistory, null, () => '2026-10-02')
        });

        // 1.49 * 1.02 = 1.5198: today's live point is the new canonical ATH.
        expect(ath.value).toBeCloseTo(2, 8);
        expect(ath.fromAthPct).toBeCloseTo(0, 8);
        expect(ath.at.source).toBe('intraday');
    });

    it('performance: keeps an intraday ATH after the live session pulls back', () => {
        const allHistory = {
            timestamps: [0, 100, 250],
            sessionDates: ['2026-09-30', '2026-10-01', '2026-10-02'],
            twr: [1, 1.49, 1.495]
        };
        const visibleHistory = { timestamps: [200, 260, 300], values: [149, 153.47, 151.98], twr: [1, 1.03, 1.02] };
        const ath = computeAthReference({
            kind: 'performance', visibleHistory,
            allHistory: mergeAthIntradayHistory(allHistory, visibleHistory, null, () => '2026-10-02')
        });

        expect(ath.at.source).toBe('intraday');
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

describe('ATH line visibility when enabled', () => {
    let chart, canvas, context;
    beforeEach(() => {
        document.body.innerHTML = '<div class="chart-wrapper"><canvas></canvas></div>';
        canvas = document.querySelector('canvas');
        context = {
            save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), setLineDash: vi.fn(),
            moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), roundRect: vi.fn(),
            fill: vi.fn(), fillText: vi.fn(), measureText: () => ({ width: 70 })
        };
        vi.spyOn(canvas, 'getContext').mockReturnValue(context);
        vi.stubGlobal('Chart', class {
            constructor(ctx, config) { this.ctx = ctx; this.config = config; }
            destroy() {}
        });
        chart = makeChart();
    });
    afterEach(() => {
        chart._selectionCleanup?.();
        chart.destroy();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    function draw(values, athValue, defaultMax) {
        const graphData = {
            labels: values.map(String), timestamps: values.map((_, i) => i + 1),
            values: values.map(value => 100 + value), twr: values.map(value => 1 + value / 100)
        };
        HistoricalChart.prototype._renderChartJs.call(chart,
            canvas, graphData, graphData.values, true, null, false, false, null,
            '#2ecc71', 100, 0, values.length - 1, { mode: 'global' }, null, 0,
            athValue === null ? null : { value: athValue, label: `ATH +${athValue}%` }
        );
        const config = chart.chart.config;
        const min = Math.min(...values, 0);
        const max = Math.max(defaultMax, config.options.scales.y.suggestedMax ?? defaultMax);
        config.plugins.find(plugin => plugin.id === 'athReference').afterDatasetsDraw({
            ctx: context, chartArea: { left: 50, right: 600, top: 10, bottom: 400 },
            scales: { y: { min, max, getPixelForValue: value => 400 - (value - min) / (max - min) * 390 } }
        });
        return config;
    }

    it.each([
        ['1J with a quiet intraday range', 1, [0, 0.245, 0.14], 0.28, 0.25],
        ['1J at a new ATH', 1, [0, 0.245, 0.28], 0.28, 0.3],
        ['3M', 90, [0, -7.06, 3.76], 4.08, 4],
        ['6M', 180, [0, 8, 19.98], 20.34, 20]
    ])('%s includes the ATH and draws its horizontal line', (_label, period, values, athValue, defaultMax) => {
        chart.currentPeriod = period;
        const config = draw(values, athValue, defaultMax);
        expect(config.options.scales.y.suggestedMax).toBeGreaterThan(athValue);
        expect(context.setLineDash).toHaveBeenCalledWith([4, 5]);
        expect(context.moveTo.mock.calls[0][1]).toBeGreaterThan(10);
        expect(context.lineTo.mock.calls[0][1]).toBeLessThan(400);
        expect(context.fillText.mock.calls[0][0]).not.toContain('▲');
    });

    it('a distant ATH keeps the curve scale and only shows the ▲ badge (issue #16)', () => {
        const config = draw([0, -0.01, 0.03], 2.5, 0.04);
        expect(config.options.scales.y.suggestedMax).toBeUndefined();
        expect(context.moveTo).not.toHaveBeenCalled();
        expect(context.fillText.mock.calls[0][0]).toBe('▲ ATH +2.5%');
    });

    it('the reported 1D view: +0.26% ATH over a 0 → -0.16% curve is not drawn as a line', () => {
        const config = draw([0, 0.01, -0.16, -0.10], 0.26, 0.05);
        expect(config.options.scales.y.suggestedMax).toBeUndefined();
        expect(context.moveTo).not.toHaveBeenCalled();
        expect(context.fillText.mock.calls[0][0]).toContain('▲');
    });

    it('includes the ATH even when all visible observations are identical', () => {
        const config = draw([0, 0, 0], 0.28, 0.25);
        expect(config.options.scales.y.suggestedMax).toBeGreaterThan(0.28);
        expect(context.setLineDash).toHaveBeenCalledWith([4, 5]);
        expect(context.moveTo).toHaveBeenCalled();
        expect(context.fillText.mock.calls[0][0]).not.toContain('▲');
    });

    it('keeps the normal scale and draws no ATH when the reference is disabled', () => {
        const config = draw([0, -7.06, 3.76], null, 4);
        expect(config.options.scales.y.suggestedMax).toBeUndefined();
        expect(context.moveTo).not.toHaveBeenCalled();
        expect(context.fillText).not.toHaveBeenCalled();
    });
});

// Friday's intraday high is above every daily close. Crypto continues to
// trade on Sunday, while exchange-traded holdings remain on Friday's close.
const at = iso => Date.parse(iso);
const sessionDate = timestamp => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(timestamp));
function weekendHistories() {
    const startValue = 37016.42;
    const make = (timestamps, values, base = values[0]) => ({
        labels: timestamps.map(String), timestamps, values,
        invested: values.map(() => 28929.06),
        totalReturn: values.map(value => value - 28929.06),
        totalReturnPct: values.map(value => (value / 28929.06 - 1) * 100),
        twr: values.map(value => value / base),
        twrWithDividends: values.map(value => value / base),
        dataQuality: { valid: true }
    });
    const all = make([
        at('2026-09-30T23:59:59Z'), at('2026-10-01T23:59:59Z'),
        at('2026-10-02T23:59:59Z'), at('2026-10-03T23:59:59Z'), at('2026-10-04T09:00:00Z')
    ], [36000, startValue, 37568, 37568.76, 37580.49]);
    all.sessionDates = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
    const twoDays = make([
        at('2026-10-01T22:00:00Z'), at('2026-10-02T14:20:00Z'),
        at('2026-10-02T21:55:00Z'), at('2026-10-03T21:55:00Z'), at('2026-10-04T09:05:00Z')
    ], [startValue, 37698.44, 37568, 37568.76, 37581.24]);
    const oneDay = make([
        at('2026-10-03T22:00:00Z'), at('2026-10-04T08:30:00Z'), at('2026-10-04T09:05:00Z')
    ], [37568.76, 37582.17, 37581.24]);
    return { all, twoDays, oneDay };
}

describe('ATH across the Friday-to-Sunday boundary', () => {
    it('reconstructs the same weekend ATH from real daily and intraday engine outputs', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-04T11:09:00+02:00'));
        try {
            const daily = {
                AAPL: {
                    [at('2026-09-30T00:00:00Z')]: 36000,
                    [at('2026-10-01T00:00:00Z')]: 36000,
                    [at('2026-10-02T00:00:00Z')]: 36552.34
                },
                'BTC-EUR': {
                    [at('2026-09-30T00:00:00Z')]: 1016.42,
                    [at('2026-10-01T00:00:00Z')]: 1016.42,
                    [at('2026-10-02T00:00:00Z')]: 1016.42,
                    [at('2026-10-03T00:00:00Z')]: 1016.42,
                    [at('2026-10-04T00:00:00Z')]: 1028.9
                }
            };
            const intraday = {
                AAPL: {
                    [at('2026-10-01T19:55:00Z')]: 36000,
                    [at('2026-10-02T14:20:00Z')]: 36682.02,
                    [at('2026-10-02T19:55:00Z')]: 36552.34
                },
                'BTC-EUR': {
                    [at('2026-10-01T21:55:00Z')]: 1016.42,
                    [at('2026-10-02T14:20:00Z')]: 1016.42,
                    [at('2026-10-02T21:55:00Z')]: 1016.42,
                    [at('2026-10-03T21:55:00Z')]: 1016.42,
                    [at('2026-10-04T08:30:00Z')]: 1029.83,
                    [at('2026-10-04T09:05:00Z')]: 1028.9
                }
            };
            const prices = {
                AAPL: { price: 36552.34, previousClose: 36000, currency: 'EUR', lastUpdate: Date.now() },
                'BTC-EUR': { price: 1028.9, previousClose: 1016.42, currency: 'EUR', lastUpdate: Date.now() }
            };
            const dm = new DataManager(createFakeStorage({ prices, conversionRate: 1 }), createFakeApi({
                async getHistoricalPricesWithRetry(ticker, start, end, interval) {
                    return interval === '1d' ? daily[ticker] : intraday[ticker];
                }
            }));
            const purchases = [
                purchase({ ticker: 'AAPL', date: '2026-09-29', price: 36000 }),
                purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', date: '2026-09-29', price: 1016.42 })
            ];
            const [all, two, one] = await Promise.all([
                dm.calculateHistory(purchases, 'all'), dm.calculateHistory(purchases, 2), dm.calculateHistory(purchases, 1)
            ]);
            const shared = dm.mergeAthIntradayHistory(all, two, null, sessionDate);
            const sunday = dm.mergeAthIntradayHistory(shared, one, shared, sessionDate);
            const reference2 = dm.computeAthReference({ kind: 'performance', allHistory: shared, visibleHistory: two });
            const reference1 = dm.computeAthReference({ kind: 'performance', allHistory: sunday, visibleHistory: one });
            expect(shared.athIntraday.values[reference2.at.index]).toBeCloseTo(37698.44, 8);
            expect(sunday.athIntraday.timestamps[reference1.at.index]).toBe(at('2026-10-02T14:20:00Z'));
            expect(reference1.fromAthPct).toBeCloseTo(reference2.fromAthPct, 8);
            expect(reference2.fromAthPct).toBeCloseTo((37581.24 / 37698.44 - 1) * 100, 8);
        } finally { vi.useRealTimers(); }
    });

    it('keeps Friday\'s intraday peak and the same drawdown in 1D and 2D', () => {
        const { all, twoDays, oneDay } = weekendHistories();
        const shared = mergeAthIntradayHistory(all, twoDays, null, sessionDate);
        const dayHistory = mergeAthIntradayHistory(shared, oneDay, shared, sessionDate);
        const two = computeAthReference({ kind: 'performance', allHistory: shared, visibleHistory: twoDays });
        const one = computeAthReference({ kind: 'performance', allHistory: dayHistory, visibleHistory: oneDay });

        expect(shared.athIntraday.values[two.at.index]).toBe(37698.44);
        expect(dayHistory.athIntraday.timestamps[one.at.index]).toBe(at('2026-10-02T14:20:00Z'));
        expect(two.value).toBeCloseTo((37698.44 / 37016.42 - 1) * 100, 8);
        expect(one.value).toBeCloseTo((37698.44 / 37568.76 - 1) * 100, 8);
        expect(two.fromAthPct).toBeCloseTo((37581.24 / 37698.44 - 1) * 100, 8);
        expect(one.fromAthPct).toBeCloseTo(two.fromAthPct, 8);
        expect(one.fromAthPct).toBeLessThan(-0.005);
    });

    it('uses the same terminal index when 1D and 2D chaining differ slightly', () => {
        const { all, twoDays, oneDay } = weekendHistories();
        const shared = mergeAthIntradayHistory(all, twoDays, null, sessionDate);
        const sampled = { ...oneDay, twr: oneDay.twr.map((ratio, index) => index === 0 ? ratio : ratio * 1.00001) };
        const sunday = mergeAthIntradayHistory(shared, sampled, shared, sessionDate);
        const two = computeAthReference({ kind: 'performance', allHistory: shared, visibleHistory: twoDays });
        const one = computeAthReference({ kind: 'performance', allHistory: sunday, visibleHistory: sampled });
        expect(one.fromAthPct).toBeCloseTo(two.fromAthPct, 8);
        expect(sunday.athIntraday.timestamps[one.at.index]).toBe(at('2026-10-02T14:20:00Z'));
    });

    it('keeps Friday\'s record stable across repeated 1D/2D navigation and JSON reloads', () => {
        const { all, twoDays, oneDay } = weekendHistories();
        let shared;
        for (let i = 1; i <= 30; i++) {
            const visible = { ...(i % 2 ? twoDays : oneDay), calculatedAt: i };
            shared = mergeAthIntradayHistory(all, visible, shared, sessionDate);
            const ath = computeAthReference({ kind: 'performance', allHistory: shared, visibleHistory: visible,
                intraday: true, sessionDate, includeDividends: i % 3 === 0 });
            expect(shared.athIntraday.values[ath.at.index]).toBe(37698.44);
            expect(ath.value).toBeCloseTo((37698.44 / visible.values[0] - 1) * 100, 10);
            expect(ath.fromAthPct).toBeCloseTo((37581.24 / 37698.44 - 1) * 100, 10);
            shared = JSON.parse(JSON.stringify(shared));
        }
    });

    it('retains Friday\'s peak when Monday\'s history no longer contains it', () => {
        const { all, twoDays, oneDay } = weekendHistories();
        const shared = mergeAthIntradayHistory(all, twoDays, null, sessionDate);
        const monday = { ...oneDay, timestamps: oneDay.timestamps.map(timestamp => timestamp + 86400000) };
        const rebuilt = mergeAthIntradayHistory(all, monday, shared, sessionDate);
        expect(Math.max(...rebuilt.athIntraday.values)).toBe(37698.44);
        expect(rebuilt.athIntraday.timestamps).toContain(at('2026-10-02T14:20:00Z'));
    });

    it('rejects an invalid intraday high without erasing the previously observed peak', () => {
        const { all, twoDays, oneDay } = weekendHistories();
        const shared = mergeAthIntradayHistory(all, twoDays, null, sessionDate);
        const invalid = { ...oneDay, twr: [1, 100, 100], dataQuality: { valid: false } };
        const rebuilt = mergeAthIntradayHistory(all, invalid, shared, sessionDate);
        expect(Math.max(...rebuilt.athIntraday.values)).toBe(37698.44);
        expect(rebuilt.athCurrent).toBeNull();
    });

    it('keeps distinct dividend peaks and neutralises a purchase in the intraday return', () => {
        const base = {
            timestamps: [at('2026-10-01T23:59:59Z')], sessionDates: ['2026-10-01'],
            values: [100], twr: [1.2], twrWithDividends: [1.3]
        };
        const recent = {
            timestamps: [at('2026-10-01T22:00:00Z'), at('2026-10-02T10:00:00Z'), at('2026-10-02T12:00:00Z')],
            // An added position doubles the euro value but leaves TWR intact.
            values: [100, 103, 202], twr: [1, 1.03, 1.01], twrWithDividends: [1, 1.03, 1.04]
        };
        const shared = mergeAthIntradayHistory(base, recent, null, sessionDate);
        const without = computeAthReference({ kind: 'performance', allHistory: shared, visibleHistory: recent });
        const withDividends = computeAthReference({
            kind: 'performance', allHistory: shared, visibleHistory: recent, includeDividends: true
        });
        expect(shared.athIntraday.values[without.at.index]).toBe(103);
        expect(without.fromAthPct).toBeCloseTo((1.01 / 1.03 - 1) * 100, 8);
        expect(shared.athIntraday.values[withDividends.at.index]).toBe(202);
        expect(withDividends.fromAthPct).toBeCloseTo(0, 8);
    });
});

describe('ATH revisions and stable anchors', () => {
    const opening = 37603.26;
    const times = ['2026-10-05T00:00:00+02:00', '2026-10-05T09:10:00+02:00',
        '2026-10-05T09:15:00+02:00', '2026-10-05T10:00:00+02:00'].map(at);
    const daily = {
        timestamps: [times[0] - 86400000], sessionDates: ['2026-10-04'],
        values: [opening], twr: [1.3], twrWithDividends: [1.4]
    };
    const make = (values, calculatedAt = 1) => ({
        timestamps: [...times], values, assetValues: values.map(value => value - 389.29),
        twr: values.map(value => value / opening),
        twrWithDividends: values.map(value => value / opening), calculatedAt,
        dataQuality: { valid: true }
    });
    const merge = (history, previous, all = daily) => mergeAthIntradayHistory(all, history, previous, sessionDate);
    const reference = (allHistory, visibleHistory, includeDividends = false) => computeAthReference({
        kind: 'performance', allHistory, visibleHistory, includeDividends, intraday: true, sessionDate
    });

    it('corrects the reported 09:15 peak instead of keeping a phantom high', () => {
        const provisional = make([opening, 37695.08, 37708.98, 37630.11]);
        const first = merge(provisional);
        const revised = make([opening, 37695.08, 37685, 37620.07], 2);
        const next = merge(revised, first);
        const ath = reference(next, revised, true);
        expect(next.athIntraday.values[ath.at.index]).toBe(37695.08);
        expect(next.athIntraday.timestamps[ath.at.index]).toBe(times[1]);
        expect(ath.value).toBeCloseTo((37695.08 / opening - 1) * 100, 10);
        expect(ath.fromAthPct).toBeCloseTo((37620.07 / 37695.08 - 1) * 100, 10);
        expect(new Set(next.athIntraday.timestamps).size).toBe(next.athIntraday.timestamps.length);
    });

    it('does not accumulate drift when the last candle changes at the same timestamp', () => {
        let retained;
        for (let i = 1; i <= 40; i++) {
            const end = i % 2 ? 37630.11 : 37620.07;
            const visible = make([opening, 37695.08, 37685, end], i);
            retained = merge(visible, retained);
            for (const dividends of [false, true]) {
                const ath = reference(retained, visible, dividends);
                expect(ath.value).toBeCloseTo((37695.08 / opening - 1) * 100, 10);
                expect(ath.fromAthPct).toBeCloseTo((end / 37695.08 - 1) * 100, 10);
            }
        }
    });

    it('replaces removed provisional bars and retains the next observed maximum', () => {
        const first = merge(make([opening, 37695.08, 37708.98, 37630.11]));
        const visible = make([opening, 37695.08, 37685, 37630.11], 2);
        for (const field of ['timestamps', 'values', 'assetValues', 'twr', 'twrWithDividends']) visible[field].splice(2, 1);
        const revised = merge(visible, first);
        expect(revised.athIntraday.timestamps).not.toContain(times[2]);
        expect(revised.athIntraday.values[reference(revised, visible).at.index]).toBe(37695.08);
    });

    it('an older cached 2D window cannot restore a subsequently corrected 1D peak', () => {
        const old = make([opening, 37695.08, 37708.98, 37630.11], 1);
        const visible = make([opening, 37695.08, 37685, 37620.07], 2);
        const revised = merge(visible, merge(old));
        const stale = merge(old, revised);
        expect(stale.athIntraday).toEqual(revised.athIntraday);
        expect(stale.athCurrent).toEqual(revised.athCurrent);
    });

    it('orders simultaneous requests by calculation sequence, not completion time', () => {
        const old = { ...make([opening, 37695.08, 37708.98, 37630.11]), calculationSequence: 1 };
        const visible = { ...make([opening, 37695.08, 37685, 37620.07]), calculationSequence: 2 };
        const revised = merge(visible, merge(old));
        expect(merge(old, revised).athIntraday).toEqual(revised.athIntraday);
    });

    it('does not promote transaction estimates or non-finite performance', () => {
        const first = merge(make([opening, 37695.08, 37685, 37630.11]));
        const estimate = { ...make([opening, 99999, 99999, 99999], 2), dataQuality: { valid: true, estimated: true } };
        expect(merge(estimate, first).athIntraday).toEqual(first.athIntraday);
        const invalid = make([opening, 99999, 99999, 37630.11], 3);
        invalid.twr[1] = Infinity;
        invalid.twr[2] = NaN;
        expect(merge(invalid, first).athIntraday.values).not.toContain(99999);
    });

    it('drops unverifiable V1 peaks and reconstructs the record from current observations', () => {
        const old = { athIntradayVersion: 1, athIntraday: {
            timestamps: [times[2]], values: [37708.98], twr: [999], twrWithDividends: [999]
        }, athCurrent: { timestamp: times[3], twr: 999 } };
        const visible = make([opening, 37695.08, 37685, 37620.07]);
        const rebuilt = merge(visible, old);
        expect(rebuilt.athIntradayVersion).toBe(3);
        expect(rebuilt.athIntraday.values[reference(rebuilt, visible).at.index]).toBe(37695.08);
    });

    it('keeps the line and drawdown consistent with an older displayed snapshot', () => {
        const old = make([opening, 37695.08, 37685, 37630.11]);
        const newer = make([opening, 37695.08, 37685, 37620.07], 2);
        const retained = merge(newer, merge(old));
        const ath = reference(retained, old);
        expect(ath.value).toBeCloseTo((37695.08 / opening - 1) * 100, 10);
        expect(ath.fromAthPct).toBeCloseTo((37630.11 / 37695.08 - 1) * 100, 10);
    });

    it('reanchors saved records once when a settled daily base is corrected', () => {
        const visible = make([opening, 37695.08, 37685, 37620.07]);
        const first = merge(visible);
        const corrected = { ...daily, twr: [1.31], twrWithDividends: [1.41] };
        const rebuilt = merge(null, first, corrected);
        expect(rebuilt.athIntraday.twr[1]).toBeCloseTo(1.31 * visible.twr[1], 10);
        const repeated = merge(null, rebuilt, corrected);
        expect(repeated.athIntraday.twr).toEqual(rebuilt.athIntraday.twr);
        expect(reference(repeated, visible).value).toBeCloseTo((37695.08 / opening - 1) * 100, 10);
    });

    it('retains an older value record even when a different point had the highest TWR', () => {
        const all = { timestamps: [at('2026-10-01T20:00:00Z')],
            sessionDates: ['2026-10-01'], values: [100], twr: [1.1] };
        const old = { timestamps: ['2026-10-02T00:00:00Z', '2026-10-02T14:00:00Z',
            '2026-10-02T15:00:00Z'].map(at), values: [100, 300, 200], twr: [1, 1.1, 1.2] };
        const recent = { timestamps: ['2026-10-06T00:00:00Z', '2026-10-06T10:00:00Z'].map(at),
            values: [150, 180], twr: [1, 1.02] };
        const saved = mergeAthIntradayHistory(all, old, null, sessionDate);
        const rebuilt = mergeAthIntradayHistory(all, recent, saved, sessionDate);
        expect(rebuilt.athIntraday.values).toContain(300);
        expect(rebuilt.athIntraday.values).toContain(200);
        const reference = computeAthReference({ kind: 'performance', allHistory: rebuilt,
            visibleHistory: recent, portfolioValue: true });
        expect(rebuilt.athIntraday.values[reference.at.index]).toBe(300);
    });
});

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

    it('the portfolio 1J ATH follows the TWR peak, not the Total Value high', () => {
        const chart = makeChart();
        chart.currentPeriod = 1;
        chart.includeDividends = true;
        const timestamps = ['2026-10-05T00:00:00+02:00', '2026-10-05T10:15:00+02:00',
            '2026-10-05T10:29:00+02:00'].map(at);
        const graphData = { labels: ['00:00', '10:15', '10:29'], timestamps,
            values: [37603.26, 37715.93, 37714.86],
            twr: [1, 1.003, 1.00297], twrWithDividends: [1, 1.003, 1.00297],
            totalReturn: [8674.2, 8786.87, 8785.8],
            totalReturnPctWithDividends: [30.5, 31.9, 31.89] };
        const all = { labels: ['yesterday', 'provisional'],
            timestamps: [timestamps[0] - 86400000, timestamps[1]],
            sessionDates: ['2026-10-04', '2026-10-05'], values: [37580.49, 37709.73],
            twr: [1.3, 1.304], twrWithDividends: [1.3, 1.304] };
        const source = { scope: 'portfolio', purchases: [purchase({ ticker: 'BTC-EUR' })], producer: vi.fn() };
        const key = chart._historyKey(source.scope, source.purchases, 'all');
        expect(chart._commitHistory(key, all, 'all')).toBe(true);
        render(chart, graphData, source);
        // The provisional daily point (TWR 1.304) beats the visible 1.003 peak.
        expect(athArg(chart)).toMatchObject({ value: expect.closeTo((1.304 / 1.3 - 1) * 100, 8),
            details: { totalValue: 37709.73, timestamp: timestamps[1] } });
        expect(athArg(chart).details.fromAthPct).toBeLessThan(0);
        chart.destroy();
    });

    it('reconciles the line, date and amount after the reported peak is revised and reloaded', () => {
        const chart = makeChart();
        chart.currentPeriod = 1;
        const opening = 37603.26;
        const timestamps = ['2026-10-05T00:00:00+02:00', '2026-10-05T09:10:00+02:00',
            '2026-10-05T09:15:00+02:00', '2026-10-05T10:00:00+02:00'].map(at);
        const make = (values, calculatedAt) => ({ labels: timestamps.map(String), timestamps, values,
            twr: values.map(value => value / opening),
            totalReturn: values.map(value => value - 28929.06), calculatedAt });
        const all = { labels: ['previous close'], timestamps: [timestamps[0] - 86400000], sessionDates: ['2026-10-04'],
            values: [opening], twr: [1.3], dataQuality: { valid: true } };
        const source = { scope: 'portfolio', purchases: [purchase({ ticker: 'BTC-EUR' })], producer: vi.fn() };
        const key = chart._historyKey(source.scope, source.purchases, 'all');
        expect(chart._commitHistory(key, mergeAthIntradayHistory(all,
            make([opening, 37695.08, 37708.98, 37630.11], 1), null, sessionDate), 'all')).toBe(true);
        const revised = make([opening, 37695.08, 37685, 37620.07], 2);
        render(chart, revised, source);
        expect(athArg(chart)).toMatchObject({
            value: expect.closeTo((37695.08 / opening - 1) * 100, 10),
            details: { timestamp: timestamps[1], totalValue: 37695.08,
                fromAthPct: expect.closeTo((37620.07 / 37695.08 - 1) * 100, 10) }
        });
        const restored = makeChart();
        restored.currentPeriod = 1;
        render(restored, revised, source);
        expect(athArg(restored)).toEqual(athArg(chart));
        expect(source.producer).not.toHaveBeenCalled();
        chart.destroy(); restored.destroy();
    });

    it('loads Friday\'s intraday peak on a cold Sunday 1D view and retains it after navigation', async () => {
        const { all, twoDays, oneDay } = weekendHistories();
        const chart = makeChart();
        chart.currentPeriod = 1;
        chart.update = vi.fn();
        const source = {
            scope: 'portfolio', purchases: [purchase({ ticker: 'BTC-EUR' })],
            producer: vi.fn(async () => all), intradayProducer: vi.fn(async () => twoDays)
        };
        chart._prefetchAthHistory(source);
        await vi.waitFor(() => expect(chart._athPending.size).toBe(0));
        render(chart, oneDay, source);
        const one = athArg(chart);

        chart.currentPeriod = 2;
        render(chart, twoDays, source);
        const two = athArg(chart);
        expect(two.details.timestamp).toBe(at('2026-10-02T14:20:00Z'));
        expect(two.details.totalValue).toBe(37698.44);
        expect(two.details.fromAthPct).toBeCloseTo(one.details.fromAthPct, 8);
        expect(two.value).toBeGreaterThanOrEqual((Math.max(...twoDays.twr) - 1) * 100 - 1e-8);

        const restored = makeChart();
        restored.currentPeriod = 1;
        render(restored, oneDay, source);
        expect(athArg(restored).details).toMatchObject({
            timestamp: at('2026-10-02T14:20:00Z'), totalValue: 37698.44,
            fromAthPct: expect.closeTo(one.details.fromAthPct, 8)
        });
        expect(source.intradayProducer).toHaveBeenCalledTimes(1);

        // A subsequent build no longer has Friday's intraday candles.
        source.intradayProducer.mockResolvedValue(oneDay);
        await chart._refreshAthHistory(source);
        render(chart, twoDays, source);
        expect(athArg(chart).details).toMatchObject({
            timestamp: at('2026-10-02T14:20:00Z'), totalValue: 37698.44,
            fromAthPct: expect.closeTo(one.details.fromAthPct, 8)
        });
        chart.destroy(); restored.destroy();
    });

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
        // The all-time TWR peak (2.0) is the ATH, not the visible 150 € high
        // reached with contributions: +100% in the rebased frame.
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
