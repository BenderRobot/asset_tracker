// @vitest-environment jsdom
// Buy/sell markers of the single-asset unit-price chart: position on the
// displayed point of the transaction day, side, and tooltip rows.
import { describe, it, expect, vi } from 'vitest';
import { HistoryCalculator } from '../src/HistoryCalculator.js';
import { HistoricalChart } from '../src/historicalChart.js';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi } from './helpers.js';

const H = 3600000;
const ledgerOf = (...entries) => ({ byTicker: new Map([['EUEA.AS', entries]]) });
const entry = (date, price, quantity) => ({ date: new Date(date), price, quantity, currency: 'EUR', broker: 'RV-CT' });

describe('Transaction markers', () => {
    // 1M-like intraday series: several candles per day sharing one label.
    const days = ['2026-09-23', '2026-09-24', '2026-09-25'];
    const timestamps = days.flatMap(d => [7, 10, 13].map(h => Date.parse(`${d}T00:00:00Z`) + h * H));
    const labels = timestamps.map(ts => new Date(ts).toISOString().slice(0, 10));
    const unitPrices = [64.0, 64.1, 64.2, 64.5, 64.17, 63.9, 64.3, 64.4, 64.2];
    const win = { displayStartTs: timestamps[0] - 12 * H, displayEndTs: timestamps.at(-1) + H };

    it('places a sale on its own day, on the candle closest to the executed price', () => {
        const calc = new HistoryCalculator(createFakeStorage(), createFakeApi());
        const points = calc._buildPurchasePoints(ledgerOf(entry('2026-09-24', 64.17, -12)), 'EUEA.AS',
            timestamps, labels, 30, win, 1, null, unitPrices);
        expect(points).toHaveLength(1);
        expect(points[0]).toMatchObject({ x: 4, y: 64.17, quantity: 12, side: 'sell', label: '2026-09-24' });
    });

    it('marks buys and falls back to the nearest point for a non-trading day', () => {
        const calc = new HistoryCalculator(createFakeStorage(), createFakeApi());
        const points = calc._buildPurchasePoints(ledgerOf(entry('2026-09-26', 64.4, 3)), 'EUEA.AS',
            timestamps, labels, 30, { ...win, displayEndTs: Date.parse('2026-09-27T00:00:00Z') }, 1, null, unitPrices);
        expect(points[0]).toMatchObject({ x: 8, side: 'buy', quantity: 3 });
    });

    it('lists the transactions of the hovered point in the tooltip', () => {
        const storage = createFakeStorage();
        const chart = new HistoricalChart(storage, new DataManager(storage, createFakeApi()), null, {
            filterManager: { getSelectedTickers: () => new Set() },
            getFilteredPurchasesFromPage: () => [], getChartTitleConfig: () => ({}), renderData: vi.fn()
        });
        chart.currentPeriod = 30;
        const graphData = { purchasePoints: [
            { x: 4, y: 64.17, quantity: 12, side: 'sell' },
            { x: 4, y: 64.2, quantity: 1, side: 'buy' },
            { x: 6, y: 64.3, quantity: 5, side: 'buy' }
        ] };
        const eurFmt = n => `${n.toFixed(2)} €`;
        const rows = chart._buildKpiRows(4, { graphData, displayValues: unitPrices, isUnitView: true, eurFmt, pctFmt: String });
        expect(rows.map(r => [r.label, r.eur, r.positive])).toEqual([
            ['Prix', '64.17 €', true],
            ['Vente · 12 parts', '64.17 €', false],
            ['Achat · 1 part', '64.20 €', true]
        ]);
    });
});

describe('PÉRIODE (period return) of the portfolio chart', () => {
    function chartWithSpy() {
        const storage = createFakeStorage();
        const chart = new HistoricalChart(storage, new DataManager(storage, createFakeApi()), null, {
            filterManager: { getSelectedTickers: () => new Set() },
            getFilteredPurchasesFromPage: () => [], getChartTitleConfig: () => ({}), renderData: vi.fn()
        });
        chart._renderChartJs = vi.fn();
        chart._renderTitle = vi.fn();
        chart.kpiManager.updateKPIs = vi.fn();
        chart.kpiManager.updateAthStats = vi.fn();
        return chart;
    }
    // A sale inside the window turns +20 € of unrealised gain into a realised
    // one: totalReturn drops while the market P&L of the period is positive.
    // A 5 € dividend is received on the last interval (120 -> 132 + 5), hence
    // twrWithDividends = 1.2 × 137 / 120 = 1.37. Like the engine, the fixture
    // provides both series: the chart never substitutes the price-only TWR for
    // the dividend one.
    const graphData = {
        labels: ['a', 'b', 'c', 'd'], timestamps: [1, 2, 3, 4],
        values: [200, 240, 120, 132], twr: [1, 1.2, 1.2, 1.32], twrWithDividends: [1, 1.2, 1.2, 1.37],
        totalReturn: [0, 40, 20, 32], periodPnl: [0, 40, 40, 52],
        periodPnlWithDividends: [0, 40, 40, 57], dataQuality: { valid: true }
    };

    it('reports the flow-neutral euro P&L, consistent with the TWR', () => {
        const chart = chartWithSpy();
        chart.currentPeriod = 90;
        chart.renderChart(document.createElement('canvas'), graphData, {}, { mode: 'global' }, null, null, null, { varTodayAbs: -30, varTodayPct: -1 });
        const kpis = chart.kpiManager.updateKPIs.mock.calls[0][0];
        expect(kpis.perfAbs).toBeCloseTo(52, 8);
        expect(kpis.perfPct).toBeCloseTo(32, 8);
        expect(chart._renderChartJs.mock.calls[0][8]).toBe('#2ecc71');
    });

    it('colours the chart from the selected period, independently of Var Today', () => {
        const chart = chartWithSpy();
        chart.currentPeriod = 90;
        const losingPeriod = {
            ...graphData,
            values: [200, 190, 185, 180],
            twr: [1, 0.95, 0.925, 0.9],
            totalReturn: [0, -10, -15, -20],
            periodPnl: [0, -10, -15, -20]
        };

        chart.renderChart(document.createElement('canvas'), losingPeriod, {}, { mode: 'global' }, null, null, null, { varTodayAbs: 30, varTodayPct: 1 });

        expect(chart.kpiManager.updateKPIs.mock.calls[0][0].perfPct).toBeCloseTo(-10, 8);
        expect(chart._renderChartJs.mock.calls[0][8]).toBe('#e74c3c');
    });

    it('includes dividends only through the toggle, and keeps realised gains in All', () => {
        const chart = chartWithSpy();
        chart.currentPeriod = 90;
        chart.includeDividends = true;
        chart.renderChart(document.createElement('canvas'), graphData, {}, { mode: 'global' }, null, null, null, null);
        expect(chart.kpiManager.updateKPIs.mock.calls[0][0].perfAbs).toBeCloseTo(57, 8);
        expect(chart.kpiManager.updateKPIs.mock.calls[0][0].perfPct).toBeCloseTo(37, 8);

        const all = chartWithSpy();
        all.currentPeriod = 'all';
        all.renderChart(document.createElement('canvas'), graphData, {}, { mode: 'global' }, null, null, null, null);
        expect(all.kpiManager.updateKPIs.mock.calls[0][0].perfAbs).toBeCloseTo(52, 8);
        expect(all.kpiManager.updateKPIs.mock.calls[0][0].perfPct).toBeCloseTo(32, 8);
    });
});

describe('Portfolio purchase points ("Achats" toggle)', () => {
    function portfolioChart() {
        const storage = createFakeStorage();
        const chart = new HistoricalChart(storage, new DataManager(storage, createFakeApi()), null, {
            filterManager: { getSelectedTickers: () => new Set() },
            getFilteredPurchasesFromPage: () => [], getChartTitleConfig: () => ({}), renderData: vi.fn()
        });
        chart.currentPeriod = 30;
        return chart;
    }
    const graphData = {
        values: [1000, 1100, 1200, 1300],
        transactionPoints: [
            { x: 1, ticker: 'AAPL', name: 'Apple', amount: 100 },
            { x: 1, ticker: 'AAPL', name: 'Apple', amount: 300 },
            { x: 2, ticker: 'BTC-EUR', name: 'Bitcoin', amount: 1600 },
            { x: 9, ticker: 'AAPL', name: 'Apple', amount: 50 },
            { x: 3, ticker: 'AAPL', name: 'Apple', side: 'sell', amount: 800 }
        ]
    };

    it('places one point per asset and day on the curve, sized by amount and coloured by asset', () => {
        const chart = portfolioChart();
        const sets = chart._buildPortfolioBuyDatasets(graphData, graphData.values, 0, 3);
        const apple = sets.find(set => set.label === 'Achats · Apple');
        const bitcoin = sets.find(set => set.label === 'Achats · Bitcoin');
        expect(sets).toHaveLength(3);
        // Two Apple buys on the same point are merged (400 €); out-of-window buys are ignored.
        expect(apple.data).toEqual([null, 1100, null, null]);
        expect(apple.pointRadius[1]).toBeCloseTo(4 + 10 * Math.sqrt(400 / 1600), 8);
        expect(bitcoin.pointRadius[2]).toBe(14);
        expect(apple.backgroundColor).not.toBe(bitcoin.backgroundColor);
        expect(sets.every(set => set.isTransactionMarker && set.showLine === false)).toBe(true);
        // Sales: same asset colour, downward triangle, sized on the same scale.
        const appleSales = sets.find(set => set.label === 'Ventes · Apple');
        expect(appleSales).toMatchObject({ pointStyle: 'triangle', rotation: 180, backgroundColor: apple.backgroundColor });
        expect(appleSales.data).toEqual([null, null, null, 1300]);
        expect(appleSales.pointRadius[3]).toBeCloseTo(4 + 10 * Math.sqrt(800 / 1600), 8);
        expect(apple.pointStyle).toBe('circle');
    });

    it('lists the buys of the hovered point only while the toggle is on', () => {
        const chart = portfolioChart();
        const opts = { graphData, pctSeries: [0, 10, 20, 30], eurFmt: n => `${n} €`, pctFmt: String,
            isIndexMode: false, isUnitView: false, displayValues: graphData.values };
        chart.refLineVisibility.buys = false;
        expect(chart._buildKpiRows(1, opts).some(row => row.label.startsWith('Achat'))).toBe(false);
        chart.refLineVisibility.buys = true;
        const buy = chart._buildKpiRows(1, opts).find(row => row.label === 'Achat · Apple');
        expect(buy).toMatchObject({ eur: '400 €', marker: 'buy' });
        expect(buy.color).toMatch(/^#/);
        expect(chart._buildKpiRows(3, opts).find(row => row.label === 'Vente · Apple')).toMatchObject({ eur: '800 €', positive: false });
    });

    it('is off by default and only offered in portfolio views', () => {
        localStorage.removeItem('chart_refline_buys');
        const chart = portfolioChart();
        expect(chart.refLineVisibility.buys).toBe(false);
        document.body.innerHTML = '<div class="chart-toolbar"><div id="view-toggle"></div></div>';
        chart._syncReferenceLineToggles(false, 'performance');
        expect(document.querySelector('[data-refline="buys"]').style.display).toBe('');
        chart._syncReferenceLineToggles(true, 'price');
        expect(document.querySelector('[data-refline="buys"]').style.display).toBe('none');
    });
});
