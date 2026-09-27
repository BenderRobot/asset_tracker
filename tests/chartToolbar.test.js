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
