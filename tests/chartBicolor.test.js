// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoricalChart } from '../src/historicalChart.js';
import { DataManager } from '../src/dataManager.js';
import { createFakeApi, createFakeStorage } from './helpers.js';

class FakeChartJs {
    constructor(ctx, config) {
        this.ctx = ctx;
        this.config = config;
    }
    destroy() {}
}

function makeChart() {
    const storage = createFakeStorage();
    return new HistoricalChart(storage, new DataManager(storage, createFakeApi()), null, {
        filterManager: { getSelectedTickers: () => new Set() },
        getFilteredPurchasesFromPage: () => [],
        getChartTitleConfig: () => ({ mode: 'global', label: 'Portfolio' }),
        renderData: vi.fn()
    });
}

describe('performance chart colours around 0%', () => {
    let chart;
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div><canvas></canvas></div>';
        canvas = document.querySelector('canvas');
        vi.spyOn(canvas, 'getContext').mockReturnValue({});
        vi.stubGlobal('Chart', FakeChartJs);
        chart = makeChart();
    });

    afterEach(() => {
        chart._selectionCleanup?.();
        chart.destroy();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    function renderMainDataset(isPerformanceMode = true) {
        const graphData = {
            labels: ['a', 'b', 'c'], timestamps: [1, 2, 3],
            values: [100, 101, 99], twr: [1, 1.01, 0.99]
        };
        chart._renderChartJs(
            canvas, graphData, graphData.values, isPerformanceMode, null,
            false, false, null, '#e74c3c', 100, 0, 2,
            { mode: 'global' }, null, 0, null
        );
        return chart.chart.config.data.datasets.find(dataset => dataset.isMain);
    }

    function gradientChart(zeroY) {
        const gradients = [];
        const ctx = {
            createLinearGradient: vi.fn(() => {
                const stops = [];
                const gradient = { addColorStop: (offset, color) => stops.push([offset, color]), stops };
                gradients.push(gradient);
                return gradient;
            })
        };
        return {
            chart: {
                chartArea: { top: 10, bottom: 110 },
                scales: { y: { getPixelForValue: vi.fn(() => zeroY) } },
                ctx
            },
            gradients
        };
    }

    it('switches the line exactly at the zero pixel', () => {
        const dataset = renderMainDataset();
        const { chart: renderedChart, gradients } = gradientChart(60);

        const colour = dataset.borderColor({ chart: renderedChart });

        expect(colour).toBe(gradients[0]);
        expect(colour.stops).toEqual([
            [0, '#2ecc71'],
            [0.5, '#2ecc71'],
            [0.5, '#e74c3c'],
            [1, '#e74c3c']
        ]);
    });

    it('uses the same green/red split for the area fill', () => {
        const dataset = renderMainDataset();
        const { chart: renderedChart } = gradientChart(35);

        const fill = dataset.backgroundColor({ chart: renderedChart });

        expect(fill.stops).toEqual([
            [0, 'rgba(46,204,113,0.30)'],
            [0.25, 'rgba(46,204,113,0.06)'],
            [0.25, 'rgba(231,76,60,0.06)'],
            [1, 'rgba(231,76,60,0.30)']
        ]);
    });

    it('uses one semantic colour when 0% is outside the visible scale', () => {
        const dataset = renderMainDataset();

        expect(dataset.borderColor(gradientChart(130))).toBe('#2ecc71');
        expect(dataset.borderColor(gradientChart(0))).toBe('#e74c3c');
    });

    it('keeps euro/price charts on their existing single period colour', () => {
        const dataset = renderMainDataset(false);

        expect(dataset.borderColor).toBe('#e74c3c');
    });
});
