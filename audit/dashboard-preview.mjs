// Isolated UI validation: real HTML/CSS/renderers with deterministic demo data.
// No Firebase login, production data, or writes. Pass a local Playwright module
// directory as argv[2] when Playwright isn't installed in the project.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
    try {
        const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
        if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
        let data = await readFile(file);
        if (file.endsWith('dashboard.html')) data = data.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
        res.setHeader('Content-Type', (mime[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8');
        res.end(data);
    } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
    const address = `http://127.0.0.1:${server.address().port}`;
    await page.goto(address + '/dashboard.html');
    await page.addScriptTag({ url: address + '/src/sidebar-render.js' });
    await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js' });
    await page.evaluate(async () => {
        window.firebase = { apps: [], initializeApp() {}, auth: () => ({ currentUser: null }), firestore: () => ({}) };
        const { DashboardApp } = await import('/src/dashboardApp.js');
        const { DEFAULT_DASHBOARD_INDICES } = await import('/src/appDataContext.js');
        const { MarketTicker, selectPortfolioMovers } = await import('/src/marketTicker.js');
        const { ChartKPIManager } = await import('/src/chartKPIManager.js');
        const { UIComponents } = await import('/src/ui.js');
        const { mountViewToggle } = await import('/src/chartViewToggle.js');
        const app = Object.create(DashboardApp.prototype);
        const prices = [6000, 21000, 8000, 5200, 75000, 2600, 1.10];
        const fixed = Date.parse('2026-10-09T18:00:00Z');
        const quotes = Object.fromEntries(DEFAULT_DASHBOARD_INDICES.map((idx, i) => [idx.ticker, {
            price: prices[i], previousClose: prices[i] / (1 + (i % 2 ? -.003 : .006)),
            currency: idx.format === 'crypto' ? 'EUR' : 'USD', quoteAsOf: fixed,
            exchangeTimezone: 'America/New_York', regularSession: { startMs: fixed - 5 * 3600000, endMs: fixed + 2 * 3600000 },
            fetchedAt: fixed, changeBasis: idx.format === 'crypto' ? 'Depuis 00:00 UTC' : 'Clôture de la séance précédente', source: 'Démonstration'
        }]));
        app.storage = { currentData: {}, setCurrentPrice(t, q) { this.currentData[t] = q; },
            getWatchlistGroups: () => [{ name: 'Tech Europe', tickers: ['ASML.AS'] }, { name: 'Favoris', tickers: ['ASML.AS', 'MC.PA'] }],
            getWatchlist: () => [{ ticker: 'ASML.AS', name: 'ASML' }, { ticker: 'MC.PA', name: 'LVMH' }] };
        app.getMarketStatus = () => 'MARKET_OPEN';
        app.api = { fetchIndexDataForDashboard: async ticker => quotes[ticker] };
        app.marketTicker = new MarketTicker(document.getElementById('market-ticker'), item => app.selectTickerAsset(item));
        app.chartKPIManager = { generateSparkline: ChartKPIManager.prototype.generateSparkline,
            fetchIndexData: async ticker => ({ values: Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 6 + ticker.length) * 2 + (ticker.length % 2 ? i : -i) * .05) }) };
        app.chart = { currentMode: 'portfolio', selectedAssets: [], showAssetChart: async ticker => { app.chart.currentMode = 'asset'; app.chart.selectedAssets = [ticker]; document.getElementById('chart-title-text').textContent = ticker; }, showIndex: async (ticker, name) => { app.chart.currentMode = 'index'; app.chart.selectedAssets = [ticker]; document.getElementById('chart-title-text').textContent = name; }, showPortfolioChart: async () => { app.chart.currentMode = 'portfolio'; app.chart.selectedAssets = []; document.getElementById('chart-title-text').textContent = 'Portefeuille global'; } };
        app.setupEventListeners(); app.setupIndicesModal(); app.setupKPIModals();
        await app.loadMarketIndices();
        await new Promise(r => setTimeout(r, 50));
        const holdings = [
            { name: 'ETF Monde', ticker: 'WORLD', quantity: 200, gainPct: 28.2, currentValue: 24000, currentPrice: 120, assetType: 'ETF', displayDayPct: .62, displayDayChange: 148.1 },
            { name: 'Alphabet', ticker: 'GOOGL', quantity: 40, gainPct: 18.4, currentValue: 6200, currentPrice: 155, assetType: 'Stock', displayDayPct: 1.84, displayDayChange: 112.3 },
            { name: 'Riber', ticker: 'ALRIB.PA', quantity: 100, gainPct: -38.5, currentValue: 810, currentPrice: 8.1, assetType: 'Stock', displayDayPct: -2.41, displayDayChange: -20 },
            { name: 'Applied Materials', ticker: 'AMAT', quantity: 3, gainPct: 213, currentValue: 1366, currentPrice: 455.45, assetType: 'Stock', displayDayPct: 3.12, displayDayChange: 41.3 },
            { name: 'Bitcoin', ticker: 'BTC-EUR', quantity: .068, gainPct: -5.4, currentValue: 5100, currentPrice: 75000, assetType: 'Crypto', displayDayPct: .82, displayDayChange: 41.5 }
        ];
        app.marketTicker.update(selectPortfolioMovers(holdings, {
            now: fixed, priceQuotes: new Map(holdings.map(h => [h.ticker, { lastUpdate: fixed - 3 * 60000 }]))
        }));
        const impacts = [48.1, 72.3, -20, 21.3, 21.1];
        app.renderDailyContributions({ status: 'valid', totalValue: 37865, dayPnl: 142.8,
            positions: holdings.map((h, i) => ({ ...h, dayPnl: impacts[i], dayPnlPct: h.displayDayPct })) });
        app.renderKPIs({}, 389, holdings); app.renderAllocation(holdings, 389);
        app.lastPortfolioSnapshot = { status: 'valid', totalValue: 37865, dayPnl: 142.8,
            positions: holdings.map((holding, index) => ({ ...holding, dayPnl: impacts[index], dayPnlPct: holding.displayDayPct })) };
        app._radarNews = [{ title: 'Riber annonce une mise à jour de ses activités', assetName: 'Riber',
            source: 'Source de démonstration', datetime: Date.now() / 1000 }];
        app._radarNewsLoaded = true;
        app.globalNews = [{ title: 'Les marchés européens réagissent aux perspectives de taux',
            source: 'Source macro de démonstration', datetime: Date.now() / 1000, url: 'https://example.org/macro' }];
        app._radarMacroLoaded = true;
        app._earningsEvents = [{ ticker: 'AMAT', name: 'Applied Materials', providerSymbol: 'AMAT',
            date: Date.now() + 7 * 86400000, estimated: true }];
        app._earningsLoadStatus = 'ready';
        app.renderPortfolioRadar(); app.renderMacroRadar(); app.renderEarningsRadar();
        app._radarAnalysis = { text: 'Le portefeuille gagne 142,80 €, principalement grâce à Alphabet (+72,30 €). Riber perd 20 € ; l’article récent à son sujet ne prouve pas la cause de cette baisse.',
            sources: [{ title: 'Source de démonstration', url: 'https://example.org/riber' }],
            reason: 'point régulier', createdAt: Date.now() };
        app.renderPortfolioRadarAnalysis();
        const ui = new UIComponents(app.storage, {});
        ui._updateTotalValueModal = () => {};
        ui.updateTopKPIs({ totalCurrentEUR: 37865, totalInvestedEUR: 28000, gainTotal: 9865, gainPct: 35.23, totalDayChangeEUR: 142.8, dayChangePct: .38 }, 389, null);
        // Portfolio 1D, as chartKPIManager leaves it: group 2 shown but empty.
        document.querySelector('.stat-group-2').style.display = 'flex';
        document.getElementById('unit-price-row').style.display = 'none';
        document.getElementById('last-update').className = 'chart-status is-fresh is-live';
        document.getElementById('last-update').innerHTML = '<span class="chart-status-dot" aria-hidden="true"></span><span class="chart-status-text">À jour · 13:49</span>';
        document.getElementById('stat-group-ath').hidden = false;
        for (const [id, value] of Object.entries({ 'ath-total-value': '38 008,70 €', 'ath-total-return': '+8 972,05 €', 'ath-total-return-pct': '+31,32 %', 'ath-date': '6 oct. · 09:00', 'ath-gap': '-1,39 %' })) document.getElementById(id).textContent = value;
        document.getElementById('chart-loading').style.display = 'none';
        document.getElementById('performance-label').textContent = '+142,80 €';
        document.getElementById('performance-percent').textContent = '+0,40 %';
        for (const [id, value] of Object.entries({ 'price-start': '37 722,20 €', 'price-end': '37 865,00 €', 'price-high': '37 900,00 €', 'price-low': '37 700,00 €' })) document.getElementById(id).textContent = value;
        mountViewToggle(document.getElementById('view-toggle'), 'portfolio', () => {});
        document.getElementById('view-toggle').style.display = 'flex';
        app.renderNewsList(document.getElementById('news-portfolio-container'), [], 'portfolio');
        app.showNewsState(document.getElementById('news-portfolio-container'), 'Aucune actualité récente pour cette sélection.');
        app.renderNewsList(document.getElementById('news-global-container'), [], 'global');
        app.showNewsState(document.getElementById('news-global-container'), 'Actualités indisponibles.', () => {});
        const values = Array.from({ length: 80 }, (_, i) => .04 + i * .004 + Math.sin(i * .6) * .025 + Math.sin(i * 2.7) * .006);
        new Chart(document.getElementById('historical-portfolio-chart'), {
            type: 'line', data: { labels: values.map((_, i) => `${9 + Math.floor(i / 9)}:${String(i % 9 * 6).padStart(2, '0')}`), datasets: [{ data: values, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.09)', fill: true, pointRadius: 0, borderWidth: 2, tension: .15 }] },
            options: { animation: false, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#a6b2ca', maxTicksLimit: 8 }, grid: { display: false } }, y: { ticks: { color: '#a6b2ca', callback: v => v.toFixed(2) + ' %' }, grid: { color: '#28364b' } } } }
        });
        window.previewDashboard = app;
    });
    await page.mouse.move(0, 0);
    const results = [];
    for (const width of [1920, 1366, 768, 390, 360]) {
        await page.setViewportSize({ width, height: 1080 });
        await page.waitForTimeout(250);
        const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
            startVisible: !!document.getElementById('price-start').offsetParent,
            contributionsVisible: !!document.querySelector('.contribution-kpi-card')?.offsetParent,
            contributionsStatus: document.getElementById('dashboard-contributions').dataset.status,
            highlights: document.querySelectorAll('.contribution-kpi-row').length,
            cardCount: document.querySelectorAll('.dashboard-kpi-grid-v2 > .kpi-card').length,
            cardRows: new Set([...document.querySelectorAll('.dashboard-kpi-grid-v2 > .kpi-card')].map(el => Math.round(el.getBoundingClientRect().top))).size,
            panelHeight: Math.round(document.querySelector('.dashboard-indices-panel-full').getBoundingClientRect().height),
            leftHeight: Math.round(document.querySelector('.dashboard-left-column').getBoundingClientRect().height),
            sparklines: document.querySelectorAll('.market-card-spark svg').length,
            badgeAtRight: (() => {
                const header = document.querySelector('.dashboard-chart-section .chart-header').getBoundingClientRect();
                const badge = document.getElementById('last-update').getBoundingClientRect();
                const style = getComputedStyle(document.querySelector('.dashboard-chart-section .chart-header'));
                return badge.width > 0 && Math.abs(header.right - parseFloat(style.paddingRight) - badge.right) < 4;
            })(),
            periodsUnderStats: (() => {
                const bar = document.querySelector('.dashboard-chart-section .chart-controls');
                return !!bar && bar.getBoundingClientRect().top >= document.querySelector('.dashboard-chart-section .chart-stats-bar').getBoundingClientRect().bottom - 1;
            })(),
            dayVarShown: !!document.getElementById('stat-day-var'),
            emptyGroupShown: getComputedStyle(document.querySelector('.stat-group-2')).display !== 'none',
            loopCopy: getComputedStyle(document.querySelector('.market-ticker-copy')).display,
            panelEdges: (r => [Math.round(r.left), Math.round(r.right)])(document.querySelector('.dashboard-indices-panel-full').getBoundingClientRect()),
            lastCardEdges: (r => [Math.round(r.left), Math.round(r.right)])(document.querySelector('.dashboard-kpi-grid-v2 > .kpi-card:last-child').getBoundingClientRect()),
            main: document.querySelector('.main-content').getBoundingClientRect().width,
            overflowingValues: [...document.querySelectorAll('.summary-card-value')].filter(el => el.scrollWidth > el.clientWidth + 1).length
        }));
        assert.match(await page.locator('#dashboard-radar-news').textContent(), /Riber annonce une mise à jour/);
        assert.match(await page.locator('#dashboard-radar-earnings').textContent(), /Applied Materials/);
        assert.match(await page.locator('#dashboard-radar-ai-text').textContent(), /Alphabet/);
        assert.equal(await page.locator('#dashboard-radar-ai-sources a').count(), 1);
        assert.match(await page.locator('#dashboard-radar-preview').textContent(), /marchés européens/);
        assert.match(await page.locator('#dashboard-radar-macro').textContent(), /perspectives de taux/);
        assert.equal(size.scroll, width, `page overflow at ${width}`);
        assert.equal(size.overflowingValues, 0, `KPI overflow at ${width}`);
        if (width >= 1200) assert.equal(size.panelEdges[1], size.lastCardEdges[1], `markets panel right edge not aligned with the KPI grid at ${width}`);
        // Small screens: manual swipe only, no looping copy.
        if (width <= 768) assert.equal(size.loopCopy, 'none');
        assert.equal(size.startVisible, true, `period stats hidden at ${width}`);
        assert.equal(size.dayVarShown, false, 'VAR. JOUR duplicates Période on the dashboard');
        assert.equal(size.emptyGroupShown, false, `empty stats group takes a column at ${width}`);
        if (width > 768) assert.equal(size.badgeAtRight, true, `freshness badge not at the right end of the chart header at ${width}`);
        assert.equal(size.periodsUnderStats, true, `period bar not under the stats bar at ${width}`);
        assert.equal(size.contributionsVisible, true, `daily contributions hidden at ${width}`);
        assert.equal(size.contributionsStatus, 'complete', `daily contributions do not reconcile at ${width}`);
        assert.equal(size.highlights, 3, `daily top/worst preview missing at ${width}`);
        assert.equal(size.cardCount, 6, `six cards missing at ${width}`);
        if (width >= 900) assert.equal(size.cardRows, 2, `six cards do not fit two rows at ${width}`);
        if (width > 1200) assert.ok(Math.abs(size.panelHeight - size.leftHeight) <= 2, `markets panel height ${size.panelHeight} vs ${size.leftHeight} at ${width}`);
        await page.locator('.contribution-kpi-card').click();
        assert.equal(await page.locator('#contributions-modal').isVisible(), true, `contribution detail closed at ${width}`);
        const impactVisible = await page.evaluate(() => document.querySelector('.contributions-table tbody td:last-child').getBoundingClientRect().right
            <= document.querySelector('.contributions-table-wrap').getBoundingClientRect().right + 1);
        assert.equal(impactVisible, true, `daily impact hidden at ${width}`);
        await page.locator('#close-contributions-modal').click();
        await page.locator('.dashboard-radar-card').click();
        assert.equal(await page.locator('#dashboard-radar-modal').isVisible(), true, `radar detail closed at ${width}`);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'close-dashboard-radar-modal');
        const radarBox = await page.locator('.dashboard-radar-modal .kpi-modal-box').evaluate(el => {
            const rect = el.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, width: rect.width, innerHeight };
        });
        assert.ok(radarBox.top >= 0 && radarBox.bottom <= radarBox.innerHeight + 1, `radar dialog outside viewport at ${width}: ${JSON.stringify(radarBox)}`);
        if ([1366, 390].includes(width)) await page.screenshot({ path: path.join(root, `audit/dashboard-radar-modal-${width}.png`) });
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#dashboard-radar-modal').isVisible(), false);
        await page.locator('#add-index-btn').click();
        assert.equal(await page.locator('body').evaluate(el => el.classList.contains('market-dialog-open')), true);
        const picker = await page.evaluate(() => {
            const modal = document.querySelector('.add-index-modal').getBoundingClientRect();
            const tabs = [...document.querySelectorAll('.index-tab')].map(el => el.getBoundingClientRect());
            const grid = document.getElementById('add-index-grid');
            return { tabsInside: tabs.every(tab => tab.left >= modal.left - 1 && tab.right <= modal.right + 1),
                modalInside: modal.left >= 0 && modal.right <= innerWidth && modal.top >= 0 && modal.bottom <= innerHeight,
                gridOverflow: grid.scrollWidth > grid.clientWidth + 1,
                addedLabel: document.querySelector('.add-index-item.already-added .add-index-item-action')?.textContent.trim() };
        });
        assert.equal(picker.tabsInside, true, `market categories overflow at ${width}`);
        assert.equal(picker.modalInside, true, `market dialog outside viewport at ${width}`);
        assert.equal(picker.gridOverflow, false, `market list overflows horizontally at ${width}`);
        assert.equal(picker.addedLabel, 'Ajouté', `followed markets unclear at ${width}`);
        if ([1920, 1366, 390].includes(width)) await page.screenshot({ path: path.join(root, `audit/dashboard-modal-preview-${width}.png`) });
        await page.locator('#add-index-search').fill('Dow');
        assert.equal(await page.locator('.add-index-item').count(), 1, `market search failed at ${width}`);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#add-index-modal').isVisible(), false, `market dialog did not close at ${width}`);
        assert.equal(await page.locator('body').evaluate(el => el.classList.contains('market-dialog-open')), false);
        results.push(size);
        if ([1920, 1366, 390].includes(width)) await page.screenshot({ path: path.join(root, `audit/dashboard-preview-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    // Hovered market card: no blue fill, tools in one row inside the card.
    await page.locator('.market-card').nth(3).hover();
    await page.waitForTimeout(250);
    const hovered = await page.locator('.market-card').nth(3).evaluate(card => {
        const tools = [...card.querySelectorAll('.market-card-actions button')].map(b => b.getBoundingClientRect());
        const box = card.getBoundingClientRect();
        return { fill: getComputedStyle(card.querySelector('.market-card-open')).backgroundColor,
            sameRow: new Set(tools.map(r => Math.round(r.top))).size === 1,
            inside: tools.every(r => r.right <= box.right && r.top >= box.top) };
    });
    assert.notEqual(hovered.fill, 'rgb(37, 99, 235)', 'market card turns blue on hover');
    assert.ok(hovered.sameRow && hovered.inside, 'market card tools are misplaced');
    await page.locator('.dashboard-indices-panel-full').screenshot({ path: path.join(root, 'audit/dashboard-preview-market-hover.png') });
    // Reordering keeps the list and page where they are, and the arrow focused.
    const list = page.locator('#market-overview-container');
    await list.evaluate(el => { el.scrollTop = 120; });
    const beforeMove = await page.evaluate(() => ({ list: document.getElementById('market-overview-container').scrollTop, page: scrollY }));
    const arrow = page.locator('.market-card').nth(2).locator('.market-card-move-down');
    await page.locator('.market-card').nth(2).hover();
    await arrow.click();
    await arrow.click();
    const after = await page.evaluate(() => ({ list: document.getElementById('market-overview-container').scrollTop, page: scrollY,
        focused: document.activeElement?.classList.contains('market-card-move-down') }));
    assert.equal(after.page, beforeMove.page, 'reordering scrolled the page');
    assert.ok(Math.abs(after.list - beforeMove.list) < 300 && after.list > 0, `reordering jumped the list to ${after.list}`);
    assert.equal(after.focused, true, 'reordering lost the arrow focus');
    await page.setViewportSize({ width: 1366, height: 1080 });
    await page.mouse.move(0, 0);
    // Ticker: auto-scroll, pause, click-and-drag and trackpad scrolling all
    // move the same scroll position; a drag never opens an asset.
    const tickerScroll = () => page.locator('.market-ticker-viewport').evaluate(el => el.scrollLeft);
    let before = await tickerScroll();
    await page.waitForTimeout(1500);
    assert.ok(await tickerScroll() !== before, 'ticker does not auto-scroll');
    await page.locator('[data-ticker-pause]').click();
    await page.mouse.move(0, 0);
    before = await tickerScroll();
    await page.waitForTimeout(800);
    assert.equal(await tickerScroll(), before, 'paused ticker still moves');
    const box = await page.locator('.market-ticker-viewport').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 220, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.ok(Math.abs(await tickerScroll() - before) >= 200, 'click-and-drag does not scroll the ticker');
    assert.equal(await page.locator('#chart-title-text').textContent(), 'Portefeuille global', 'a drag opened an asset');
    before = await tickerScroll();
    await page.mouse.wheel(180, 0);
    await page.waitForTimeout(200);
    assert.ok(await tickerScroll() !== before, 'horizontal trackpad scroll does not move the ticker');
    await page.mouse.move(0, 0);
    await page.locator('[data-ticker-pause]').click();
    await page.mouse.move(0, 0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.market-ticker-copy').evaluate(el => getComputedStyle(el).display), 'none');
    await page.locator('.market-ticker-group:not(.market-ticker-copy) button').first().click();
    await page.locator('#dashboard-back-portfolio').click();
    assert.equal(await page.locator('#chart-title-text').textContent(), 'Portefeuille global');
    await page.locator('#add-index-btn').click();
    assert.equal(await page.locator('#add-index-modal').isVisible(), true);
    await page.locator('.index-tab[data-tab="Watchlist"]').click();
    assert.equal(await page.locator('.add-index-item').count(), 2, 'watchlist duplicates in the market dialog');
    assert.match(await page.locator('.add-index-item[data-ticker="ASML.AS"] .add-index-item-ticker').textContent(), /Tech Europe.*Favoris/);
    await page.locator('.index-tab[data-tab="Indices"]').click();
    await page.locator('#add-index-search').fill('Dow');
    await page.locator('.add-index-item[data-ticker="^DJI"]').click();
    assert.equal(await page.locator('#add-index-modal').isVisible(), true, 'market dialog closes after adding one asset');
    assert.equal(await page.locator('.add-index-item[data-ticker="^DJI"]').isDisabled(), true);
    assert.match(await page.locator('#add-index-count').textContent(), /1 déjà suivi/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#add-index-modal').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'add-index-btn');
    await page.locator('.contribution-kpi-card').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#contributions-modal').isVisible(), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'close-contributions-modal');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#contributions-modal').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('contribution-kpi-card')), true);
    assert.deepEqual(errors, []);
    await writeFile(path.join(root, 'audit/dashboard-preview-results.json'), JSON.stringify({ scope: 'Isolated deterministic UI, no authenticated session', sizes: results, errors, checks: ['pause control', 'ticker auto-scroll, drag and trackpad scroll', 'reduced motion', 'ticker asset selection and back', 'period stats visible at all sizes', 'five KPI cards', 'contribution preview and full table', 'contribution dialog keyboard access', 'markets panel matches left column', 'market dialog responsive layout, search, watchlist, multi-add and keyboard access'] }, null, 2));
    console.log(JSON.stringify(results));
} finally { await browser.close(); server.close(); }
