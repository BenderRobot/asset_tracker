// ========================================
// historicalChart.js — Portfolio chart + its KPI panel
// ========================================
//
// SINGLE SOURCE OF TRUTH RULE (the whole reason this file was rewritten):
// exactly ONE call resolves "today's" portfolio data per update() cycle —
// _resolveTodayData(). That same object feeds:
//   - the visible curve (when the 1D tab is active, it IS the curve's data —
//     no second fetch)
//   - the top KPI cards (TOTAL VALUE / TOTAL RETURN / VAR TODAY), via
//     portfolioKPIs
//   - the chart's own stats panel (FIN / DÉBUT / HAUT / BAS / PÉRIODE /
//     VAR. JOUR / CLÔTURE HIER), via chartKPIManager
//   - the table's "Day P&L" column (yesterdayCloseMap), via
//     dataManager.calculateHoldings
// No other code path in this file computes "today's change" a second,
// independent way. That duplication — not any single formula — was the root
// cause of every table/KPI/chart mismatch found in this app.

import { eventBus } from './eventBus.js';
import { ChartKPIManager } from './chartKPIManager.js';
import { MarketStatus } from './marketStatus.js?v=3';
import { renderCompanyLogo } from './logoUtils.js';
import { portfolioKPIs } from './portfolioKPIs.js';
import { getMarketOpenUTCHour, isCryptoTicker } from './MarketUtils.js';

const AUTO_REFRESH_FIRST_MS = 30 * 1000;
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export class HistoricalChart {
    constructor(storage, dataManager, ui, investmentsPage) {
        this.storage = storage;
        this.dataManager = dataManager;
        this.ui = ui;
        this.investmentsPage = investmentsPage;
        this.api = dataManager.api;
        this.filterManager = investmentsPage.filterManager;
        this.marketStatus = new MarketStatus(storage);
        this.kpiManager = new ChartKPIManager(this.api, storage, dataManager, this.marketStatus);

        this.chart = null;
        this.currentPeriod = 1;
        this.currentMode = 'portfolio'; // 'portfolio' | 'asset' | 'index'
        this.selectedAssets = [];
        this.zoomModeEnabled = false; // drag-to-zoom toggle, see _injectSelectionToggle (drag-to-compare is the default, always on)
        this._isZoomed = false; // true once a drag-zoom has actually been applied to the current chart
        this.currentBenchmark = null;
        this.customTitle = null;

        this.isLoading = false;
        this._pendingUpdate = null;
        this._autoRefreshTimeout = null;
        this._autoRefreshInterval = null;
        this.lastRefreshTime = null;

        this._onShowAsset = (e) => {
            this.showAssetChart(e.detail.ticker);
        };
        this._onClearAsset = () => {
            this.showPortfolioChart();
        };
        eventBus.addEventListener('showAssetChart', this._onShowAsset);
        eventBus.addEventListener('clearAssetChart', this._onClearAsset);
    }

    destroy() {
        this.stopAutoRefresh();
        eventBus.removeEventListener('showAssetChart', this._onShowAsset);
        eventBus.removeEventListener('clearAssetChart', this._onClearAsset);
        if (this.chart) { this.chart.destroy(); this.chart = null; }
    }

    // Public API expected by investmentsPage.js (row click -> drill into one
    // asset's chart) and by the eventBus 'showAssetChart'/'clearAssetChart'
    // events (filters.js and others) — both paths go through these same two
    // methods, so there is exactly one way to switch the chart's mode.
    async showAssetChart(ticker) {
        this.currentMode = 'asset';
        this.selectedAssets = [ticker];
        await this.update(true, false);
    }

    async showPortfolioChart() {
        this.currentMode = 'portfolio';
        this.selectedAssets = [];
        this.currentBenchmark = null;
        const benchmarkSelect = document.getElementById('benchmark-select');
        if (benchmarkSelect) benchmarkSelect.value = '';
        await this.update(true, false);
    }

    getFilteredPurchasesFromPage(ignoreTickerFilter = false) {
        return this.investmentsPage.getFilteredPurchasesFromPage(ignoreTickerFilter);
    }

    // ========================================================
    // Auto-refresh
    // ========================================================
    startAutoRefresh() {
        this.stopAutoRefresh();
        if (this.currentPeriod !== 1) return;
        this._autoRefreshTimeout = setTimeout(() => {
            if (this.currentPeriod === 1) this.silentUpdate();
        }, AUTO_REFRESH_FIRST_MS);
        this._autoRefreshInterval = setInterval(() => {
            if (this.currentPeriod === 1) this.silentUpdate();
        }, AUTO_REFRESH_INTERVAL_MS);
    }

    stopAutoRefresh() {
        if (this._autoRefreshTimeout) { clearTimeout(this._autoRefreshTimeout); this._autoRefreshTimeout = null; }
        if (this._autoRefreshInterval) { clearInterval(this._autoRefreshInterval); this._autoRefreshInterval = null; }
    }

    async silentUpdate() {
        if (this.isLoading) return;
        const now = Date.now();
        if (this.lastRefreshTime && (now - this.lastRefreshTime) < 4 * 60 * 1000) return;
        this.lastRefreshTime = now;
        try { await this.update(false, true); }
        catch (err) { console.warn('[HistoricalChart] silentUpdate failed:', err); }
    }

    async changePeriod(days) {
        if (this.isLoading) return;
        this.currentPeriod = days;
        this.stopAutoRefresh();
        await this.update(true, true);
        this.startAutoRefresh();
    }

    // Binds the period-tab buttons (1J/2J/1W/.../All) directly to changePeriod().
    // Called once by app.js on the Investments page (the Dashboard binds its own
    // buttons inline instead, since it also needs to sync desktop+mobile button
    // sets — see dashboardApp.js).
    setupPeriodButtons() {
        document.querySelectorAll('.period-btn').forEach(btn => {
            const newBtn = btn.cloneNode(true); // drop any previously-attached listener
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', (e) => {
                if (newBtn.classList.contains('period-disabled')) return;
                document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b === newBtn));
                const raw = newBtn.dataset.period;
                this.changePeriod((raw === 'all' || raw === 'ytd') ? raw : parseInt(raw));
            });
        });
        this.updatePeriodButtonsAvailability();
    }

    // Called on the Investments page's initial blocking load, once prices have
    // already been fetched/synced moments earlier — a plain update() with
    // forceApi=false avoids re-fetching live prices a second time right away.
    async loadPageWithCacheFirst() {
        await this.update(false, false);
    }

    // Dashboard market-index cards (CAC40, S&P500...) switch the chart into
    // index mode for that ticker.
    async showIndex(ticker, displayName) {
        this.currentMode = 'index';
        this.selectedAssets = [ticker];
        this.customTitle = displayName ? { label: displayName } : null;
        await this.update(true, true);
    }

    // Year buttons (1Y/2Y/3Y/...) should only exist once the account is
    // genuinely that old — a 3Y button is meaningless noise on a portfolio that
    // started 8 months ago. The fixed 1Y/2Y/3Y buttons already in the page are
    // hidden until their anniversary; once the account passes 3 years, a new
    // "NY" button is created for each additional full year, right before "All",
    // so the list grows one button per birthday instead of staying capped.
    updatePeriodButtonsAvailability() {
        this._injectSelectionToggle();

        const firstPurchase = this.storage.getPurchases()
            .map(p => new Date(p.date))
            .filter(d => !isNaN(d.getTime()))
            .sort((a, b) => a - b)[0];
        if (!firstPurchase) return;

        const ageDays = Math.floor((Date.now() - firstPurchase.getTime()) / (24 * 60 * 60 * 1000));
        const ageYears = Math.floor(ageDays / 365);
        const fixedYearDays = { '365': 1, '730': 2, '1095': 3 };

        document.querySelectorAll('.period-btn[data-period]').forEach(btn => {
            const requiredYears = fixedYearDays[btn.dataset.period];
            if (requiredYears !== undefined) {
                const eligible = ageYears >= requiredYears;
                btn.style.display = eligible ? '' : 'none';
                // The 3Y button ships with "period-disabled" hardcoded in the HTML
                // (blocks clicks regardless of visibility) — clear it once the
                // account is actually old enough, or the button stays inert even
                // though it's now shown.
                btn.classList.toggle('period-disabled', !eligible);
            }
        });

        const containers = new Set();
        document.querySelectorAll('.period-btn').forEach(btn => containers.add(btn.parentNode));

        containers.forEach(container => {
            // Drop dynamic buttons from a previous call before re-adding, so
            // re-running this (e.g. on a later page load) never duplicates them.
            container.querySelectorAll('.period-btn[data-dynamic-year]').forEach(b => b.remove());
            const allBtn = container.querySelector('.period-btn[data-period="all"]');
            if (!allBtn) return;

            for (let y = 4; y <= ageYears; y++) {
                const btn = document.createElement('button');
                btn.className = 'period-btn';
                btn.dataset.period = String(y * 365);
                btn.dataset.dynamicYear = 'true';
                btn.textContent = `${y}Y`;
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
                    document.querySelectorAll(`.period-btn[data-period="${y * 365}"]`).forEach(b => b.classList.add('active'));
                    this.changePeriod(y * 365);
                });
                allBtn.parentNode.insertBefore(btn, allBtn);
            }
        });
    }

    // A small toggle dropped next to the period buttons (1J/2J/1M/...), one
    // per container so it shows up wherever those buttons do (desktop +
    // mobile rows on Dashboard, the single row on Investments). Drag-to-
    // compare (Total Value/Return/Variation for the dragged slice) is
    // always on by default — this toggle repurposes that same drag into a
    // zoom instead, for whoever wants to actually narrow the displayed
    // range rather than just read it off.
    _injectSelectionToggle() {
        const containers = new Set();
        document.querySelectorAll('.period-btn').forEach(btn => containers.add(btn.parentNode));

        containers.forEach(container => {
            if (container.querySelector('.selection-mode-toggle')) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'period-btn selection-mode-toggle';
            btn.addEventListener('click', () => {
                // Once a zoom is actually applied, the button's job switches
                // from "arm zoom mode" to "undo it" — a second click always
                // takes you back to the view from before the zoom, rather
                // than requiring a double-click on the chart itself.
                if (this._isZoomed) { this._resetZoom?.(); return; }
                this.zoomModeEnabled = !this.zoomModeEnabled;
                this._updateSelectionToggleUI();
            });
            container.appendChild(btn);
        });
        this._updateSelectionToggleUI();
    }

    // Reflects the current zoom state on every injected toggle button (there
    // can be more than one — desktop + mobile rows) and on the canvas cursor.
    _updateSelectionToggleUI() {
        document.querySelectorAll('.selection-mode-toggle').forEach(b => {
            if (this._isZoomed) {
                b.classList.add('active');
                b.title = 'Réinitialiser le zoom';
                b.innerHTML = '<i class="fa-solid fa-magnifying-glass-minus"></i>';
            } else {
                b.classList.toggle('active', !!this.zoomModeEnabled);
                b.title = 'Activer le zoom par glisser-déposer';
                b.innerHTML = '<i class="fa-solid fa-magnifying-glass-plus"></i>';
            }
        });
        if (this._canvasEl) this._canvasEl.style.cursor = this.zoomModeEnabled ? 'zoom-in' : 'crosshair';
    }

    getStartEndTs(days) {
        const today = new Date();
        const endTs = Math.floor(Date.now() / 1000);
        if (days === 1) {
            const openUTCHour = getMarketOpenUTCHour(9, 'Europe/Paris', today);
            const h = Math.floor(openUTCHour), m = Math.round((openUTCHour - h) * 60);
            const startTs = Math.floor(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), h, m, 0) / 1000);
            return { startTs, endTs };
        }
        const daysBack = (days === 'ytd')
            ? Math.ceil((Date.now() - new Date(today.getFullYear(), 0, 1).getTime()) / 86400000)
            : (days === 'all' ? 3650 : (typeof days === 'number' ? days : 365));
        return { startTs: endTs - daysBack * 86400, endTs };
    }

    showMessage(msg) {
        const info = document.getElementById('chart-info');
        if (info) { info.style.display = 'block'; info.textContent = msg; }
    }

    // ========================================================
    // THE single resolver for "today" — reused for the curve (1D tab), the top
    // KPIs and the table's day-change column. Never called a second, separate
    // way anywhere else in this file.
    // ========================================================
    async _resolveTodayData(assetPurchases, cashPurchases, isSingleAsset, existingGraphData) {
        if (this.currentPeriod === 1 && existingGraphData) return existingGraphData;
        const purchases = isSingleAsset ? assetPurchases : [...assetPurchases, ...cashPurchases];
        return this.dataManager.calculateHistory(purchases, 1);
    }

    // ========================================================
    // update() — builds graphData for whichever mode is active, then renders.
    // ========================================================
    async update(showLoading = true, forceApi = true) {
        if (this.isLoading) { this._pendingUpdate = { showLoading, forceApi }; return; }
        const canvas = document.getElementById('historical-portfolio-chart');
        if (!canvas) return;
        this.isLoading = true;

        const loading = document.getElementById('chart-loading');
        const info = document.getElementById('chart-info');
        const benchmarkWrapper = document.getElementById('benchmark-wrapper');
        if (showLoading) { if (loading) loading.style.display = 'flex'; if (info) info.style.display = 'none'; }

        try {
            let graphData = null;
            let todayGraphData = null;
            let targetHoldings = [];
            let targetSummary = {};
            let targetCashReserve = { total: 0 };
            let titleConfig;
            let isSingleAsset = false;
            let isIndexMode = (this.currentMode === 'index');
            let currentTicker = null;

            if (this.currentMode === 'portfolio' && this.selectedAssets.length === 0) this.lastYesterdayClose = null;

            // === MODE INDICE ===
            if (isIndexMode && this.selectedAssets.length === 1) {
                isSingleAsset = true;
                currentTicker = this.selectedAssets[0];

                if (forceApi) {
                    const smart = await this.api.fetchIndexDataForDashboard(currentTicker);
                    if (smart) {
                        this.storage.setCurrentPrice(currentTicker, {
                            price: smart.price, previousClose: smart.previousClose,
                            currency: smart.currency, marketState: smart.marketState, lastUpdate: Date.now()
                        });
                    }
                }

                if (this.currentPeriod === 1) {
                    const indexData = await this.kpiManager.fetchIndexData(currentTicker, '1D');
                    graphData = { labels: indexData.labels, values: indexData.values, timestamps: indexData.timestamps, truePreviousClose: indexData.truePreviousClose };
                } else {
                    graphData = await this.dataManager.calculateIndexData(currentTicker, this.currentPeriod);
                }

                const currentPriceData = this.storage.getCurrentPrice(currentTicker);
                let indexPreviousClose = currentPriceData?.previousClose;
                if (!indexPreviousClose && graphData?.values?.length > 0 && this.currentPeriod === 1) indexPreviousClose = graphData.values[0];
                this.lastYesterdayClose = indexPreviousClose;

                if (graphData?.values?.length > 0) {
                    const currentPrice = graphData.values[graphData.values.length - 1];
                    const startPrice = graphData.values[0];
                    const diff = currentPrice - startPrice;
                    targetSummary = {
                        totalCurrentEUR: currentPrice, totalInvestedEUR: 0, gainTotal: diff,
                        gainPct: startPrice > 0 ? (diff / startPrice) * 100 : 0,
                        totalDayChangeEUR: indexPreviousClose ? currentPriceData.price - indexPreviousClose : diff,
                        dayChangePct: indexPreviousClose > 0 ? ((currentPriceData.price - indexPreviousClose) / indexPreviousClose) * 100 : 0
                    };
                }
                titleConfig = { mode: 'index', label: this.customTitle ? this.customTitle.label : currentTicker, icon: '🌎' };

            // === MODE ACTIF UNIQUE (drill-down depuis une ligne du tableau) ===
            } else if (this.currentMode === 'asset' && this.selectedAssets.length === 1) {
                isSingleAsset = true;
                currentTicker = this.selectedAssets[0];
                if (forceApi) await this.api.fetchBatchPrices([currentTicker]);

                const pagePurchases = this.getFilteredPurchasesFromPage(false);
                const targetAssetPurchases = pagePurchases.filter(p => {
                    const type = (p.assetType || 'Stock').toLowerCase();
                    return p.ticker.toUpperCase() === currentTicker.toUpperCase() &&
                        type !== 'cash' && type !== 'dividend' && p.type !== 'dividend' && type !== 'real estate';
                });

                graphData = targetAssetPurchases.length === 0
                    ? await this.dataManager.calculateAssetHistory(currentTicker, this.currentPeriod)
                    : await this.dataManager.calculateGenericHistory(targetAssetPurchases, this.currentPeriod, true);

                todayGraphData = await this._resolveTodayData(targetAssetPurchases, [], true, graphData);
                const yesterdayCloseMap = this.dataManager.buildYesterdayCloseMapFromGraphData(todayGraphData);
                targetHoldings = this.dataManager.calculateHoldings(targetAssetPurchases, yesterdayCloseMap);
                targetSummary = this.dataManager.calculateSummary(targetHoldings);

                const name = targetAssetPurchases[0]?.name || currentTicker;
                titleConfig = { mode: 'asset', label: `${currentTicker} • ${name}`, icon: this.dataManager.isCryptoTicker(currentTicker) ? '₿' : '📊' };

            // === MODE PORTFOLIO GLOBAL / FILTRÉ ===
            } else {
                titleConfig = this.investmentsPage.getChartTitleConfig();
                const allPurchases = this.getFilteredPurchasesFromPage(false);
                const assetPurchases = allPurchases.filter(p => {
                    const type = (p.assetType || 'Stock').toLowerCase();
                    return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend' && type !== 'real estate';
                });
                const cashPurchases = allPurchases.filter(p => {
                    const type = (p.assetType || 'Stock').toLowerCase();
                    return type === 'cash' || type === 'dividend' || p.type === 'dividend';
                });

                targetCashReserve = this.dataManager.calculateCashReserve(cashPurchases);
                if (titleConfig.mode === 'asset') {
                    isSingleAsset = true;
                    currentTicker = this.filterManager.getSelectedTickers().values().next().value;
                }

                if (forceApi) {
                    const tickers = [...new Set(assetPurchases.map(p => p.ticker.toUpperCase()))];
                    if (tickers.length > 0) await this.api.fetchBatchPrices(tickers);
                }

                graphData = await this.dataManager.calculateHistory([...assetPurchases, ...cashPurchases], this.currentPeriod);

                // SSOT: on the 1D tab this IS graphData (zero extra fetch); on any
                // other tab, one dedicated period=1 call — never a third, separate
                // "day change" computation anywhere downstream of this.
                todayGraphData = await this._resolveTodayData(assetPurchases, cashPurchases, false, graphData);
                const yesterdayCloseMap = this.dataManager.buildYesterdayCloseMapFromGraphData(todayGraphData);

                targetHoldings = this.dataManager.calculateHoldings(assetPurchases, yesterdayCloseMap);
                targetSummary = this.dataManager.calculateSummary(targetHoldings);
            }

            if (benchmarkWrapper) benchmarkWrapper.style.display = (isSingleAsset || isIndexMode) ? 'none' : 'block';

            if (!isIndexMode) {
                const stored = (isSingleAsset && currentTicker) ? this.storage.getCurrentPrice(currentTicker) : null;
                this.lastYesterdayClose = (isSingleAsset && stored?.previousClose)
                    ? stored.previousClose
                    : graphData?.yesterdayClose;
            }

            let benchmarkData = null;
            if (this.currentBenchmark && !isSingleAsset && !isIndexMode) {
                const { startTs, endTs } = this.getStartEndTs(this.currentPeriod);
                const interval = this.dataManager.getIntervalForPeriod ? this.dataManager.getIntervalForPeriod(this.currentPeriod) : '1d';
                benchmarkData = await this.api.getHistoricalPricesWithRetry(this.currentBenchmark, startTs, endTs, interval);
            }

            if (!graphData || !graphData.labels || graphData.labels.length === 0) {
                this.showMessage('Pas de données disponibles pour cette période');
            } else {
                const kpiData = this._computeAggregateKPIs({ targetSummary, targetCashReserve, todayGraphData });
                this.renderChart(canvas, graphData, targetSummary, titleConfig, benchmarkData, currentTicker, this.lastYesterdayClose, kpiData);

                if (!isSingleAsset && !isIndexMode) {
                    const statsToPass = { historicalDayChange: kpiData.varTodayAbs, historicalDayChangePct: kpiData.varTodayPct };
                    this.investmentsPage.renderData(targetHoldings, targetSummary, targetCashReserve.total, statsToPass);
                }
            }

            if (info) info.style.display = 'none';
        } catch (err) {
            console.error('[HistoricalChart] update failed:', err);
            this.showMessage('Erreur lors du calcul');
        } finally {
            if (loading) loading.style.display = 'none';
            this.isLoading = false;
            if (this._pendingUpdate) {
                const p = this._pendingUpdate; this._pendingUpdate = null;
                this.update(p.showLoading, p.forceApi);
            }
        }
    }

    // Aggregate "today" numbers (Total Value / Total Return / Var Today).
    //
    // SOURCE: todayGraphData — the exact same object the curve itself is drawn
    // from (see renderChart/_renderChartJs). Total Value/Var Today used to be
    // computed from targetSummary (calculateHoldings, live snapshot prices)
    // instead — a SEPARATE engine from the curve — on the theory that the
    // graph's historical candles could be stale. That created its own bug: the
    // text (table-derived) and the curve (graph-derived) could each be
    // internally consistent yet still disagree with EACH OTHER by tens or
    // hundreds of euros, because they never actually shared a number, just two
    // formulas that were supposed to agree. Now that the graph's own last point
    // prefers a fresh live price when one is available (see _buildSeries), it is
    // safe to make it the single source again: text and curve read the exact
    // same array, so they cannot disagree.
    // investedAssetOnly still comes from targetSummary — that is a cost-basis
    // question (weighted-average purchase price, correctly reduced on a partial
    // sell), not a "which price is freshest" question, so there was never a
    // real SSOT conflict to resolve for it.
    _computeAggregateKPIs({ targetSummary, targetCashReserve, todayGraphData }) {
        const cash = targetCashReserve.total || 0;
        const investedAssetOnly = targetSummary.totalInvestedEUR || 0;

        const values = todayGraphData?.values;
        let totalValue = null;
        if (values) {
            for (let i = values.length - 1; i >= 0; i--) {
                if (values[i] !== null && values[i] !== undefined && !isNaN(values[i])) { totalValue = values[i]; break; }
            }
        }

        let varTodayAbs = null, varTodayPct = null;
        if (totalValue !== null && todayGraphData?.yesterdayClose > 0) {
            varTodayAbs = totalValue - todayGraphData.yesterdayClose;
            varTodayPct = (varTodayAbs / todayGraphData.yesterdayClose) * 100;
        } else {
            // No graph data (index/single-asset modes don't build a dedicated
            // todayGraphData) — targetSummary remains the only source there.
            if (totalValue === null) totalValue = (targetSummary.totalCurrentEUR || 0) + cash;
            varTodayAbs = targetSummary.totalDayChangeEUR ?? null;
            varTodayPct = targetSummary.dayChangePct ?? null;
        }

        const totalReturn = totalValue - cash - investedAssetOnly;
        const totalReturnPct = investedAssetOnly > 0 ? (totalReturn / investedAssetOnly) * 100 : 0;
        return { totalValue, cash, totalReturn, totalReturnPct, varTodayAbs, varTodayPct, investedAssetOnly };
    }

    // ========================================================
    // renderChart — Chart.js dataset construction + stats panel + KPI cards
    // ========================================================
    renderChart(canvas, graphData, summary, titleConfig, benchmarkData, currentTicker, referenceCloseIn, kpiData) {
        const isSingleAssetMode = (titleConfig && titleConfig.mode === 'asset');
        const isIndexMode = (titleConfig && titleConfig.mode === 'index');

        const viewToggle = document.getElementById('view-toggle');
        const activeView = viewToggle?.querySelector('.toggle-btn.active')?.dataset.view || 'global';
        const isUnitView = isSingleAssetMode && activeView === 'unit';
        const isPerformanceView = !isSingleAssetMode && !isIndexMode && activeView === 'performance';
        const isPerformanceMode = (benchmarkData && !isUnitView && !isIndexMode) || isPerformanceView;

        const displayValues = isUnitView ? graphData.unitPrices : graphData.values;
        const decimals = (isUnitView || isIndexMode) ? 4 : 2;

        let firstIndex = displayValues.findIndex(v => v !== null && !isNaN(v));
        let lastIndex = displayValues.length - 1;
        while (lastIndex >= 0 && (displayValues[lastIndex] === null || isNaN(displayValues[lastIndex]))) lastIndex--;
        if (firstIndex < 0) firstIndex = 0;
        // BUG FIX: lastIndex can also fall through to -1 (every point null) — left
        // unclamped, `array[-1]` doesn't throw in JS, it silently returns undefined,
        // which then poisoned graphData.twr[lastIndex] into NaN (seen live: PÉRIODE
        // showing "NaN€", VAR. JOUR showing -100% because priceEnd defaulted to 0).
        if (lastIndex < 0) lastIndex = displayValues.length - 1;

        // (firstIndex/lastIndex are forced to a valid array position above even when
        // NO point in the series has a real value — e.g. a brand new day where not a
        // single ticker has priced yet — so the value AT that position can still be
        // null. Never let a null through to chartKPIManager, which calls .toFixed()
        // unconditionally and would throw.)
        let priceStart = (firstIndex >= 0 && displayValues[firstIndex] != null) ? displayValues[firstIndex] : 0;
        let priceEnd = (lastIndex >= 0 && displayValues[lastIndex] != null) ? displayValues[lastIndex] : 0;
        let priceHigh = -Infinity, priceLow = Infinity;
        displayValues.forEach(v => { if (v !== null && !isNaN(v)) { priceHigh = Math.max(priceHigh, v); priceLow = Math.min(priceLow, v); } });
        if (priceHigh === -Infinity) priceHigh = priceEnd;
        if (priceLow === Infinity) priceLow = priceStart;

        // PÉRIODE: from the TWR series when available (true previous-close anchor),
        // matching exactly what the plotted curve shows.
        let perfAbs = 0, perfPct = 0;
        if (!isIndexMode && !isUnitView && graphData.twr?.length > lastIndex) {
            const twrStart = (this.currentPeriod === 1) ? 1.0 : (graphData.twr[firstIndex] || 1.0);
            const twrEnd = graphData.twr[lastIndex];
            perfPct = twrStart !== 0 ? ((twrEnd - twrStart) / twrStart) * 100 : 0;
            const baseValue = (this.currentPeriod === 1)
                ? (referenceCloseIn || graphData.yesterdayClose || priceStart)
                : priceStart;
            perfAbs = (perfPct / 100) * baseValue;
        } else {
            perfAbs = priceEnd - priceStart;
            perfPct = priceStart !== 0 ? (perfAbs / priceStart) * 100 : 0;
        }

        let referenceClose = referenceCloseIn ?? graphData.yesterdayClose ?? priceStart;
        if (!referenceClose || isNaN(referenceClose)) referenceClose = priceStart;

        // VAR TODAY: ALWAYS the graph-derived value (kpiData.varTodayAbs), the same
        // number driving the top KPI cards — never re-derived here.
        let vsYesterdayAbs = null, vsYesterdayPct = null;
        if (!isIndexMode && kpiData?.varTodayAbs !== null && kpiData?.varTodayAbs !== undefined && !isNaN(kpiData.varTodayAbs)) {
            vsYesterdayAbs = kpiData.varTodayAbs;
            vsYesterdayPct = kpiData.varTodayPct || 0;
            // BUG FOUND: this used to derive CLÔTURE HIER from the graph's own RAW
            // last point (displayValues[lastIndex], historical-candle based) minus
            // the LIVE-based vsYesterdayAbs — mixing two different "current value"
            // bases. Since FIN is displayed as kpiData.totalValue (live-based, see
            // displayPriceEnd below), CLÔTURE HIER must be derived from that SAME
            // base, or FIN − CLÔTURE HIER stops equaling VAR JOUR and the curve
            // (anchored on the graph's own true close) visibly disagrees with the
            // text (verified: text showed +177€/+0.85% while the curve sat almost
            // entirely below 0%, because CLÔTURE HIER was off by ~300€).
            if (!isSingleAssetMode && kpiData?.totalValue !== undefined && kpiData?.totalValue !== null) {
                referenceClose = kpiData.totalValue - vsYesterdayAbs;
            }
        } else if (priceEnd !== null && referenceClose) {
            vsYesterdayAbs = priceEnd - referenceClose;
            vsYesterdayPct = referenceClose !== 0 ? (vsYesterdayAbs / referenceClose) * 100 : 0;
        }

        // PÉRIODE == VAR. JOUR on the 1D tab: they are the exact same concept
        // ("change over the displayed period" vs "change today") and must show
        // the exact same number. Overriding perfAbs/perfPct here (computed above
        // from the graph's own TWR series) with vsYesterdayAbs/vsYesterdayPct
        // (table-derived, live snapshot) is what actually makes that true —
        // computing them via two different paths is what produced PÉRIODE
        // -247,57€ next to VAR. JOUR -9,76€ for the same day.
        if (this.currentPeriod === 1 && vsYesterdayAbs !== null && !isNaN(vsYesterdayAbs)) {
            perfAbs = vsYesterdayAbs;
            perfPct = vsYesterdayPct;
        }

        // FIN affiché = TOTAL VALUE (même nombre que la carte KPI), pour le
        // portefeuille (pas un actif unique, pas un indice).
        let displayPriceEnd = priceEnd;
        if (!isSingleAssetMode && !isIndexMode && kpiData?.totalValue !== undefined && kpiData?.totalValue !== null) {
            displayPriceEnd = kpiData.totalValue;
        }

        const isPositive = (vsYesterdayAbs !== null ? vsYesterdayAbs : perfAbs) >= 0;
        const mainColor = isPositive ? '#2ecc71' : '#e74c3c';

        this._renderChartJs(canvas, graphData, displayValues, isPerformanceMode, benchmarkData, isUnitView, isIndexMode, currentTicker, mainColor, referenceClose, firstIndex, lastIndex, titleConfig, kpiData);

        this._renderTitle(titleConfig, currentTicker, isSingleAssetMode);

        const avgPrice = this._computeAvgPrice(currentTicker, isIndexMode);

        this.kpiManager.updateKPIs({
            isIndexMode, isSingleAsset: isSingleAssetMode, isUnitView, currentPeriod: this.currentPeriod,
            perfAbs, perfPct, isPositive,
            vsYesterdayAbs, vsYesterdayPct, useTodayVar: vsYesterdayAbs !== null,
            referenceClose, finalYesterdayClose: this.lastYesterdayClose,
            priceStart, priceEnd: displayPriceEnd, priceHigh, priceLow, avgPrice, decimals
        });

        if (!isSingleAssetMode && !isIndexMode) {
            const periodMap = { 1: '1d', 2: '2d', 7: '1w', 30: '1m', 90: '3m', 180: '6m', 365: '1y', 730: '2y' };
            portfolioKPIs.updateFromGraph({
                values: graphData.values,
                invested: kpiData?.investedAssetOnly ?? summary.totalInvestedEUR,
                vsYesterdayAbs, vsYesterdayPct,
                period: periodMap[this.currentPeriod] || String(this.currentPeriod),
                cashDetails: { total: kpiData ? kpiData.cash : 0 },
                liveTotalValue: kpiData ? kpiData.totalValue : null,
                liveTotalReturn: kpiData ? kpiData.totalReturn : null,
                liveTotalReturnPct: kpiData ? kpiData.totalReturnPct : null
            });
        }

        return { historicalDayChange: vsYesterdayAbs, historicalDayChangePct: vsYesterdayPct };
    }

    _computeAvgPrice(currentTicker, isIndexMode) {
        if (!currentTicker || isIndexMode) return 0;
        const purchases = this.storage.getPurchases()
            .filter(p => p.ticker.toUpperCase() === currentTicker.toUpperCase())
            .filter(p => { const type = (p.assetType || 'Stock').toLowerCase(); return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend'; });
        if (!purchases.length) return 0;
        const holdings = this.dataManager.calculateHoldings(purchases);
        return holdings?.[0]?.avgPrice || 0;
    }

    _renderTitle(titleConfig, currentTicker, isSingleAssetMode) {
        const titleText = document.getElementById('chart-title-text');
        const titleIcon = document.getElementById('chart-title-icon');
        if (!titleText || !titleIcon || !titleConfig) return;
        titleText.textContent = titleConfig.label;
        if (isSingleAssetMode && currentTicker) {
            const purchases = this.storage.getPurchases().filter(p => p.ticker.toUpperCase() === currentTicker.toUpperCase());
            const assetName = purchases[0]?.name || currentTicker;
            const logoInfo = renderCompanyLogo(currentTicker, assetName);
            titleIcon.innerHTML = logoInfo.html;
        } else {
            titleIcon.textContent = titleConfig.icon || '📈';
        }
    }

    // Tooltip title, scaled to how granular the displayed period is: exact
    // time for 1D/2D views (where the hour is the point), weekday+date for
    // anything within about a month, plain date beyond that (where the exact
    // weekday stops being useful) — always including the year once the view
    // can span more than one.
    _formatTooltipDate(ts) {
        const d = new Date(ts);
        const days = this.currentPeriod;
        if (days <= 2) {
            return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) +
                ' · ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        }
        if (days <= 31) {
            return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long' });
        }
        return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    }

    // A DOM-rendered tooltip (rather than Chart.js's canvas-drawn one) is
    // what actually makes multi-row, column-aligned content ("visuel pro")
    // possible — canvas text has no notion of a grid, so lining up labels of
    // different lengths against right-aligned €/% columns was never going to
    // look right with plain fillText() calls.
    _ensureTooltipStyles() {
        if (document.getElementById('hc-tooltip-styles')) return;
        const style = document.createElement('style');
        style.id = 'hc-tooltip-styles';
        style.textContent = `
.hc-tooltip {
    position: absolute; z-index: 50; pointer-events: none;
    background: rgba(8, 13, 26, 0.97);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    padding: 10px 14px;
    min-width: 220px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
    font-family: 'Inter', sans-serif;
    color: #f1f5f9;
    opacity: 0; transition: opacity 0.08s ease;
}
.hc-tooltip.visible { opacity: 1; }
.hc-tooltip .hc-tt-title { font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 6px; letter-spacing: 0.02em; }
.hc-tooltip .hc-tt-row { display: grid; grid-template-columns: 18px 100px 1fr auto; align-items: center; column-gap: 8px; font-size: 13px; font-weight: 500; color: #e2e8f0; padding: 3px 0; white-space: nowrap; }
.hc-tooltip .hc-tt-row .hc-tt-icon { font-size: 13px; }
.hc-tooltip .hc-tt-row .hc-tt-eur { text-align: right; font-variant-numeric: tabular-nums; color: #f1f5f9; font-weight: 600; }
.hc-tooltip .hc-tt-row .hc-tt-pct { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; min-width: 64px; }
.hc-tooltip .positive { color: #2ecc71; }
.hc-tooltip .negative { color: #e74c3c; }
`;
        document.head.appendChild(style);
    }

    // Every KPI row (hover tooltip AND the drag-selection box) renders
    // through this one function — name / amount / percentage, same grid,
    // same weight, no row visually singled out and no divider between them.
    _renderKpiRowsHtml(titleText, rows) {
        const rowsHtml = rows.map(r => `<div class="hc-tt-row"><span class="hc-tt-icon">${r.icon}</span><span>${r.label}</span><span class="hc-tt-eur">${r.eur ?? ''}</span><span class="hc-tt-pct ${r.positive ? 'positive' : 'negative'}">${r.pct != null ? '(' + r.pct + ')' : ''}</span></div>`).join('');
        return `<div class="hc-tt-title">${titleText}</div>${rowsHtml}`;
    }

    // The unified rows (Total Value / Total Return, plus Benchmark + the
    // delta against it when one is active) at a single point in time — used
    // for the normal hover tooltip. Restricted to genuine portfolio views:
    // an index or a single asset's unit price has no "invested" or "cash" to
    // build Total Return from.
    _buildKpiRows(idx, opts) {
        const { graphData, pctSeries, eurFmt, pctFmt, kpiData, isIndexMode, isUnitView, isPerformanceMode, displayValues } = opts;
        if (isIndexMode || isUnitView) {
            const v = displayValues?.[idx];
            if (v == null || isNaN(v)) return [];
            const label = isUnitView ? 'Prix' : 'Cours';
            return isPerformanceMode
                ? [{ icon: '📊', label, eur: null, pct: pctFmt(v), positive: v >= 0 }]
                : [{ icon: '📊', label, eur: eurFmt(v), pct: null, positive: true }];
        }

        const val = graphData.values?.[idx];
        if (val == null || isNaN(val)) return [];
        const pct = pctSeries?.[idx];
        const rows = [{ icon: '📊', label: 'Total Value', eur: eurFmt(val), pct: (pct != null && !isNaN(pct)) ? pctFmt(pct) : null, positive: (pct ?? 0) >= 0 }];

        const investedAO = graphData.investedAssetOnly?.[idx];
        const cash = kpiData?.cash || 0;
        if (investedAO != null && !isNaN(investedAO)) {
            const totalReturn = (val - cash) - investedAO;
            const totalReturnPct = investedAO > 0 ? (totalReturn / investedAO) * 100 : 0;
            rows.push({ icon: '💰', label: 'Total Return', eur: eurFmt(totalReturn), pct: pctFmt(totalReturnPct), positive: totalReturn >= 0 });
        }

        // Only on the 1D tab: "Var Today" is specifically about today, and
        // stops meaning anything once the view spans more than one day (the
        // 1W tooltip showed it relative to a mid-week close, which just read
        // as a confusing 4th number rather than "today").
        if (this.currentPeriod === 1) {
            const dTwr = graphData.dailyTwr?.[idx];
            if (dTwr != null && !isNaN(dTwr) && dTwr > 0) {
                const varTodayAbs = val - val / dTwr;
                const varTodayPct = (dTwr - 1) * 100;
                rows.push({ icon: '📅', label: 'Var Today', eur: eurFmt(varTodayAbs), pct: pctFmt(varTodayPct), positive: varTodayAbs >= 0 });
            }
        }

        this._pushBenchmarkRows(rows, idx, pct, opts);
        return rows;
    }

    // Shared by both the hover tooltip and the drag-selection box: when a
    // benchmark is active, show its own performance plus the delta against
    // the portfolio — the whole point of comparing against one.
    _pushBenchmarkRows(rows, idx, portfolioPct, opts) {
        const { benchPctSeries, benchmarkLabel, pctFmt } = opts;
        if (!benchPctSeries || portfolioPct == null || isNaN(portfolioPct)) return;
        const benchPct = benchPctSeries[idx];
        if (benchPct == null || isNaN(benchPct)) return;
        rows.push({ icon: '🟣', label: benchmarkLabel || 'Benchmark', eur: null, pct: pctFmt(benchPct), positive: benchPct >= 0 });
        const delta = portfolioPct - benchPct;
        rows.push({ icon: '⚖️', label: 'vs Benchmark', eur: null, pct: pctFmt(delta), positive: delta >= 0 });
    }

    // The same 3-row shape, but for a dragged RANGE instead of one point:
    // Total Value / Total Return as of the range's end, and "Variation" —
    // the change between the two dragged points — standing in for Var Today
    // (which is specifically about "today", not an arbitrary slice).
    _buildSelectionRows(i0, i1, opts) {
        const { graphData, pctSeries, eurFmt, pctFmt, kpiData } = opts;
        const v0 = graphData.values?.[i0], v1 = graphData.values?.[i1];
        if (v0 == null || v1 == null || isNaN(v0) || isNaN(v1)) return [];

        const pct1 = pctSeries?.[i1];
        const rows = [{ icon: '📊', label: 'Total Value', eur: eurFmt(v1), pct: (pct1 != null && !isNaN(pct1)) ? pctFmt(pct1) : null, positive: (pct1 ?? 0) >= 0 }];

        const investedAO = graphData.investedAssetOnly?.[i1];
        const cash = kpiData?.cash || 0;
        if (investedAO != null && !isNaN(investedAO)) {
            const totalReturn = (v1 - cash) - investedAO;
            const totalReturnPct = investedAO > 0 ? (totalReturn / investedAO) * 100 : 0;
            rows.push({ icon: '💰', label: 'Total Return', eur: eurFmt(totalReturn), pct: pctFmt(totalReturnPct), positive: totalReturn >= 0 });
        }

        if (v0 !== 0) {
            const deltaAbs = v1 - v0;
            const deltaPct = (deltaAbs / v0) * 100;
            rows.push({ icon: '📅', label: 'Variation', eur: eurFmt(deltaAbs), pct: pctFmt(deltaPct), positive: deltaAbs >= 0 });
        }

        this._pushBenchmarkRows(rows, i1, pct1, opts);
        return rows;
    }

    // Chart.js's `external` tooltip mode: instead of letting Chart.js draw
    // its own canvas tooltip, it calls this on every hover with the tooltip
    // model (position, opacity, matched dataPoints) and leaves rendering
    // entirely up to us — here, a positioned HTML element.
    _renderExternalTooltip(context, opts) {
        const { canvas, graphData } = opts;
        if (opts.dragState?.active) return; // a drag-selection box owns this element right now

        this._ensureTooltipStyles();
        const el = this._ensureTooltipEl(canvas);

        const tt = context.tooltip;
        if (!tt || tt.opacity === 0 || !tt.dataPoints?.length) {
            el.classList.remove('visible');
            return;
        }
        const dataPoints = tt.dataPoints.filter(dp => dp.dataset.label !== 'Base 0%');
        if (!dataPoints.length) { el.classList.remove('visible'); return; }

        const idx = dataPoints[0].dataIndex;
        const ts = graphData.timestamps?.[idx];
        const titleText = ts ? this._formatTooltipDate(ts) : (dataPoints[0].label || '');
        const rows = this._buildKpiRows(idx, opts);
        if (!rows.length) { el.classList.remove('visible'); return; }

        el.innerHTML = this._renderKpiRowsHtml(titleText, rows);
        el.classList.add('visible');
        this._positionTooltipEl(el, canvas, context.chart.chartArea, tt.caretX, tt.caretY);
    }

    _ensureTooltipEl(canvas) {
        const parent = canvas.parentNode;
        if (!parent.style.position) parent.style.position = 'relative';
        let el = parent.querySelector(':scope > .hc-tooltip');
        if (!el) {
            el = document.createElement('div');
            el.className = 'hc-tooltip';
            parent.appendChild(el);
        }
        return el;
    }

    // Shared placement logic for both the hover tooltip and the
    // drag-selection box: anchored to one x pixel, flipped to whichever side
    // has room, and clamped so it never spills outside the chart area.
    _positionTooltipEl(el, canvas, area, anchorX, anchorY) {
        const elW = el.offsetWidth || 220, elH = el.offsetHeight || 110;
        let left = canvas.offsetLeft + anchorX + 14;
        const maxLeft = canvas.offsetLeft + area.right - elW;
        if (left > maxLeft) left = canvas.offsetLeft + anchorX - elW - 14;
        left = Math.max(canvas.offsetLeft + area.left, left);

        let top = canvas.offsetTop + (anchorY != null ? anchorY - elH / 2 : area.top + 4);
        const maxTop = canvas.offsetTop + area.bottom - elH;
        top = Math.min(Math.max(top, canvas.offsetTop + area.top), maxTop);

        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }

    // ========================================================
    // Chart.js construction
    // ========================================================
    _renderChartJs(canvas, graphData, displayValues, isPerformanceMode, benchmarkData, isUnitView, isIndexMode, currentTicker, mainColor, referenceClose, firstIndex, lastIndex, titleConfig, kpiData) {
        if (this.chart) { this.chart.destroy(); this.chart = null; }
        canvas.parentNode?.querySelector(':scope > .hc-tooltip')?.classList.remove('visible');
        this._isZoomed = false; // a freshly-built chart never starts zoomed
        this._updateSelectionToggleUI();
        const ctx = canvas.getContext('2d');
        const datasets = [];

        const makeGradient = (chart, refValue) => {
            const ca = chart.chartArea, sc = chart.scales?.y;
            if (!ca || !sc) return 'transparent';
            const refPx = sc.getPixelForValue(refValue);
            const z = Math.max(ca.top, Math.min(ca.bottom, refPx));
            const h = ca.bottom - ca.top;
            if (h <= 0) return 'transparent';
            const r = (z - ca.top) / h;
            const g = chart.ctx.createLinearGradient(0, ca.top, 0, ca.bottom);
            // r is a fraction of PIXEL height (top-to-bottom), inverted versus
            // y-axis VALUE space (higher values at the top). r<=0 means refValue
            // sits at/above the chart's top, so every plotted value is BELOW it
            // (all negative) — red. r>=1 means refValue sits at/below the
            // bottom, so every value is ABOVE it (all positive) — green. (Bug
            // found: these two were swapped — an all-positive curve filled red.)
            if (r <= 0) { g.addColorStop(0, 'rgba(231,76,60,0.35)'); g.addColorStop(1, 'rgba(231,76,60,0.05)'); }
            else if (r >= 1) { g.addColorStop(0, 'rgba(46,204,113,0.35)'); g.addColorStop(1, 'rgba(46,204,113,0.05)'); }
            else {
                g.addColorStop(0, 'rgba(46,204,113,0.35)'); g.addColorStop(r, 'rgba(46,204,113,0.05)');
                g.addColorStop(r, 'rgba(231,76,60,0.05)'); g.addColorStop(1, 'rgba(231,76,60,0.35)');
            }
            return g;
        };

        // Colors each line segment green above `refValue`, red below it, with a
        // sharp transition placed exactly where the segment crosses that value
        // (rather than blending green-to-red across the whole segment).
        const GREEN = 'rgba(46,204,113,0.95)', RED = 'rgba(231,76,60,0.95)';
        const segmentColor = (ctx, refValue) => {
            const y0 = ctx.p0.parsed.y, y1 = ctx.p1.parsed.y;
            if (y0 == null || y1 == null) return mainColor;
            const a0 = y0 >= refValue, a1 = y1 >= refValue;
            if (a0 && a1) return GREEN;
            if (!a0 && !a1) return RED;
            const t = Math.abs(y0 - refValue) / (Math.abs(y0 - refValue) + Math.abs(y1 - refValue));
            const [c0, c1] = a0 ? [GREEN, RED] : [RED, GREEN];
            const g = ctx.chart.ctx.createLinearGradient(ctx.p0.x, 0, ctx.p1.x, 0);
            g.addColorStop(0, c0); g.addColorStop(Math.max(0, t - 0.001), c0);
            g.addColorStop(Math.min(1, t + 0.001), c1); g.addColorStop(1, c1);
            return g;
        };

        // Computed unconditionally (not just in performance mode) so the
        // tooltip can always show €+% together on the main line, whichever
        // mode is currently displayed.
        const hasDailyTwr = this.currentPeriod === 1 && Array.isArray(graphData.dailyTwr) &&
            graphData.dailyTwr.length === graphData.twr.length && graphData.dailyTwr.some(v => v !== null);
        const twrSeries = hasDailyTwr ? graphData.dailyTwr : graphData.twr;
        const twrStart = hasDailyTwr ? 1.0 : (twrSeries?.[firstIndex] || 1.0);
        const pctSeries = Array.isArray(twrSeries)
            ? twrSeries.map(v => (v === null || v === undefined) ? null : ((v - twrStart) / twrStart) * 100)
            : null;

        // Hoisted out of the `if (benchmarkData...)` block below so the
        // tooltip (hover AND drag-selection) can show the benchmark's own
        // value plus the delta against the portfolio, not just the chart.
        let benchPctSeries = null;
        let benchmarkLabel = null;

        if (isPerformanceMode) {
            const perfData = pctSeries;

            datasets.push({
                label: 'Total Value (%)', data: perfData, borderColor: mainColor,
                backgroundColor: (c) => makeGradient(c.chart, 0), borderWidth: 2, fill: true,
                pointRadius: 0, tension: 0.3, spanGaps: true,
                segment: { borderColor: (c) => segmentColor(c, 0) },
                isMain: true
            });

            if (benchmarkData && graphData.timestamps) {
                const benchTs = Object.keys(benchmarkData).map(Number).sort((a, b) => a - b);
                if (benchTs.length > 0) {
                    const startGraphTs = graphData.timestamps[firstIndex];
                    let startBenchPrice = null;
                    for (let i = benchTs.length - 1; i >= 0; i--) { if (benchTs[i] <= startGraphTs) { startBenchPrice = benchmarkData[benchTs[i]]; break; } }
                    if (!startBenchPrice) startBenchPrice = benchmarkData[benchTs[0]];
                    if (startBenchPrice) {
                        let lastKnown = startBenchPrice;
                        const benchData = graphData.timestamps.map((ts, i) => {
                            if (i < firstIndex) return null;
                            for (let j = benchTs.length - 1; j >= 0; j--) { if (benchTs[j] <= ts) { lastKnown = benchmarkData[benchTs[j]]; break; } }
                            return ((lastKnown - startBenchPrice) / startBenchPrice) * 100;
                        });
                        datasets.push({ label: 'Benchmark (%)', data: benchData, borderColor: '#A855F7', borderWidth: 2, fill: false, pointRadius: 0, spanGaps: true });
                        benchPctSeries = benchData;
                        benchmarkLabel = document.getElementById('benchmark-select')?.selectedOptions?.[0]?.textContent?.trim() || 'Benchmark';
                    }
                }
            }
            datasets.push({ label: 'Base 0%', data: Array(graphData.labels.length).fill(0), borderColor: 'rgba(255,255,255,0.2)', borderWidth: 1, borderDash: [5, 5], fill: false, pointRadius: 0 });
        } else {
            if (!isIndexMode && !isUnitView && graphData.invested) {
                datasets.push({ label: 'Investi (€)', data: graphData.invested, borderColor: '#3b82f6', borderWidth: 2, fill: false, pointRadius: 0, borderDash: [5, 5], hidden: true, spanGaps: true });
            }
            let label = isUnitView ? 'Prix unitaire (€)' : (isIndexMode ? 'Cours' : 'Total Value (€)');
            const bicolorRef = (this.currentPeriod === 1 && referenceClose > 0) ? referenceClose : null;

            datasets.push({
                label, data: displayValues, borderColor: mainColor,
                backgroundColor: (c) => makeGradient(c.chart, bicolorRef || 0),
                borderWidth: 3, fill: true, tension: 0.3, pointRadius: 0, spanGaps: true,
                ...(bicolorRef ? { segment: { borderColor: (c) => segmentColor(c, bicolorRef) } } : {}),
                isMain: true
            });
            if (this.currentPeriod === 1 && referenceClose > 0) {
                datasets.push({ label: 'Clôture hier', data: Array(graphData.labels.length).fill(referenceClose), borderColor: '#95a5a6', borderWidth: 2, borderDash: [6, 4], fill: false, pointRadius: 0 });
            }
            if (isUnitView && graphData.purchasePoints?.length) {
                datasets.push({ type: 'scatter', label: "Points d'achat", data: graphData.purchasePoints, backgroundColor: '#FFFFFF', borderColor: '#3b82f6', borderWidth: 2, pointRadius: 5, pointHoverRadius: 8, parsing: { yAxisKey: 'y' } });
            }
        }

        const eurFmt = (n) => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
        const pctFmt = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
        // Shared with _renderExternalTooltip below: Chart.js keeps calling the
        // `external` hover callback on every mousemove regardless of
        // tooltip.enabled — that flag only controls Chart.js's OWN canvas
        // drawing, not whether the callback fires. Without this guard, the
        // very next mousemove after releasing a drag would silently
        // overwrite the persisted selection box with the normal single-point
        // hover content, making it look like it "disappeared" on its own
        // instead of staying until an explicit click.
        const dragState = { active: false };
        const tooltipOpts = { canvas, graphData, isPerformanceMode, isIndexMode, isUnitView, displayValues, pctSeries, eurFmt, pctFmt, kpiData, dragState, benchPctSeries, benchmarkLabel };

        // Drag-selection ("Google Finance" style) IS the default interaction:
        // dragging across the chart shows Total Value / Total Return /
        // Variation for that slice, without ever re-fetching or rescaling the
        // chart itself. The toggle next to the period buttons (see
        // _injectSelectionToggle) repurposes the SAME drag into a zoom
        // instead — the two are mutually exclusive per drag, decided at
        // mouseup by whether zoom mode is on.
        let selStart = null, selEnd = null, isSelecting = false;
        this._canvasEl = canvas;
        canvas.style.cursor = this.zoomModeEnabled ? 'zoom-in' : 'crosshair';

        const indexFromClientX = (clientX) => {
            const rect = canvas.getBoundingClientRect();
            const px = clientX - rect.left;
            const idx = Math.round(this.chart.scales.x.getValueForPixel(px));
            return Math.max(0, Math.min(graphData.labels.length - 1, idx));
        };

        const selectionPlugin = {
            id: 'dragSelection',
            afterDraw: (chart) => {
                if (selStart === null || selEnd === null) return;
                const i0 = Math.min(selStart, selEnd), i1 = Math.max(selStart, selEnd);
                const xScale = chart.scales.x, yScale = chart.scales.y;
                const x0 = xScale.getPixelForValue(i0), x1 = xScale.getPixelForValue(i1);
                const top = chart.chartArea.top, bottom = chart.chartArea.bottom;
                const c = chart.ctx;

                c.save();
                c.fillStyle = this.zoomModeEnabled ? 'rgba(168,85,247,0.10)' : 'rgba(59,130,246,0.10)';
                c.fillRect(x0, top, Math.max(1, x1 - x0), bottom - top);
                c.setLineDash([4, 4]);
                c.strokeStyle = 'rgba(255,255,255,0.4)';
                c.lineWidth = 1;
                [x0, x1].forEach(x => { c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke(); });
                c.restore();

                const mainDs = chart.data.datasets.find(d => d.isMain);
                if (mainDs) {
                    [[x0, i0], [x1, i1]].forEach(([x, i]) => {
                        const v = mainDs.data[i];
                        if (v == null || isNaN(v)) return;
                        const y = yScale.getPixelForValue(v);
                        c.save();
                        c.fillStyle = mainColor;
                        c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fill();
                        c.strokeStyle = '#0b1220'; c.lineWidth = 2; c.stroke();
                        c.restore();
                    });
                }
            }
        };

        this.chart = new Chart(ctx, {
            type: 'line',
            data: { labels: graphData.labels, datasets },
            plugins: [selectionPlugin],
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: false,
                        external: (context) => this._renderExternalTooltip(context, tooltipOpts)
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { autoSkip: true, maxTicksLimit: 10, maxRotation: 0 }
                    },
                    y: { ticks: { callback: (v) => isPerformanceMode ? `${v.toFixed(2)}%` : v } }
                }
            }
        });

        const clientXOf = (evt) => evt.touches?.[0]?.clientX ?? evt.changedTouches?.[0]?.clientX ?? evt.clientX;
        const tooltipEl = this._ensureTooltipEl(canvas);
        this._ensureTooltipStyles();

        const showSelectionBox = () => {
            const i0 = Math.min(selStart, selEnd), i1 = Math.max(selStart, selEnd);
            const rows = this._buildSelectionRows(i0, i1, tooltipOpts);
            if (!rows.length) { tooltipEl.classList.remove('visible'); return; }
            const t0 = graphData.timestamps?.[i0], t1 = graphData.timestamps?.[i1];
            const titleText = (t0 && t1) ? `${this._formatTooltipDate(t0)}  →  ${this._formatTooltipDate(t1)}` : '';
            tooltipEl.innerHTML = this._renderKpiRowsHtml(titleText, rows);
            tooltipEl.classList.add('visible');
            const anchorX = this.chart.scales.x.getPixelForValue(i0);
            this._positionTooltipEl(tooltipEl, canvas, this.chart.chartArea, anchorX, null);
        };

        const onDown = (evt) => {
            isSelecting = true;
            dragState.active = true;
            selStart = selEnd = indexFromClientX(clientXOf(evt));
            if (this.chart) { this.chart.options.plugins.tooltip.enabled = false; this.chart.update('none'); }
            evt.preventDefault();
        };
        const onMove = (evt) => {
            if (!isSelecting || !this.chart) return;
            selEnd = indexFromClientX(clientXOf(evt));
            this.chart.update('none');
            if (selStart !== selEnd) showSelectionBox();
        };
        const onUp = () => {
            if (!isSelecting) return;
            isSelecting = false;

            // A plain click (no actual drag) clears whatever was showing
            // instead of leaving a zero-width selection on screen.
            if (selStart === selEnd) {
                selStart = null; selEnd = null;
                dragState.active = false;
                tooltipEl.classList.remove('visible');
                if (this.chart) { this.chart.options.plugins.tooltip.enabled = true; this.chart.update('none'); }
                return;
            }

            if (this.zoomModeEnabled) {
                // Zoom mode: the drag rescales the x-axis to that range
                // instead of showing the info box — a real "redo the
                // graph on this period", but purely visual (same already-
                // fetched data, no re-fetch/recalculation).
                const i0 = Math.min(selStart, selEnd), i1 = Math.max(selStart, selEnd);
                this.chart.options.scales.x.min = graphData.labels[i0];
                this.chart.options.scales.x.max = graphData.labels[i1];
                this.chart.update();
                selStart = null; selEnd = null;
                dragState.active = false;
                tooltipEl.classList.remove('visible');
                this.chart.options.plugins.tooltip.enabled = true;
                this._isZoomed = true;
                this._updateSelectionToggleUI();
                return;
            }
            // Default (zoom off): the selection + info box stay exactly as
            // shown (dragState stays active) until the next click/drag
            // clears them — see the selStart===selEnd branch above.
        };
        const onReset = () => {
            if (!this.chart?.options.scales.x.min) return;
            delete this.chart.options.scales.x.min;
            delete this.chart.options.scales.x.max;
            this.chart.update();
            this._isZoomed = false;
            this._updateSelectionToggleUI();
        };
        this._resetZoom = onReset;

        canvas.addEventListener('mousedown', onDown);
        canvas.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        canvas.addEventListener('touchstart', onDown, { passive: false });
        canvas.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onUp);
        canvas.addEventListener('dblclick', onReset);

        // _renderChartJs recreates the Chart instance (and re-adds listeners)
        // on every period/mode change on the SAME canvas element — without
        // this, listeners would pile up across re-renders instead of being
        // replaced.
        if (this._selectionCleanup) this._selectionCleanup();
        this._selectionCleanup = () => {
            canvas.removeEventListener('mousedown', onDown);
            canvas.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            canvas.removeEventListener('touchstart', onDown);
            canvas.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', onUp);
            canvas.removeEventListener('dblclick', onReset);
        };
    }
}
