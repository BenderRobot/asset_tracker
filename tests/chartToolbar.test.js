// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HistoricalChart } from '../src/historicalChart.js';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi } from './helpers.js';

function makeChart({ ui = {} } = {}) {
    const storage = createFakeStorage();
    const page = {
        filterManager: { getSelectedTickers: () => new Set() },
        getFilteredPurchasesFromPage: () => [],
        getChartTitleConfig: () => ({ mode: 'global', label: 'Portfolio' }),
        renderData: vi.fn()
    };
    const chart = new HistoricalChart(storage, new DataManager(storage, createFakeApi()), ui, page);
    chart.update = vi.fn();
    return chart;
}

describe('chart toolbar', () => {
    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = `
            <div class="chart-toolbar">
                <div id="view-toggle"></div>
                <div id="benchmark-wrapper" class="chart-benchmark"><select id="benchmark-select"></select></div>
                <div id="last-update" class="chart-status"></div>
            </div>`;
    });

    it('reference-line chips expose their state and carry a legend swatch', () => {
        const chart = makeChart();
        chart._syncReferenceLineToggles(true, 'price');

        const ath = document.querySelector('[data-refline="ath"]');
        expect(ath.classList.contains('chart-chip')).toBe(true);
        expect(ath.querySelector('.chart-chip-swatch')).not.toBeNull();
        // Reference lines default to visible when no preference is stored.
        expect(ath.getAttribute('aria-pressed')).toBe('true');

        ath.click();
        expect(ath.getAttribute('aria-pressed')).toBe('false');
        expect(ath.classList.contains('active')).toBe(false);
        expect(localStorage.getItem('chart_refline_ath')).toBe('0');
        expect(chart.update).toHaveBeenCalledWith(false, false);
    });

    it('freshness status reflects the snapshot state instead of a static time', () => {
        const chart = makeChart();
        const status = document.getElementById('last-update');
        const generatedAt = new Date(2026, 8, 27, 14, 32).getTime();

        chart.currentPeriod = 1;
        chart._syncToolbarState({ stale: false, degraded: false, generatedAt });
        expect(status.className).toBe('chart-status is-fresh is-live');
        expect(status.textContent).toBe('À jour · 14:32');

        chart.currentPeriod = 30;
        chart._syncToolbarState({ stale: true, degraded: false, generatedAt });
        expect(status.className).toBe('chart-status is-stale');
        expect(status.textContent).toBe('Différé · 14:32');

        chart._syncToolbarState({ stale: false, degraded: true, generatedAt });
        expect(status.className).toBe('chart-status is-degraded');
        expect(status.textContent).toBe('Partiel · 14:32');
    });

    it('tints the benchmark chip only while a benchmark is compared', () => {
        const chart = makeChart();
        const wrapper = document.getElementById('benchmark-wrapper');

        chart.currentBenchmark = '^GSPC';
        chart._syncToolbarState(null);
        expect(wrapper.classList.contains('is-active')).toBe(true);

        chart.currentBenchmark = null;
        chart._syncToolbarState(null);
        expect(wrapper.classList.contains('is-active')).toBe(false);
    });
});

describe('ATH stats group', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div class="stat-group stat-group-ath" id="stat-group-ath" hidden>
                <div class="stat" id="ath-value-row"><span id="ath-value-label"></span><span id="ath-total-value"></span></div>
                <div class="stat" id="ath-return-row"><span id="ath-total-return"></span><span id="ath-total-return-pct"></span></div>
                <div class="stat"><span id="ath-date"></span></div>
                <div class="stat"><span id="ath-gap"></span></div>
            </div>`;
    });

    const manager = () => makeChart().kpiManager;
    const text = (id) => document.getElementById(id).textContent;

    it('performance: shows Total Value / Total Return at the ATH, its date and the gap', () => {
        manager().updateAthStats({
            kind: 'performance', timestamp: new Date(2026, 2, 12).getTime(), intraday: false,
            price: null, totalValue: 36717.02, totalReturn: 1964.79, totalReturnPct: 7.45, fromAthPct: -1.3
        });
        expect(document.getElementById('stat-group-ath').hidden).toBe(false);
        expect(text('ath-value-label')).toBe('Total Value ATH');
        expect(text('ath-total-value').replace(/\s/g, ' ')).toBe('36 717,02 €');
        expect(text('ath-total-return').replace(/\s/g, ' ')).toBe('+1 964,79 €');
        expect(text('ath-total-return-pct')).toBe('(+7.45%)');
        expect(text('ath-date')).toBe('12 mars 2026');
        expect(text('ath-gap')).toBe('-1.30%');
        expect(document.getElementById('ath-gap').classList.contains('negative')).toBe(true);
    });

    it('price: shows the ATH price, hides Total Return, and "Au plus haut" at the peak', () => {
        manager().updateAthStats({
            kind: 'price', timestamp: 0, intraday: false, price: 43.5,
            totalValue: null, totalReturn: null, totalReturnPct: null, fromAthPct: 0
        });
        expect(text('ath-value-label')).toBe('Prix ATH');
        expect(document.getElementById('ath-return-row').hidden).toBe(true);
        expect(text('ath-gap')).toBe('Au plus haut');
    });

    it('hides the group when there is no ATH to show', () => {
        const kpi = manager();
        kpi.updateAthStats({ kind: 'price', timestamp: 0, price: 1, fromAthPct: 0 });
        kpi.updateAthStats(null);
        expect(document.getElementById('stat-group-ath').hidden).toBe(true);
    });
});

describe('ATH stats group — loading', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div class="chart-stats-bar">
                <div class="stat-group stat-group-ath" id="stat-group-ath" hidden>
                    <span id="ath-total-value"></span><span id="ath-total-return"></span>
                    <span id="ath-total-return-pct"></span><span id="ath-date"></span><span id="ath-gap"></span>
                    <span id="ath-value-label"></span><div id="ath-value-row"></div><div id="ath-return-row"></div>
                </div>
            </div>`;
    });

    it('reserves the block with a loading state, then fills it', () => {
        const kpi = makeChart().kpiManager;
        const group = document.getElementById('stat-group-ath');
        const bar = document.querySelector('.chart-stats-bar');

        kpi.updateAthStats({ loading: true });
        expect(group.hidden).toBe(false);
        expect(group.classList.contains('is-loading')).toBe(true);
        expect(bar.classList.contains('has-ath')).toBe(true);

        kpi.updateAthStats({ kind: 'price', timestamp: 0, price: 10, fromAthPct: -5 });
        expect(group.classList.contains('is-loading')).toBe(false);
        expect(document.getElementById('ath-gap').textContent).toBe('-5.00%');

        kpi.updateAthStats(null);
        expect(bar.classList.contains('has-ath')).toBe(false);
    });
});
