// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UIComponents } from '../src/ui.js';

const summary = (overrides = {}) => ({
    totalCurrentEUR: 1000,
    totalInvestedEUR: 800,
    gainTotal: 200,
    gainPct: 25,
    totalDayChangeEUR: 20,
    dayChangePct: 2,
    ...overrides
});

describe('modal des KPI principaux', () => {
    let storage;
    let dataManager;
    let ui;

    beforeEach(() => {
        document.body.innerHTML = `
            <div class="summary-card"><div id="total-current"></div><div id="invested"></div></div>
            <div class="summary-card"><div id="total-gain-loss"></div><div id="total-gain-pct"></div></div>
            <div class="summary-card"><div id="total-invested"></div><div id="avg-cost-per-share"></div></div>
        `;
        Element.prototype.scrollIntoView = vi.fn();
        storage = {
            getPurchases: () => [
                { ticker: 'AAPL', broker: 'PEA' },
                { ticker: 'MSFT', broker: 'CTO' }
            ]
        };
        dataManager = {
            calculateReturnByBroker: vi.fn(),
            calculateDayChangeByBroker: vi.fn()
        };
        ui = new UIComponents(storage, dataManager);
    });

    it('recharge les détails par courtier quand les KPI changent pendant son ouverture', async () => {
        dataManager.calculateReturnByBroker
            .mockResolvedValueOnce([{ broker: 'PEA', totalReturn: 100, totalReturnPct: 20 }])
            .mockResolvedValueOnce([{ broker: 'PEA', totalReturn: 130, totalReturnPct: 26 }]);
        dataManager.calculateDayChangeByBroker
            .mockResolvedValueOnce([{ broker: 'PEA', dayChange: 10, dayChangePct: 1 }])
            .mockResolvedValueOnce([{ broker: 'PEA', dayChange: 15, dayChangePct: 1.5 }]);

        ui.updateTopKPIs(summary(), 50);
        document.getElementById('total-current').closest('.summary-card').click();

        await vi.waitFor(() => {
            expect(document.getElementById('tv-broker-return').textContent).toContain('100,00');
            expect(document.getElementById('tv-broker-daychange').textContent).toContain('10,00');
        });

        ui.updateTopKPIs(summary({
            totalCurrentEUR: 1100,
            gainTotal: 300,
            gainPct: 37.5,
            totalDayChangeEUR: 30,
            dayChangePct: 3
        }), 50);

        await vi.waitFor(() => {
            expect(dataManager.calculateReturnByBroker).toHaveBeenCalledTimes(2);
            expect(dataManager.calculateDayChangeByBroker).toHaveBeenCalledTimes(2);
            expect(document.getElementById('total-value-modal-body').textContent).toContain('1\u202f100,00');
            expect(document.getElementById('tv-broker-return').textContent).toContain('130,00');
            expect(document.getElementById('tv-broker-daychange').textContent).toContain('15,00');
        });
    });
});
