// Audit isolation: real HTML/CSS, InvestmentsPage, FilterManager and UI renderers.
// Synthetic holdings/chart; no authentication, production reads or writes.
// Usage: node audit/investments-audit-preview.mjs <path-to-playwright>
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const outputSuffix = process.argv[3] || '';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
    try {
        const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
        if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
        let data = await readFile(file);
        if (file.endsWith('investments.html')) data = data.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
        res.setHeader('Content-Type', (mime[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8');
        res.end(data);
    } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const results = { scope: 'Isolated demo: real renderers, mocked storage/API/chart data', viewports: [], checks: {}, errors };
try {
    const address = `http://127.0.0.1:${server.address().port}`;
    await page.goto(address + '/investments.html');
    await page.addScriptTag({ url: address + '/src/sidebar-render.js' });
    await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js' });
    await page.evaluate(async () => {
        window.firebase = { apps: [], initializeApp() {}, auth: () => ({ currentUser: null }), firestore: () => ({}) };
        const { InvestmentsPage } = await import('/src/investmentsPage.js');
        const { FilterManager } = await import('/src/filters.js');
        const { UIComponents } = await import('/src/ui.js');
        const { DataManager } = await import('/src/dataManager.js');
        const { HistoricalChart } = await import('/src/historicalChart.js');
        const { createFakeStorage, createFakeApi } = await import('/tests/helpers.js');
        const { mountViewToggle } = await import('/src/chartViewToggle.js');
        const definitions = [
            ['AAPL', 'Apple', 30, 170, 210, 'Stock', 1.4],
            ['MSFT', 'Microsoft', 12, 320, 380, 'Stock', -0.5],
            ['CSPX', 'iShares Core S&P 500 UCITS ETF USD (Acc)', 18, 400, 510, 'ETF', 0.7],
            ['ASML.AS', 'ASML Holding', 5, 600, 720, 'Stock', -2.3],
            ['BTC-EUR', 'Bitcoin', 0.068, 65000, 75000, 'Crypto', 0.8],
            ['MC.PA', 'LVMH', 8, 680, 590, 'Stock', -1.1]
        ];
        const holdings = definitions.map(([ticker, name, quantity, avgPrice, currentPrice, assetType, dayPct]) => ({
            ticker, name, quantity, avgPrice, currentPrice, assetType, invested: quantity * avgPrice,
            currentValue: quantity * currentPrice, gainEUR: quantity * (currentPrice - avgPrice),
            gainPct: (currentPrice / avgPrice - 1) * 100, dayPct, displayDayPct: dayPct,
            dayChange: quantity * currentPrice * dayPct / 100, displayDayChange: quantity * currentPrice * dayPct / 100,
            purchases: [{ ticker, name, assetType, quantity, price: avgPrice, currency: 'EUR', date: '2025-06-12', broker: 'TR' }]
        }));
        const storage = createFakeStorage({ purchases: holdings.flatMap(h => h.purchases), conversionRate: 0.9 });
        const dm = new DataManager(storage, createFakeApi());
        const ui = new UIComponents(storage, dm);
        const filters = new FilterManager(storage);
        const view = new InvestmentsPage(storage, { formatTicker: t => t }, ui, filters, dm,
            [{ value: 'TR', label: 'Trade Republic' }, { value: 'BOURSO', label: 'Boursobank PEA' }, { value: 'REV', label: 'Revolut' }], null);
        filters.updateTickerFilter(() => {});
        view.setupFilters(); view.setupSorting();
        const summary = dm.calculateSummary(holdings);
        ui.updateTopKPIs({ ...summary, totalCurrentEUR: summary.totalCurrentEUR + 1300 }, 1300);
        view.renderData(holdings, summary, { total: 1300, byBroker: { TR: 900, BOURSO: 350, REV: 50 } });
        document.getElementById('filter-broker').insertAdjacentHTML('beforeend', '<option value="TR">Trade Republic</option>');
        mountViewToggle(document.getElementById('view-toggle'), 'portfolio', () => {});
        document.querySelector('#view-toggle [data-view="global"]').click();
        document.getElementById('view-toggle').style.display = 'flex';
        document.getElementById('benchmark-wrapper').style.display = 'block';
        document.getElementById('chart-loading').style.display = 'none';
        document.getElementById('last-update').className = 'chart-status is-fresh';
        document.querySelector('.chart-status-text').textContent = 'À jour · 14:30';
        const end = summary.totalCurrentEUR + 1300;
        const start = end - summary.totalDayChangeEUR;
        const values = Array.from({ length: 50 }, (_, i) => start + (end - start) * i / 49 + Math.sin(i * Math.PI / 49) * Math.sin(i / 3) * 20);
        const eur = n => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
        for (const [id, value] of Object.entries({ 'performance-label': '+' + eur(end - start), 'performance-percent': '+' + ((end / start - 1) * 100).toFixed(2) + ' %', 'price-start': eur(start), 'price-end': eur(end), 'price-high': eur(Math.max(...values)), 'price-low': eur(Math.min(...values)) })) document.getElementById(id).textContent = value;
        const demoChart = new Chart(document.querySelector('canvas'), { type: 'line', data: { labels: values.map((_, i) => `${9 + Math.floor(i / 6)}:${String(i % 6 * 10).padStart(2, '0')}`), datasets: [{ data: values, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.07)', fill: true, pointRadius: 0, borderWidth: 2 }] }, options: { animation: false, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 8, color: '#a6b2ca' } }, y: { ticks: { color: '#a6b2ca' } } } } });
        window.audit = { view, ui, dm, storage, holdings, summary, HistoricalChart, demoChart };
    });
    for (const width of [1920, 1601, 1600, 1366, 1301, 1300, 1251, 1250, 1152, 1024, 768, 390, 360]) {
        await page.setViewportSize({ width, height: 900 });
        await page.mouse.move(1, 1);
        await page.waitForTimeout(200);
        await page.evaluate(() => scrollTo(0, 0));
        results.viewports.push(await page.evaluate(() => {
            const first = document.querySelector('.asset-row');
            return { width: innerWidth, documentWidth: document.documentElement.scrollWidth,
                firstPositionY: Math.round(first.getBoundingClientRect().top + scrollY),
                tableWidth: Math.round(document.getElementById('investments-table').getBoundingClientRect().width),
                visibleFirstRowCells: [...first.cells].filter(el => getComputedStyle(el).display !== 'none').map(el => el.innerText.trim()),
                quantityAttribute: first.cells[0].getAttribute('data-quantity'),
                kpiOverflows: [...document.querySelectorAll('.summary-card-value')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.id),
                clippedSummaryCards: [...document.querySelectorAll('.summary-stats .stat-item')].filter(el => { const r = el.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < 0; }).map(el => el.querySelector('.stat-label').innerText),
                rankingRows: [...document.querySelectorAll('.investment-insight:not(.investment-cash-insight) .insight-table')].map(table => table.rows.length),
                clippedRankingValues: [...document.querySelectorAll('.investment-insight:not(.investment-cash-insight) .insight-table td')]
                    .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent),
                wallets: [...document.querySelectorAll('.wallet-table tbody tr')].map(row => row.innerText),
                walletNameClips: [...document.querySelectorAll('.wallet-table th .insight-identity')]
                    .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent),
                walletValueClips: [...document.querySelectorAll('.wallet-table td')]
                    .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent),
                primaryCardTops: [...document.querySelectorAll('.summary-grid > .summary-card')]
                    .map(card => Math.round(card.getBoundingClientRect().top + scrollY)),
                primaryCardHeights: [...document.querySelectorAll('.summary-grid > .summary-card')]
                    .map(card => Math.round(card.getBoundingClientRect().height)),
                primaryValueFontSizes: [...document.querySelectorAll('.summary-grid .summary-card-value')]
                    .map(value => Math.round(parseFloat(getComputedStyle(value).fontSize))),
                primaryGridWidth: Math.round(document.querySelector('.summary-grid').getBoundingClientRect().width),
                secondaryCardTops: [...document.querySelectorAll('.investment-insights > .investment-insight')]
                    .map(card => Math.round(card.getBoundingClientRect().top + scrollY)),
                secondaryCardWidths: [...document.querySelectorAll('.investment-insights > .investment-insight')]
                    .map(card => Math.round(card.getBoundingClientRect().width)),
                secondaryCardHeights: [...document.querySelectorAll('.investment-insights > .investment-insight')]
                    .map(card => Math.round(card.getBoundingClientRect().height)),
                cashCardContentHeight: (() => { const card = document.querySelector('.investment-cash-insight');
                    const last = card.querySelector('.wallet-table tr:last-child'); return Math.round(last.getBoundingClientRect().bottom - card.getBoundingClientRect().top); })(),
                rankingCardContentHeight: (() => { const card = document.querySelector('.investment-insight:not(.investment-cash-insight)');
                    const last = card.querySelector('.insight-table tr:last-child'); return Math.round(last.getBoundingClientRect().bottom - card.getBoundingClientRect().top); })(),
                primaryGridEdges: (r => [Math.round(r.left), Math.round(r.right)])(document.querySelector('.summary-grid').getBoundingClientRect()),
                secondaryGridEdges: (r => [Math.round(r.left), Math.round(r.right)])(document.querySelector('.investment-insights').getBoundingClientRect()),
                chartTop: Math.round(document.querySelector('.historical-chart-container').getBoundingClientRect().top + scrollY),
                cashInInsightsGrid: !!document.querySelector('.investment-insights > .investment-cash-insight'),
                summaryGridWidth: Math.round(document.querySelector('.summary-stats').getBoundingClientRect().width),
                rowFocusable: first.tabIndex >= 0,
                sortableHeadersFocusable: [...document.querySelectorAll('th[data-sort]')].every(el => el.tabIndex >= 0 || el.querySelector('button')),
                clearButtonSize: (() => { const r = document.getElementById('clear-filters').getBoundingClientRect(); return [r.width, r.height]; })()
            };
        }));
        if ([1920, 1366, 1152, 390].includes(width)) {
            await page.screenshot({ path: path.join(root, `audit/investments-preview-${width}${outputSuffix}.png`), fullPage: true });
            await page.locator('.asset-row').first().click();
            await page.evaluate(() => scrollTo(0, 0));
            await page.waitForTimeout(300);
            await page.screenshot({ path: path.join(root, `audit/investments-detail-${width}${outputSuffix}.png`), fullPage: true });
            if (width === 390) results.checks.mobileDetailScroll = await page.evaluate(() => {
                const container = document.querySelector('.purchases-expand');
                container.scrollLeft = container.scrollWidth;
                const amount = document.querySelector('.purchase-detail-row td:last-child').getBoundingClientRect();
                const frame = container.getBoundingClientRect();
                return { scrollable: container.scrollWidth > container.clientWidth,
                    amountVisibleAfterScroll: amount.left >= frame.left - 1 && amount.right <= frame.right + 1 };
            });
            await page.locator('.asset-row').first().click();
        }
    }
    results.checks.mobileToggle = await page.evaluate(() => {
        const { view } = audit;
        const before = view.sortColumn;
        document.querySelector('th[data-sort="dayPct"]').click();
        return { before, after: view.sortColumn, totalVisible: document.querySelector('#investments-table').classList.contains('show-total-gain') };
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.locator('.summary-card').first().click();
    await page.keyboard.press('Escape');
    results.checks.modal = await page.evaluate(() => ({ remainsOpenAfterEscape: getComputedStyle(document.getElementById('total-value-modal')).display !== 'none', role: document.getElementById('total-value-modal').getAttribute('role'), focusInside: document.getElementById('total-value-modal').contains(document.activeElement) }));
    await page.locator('#close-total-value-modal').click();
    await page.locator('#filter-toggle').click();
    await page.locator('.ticker-checkbox').first().check();
    results.checks.multiselect = await page.evaluate(() => ({ closesAfterOneCheck: getComputedStyle(document.getElementById('filter-dropdown')).display === 'none', focus: document.activeElement.tagName }));
    results.checks.logic = await page.evaluate(async () => {
        const { view, holdings, summary, dm } = audit;
        view.filterManager.selectedTickers.clear();
        view.currentSearchQuery = 'Apple';
        const searchTitle = view.getChartTitleConfig();
        view.currentSearchQuery = '2025-06-12';
        const dateResults = view.getFilteredPurchasesFromPage().length;
        view.currentSearchQuery = '';
        const weekend = holdings.map(h => ({ ...h, dayPct: h.assetType === 'Crypto' ? 0.8 : 0, dayChange: h.assetType === 'Crypto' ? h.dayChange : 0 }));
        const weekendSummary = dm.calculateSummary(weekend);
        view.renderData(weekend, weekendSummary, 1300);
        const weekendState = { card: document.getElementById('best-day-asset').innerText, firstRow: document.querySelector('.asset-row').dataset.ticker, firstDayPct: document.querySelector('.asset-row').cells[10].innerText };
        const ordered = [{ ...holdings[0], purchases: [{ ...holdings[0].purchases[0], date: '2026-09-01' }, { ...holdings[0].purchases[0], date: '2024-01-01' }] }];
        view.renderData(ordered, summary, 0);
        const purchaseDateOrder = [...document.querySelectorAll('.purchase-detail-row')].map(el => el.cells[1].innerText);
        const transactions = [{ ...holdings[0].purchases[0], quantity: 10, price: 100, date: '2025-01-01' }, { ...holdings[0].purchases[0], quantity: -5, price: 150, date: '2025-02-01' }];
        const saleHolding = { ...holdings[0], quantity: 5, currentPrice: 200, currentValue: 1000, invested: 500, avgPrice: 100, gainEUR: 500, gainPct: 100, purchases: transactions };
        view.renderData([saleHolding], summary, 0);
        const partialSale = { expectedUnrealizedPnl: saleHolding.gainEUR, rows: [...document.querySelectorAll('.purchase-detail-row')].map(el => [...el.cells].map(td => td.innerText)) };
        // Harmless markup marker proves an HTML sink, no script or external transfer.
        view.renderData([{ ...holdings[0], name: '<b data-audit-marker="injected">Audit marker</b>' }], summary, 0);
        const insertedMarkup = !!document.querySelector('.asset-row [data-audit-marker="injected"]');
        view.renderData(holdings, summary, 1300);
        const calls = [];
        view.filterManager.onFilterChangeCallback = () => calls.push('filterCallback');
        view.historicalChart = { currentPeriod: 30, currentBenchmark: '^GSPC', currentMode: 'portfolio', showPortfolioChart() { calls.push('showPortfolioChart'); } };
        const originalRender = view.render;
        view.render = () => calls.push('render');
        document.getElementById('clear-filters').click();
        const clearState = { calls, periodAfter: view.historicalChart.currentPeriod, benchmarkAfter: view.historicalChart.currentBenchmark };
        view.render = originalRender;
        // Real update orchestration with invalid historical data; only data source is a stub.
        const chart = Object.create(audit.HistoricalChart.prototype);
        Object.assign(chart, { _updateRequestId: 0, currentMode: 'portfolio', currentPeriod: 1, selectedAssets: [], investmentsPage: view,
            filterManager: view.filterManager, dataManager: { splitCanonicalPurchases: () => ({ assets: [], cash: [] }), repository: { getSnapshot: async () => ({ snapshot: { generatedAt: Date.now(), _engine: { holdings, summary, cashReserve: { total: 1300 }, todayGraphData: { labels: [], values: [], dataQuality: { valid: false } } } } }) } },
            _prefetchAthHistory() {}, _setLoadingState() {} });
        view.historicalChart = chart;
        await view.render('', true);
        const invalidHistoryState = { table: document.querySelector('#investments-table > tbody').innerText, chartMessage: document.getElementById('chart-info').innerText };
        return { searchTitle, dateResults, weekendState, purchaseDateOrder, partialSale, insertedMarkup, clearState, invalidHistoryState };
    });
    if (outputSuffix === '-lot1' || outputSuffix === '-insights') {
        assert.equal(results.errors.length, 0);
        for (const size of results.viewports.filter(item => item.width <= 768)) {
            assert.deepEqual(size.clippedSummaryCards, [], `summary cards clipped at ${size.width}px`);
            assert.match(size.visibleFirstRowCells[0], /AAPL[\s\S]*Apple[\s\S]*30 titres/);
        }
        assert.deepEqual(results.checks.logic.searchTitle.mode, 'filter');
        assert.equal(results.checks.logic.insertedMarkup, false);
        assert.equal(results.checks.logic.partialSale.rows[1][0], 'Vente · TR');
        assert.equal(results.checks.logic.partialSale.rows[1][4].replace(/[\u00a0\u202f]/g, ' '), '750,00 €');
        assert.ok(!results.checks.logic.invalidHistoryState.table.includes('Loading'));
        assert.deepEqual(results.checks.logic.purchaseDateOrder, ['1 janv. 2024', '1 sept. 2026']);
        assert.deepEqual(results.checks.mobileDetailScroll, { scrollable: true, amountVisibleAfterScroll: true });
        if (outputSuffix === '-insights') {
            for (const size of results.viewports) {
                assert.deepEqual(size.rankingRows, [3, 3, 3, 3]);
                assert.equal(size.wallets.length, 3);
                assert.deepEqual(size.clippedRankingValues, [], `ranking values clipped at ${size.width}px`);
                assert.deepEqual(size.walletNameClips, [], `wallet names clipped at ${size.width}px`);
                assert.deepEqual(size.walletValueClips, [], `wallet values clipped at ${size.width}px`);
                assert.equal(size.cashInInsightsGrid, true);
                assert.equal(size.primaryCardTops.length, 3);
                assert.equal(size.secondaryCardTops.length, 5);
                if (size.width > 1150) {
                    assert.ok(size.primaryCardTops.every(top => Math.abs(top - size.primaryCardTops[0]) <= 1),
                        `three primary cards should share a row at ${size.width}px: ${size.primaryCardTops.join(', ')}`);
                    assert.ok(size.secondaryCardTops.every(top => Math.abs(top - size.secondaryCardTops[0]) <= 1),
                        `five insight cards should share a row at ${size.width}px: ${size.secondaryCardTops.join(', ')}`);
                    assert.ok(Math.max(...size.primaryCardHeights) <= 190,
                        `the first KPI row is too tall at ${size.width}px`);
                    // Values readable but not oversized; top row aligned on the row below.
                    assert.ok(size.primaryValueFontSizes.every(fontSize => fontSize >= 24 && fontSize <= 36),
                        `primary values should stay between 24 and 36 px at ${size.width}px: ${size.primaryValueFontSizes}`);
                    assert.deepEqual(size.primaryGridEdges, size.secondaryGridEdges,
                        `primary KPI row should align with the insight row at ${size.width}px`);
                    assert.ok(Math.max(...size.secondaryCardWidths) - Math.min(...size.secondaryCardWidths) <= 1,
                        `the five insight cards should share one width at ${size.width}px: ${size.secondaryCardWidths}`);
                    // The cash card no longer sets the row height (at most its colour bar taller).
                    assert.ok(size.cashCardContentHeight - size.rankingCardContentHeight <= 20,
                        `the cash card is too tall at ${size.width}px: ${size.cashCardContentHeight} vs ${size.rankingCardContentHeight}`);
                    assert.ok(size.chartTop <= 620, `chart starts too low at ${size.width}px`);
                }
            }
        }
    }
    await writeFile(path.join(root, `audit/investments-preview-results${outputSuffix}.json`), JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(results, null, 2));
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
