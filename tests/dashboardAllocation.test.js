// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

let DashboardApp;
beforeAll(async () => {
    const original = document.addEventListener.bind(document);
    const spy = vi.spyOn(document, 'addEventListener').mockImplementation((type, ...args) => {
        if (type !== 'DOMContentLoaded') original(type, ...args);
    });
    ({ DashboardApp } = await import('../src/dashboardApp.js'));
    spy.mockRestore();
});

const holdings = [
    { ticker: 'ETF', assetType: 'ETF', quantity: 5, invested: 500, currentValue: 1000, purchases: [] },
    { ticker: 'STOCK', assetType: 'Stock', quantity: 10, invested: 1000, currentValue: 500, purchases: [] }
];

describe('Dashboard Asset Allocation UI', () => {
    it('renders the main KPI from current market values, not invested amounts', () => {
        document.body.innerHTML = '<div id="dashboard-allocation-container"></div>';
        const app = Object.create(DashboardApp.prototype);

        app.renderAllocation(holdings, 500);

        const text = document.getElementById('dashboard-allocation-container').textContent;
        expect(text).toContain('Valeur actuelle · cash inclus');
        expect(text).toContain('50.0%');
        expect(text).toContain('25.0%');
        expect(text).toContain('Cash');
        expect(text.indexOf('ETF')).toBeLessThan(text.indexOf('Actions'));
    });

    it('opens on current allocation and lets the Investi button switch basis', () => {
        document.body.innerHTML = `
            <div id="kpi-allocation-modal" style="display:none"></div>
            <div id="alloc-basis-toggle">
                <button class="toggle-btn active" data-basis="market">Actuelle</button>
                <button class="toggle-btn" data-basis="invested">Investi</button>
            </div>
            <div id="alloc-svg-wrap"></div>
            <div id="alloc-modal-legend"></div>
            <div id="alloc-current-breakdown"></div>`;
        const app = Object.create(DashboardApp.prototype);
        app.lastHoldings = holdings;
        app.lastCashTotal = 500;
        app.lastCashTransactions = [{ ticker: 'EUR', assetType: 'Cash', price: 500, quantity: 1, date: '2024-01-01' }];
        app.buildAllocationChart = vi.fn();

        app.openAllocationModal();
        expect(app.buildAllocationChart.mock.calls.at(-1)[4]).toBe('market');
        expect(app.buildAllocationChart.mock.calls.at(-1)[5]).toBe(500);

        document.querySelector('[data-basis="invested"]').click();
        expect(app.buildAllocationChart.mock.calls.at(-1)[4]).toBe('invested');
    });
});
