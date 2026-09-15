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

function lastValid(arr) {
    if (!arr) return null;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) return arr[i];
    }
    return null;
}
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

    // Disable a period button if its window would start before the account's
    // very first purchase — there is nothing meaningful to plot before that.
    updatePeriodButtonsAvailability() {
        const firstPurchase = this.storage.getPurchases()
            .map(p => new Date(p.date))
            .filter(d => !isNaN(d.getTime()))
            .sort((a, b) => a - b)[0];
        if (!firstPurchase) return;
        const ageDays = (Date.now() - firstPurchase.getTime()) / (24 * 60 * 60 * 1000);

        document.querySelectorAll('.period-btn').forEach(btn => {
            const raw = btn.dataset.period;
            if (raw === 'all' || raw === 'ytd' || raw === '1' || raw === '2' || raw === '7') return;
            const days = parseInt(raw);
            if (!Number.isFinite(days)) return;
            const tooOld = days > 30 && ageDays < days * 0.5;
            btn.classList.toggle('period-disabled', tooOld);
        });
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
                const kpiData = this._computeAggregateKPIs({ isSingleAsset, isIndexMode, todayGraphData, targetSummary, targetCashReserve });
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
    // For the portfolio (not a single asset, not an index): the graph is the
    // ONLY source, full stop. No fallback to targetSummary (live snapshot via
    // calculateHoldings) — if the graph didn't produce a usable value, this
    // returns nulls rather than quietly substituting a different calculation
    // that happens to look plausible. A wrong-looking screen is more honest,
    // and more useful to debug, than a right-looking screen built from the
    // wrong source.
    //
    // Single-asset / index modes don't build a dedicated todayGraphData (see
    // update()), so targetSummary remains their only available source — not a
    // silent fallback, just the sole source for those two modes.
    _computeAggregateKPIs({ isSingleAsset, isIndexMode, todayGraphData, targetSummary, targetCashReserve }) {
        const cash = targetCashReserve.total || 0;

        if (!isSingleAsset && !isIndexMode) {
            const totalValue = lastValid(todayGraphData?.values);
            if (totalValue === null) {
                console.warn('[HistoricalChart] Graph produced no usable value — KPIs left unresolved rather than falling back to a non-graph source.');
                return { totalValue: null, cash, totalReturn: null, totalReturnPct: null, varTodayAbs: null, varTodayPct: null, investedAssetOnly: null };
            }
            const yesterdayClose = todayGraphData.yesterdayClose;
            const investedTotal = lastValid(todayGraphData.invested) || 0;
            const investedAssetOnly = Math.max(0, investedTotal - cash);
            const totalReturn = totalValue - cash - investedAssetOnly;
            const totalReturnPct = investedAssetOnly > 0 ? (totalReturn / investedAssetOnly) * 100 : 0;
            const varTodayAbs = (yesterdayClose > 0) ? totalValue - yesterdayClose : null;
            const varTodayPct = (yesterdayClose > 0 && varTodayAbs !== null) ? (varTodayAbs / yesterdayClose) * 100 : null;
            return { totalValue, cash, totalReturn, totalReturnPct, varTodayAbs, varTodayPct, investedAssetOnly };
        }

        const totalValue = (targetSummary.totalCurrentEUR || 0) + cash;
        const investedAssetOnly = targetSummary.totalInvestedEUR || 0;
        const totalReturn = totalValue - cash - investedAssetOnly;
        const totalReturnPct = investedAssetOnly > 0 ? (totalReturn / investedAssetOnly) * 100 : 0;
        return {
            totalValue, cash, totalReturn, totalReturnPct,
            varTodayAbs: targetSummary.totalDayChangeEUR ?? null,
            varTodayPct: targetSummary.dayChangePct ?? null,
            investedAssetOnly
        };
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
            if (!isSingleAssetMode) {
                const graphLast = displayValues[lastIndex];
                if (graphLast !== null && !isNaN(graphLast)) referenceClose = graphLast - vsYesterdayAbs;
            }
        } else if (priceEnd !== null && referenceClose) {
            vsYesterdayAbs = priceEnd - referenceClose;
            vsYesterdayPct = referenceClose !== 0 ? (vsYesterdayAbs / referenceClose) * 100 : 0;
        }

        // FIN affiché = TOTAL VALUE (même nombre que la carte KPI), pour le
        // portefeuille (pas un actif unique, pas un indice).
        let displayPriceEnd = priceEnd;
        if (!isSingleAssetMode && !isIndexMode && kpiData?.totalValue !== undefined && kpiData?.totalValue !== null) {
            displayPriceEnd = kpiData.totalValue;
        }

        const isPositive = (vsYesterdayAbs !== null ? vsYesterdayAbs : perfAbs) >= 0;
        const mainColor = isPositive ? '#2ecc71' : '#e74c3c';

        this._renderChartJs(canvas, graphData, displayValues, isPerformanceMode, benchmarkData, isUnitView, isIndexMode, currentTicker, mainColor, referenceClose, firstIndex, lastIndex, titleConfig);

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

    // ========================================================
    // Chart.js construction
    // ========================================================
    _renderChartJs(canvas, graphData, displayValues, isPerformanceMode, benchmarkData, isUnitView, isIndexMode, currentTicker, mainColor, referenceClose, firstIndex, lastIndex, titleConfig) {
        if (this.chart) { this.chart.destroy(); this.chart = null; }
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
            if (r <= 0) { g.addColorStop(0, 'rgba(46,204,113,0.35)'); g.addColorStop(1, 'rgba(46,204,113,0.05)'); }
            else if (r >= 1) { g.addColorStop(0, 'rgba(231,76,60,0.35)'); g.addColorStop(1, 'rgba(231,76,60,0.05)'); }
            else {
                g.addColorStop(0, 'rgba(46,204,113,0.35)'); g.addColorStop(r, 'rgba(46,204,113,0.05)');
                g.addColorStop(r, 'rgba(231,76,60,0.05)'); g.addColorStop(1, 'rgba(231,76,60,0.35)');
            }
            return g;
        };

        if (isPerformanceMode) {
            const hasDailyTwr = this.currentPeriod === 1 && Array.isArray(graphData.dailyTwr) &&
                graphData.dailyTwr.length === graphData.twr.length && graphData.dailyTwr.some(v => v !== null);

            const series = hasDailyTwr ? graphData.dailyTwr : graphData.twr;
            const start = hasDailyTwr ? 1.0 : (series[firstIndex] || 1.0);
            const perfData = series.map(v => (v === null || v === undefined) ? null : ((v - start) / start) * 100);

            datasets.push({
                label: 'Performance Portfolio (%)', data: perfData, borderColor: mainColor,
                backgroundColor: (c) => makeGradient(c.chart, 0), borderWidth: 2, fill: true,
                pointRadius: 0, tension: 0.3, spanGaps: true
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
                    }
                }
            }
            datasets.push({ label: 'Base 0%', data: Array(graphData.labels.length).fill(0), borderColor: 'rgba(255,255,255,0.2)', borderWidth: 1, borderDash: [5, 5], fill: false, pointRadius: 0 });
        } else {
            if (!isIndexMode && !isUnitView && graphData.invested) {
                datasets.push({ label: 'Investi (€)', data: graphData.invested, borderColor: '#3b82f6', borderWidth: 2, fill: false, pointRadius: 0, borderDash: [5, 5], hidden: true, spanGaps: true });
            }
            let label = isUnitView ? 'Prix unitaire (€)' : (isIndexMode ? 'Cours' : 'Valeur Portfolio (€)');
            const bicolorRef = (this.currentPeriod === 1 && referenceClose > 0) ? referenceClose : null;
            datasets.push({
                label, data: displayValues, borderColor: mainColor,
                backgroundColor: (c) => makeGradient(c.chart, bicolorRef || 0),
                borderWidth: 3, fill: true, tension: 0.3, pointRadius: 0, spanGaps: true
            });
            if (this.currentPeriod === 1 && referenceClose > 0) {
                datasets.push({ label: 'Clôture hier', data: Array(graphData.labels.length).fill(referenceClose), borderColor: '#95a5a6', borderWidth: 2, borderDash: [6, 4], fill: false, pointRadius: 0 });
            }
            if (isUnitView && graphData.purchasePoints?.length) {
                datasets.push({ type: 'scatter', label: "Points d'achat", data: graphData.purchasePoints, backgroundColor: '#FFFFFF', borderColor: '#3b82f6', borderWidth: 2, pointRadius: 5, pointHoverRadius: 8, parsing: { yAxisKey: 'y' } });
            }
        }

        this.chart = new Chart(ctx, {
            type: 'line',
            data: { labels: graphData.labels, datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (item) => {
                                const v = item.raw;
                                if (v === null || v === undefined) return '';
                                return isPerformanceMode ? `${item.dataset.label}: ${v.toFixed(2)}%` : `${item.dataset.label}: ${v.toFixed(2)}€`;
                            }
                        }
                    }
                },
                scales: {
                    x: { grid: { display: false } },
                    y: { ticks: { callback: (v) => isPerformanceMode ? `${v.toFixed(2)}%` : v } }
                }
            }
        });
    }
}
