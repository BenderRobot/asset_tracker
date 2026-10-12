// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvestmentsPage } from '../src/investmentsPage.js';
import { HistoricalChart } from '../src/historicalChart.js';
import { UIComponents } from '../src/ui.js';
import { renderCompanyLogo } from '../src/logoUtils.js';
import { FilterManager } from '../src/filters.js';
import { portfolioKPIs } from '../src/portfolioKPIs.js';

const purchase = (quantity, price, date) => ({ ticker: 'AAPL', name: 'Apple', quantity, price, date, currency: 'EUR', broker: 'TR' });
const holding = (overrides = {}) => ({
    ticker: 'AAPL', name: 'Apple', quantity: 5, avgPrice: 100, invested: 500,
    currentPrice: 200, currentValue: 1000, gainEUR: 500, gainPct: 100,
    dayPct: 0, displayDayPct: 1, dayChange: 0, displayDayChange: 10,
    purchases: [purchase(10, 100, '2025-01-01'), purchase(-5, 150, '2025-02-01')], ...overrides
});

function pageWithDom() {
    document.body.innerHTML = `<div id="investment-filter-context" hidden></div><table id="investments-table"><thead><tr><th id="day-change-label"></th><th id="day-percent-label"></th></tr></thead><tbody></tbody></table>`;
    const page = Object.create(InvestmentsPage.prototype);
    page.storage = { getPurchases: () => [purchase(10, 100, '2025-01-01')] };
    page.filterManager = { getSelectedTickers: () => new Set() };
    page.dataManager = { calculateSummary: () => ({ movementsCount: 2 }), isCryptoTicker: () => false };
    page.ui = { updateSecondaryKPIs: vi.fn(), renderPagination: vi.fn(), populateTickerSelect: vi.fn() };
    page.currentSearchQuery = '';
    page.currentAssetTypeFilter = '';
    page.currentBrokerFilter = '';
    page.currentPage = 1;
    page.sortColumn = 'ticker';
    page.sortDirection = 'asc';
    return page;
}

describe('Investment audit lot 1', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('renders purchases and partial sales as movements; only buys show their gain since purchase', () => {
        const page = pageWithDom();
        page.renderData([holding()], {}, 0);
        const rows = [...document.querySelectorAll('.purchase-detail-row')].map(row => [...row.cells].map(cell => cell.textContent.trim()));
        // Type badge then broker (no label known for "TR" here: its code is shown).
        expect(document.querySelector('.purchase-detail-row .movement-type.is-buy').textContent).toBe('Achat');
        expect(rows[0].slice(0, 5)).toEqual(['AchatTR', '1 janv. 2025', '100,00 €', '10', '1 000,00 €']);
        // Bought 10 at 100 €, now 200 €: +1 000 € / +100 % on the quantity bought.
        expect(rows[0][5].replace(/\s/g, '')).toBe('+1000,00€+100,00%');
        // A sale has no "gain since purchase": never the gap to today's price.
        expect(rows[1][5]).toBe('—');
        expect(document.querySelector('.purchase-detail-row .movement-type.is-sale').textContent).toBe('Vente');
        expect(rows[1].slice(0, 5)).toEqual(['VenteTR', '1 févr. 2025', '150,00 €', '5', '750,00 €']);
        expect(document.querySelector('.purchases-sub-table').textContent).not.toContain('GAIN TOTAL');
        expect(document.querySelector('.purchases-sub-table').textContent).toContain("+/- DEPUIS L'ACHAT");
    });

    it('keeps asset identity visible in the first cell and treats names as text', () => {
        const page = pageWithDom();
        page.renderData([holding({ name: '<b data-injected="yes">Fake</b>' })], {}, 0);
        const firstCell = document.querySelector('.asset-row').cells[0];
        expect(firstCell.textContent).toContain('AAPL');
        expect(firstCell.textContent).toContain('<b data-injected="yes">Fake</b>');
        expect(firstCell.textContent).toContain('5 titres');
        expect(document.querySelector('[data-injected]')).toBeNull();
        expect(renderCompanyLogo('AAPL', 'A" onerror="alert(1)').html).not.toContain('alt="A" onerror=');
    });

    it('treats names in the ticker filter as text', () => {
        document.body.innerHTML = '<div id="ticker-filter-dropdown"></div>';
        const filters = new FilterManager({ getPurchases: () => [{
            ...purchase(1, 100, '2025-01-01'), name: '<img data-injected="yes" src=x>'
        }] });
        filters.updateTickerFilter(() => {});
        expect(document.querySelector('[data-injected]')).toBeNull();
        expect(document.getElementById('ticker-filter-dropdown').textContent).toContain('<img data-injected="yes" src=x>');
    });

    it('keeps filtered search context and does not treat a text search as global', () => {
        const page = pageWithDom();
        page.currentSearchQuery = 'Apple';
        page.renderData([holding()], {}, 0);
        expect(page.getChartTitleConfig()).toMatchObject({ mode: 'filter', label: 'Recherche : Apple' });
        expect(document.getElementById('investment-filter-context').textContent).toContain('1 position · Recherche : Apple');
    });

    it('shows an error on first load but preserves a previously rendered table', () => {
        const page = pageWithDom();
        page.historicalChart = { update: vi.fn().mockResolvedValue(undefined) };
        page.showDataError();
        expect(document.querySelector('#investments-table tbody').textContent).toContain('Positions indisponibles');
        expect(document.querySelector('.investments-retry')).not.toBeNull();
        document.querySelector('.investments-retry').click();
        expect(page.historicalChart.update).toHaveBeenCalledWith(true, true);
        page.renderData([holding()], {}, 0);
        page.showDataError();
        expect(document.querySelector('.asset-row').dataset.ticker).toBe('AAPL');
        expect(document.querySelector('#investments-table tbody').textContent).not.toContain('Positions indisponibles');
        expect(document.getElementById('investment-filter-context').textContent).toContain('Dernières positions connues');
    });

    it('does not pass old positions off as a newly selected portfolio after a failed request', () => {
        const page = pageWithDom();
        page.renderData([holding()], {}, 0);
        page.currentSearchQuery = 'Bitcoin';
        page.beginScopeRender();
        expect(document.querySelector('.asset-row')).toBeNull();
        expect(document.querySelector('#investments-table tbody').textContent).toContain('Chargement des positions');
        page.showDataError();
        expect(document.querySelector('#investments-table tbody').textContent).toContain('Positions indisponibles');
        expect(document.getElementById('investment-filter-context').textContent).toContain('Recherche : Bitcoin');
    });

    it('keeps positions when the historical series fails after a valid snapshot', async () => {
        document.body.innerHTML = '<canvas id="historical-portfolio-chart"></canvas><div id="chart-info"></div>';
        const renderData = vi.fn();
        const chart = Object.create(HistoricalChart.prototype);
        Object.assign(chart, {
            _updateRequestId: 0, isLoading: false, currentMode: 'portfolio', currentPeriod: 1,
            selectedAssets: [], filterManager: { getSelectedTickers: () => new Set() },
            investmentsPage: {
                getChartTitleConfig: () => ({ mode: 'global', label: 'Portefeuille' }),
                getFilteredPurchasesFromPage: () => [], renderData
            },
            dataManager: {
                splitCanonicalPurchases: () => ({ assets: [], cash: [] }),
                repository: { getSnapshot: async () => ({ snapshot: { generatedAt: Date.now(), _engine: {
                    holdings: [holding()], summary: {}, cashReserve: { total: 0 },
                    todayGraphData: { labels: [], values: [], dataQuality: { valid: false } },
                    portfolioSnapshot: { status: 'valid', snapshotId: 'audit-1', totalValue: 1000,
                        invested: 500, totalReturn: 500, totalReturnPct: 100, dayPnl: 0,
                        dayPnlPct: 0, cash: 0, positions: [] }
                } } }) }
            },
            _prefetchAthHistory: vi.fn(), _setLoadingState: vi.fn(), showMessage: vi.fn()
        });
        await chart.update(false, false);
        expect(renderData).toHaveBeenCalledOnce();
        expect(renderData.mock.calls[0][0][0].ticker).toBe('AAPL');
        expect(chart.showMessage).toHaveBeenCalledWith('Données de marché indisponibles pour cette période.');
        expect(portfolioKPIs.getKPIs().totalValue).toBe(1000);
    });

    it('uses the displayed session values for daily cards without rewriting canonical day P&L', () => {
        document.body.innerHTML = '<div id="best-day-asset"></div><div id="worst-day-asset"></div><div id="best-day-label"></div><div id="worst-day-label"></div>';
        const ui = new UIComponents({});
        const positions = [holding({ name: 'Apple', dayPct: 0, displayDayPct: 1.4 }), holding({ ticker: 'BTC-EUR', name: 'Bitcoin', dayPct: 0.8, displayDayPct: 0.8 })];
        ui.updateSecondaryKPIs({ bestDayAsset: { name: 'Bitcoin', dayPct: 0.8 } }, 2, 0, { displayDayHoldings: positions });
        expect(document.getElementById('best-day-asset').textContent).toContain('Apple');
        expect(document.getElementById('best-day-label').textContent).toBe('Meilleure variation affichée');
        expect(positions[0].dayPct).toBe(0);
    });
});
