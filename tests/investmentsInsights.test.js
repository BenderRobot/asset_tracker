// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { renderInvestmentInsights } from '../src/investmentsInsights.js';
import { InvestmentsPage } from '../src/investmentsPage.js';

const asset = (ticker, dayPct, gainPct, overrides = {}) => ({
    ticker, name: ticker, dayPct, displayDayPct: dayPct, gainPct, ...overrides
});

beforeEach(() => {
    document.body.innerHTML = `
        <div id="best-day-context"></div><div id="worst-day-context"></div>
        <section class="investment-insight"><div class="stat-label">Meilleurs · jour</div><div id="best-day-asset"></div></section>
        <section class="investment-insight"><div class="stat-label">Moins bons · jour</div><div id="worst-day-asset"></div></section>
        <section class="investment-insight"><div class="stat-label">Meilleurs · total</div><div id="best-asset"></div></section>
        <section class="investment-insight"><div class="stat-label">Moins bons · total</div><div id="worst-asset"></div></section>
        <div id="cash-reserve-label"></div><div id="cash-reserve"></div><div id="cash-wallets"></div>`;
});

describe('Investment mini-classements', () => {
    it('shows three ranked assets for day and total, using the displayed session metric', () => {
        const holdings = [
            asset('AAPL', 2, 10, { dayPct: 0 }), asset('MSFT', -3, 4),
            asset('NVDA', 5, -2), asset('BTC', 1, 50), asset('BAD', null, null)
        ];
        renderInvestmentInsights(holdings, { total: 0, byBroker: {} });
        const tickers = id => [...document.querySelectorAll(`#${id} th .insight-identity`)].map(el => el.textContent);
        expect(tickers('best-day-asset')).toEqual(['NVDA', 'AAPL', 'BTC']);
        expect(tickers('worst-day-asset')).toEqual(['MSFT', 'BTC', 'AAPL']);
        expect(tickers('best-asset')).toEqual(['BTC', 'AAPL', 'MSFT']);
        expect(tickers('worst-asset')).toEqual(['NVDA', 'MSFT', 'AAPL']);
        expect(document.getElementById('best-day-context').textContent).toContain('dernière séance');
        expect(document.getElementById('best-day-asset').textContent).toContain('+5,00 %');
    });

    it('shows each wallet amount and its share from the canonical cash breakdown', () => {
        renderInvestmentInsights([], { total: 300, byBroker: { TR: 200, BOURSO: 100 } },
            [{ value: 'TR', label: 'Trade Republic' }, { value: 'BOURSO', label: 'Boursobank' }]);
        expect(document.getElementById('cash-reserve').textContent).toContain('300,00');
        expect([...document.querySelectorAll('#cash-wallets tbody tr')].map(row => row.textContent))
            .toEqual([expect.stringContaining('Trade Republic'), expect.stringContaining('Boursobank')]);
        expect(document.querySelectorAll('.wallet-segment')).toHaveLength(2);
        expect(document.querySelector('.wallet-table .wallet-share').textContent).toBe('66,67 %');
    });

    it('keeps unpriced assets out, treats wallet names as text and avoids invented shares with negative cash', () => {
        renderInvestmentInsights([asset('<img src=x onerror=alert(1)>', null, null)],
            { total: 50, byBroker: { '<b>Wallet</b>': 100, debt: -50 } });
        expect(document.querySelector('#best-day-asset .insight-empty')).not.toBeNull();
        expect(document.querySelector('#best-asset .insight-empty')).not.toBeNull();
        expect(document.querySelector('#cash-wallets b')).toBeNull();
        expect(document.getElementById('cash-wallets').textContent).toContain('<b>Wallet</b>');
        expect(document.querySelector('.wallet-segment')).toBeNull();
        expect(document.querySelector('.wallet-table .insight-negative').textContent).toContain('-50,00');
    });

    it('upgrades older Investment cards and creates the missing wallet detail host', () => {
        document.body.innerHTML = `<div class="summary-stats">
            <div class="stat-item"><div id="best-day-label" class="stat-label">Meilleure variation du jour</div><div id="best-day-asset" class="stat-value"></div></div>
            <div class="stat-item"><div id="worst-day-label" class="stat-label">Pire variation du jour</div><div id="worst-day-asset" class="stat-value"></div></div>
            <div class="stat-item"><div class="stat-label">Best Performer</div><div id="best-asset" class="stat-value"></div></div>
            <div class="stat-item"><div class="stat-label">Worst Performer</div><div id="worst-asset" class="stat-value"></div></div>
            <div class="stat-item"><div id="cash-reserve-label" class="stat-label">Cash par wallet</div><div id="cash-reserve" class="stat-value"></div></div>
        </div>`;
        renderInvestmentInsights([asset('AAPL', 1, 10)], { total: 300, byBroker: { TR: 200, BOURSO: 100 } });
        expect(document.querySelectorAll('.investment-insights .kpi-card')).toHaveLength(5);
        expect(document.querySelectorAll('#cash-wallets tbody tr')).toHaveLength(2);
        expect(document.getElementById('cash-reserve').classList.contains('stat-value')).toBe(false);
        expect(document.getElementById('best-asset').closest('.kpi-card').querySelector('.kpi-header').textContent)
            .toBe('Meilleures performances');
    });

    it('moves a legacy cash card beside the three primary KPIs when their grid exists', () => {
        document.body.innerHTML = `<div class="portfolio-summary-enhanced">
            <div class="summary-grid"><div class="summary-card"></div><div class="summary-card"></div><div class="summary-card"></div></div>
            <div class="summary-stats">
                <div class="stat-item"><div id="best-day-asset"></div></div>
                <div class="stat-item"><div id="worst-day-asset"></div></div>
                <div class="stat-item"><div id="best-asset"></div></div>
                <div class="stat-item"><div id="worst-asset"></div></div>
                <div class="stat-item"><div id="cash-reserve"></div></div>
            </div>
        </div>`;
        renderInvestmentInsights([], { total: 300, byBroker: { TR: 200, BOURSO: 100 } });
        expect(document.querySelectorAll('.summary-grid > .summary-card')).toHaveLength(4);
        expect(document.querySelector('.summary-grid > .investment-cash-insight')).not.toBeNull();
        expect(document.querySelectorAll('.summary-stats > .investment-insight')).toHaveLength(4);
        expect(document.querySelectorAll('#cash-wallets tbody tr')).toHaveLength(2);
    });

    it('recovers a legacy cash breakdown only when it reconciles with the snapshot total', () => {
        const page = Object.create(InvestmentsPage.prototype);
        page.storage = { getPurchases: () => [] };
        page.getFilteredPurchasesFromPage = () => [{ ticker: 'CASH-EUR', price: 200 }];
        page.dataManager = { calculateCashReserve: () => ({ total: 300, byBroker: { TR: 200, BOURSO: 100 } }) };
        expect(page.resolveCashReserveDetails(300).byBroker).toEqual({ TR: 200, BOURSO: 100 });
        expect(page.resolveCashReserveDetails(301)).toBe(301);
        expect(page.resolveCashReserveDetails(300, { dividendsOnly: true })).toBe(300);
    });
});
