// ========================================
// historicalChart.js — Portfolio chart + its KPI panel
// ========================================
//
// SINGLE SOURCE OF TRUTH RULE (the whole reason this file was rewritten):
// exactly ONE call resolves "today's" FINANCIAL SNAPSHOT per update() cycle —
// dataManager.buildTodaySnapshot() for portfolio mode (_resolveTodayData() is
// kept for the single-asset drill-down, which has no "Total Value" card to
// reconcile against). That snapshot bundles todayGraphData (the graph's own
// series) together with holdings/summary/cash computed from the EXACT SAME
// resolved prices and FX rate — not two engines each reading
// storage.getCurrentPrice()/getConversionRate() independently. It feeds:
//   - the visible curve (when the 1D tab is active, it IS the curve's data —
//     no second fetch)
//   - the top KPI cards (TOTAL VALUE / TOTAL RETURN / VAR TODAY), via
//     portfolioKPIs
//   - the chart's own stats panel (FIN / DÉBUT / HAUT / BAS / PÉRIODE /
//     VAR. JOUR / CLÔTURE HIER), via chartKPIManager
//   - the tooltip (reads graphData.values/pctSeries directly — no per-point
//     substitution, see _buildKpiRows)
//   - the table's "Day P&L" column (yesterdayCloseMap), via
//     dataManager.calculateHoldings
// No other code path in this file computes "today's change" a second,
// independent way. That duplication — not any single formula — was the root
// cause of every table/KPI/chart mismatch found in this app (see
// dataManager.buildTodaySnapshot's own doc comment for the full audit).

import { eventBus } from './eventBus.js';
import { performanceSeries, periodPerformance } from './financialSeries.js';
import { ChartKPIManager } from './chartKPIManager.js?v=6';
import { MarketStatus } from './marketStatus.js?v=3';
import { renderCompanyLogo } from './logoUtils.js';
import { portfolioKPIs } from './portfolioKPIs.js';
import { isCryptoTicker } from './MarketUtils.js?v=2';
import { mountViewToggle } from './chartViewToggle.js?v=1';
import { marketCalendarEngine } from './MarketCalendarEngine.js';
import { cacheDelete, cacheGet, cacheSet, isPersistentCacheAvailable } from './persistentCache.js';

const AUTO_REFRESH_FIRST_MS = 30 * 1000;
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
// Bump whenever the financial meaning of a persisted series changes. Version 14
// invalidates closed-weekend 1D series that showed an empty current civil day.
// Version 17 drops single-point series of distributing assets whose price
// history had been skipped (dividend record read as the ticker's type — see
// storage.getAssetType).
// Version 18: transaction markers are positioned by point index and carry
// their side (buy/sell). Version 19 adds periodPnlWithDividends.
// Version 22: causal timestamps (no point after the calculation instant),
// holding-interval validity and pointMeta.sessionDate.
const HISTORY_CHART_CACHE_VERSION = 22;
const HISTORY_CHART_CACHE_MAX_ENTRIES = 8;
// IndexedDB is not bound by the ~5 MB localStorage quota shared by the app:
// every period of the portfolio and of recently viewed assets fits.
const HISTORY_CHART_PERSISTENT_MAX_ENTRIES = 48;
const HISTORY_CHART_MEMORY_MAX_ENTRIES = 32;
// Provider daily/intraday candles of a session are settled after its close.
const MARKET_SETTLE_MS = 30 * 60_000;
const ATH_RETRY_DELAY_MS = 5 * 60 * 1000;
const historyEncode = (_, value) => value instanceof Map ? { $historyMap: [...value] } : value;
const historyDecode = (_, value) => value?.$historyMap ? new Map(value.$historyMap) : value;

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

        // Reference-line visibility (Clôture Hier / PRU / ATH) — a per-viewer display
        // preference, so it's persisted in localStorage rather than app state.
        this.refLineVisibility = {
            // No toggle is ever offered on the Dashboard (this.ui is null there
            // — see _syncReferenceLineToggles), so its line must not be
            // silently turned off by a preference set on the Investments page:
            // both pages share the same origin/localStorage key.
            close: this.ui ? this._loadRefLinePref('close') : true,
            pru: this._loadRefLinePref('pru'),
            ath: this._loadRefLinePref('ath')
        };
        try { this.includeDividends = localStorage.getItem('chart_include_dividends') === '1'; }
        catch { this.includeDividends = false; }

        this._unsubscribeSnapshot = this.dataManager.repository?.subscribe(result => {
            // A live snapshot refresh can change the 1D valuation. It must not
            // rebuild and repaint an already complete historical period: that
            // was the source of the first, wrong 6M curve being replaced a few
            // seconds later by another curve.
            if (result.background && this.currentMode === 'portfolio' && this.currentPeriod === 1) this.update(false, false);
        });
        this.isLoading = false;
        this._pendingUpdate = null;
        this._pendingPeriod = undefined;
        this._updateRequestId = 0;
        this._autoRefreshTimeout = null;
        this._autoRefreshInterval = null;
        this.lastRefreshTime = null;
        this._historyCache = new Map();
        this._historyInFlight = new Map();
        // All-time histories being built for the ATH line, and the last failed
        // attempt per scope (throttles retries instead of a repaint loop).
        this._athPending = new Set();
        this._athFailedAt = new Map();
        this._athRepaintKeys = new Set();
        this._migrateLegacyHistory();

        this._onShowAsset = (e) => {
            this.showAssetChart(e.detail.ticker);
        };
        this._onClearAsset = () => {
            this.showPortfolioChart();
        };
        eventBus.addEventListener('showAssetChart', this._onShowAsset);
        eventBus.addEventListener('clearAssetChart', this._onClearAsset);
    }

    // Broker-comparable performance: security-only TWR. HistoryCalculator
    // excludes cash and emits null for every incomplete portfolio valuation.
    _getPortfolioPerformanceSeries(graphData) {
        return performanceSeries(graphData, this.includeDividends);
    }

    _getPortfolioPeriodPnlSeries(graphData) {
        const series = this.includeDividends && Array.isArray(graphData.periodPnlWithDividends)
            ? graphData.periodPnlWithDividends
            : graphData.periodPnl;
        return Array.isArray(series) ? series : null;
    }

    _getPortfolioReturnSeries(graphData) {
        // Unrealised position gain, matching the live Total Return definition.
        // Dividend income belongs to the separate period-performance metric.
        return graphData.totalReturn;
    }

    destroy() {
        this._unsubscribeSnapshot?.();
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
        // Re-evaluate which period buttons make sense for THIS asset's own
        // age, not the whole portfolio's — see updatePeriodButtonsAvailability().
        this.updatePeriodButtonsAvailability();
    }

    async showPortfolioChart() {
        this.currentMode = 'portfolio';
        this.selectedAssets = [];
        this.currentBenchmark = null;
        const benchmarkSelect = document.getElementById('benchmark-select');
        if (benchmarkSelect) benchmarkSelect.value = '';
        // Defensive: clear any "selected" highlight left on a market/index card
        // (dashboardApp.js) — a no-op on pages (investments.html) that have none.
        document.querySelectorAll('.market-card.active-index').forEach(c => c.classList.remove('active-index'));
        await this.update(true, false);
        this.updatePeriodButtonsAvailability();
    }

    getFilteredPurchasesFromPage(ignoreTickerFilter = false) {
        return this.investmentsPage.getFilteredPurchasesFromPage(ignoreTickerFilter);
    }

    _historyKey(scope, purchases, period) {
        const ledger = (purchases || []).map(p => [
            p.ticker, p.date, p.price, p.quantity, p.type, p.assetType, p.currency, p.broker
        ]);
        return JSON.stringify([scope, period, ledger]);
    }

    _historyCacheTtl(period) {
        if (period === 1) return 30_000;
        if (period === 2) return 2 * 60_000;
        if (typeof period === 'number' && period <= 7) return 5 * 60_000;
        if (typeof period === 'number' && period <= 30) return 30 * 60_000;
        if (typeof period === 'number' && period <= 365) return 6 * 60 * 60_000;
        return 24 * 60 * 60_000;
    }

    _historyStorageKey() {
        const sync = this.storage.marketDataSync;
        const uid = sync ? (sync.auth ? sync.auth.currentUser?.uid : sync.userId) || 'anonymous' : 'local';
        return `historicalChart_snapshots_v${HISTORY_CHART_CACHE_VERSION}:${uid}`;
    }

    _historyCacheId(key) {
        // Compact deterministic id; the complete signature is retained in the
        // entry and checked as collision protection.
        let hash = 2166136261;
        for (let i = 0; i < key.length; i++) {
            hash ^= key.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    // Moves series persisted in localStorage by previous versions to IndexedDB
    // (same keys and signatures), then frees the shared localStorage quota.
    _migrateLegacyHistory() {
        if (!isPersistentCacheAvailable()) return;
        let keys = [];
        try {
            keys = Object.keys(localStorage).filter(k => k.startsWith('historicalChart_snapshots_v'));
        } catch { return; }
        const current = `historicalChart_snapshots_v${HISTORY_CHART_CACHE_VERSION}:`;
        for (const storageKey of keys) {
            let store = null;
            try { if (storageKey.startsWith(current)) store = JSON.parse(localStorage.getItem(storageKey), historyDecode); } catch { store = null; }
            try { localStorage.removeItem(storageKey); } catch { /* best effort */ }
            if (!store) continue;
            const write = async () => {
                const index = { ...((await cacheGet(`${storageKey}:index`)) || {}) };
                for (const [id, record] of Object.entries(store)) {
                    if (index[id] >= record?.createdAt) continue;
                    if (await cacheSet(`${storageKey}:${id}`, record)) index[id] = record.createdAt;
                }
                await cacheSet(`${storageKey}:index`, index);
            };
            this._persistQueue = (this._persistQueue || Promise.resolve()).then(write, write);
            this._legacyMigration = this._persistQueue;
        }
    }

    _isUsablePersistedEntry(entry, key) {
        return entry?.signature === key && this._isValidHistoryData(entry.data) &&
            Number.isFinite(entry.createdAt) && entry.createdAt <= Date.now();
    }

    // Asynchronous IndexedDB read. Series persisted by the other page are
    // reused here; the localStorage fallback is read by _readPersistentHistory.
    async _loadPersistentHistory(key, period) {
        if (period === 1 || !isPersistentCacheAvailable()) return null;
        if (this._legacyMigration) await this._legacyMigration;
        const entry = await cacheGet(`${this._historyStorageKey()}:${this._historyCacheId(key)}`);
        return this._isUsablePersistedEntry(entry, key) ? entry : null;
    }

    _readPersistentHistory(key) {
        if (isPersistentCacheAvailable()) return null;
        try {
            const store = JSON.parse(localStorage.getItem(this._historyStorageKey()), historyDecode) || {};
            const entry = store[this._historyCacheId(key)];
            if (this._isUsablePersistedEntry(entry, key)) return entry;
        } catch { /* corrupt/unavailable storage is a normal cache miss */ }
        return null;
    }

    _persistHistory(key, entry, period) {
        // 1D belongs to the canonical live snapshot cache. Persisting it here
        // would duplicate volatile financial state in a visual cache.
        if (period === 1) return;
        // Raw per-ticker candles and diagnostic provenance are already
        // persisted by the market-data layer and can be very large. The
        // chart snapshot stores only the final canonical series needed to
        // paint the graph and its period KPIs.
        const {
            historicalDataMap: _rawCandles,
            resolvedPrices: _resolvedPrices,
            perTickerYesterdayClose: _perTickerClose,
            pointMeta: _pointMeta,
            ...renderData
        } = entry.data;
        const record = { signature: key, createdAt: entry.createdAt, data: renderData };
        if (isPersistentCacheAvailable()) {
            // IndexedDB rejects non-cloneable values; JSON drops them, as the
            // localStorage cache always did.
            try { structuredClone(renderData); }
            catch { record.data = JSON.parse(JSON.stringify(renderData, historyEncode), historyDecode); }
            void this._persistHistoryEntry(key, record);
            return;
        }
        try {
            const storageKey = this._historyStorageKey();
            const store = JSON.parse(localStorage.getItem(storageKey), historyDecode) || {};
            store[this._historyCacheId(key)] = record;
            const ids = Object.keys(store).sort((a, b) => (store[b]?.createdAt || 0) - (store[a]?.createdAt || 0));
            ids.slice(HISTORY_CHART_CACHE_MAX_ENTRIES).forEach(id => delete store[id]);
            localStorage.setItem(storageKey, JSON.stringify(store, historyEncode));
        } catch {
            // Quota/storage failure never invalidates the in-memory graph.
        }
    }

    // One IndexedDB record per series plus a small index used for eviction.
    // Writes are serialized so concurrent commits never lose index entries.
    _persistHistoryEntry(key, record) {
        const storageKey = this._historyStorageKey();
        const id = this._historyCacheId(key);
        const write = async () => {
            if (!(await cacheSet(`${storageKey}:${id}`, record))) return;
            const index = { ...((await cacheGet(`${storageKey}:index`)) || {}), [id]: record.createdAt };
            const ids = Object.keys(index).sort((a, b) => index[b] - index[a]);
            for (const evicted of ids.slice(HISTORY_CHART_PERSISTENT_MAX_ENTRIES)) {
                delete index[evicted];
                await cacheDelete(`${storageKey}:${evicted}`);
            }
            await cacheSet(`${storageKey}:index`, index);
        };
        this._persistQueue = (this._persistQueue || Promise.resolve()).then(write, write);
        return this._persistQueue;
    }

    // Tickers whose market can move this series (cash/dividend lines cannot).
    _historyTickers(key) {
        try {
            const [scope, , ledger] = JSON.parse(key);
            const tickers = new Set();
            if (typeof scope === 'string' && scope.startsWith('asset:')) tickers.add(scope.slice(6).toUpperCase());
            for (const [ticker, , , , type, assetType] of ledger || []) {
                const kind = String(assetType || 'Stock').toLowerCase();
                if (type === 'dividend' || ['cash', 'dividend', 'real estate'].includes(kind)) continue;
                if (ticker) tickers.add(String(ticker).toUpperCase());
            }
            return [...tickers];
        } catch { return null; }
    }

    // Past points never change: a series is only worth rebuilding when a new
    // point can exist, i.e. one of its markets traded (or settled its close)
    // after the series was built, or the civil day changed (sliding window).
    _isHistoryStale(key, entry, period, now = Date.now()) {
        const age = now - entry.createdAt;
        if (new Date(entry.createdAt).toDateString() !== new Date(now).toDateString()) return true;
        const tickers = this._historyTickers(key);
        if (!tickers) return true;
        try {
            // A settled daily close is a stronger freshness signal than the
            // generic TTL. In particular, 2Y/All caches live for 24 h: without
            // this check a series built before today's close could remain frozen
            // until the following day even though a definitive candle exists.
            const hasNewSettledClose = tickers.some(ticker => {
                if (marketCalendarEngine.getTradingModel(ticker) === 'crypto_24_7') return false;
                let session = marketCalendarEngine.getSession(ticker, new Date(now));
                if (!session || session.openUTCMs > now) session = marketCalendarEngine.getPreviousTradingSession(ticker, new Date(now));
                const settledAt = Number(session?.closeUTCMs) + MARKET_SETTLE_MS;
                return Number.isFinite(settledAt) && settledAt <= now && entry.createdAt < settledAt;
            });
            if (hasNewSettledClose) return true;
            if (age < this._historyCacheTtl(period)) return false;
            return tickers.some(ticker => {
                if (marketCalendarEngine.getTradingModel(ticker) === 'crypto_24_7') return true;
                if (marketCalendarEngine.isMarketOpen(ticker, now)) return true;
                let session = marketCalendarEngine.getSession(ticker, new Date(now));
                if (!session || session.openUTCMs > now) session = marketCalendarEngine.getPreviousTradingSession(ticker, new Date(now));
                const lastClose = session?.closeUTCMs;
                return !Number.isFinite(lastClose) || entry.createdAt < lastClose + MARKET_SETTLE_MS;
            });
        } catch { return true; }
    }

    _isValidHistoryData(data) {
        if (!data || data.dataQuality?.valid === false || !Array.isArray(data.labels) || !data.labels.length) return false;
        const values = this.currentMode === 'asset' && Number.isFinite(data.unitPrices?.at(-1))
            ? data.unitPrices
            : data.values;
        if (!Array.isArray(values) || values.length !== data.labels.length) return false;
        const lastValue = values.at(-1);
        if (lastValue === null || lastValue === undefined || !Number.isFinite(Number(lastValue))) return false;
        // A cash-only value is traceable even when security TWR is undefined.
        return true;
    }

    _commitHistory(key, data, period) {
        if (!this._isValidHistoryData(data)) return false;
        const entry = { createdAt: Date.now(), data };
        this._historyCache.set(key, entry);
        while (this._historyCache.size > HISTORY_CHART_MEMORY_MAX_ENTRIES) this._historyCache.delete(this._historyCache.keys().next().value);
        this._persistHistory(key, entry, period);
        return true;
    }

    _refreshCachedHistory(key, period, producer) {
        if (this._historyInFlight.has(key)) return this._historyInFlight.get(key);
        const periodAtStart = this.currentPeriod;
        const promise = producer().then(data => {
            if (this._commitHistory(key, data, period) && this.currentPeriod === periodAtStart) {
                // Repaint only after the complete replacement has been committed.
                // update() will read it synchronously from memory; no second build.
                queueMicrotask(() => this.update(false, false));
            }
            return data;
        }).catch(error => {
            console.warn('[HistoricalChart] background history refresh failed:', error);
            return null;
        }).finally(() => this._historyInFlight.delete(key));
        this._historyInFlight.set(key, promise);
        return promise;
    }

    // Synchronous cache read (memory, then persistent). A stale entry is still
    // served while its replacement is rebuilt in the background.
    _peekCachedHistory(key, period, producer) {
        let cached = this._historyCache.get(key);
        if (!cached && period !== 1) {
            cached = this._readPersistentHistory(key);
            if (cached) this._historyCache.set(key, cached);
        }
        if (!cached) return null;
        if (this._isHistoryStale(key, cached, period)) this._refreshCachedHistory(key, period, producer);
        return cached.data;
    }

    async _getCachedHistory(scope, purchases, period, producer) {
        const key = this._historyKey(scope, purchases, period);
        const cached = this._peekCachedHistory(key, period, producer);
        if (cached) return cached;
        if (this._historyInFlight.has(key)) return this._historyInFlight.get(key);
        // Series already built on the other page (or a previous session).
        // Without IndexedDB, _peekCachedHistory already read localStorage.
        if (period !== 1 && isPersistentCacheAvailable()) {
            const persisted = await this._loadPersistentHistory(key, period);
            if (persisted && !this._historyCache.has(key)) this._historyCache.set(key, persisted);
            const restored = this._peekCachedHistory(key, period, producer);
            if (restored) return restored;
            if (this._historyInFlight.has(key)) return this._historyInFlight.get(key);
        }

        const promise = producer().then(data => {
            this._commitHistory(key, data, period);
            return data;
        }).finally(() => this._historyInFlight.delete(key));
        this._historyInFlight.set(key, promise);
        return promise;
    }

    // ========================================================
    // Auto-refresh
    // ========================================================
    startAutoRefresh() {
        this.stopAutoRefresh();
        this._autoRefreshTimeout = setTimeout(() => {
            this.silentUpdate();
        }, AUTO_REFRESH_FIRST_MS);
        this._autoRefreshInterval = setInterval(() => {
            this.silentUpdate();
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
        // BUG FOUND: silently dropping the request when isLoading left the
        // period button visually "active" (setupPeriodButtons toggles that
        // class unconditionally, before this even runs) while the chart kept
        // showing the PREVIOUS period's data underneath — e.g. clicking "All"
        // right after a broker filter change (still loading) left "All"
        // highlighted over a stale 1D chart, with PÉRIODE reading as VAR. JOUR.
        // Queue the latest request instead of dropping it, and drain it once
        // the in-flight load finishes — same coalesce-to-latest pattern as
        // update()'s own _pendingUpdate.
        this._pendingPeriod = days;
        this._setLoadingState(true);
        if (this.isLoading) {
            // Invalidate the render currently in flight. Its data may still be
            // useful to the network caches, but it must never reach the canvas.
            this._updateRequestId++;
            return;
        }
        this._pendingPeriod = undefined;
        this.currentPeriod = days;
        this.stopAutoRefresh();
        await this.update(true, false);
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
    // Scope for "how old is what's being displayed": the drilled-into asset's
    // own first purchase in asset mode (row click, or a single-ticker filter
    // on the portfolio view) — the whole portfolio's otherwise. Shared by
    // updatePeriodButtonsAvailability() below.
    _periodAvailabilityScopeTicker() {
        if (this.currentMode === 'asset' && this.selectedAssets.length === 1) return this.selectedAssets[0];
        if (this.currentMode === 'portfolio' && this.filterManager) {
            const selected = this.filterManager.getSelectedTickers();
            if (selected.size === 1) return Array.from(selected)[0];
        }
        return null;
    }

    updatePeriodButtonsAvailability() {
        this._injectSelectionToggle();

        const ticker = this._periodAvailabilityScopeTicker();
        const purchases = this.storage.getPurchases();
        const relevant = ticker
            ? purchases.filter(p => p.ticker.toUpperCase() === ticker.toUpperCase())
            : purchases;

        const firstPurchase = relevant
            .map(p => new Date(p.date))
            .filter(d => !isNaN(d.getTime()))
            .sort((a, b) => a - b)[0];

        const containers = new Set();
        document.querySelectorAll('.period-btn').forEach(btn => containers.add(btn.parentNode));

        if (!firstPurchase) {
            // Nothing to constrain by for this scope — show every fixed button
            // and drop any leftover dynamic NY buttons from a previous (older)
            // scope, rather than leaving them at whatever state the last asset
            // viewed left them in.
            document.querySelectorAll('.period-btn[data-period]').forEach(btn => {
                btn.style.display = '';
                btn.classList.remove('period-disabled');
            });
            containers.forEach(c => c.querySelectorAll('.period-btn[data-dynamic-year]').forEach(b => b.remove()));
            return;
        }

        const ageDays = Math.floor((Date.now() - firstPurchase.getTime()) / (24 * 60 * 60 * 1000));
        const ageYears = Math.floor(ageDays / 365);

        // Evolutive period buttons: a fixed-window button only becomes available
        // once what's displayed has actually existed that long — otherwise
        // clicking it shows a mostly-empty chart before the first purchase (e.g.
        // "6M" on an asset held 3 months). 1D/2D, YTD and All are intentionally
        // excluded — always meaningful regardless of age.
        const fixedPeriodDays = { '7': 7, '30': 30, '90': 90, '180': 180, '365': 365, '730': 730, '1095': 1095 };

        document.querySelectorAll('.period-btn[data-period]').forEach(btn => {
            const requiredDays = fixedPeriodDays[btn.dataset.period];
            if (requiredDays !== undefined) {
                const eligible = ageDays >= requiredDays;
                btn.style.display = eligible ? '' : 'none';
                // The 3Y button ships with "period-disabled" hardcoded in the HTML
                // (blocks clicks regardless of visibility) — clear it once the
                // account is actually old enough, or the button stays inert even
                // though it's now shown.
                btn.classList.toggle('period-disabled', !eligible);
            }
        });

        containers.forEach(container => {
            // Drop dynamic buttons from a previous call before re-adding, so
            // re-running this (e.g. on a later page load, or a narrower scope)
            // never duplicates or leaves stale ones behind.
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

        // The currently active period just became unavailable for this (now
        // narrower) scope — e.g. switching from the full portfolio's "6M" tab
        // into a 3-month-old asset. Fall back to "All" instead of leaving the
        // chart stuck on a hidden button showing a mostly-empty window.
        const activeBtn = document.querySelector('.period-btn.active[data-period]');
        if (activeBtn && activeBtn.style.display === 'none' && !this.isLoading) {
            this.changePeriod('all');
        }
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
                b.innerHTML = '<i class="fa-solid fa-magnifying-glass-minus" aria-hidden="true"></i>';
            } else {
                b.classList.toggle('active', !!this.zoomModeEnabled);
                b.title = this.zoomModeEnabled
                    ? 'Zoom activé : glissez sur le graphique pour zoomer'
                    : 'Activer le zoom par glisser-déposer';
                b.innerHTML = '<i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i>';
            }
            b.setAttribute('aria-label', b.title);
            b.setAttribute('aria-pressed', String(this._isZoomed || !!this.zoomModeEnabled));
        });
        if (this._canvasEl) this._canvasEl.style.cursor = this.zoomModeEnabled ? 'zoom-in' : 'crosshair';
    }

    _getBenchmarkWindow(graphData) {
        const timestamps = graphData?.timestamps?.map(Number).filter(Number.isFinite) || [];
        if (timestamps.length === 0) return null;
        const startMs = Math.min(...timestamps);
        const endMs = Math.max(...timestamps);
        // Yahoo treats period2 as exclusive. One second beyond the last plotted
        // instant includes a candle exactly aligned with that final instant while
        // keeping the request on the portfolio's canonical display window.
        const startTs = Math.floor(startMs / 1000);
        const endTs = Math.max(startTs + 1, Math.ceil(endMs / 1000) + 1);
        return { startTs, endTs };
    }

    _buildBenchmarkPerformanceSeries(benchmarkData, graphTimestamps, firstIndex = 0) {
        if (!benchmarkData || !Array.isArray(graphTimestamps)) return null;
        const points = Object.entries(benchmarkData)
            .map(([timestamp, price]) => ({ timestamp: Number(timestamp), price: Number(price) }))
            .filter(({ timestamp, price }) => Number.isFinite(timestamp) && Number.isFinite(price) && price > 0)
            .sort((a, b) => a.timestamp - b.timestamp);
        const startGraphTs = Number(graphTimestamps[firstIndex]);
        if (points.length === 0 || !Number.isFinite(startGraphTs)) return null;

        // Prefer the latest observation already known at the portfolio's first
        // meaningful point. If none exists, the benchmark starts only at its own
        // first observation: earlier portfolio points remain null, never 0%.
        const priorPoint = points.findLast(point => point.timestamp <= startGraphTs);
        const basePoint = priorPoint || points.find(point => point.timestamp >= startGraphTs);
        if (!basePoint) return null;

        let cursor = 0;
        let lastKnown = null;
        return graphTimestamps.map((rawTs, index) => {
            const timestamp = Number(rawTs);
            if (index < firstIndex || !Number.isFinite(timestamp) || timestamp < basePoint.timestamp) return null;
            while (cursor < points.length && points[cursor].timestamp <= timestamp) {
                lastKnown = points[cursor];
                cursor++;
            }
            if (!lastKnown || lastKnown.timestamp < basePoint.timestamp) return null;
            return ((lastKnown.price - basePoint.price) / basePoint.price) * 100;
        });
    }

    showMessage(msg) {
        const info = document.getElementById('chart-info');
        if (info) { info.style.display = 'block'; info.textContent = msg; }
    }

    _setLoadingState(active, { reveal = true } = {}) {
        const loading = document.getElementById('chart-loading');
        const canvas = document.getElementById('historical-portfolio-chart');
        const stats = canvas?.closest('.dashboard-chart-section, .historical-chart-section, .chart-card')
            ?.querySelector('.chart-stats-bar') || document.querySelector('.chart-stats-bar');
        if (loading) loading.style.display = active ? 'flex' : 'none';
        if (canvas) {
            canvas.style.visibility = (active || !reveal) ? 'hidden' : 'visible';
            canvas.setAttribute('aria-busy', active ? 'true' : 'false');
        }
        if (stats) stats.style.visibility = (active || !reveal) ? 'hidden' : 'visible';
        if (active) canvas?.parentNode?.querySelector(':scope > .hc-tooltip')?.classList.remove('visible');
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

    // Complete history of the active scope, for the ATH line. Never awaited by
    // update(): a cache hit is returned synchronously; on a miss the all-time
    // build starts in the background and the chart repaints once it has been
    // committed, so enabling ATH never delays the main curve.
    //
    // `forRender: false` is the prefetch issued by update() before its own
    // awaits, so the all-time build runs in parallel with the snapshot/period
    // history instead of after the first paint. A repaint is only scheduled
    // when a render actually went out without the ATH (`_athRepaintKeys`).
    _getAthHistory(source, graphData, { forRender = true } = {}) {
        if (!source) return null;
        if (this.currentPeriod === 'all') return graphData;
        const key = this._historyKey(source.scope, source.purchases, 'all');
        const cached = this._peekCachedHistory(key, 'all', source.producer);
        if (cached) return cached;
        if (this._athPending.has(key)) {
            if (forRender) this._athRepaintKeys.add(key);
            return null;
        }
        if (Date.now() - (this._athFailedAt.get(key) || 0) < ATH_RETRY_DELAY_MS) return null;

        this._athPending.add(key);
        if (forRender) this._athRepaintKeys.add(key);
        this._getCachedHistory(source.scope, source.purchases, 'all', source.producer)
            .then(data => {
                // Only a committed (valid) history ends up in the cache the
                // repaint reads — anything else would loop on the same miss.
                if (!this._isValidHistoryData(data)) throw new Error('all-time history failed validation');
                if (this._athRepaintKeys.delete(key) && this.refLineVisibility.ath) this.update(false, false);
            })
            .catch(error => {
                const renderWaiting = this._athRepaintKeys.delete(key);
                this._athFailedAt.set(key, Date.now());
                console.warn('[HistoricalChart] ATH history unavailable:', error);
                // A waiting render shows a loading ATH block: repaint once so
                // it resolves to "hidden" instead of loading forever.
                if (renderWaiting && this.refLineVisibility.ath) this.update(false, false);
            })
            .finally(() => this._athPending.delete(key));
        return null;
    }

    // True while an all-time build for this source is in flight (the stats
    // bar then shows a loading ATH block instead of popping it in later).
    _isAthPending(source) {
        return !!source && this._athPending.has(this._historyKey(source.scope, source.purchases, 'all'));
    }

    // Start the all-time build as early as possible, but only when the ATH
    // would actually be drawn: line enabled, and a performance (%) or unit
    // price view — never for the € value view.
    _prefetchAthHistory(source) {
        if (!this.refLineVisibility.ath || this.currentPeriod === 'all') return;
        const view = document.querySelector('#view-toggle .toggle-btn.active')?.dataset.view;
        const athView = view === 'performance' || view === 'unit' || (!!this.currentBenchmark && view !== 'unit');
        if (athView) this._getAthHistory(source, null, { forRender: false });
    }

    // ========================================================
    // update() — builds graphData for whichever mode is active, then renders.
    // ========================================================
    async update(showLoading = true, forceApi = true) {
        const requestId = ++this._updateRequestId;
        if (this.isLoading) {
            this._pendingUpdate = { showLoading, forceApi };
            if (showLoading) this._setLoadingState(true);
            return;
        }
        const canvas = document.getElementById('historical-portfolio-chart');
        if (!canvas) return;
        this.isLoading = true;

        const loading = document.getElementById('chart-loading');
        const info = document.getElementById('chart-info');
        const benchmarkWrapper = document.getElementById('benchmark-wrapper');
        if (showLoading) { this._setLoadingState(true); if (info) info.style.display = 'none'; }
        let committed = false;

        try {
            let graphData = null;
            // How to obtain the complete history of the active scope (ATH
            // line) — resolved lazily by renderChart, never awaited here.
            let athSource = null;
            let todayGraphData = null;
            let targetHoldings = [];
            let targetSummary = {};
            let targetCashReserve = { total: 0 };
            // SSOT (audit architecture) : PortfolioSnapshot canonique produit par
            // le moteur (dataManager.buildTodaySnapshot/buildAssetTodaySnapshot/
            // buildIndexSnapshot) pour CE cycle — seule donnée que
            // _computeAggregateKPIs est autorisée à lire pour Var Today/Total
            // Value/Total Return. targetSummary/targetHoldings/targetCashReserve
            // restent en plus pour la TABLE (investmentsPage.js) et les sous-lignes
            // d'achat, mais ne sont plus utilisés pour dériver un KPI agrégé ici.
            let portfolioSnapshot = null;
            // Capturé par dataManager.buildTodaySnapshot() AVANT tout await de ce
            // cycle — sert de garde anti-race dans portfolioKPIs.updateFromGraph
            // (voir plus bas) pour qu'une réponse plus ancienne ne puisse jamais
            // écraser un état plus récent.
            let snapshotStartedAt = null;
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
                    const graphCurrentPrice = graphData.values[graphData.values.length - 1];
                    const startPrice = graphData.values[0];
                    // Moteur canonique (dataManager.buildIndexSnapshot) — même
                    // formule qu'avant (Total Return sur la série affichée, Var
                    // Today sur le prix live vs previousClose), désormais produite
                    // à un seul endroit et enveloppée dans un PortfolioSnapshot figé.
                    const indexSnap = this.dataManager.buildIndexSnapshot(currentTicker, {
                        graphCurrentPrice, startPrice, previousClose: indexPreviousClose,
                        livePrice: currentPriceData?.price
                    });
                    targetSummary = indexSnap.summary;
                    portfolioSnapshot = indexSnap.portfolioSnapshot;
                }
                titleConfig = { mode: 'index', label: this.customTitle ? this.customTitle.label : currentTicker, icon: '🌎' };

            // === MODE ACTIF UNIQUE (drill-down depuis une ligne du tableau) ===
            } else if (this.currentMode === 'asset' && this.selectedAssets.length === 1) {
                isSingleAsset = true;
                currentTicker = this.selectedAssets[0];
                // Capturé AVANT tout await de ce cycle (même règle que
                // dataManager.buildTodaySnapshot pour le mode portefeuille) — sans
                // ça, portfolioKPIs.updateFromSnapshot() n'a aucun moyen de rejeter un
                // refresh PORTEFEUILLE plus ancien qui répondrait APRÈS que cet
                // actif ait été sélectionné (voir le bug KPI-non-synchronisé).
                snapshotStartedAt = Date.now();
                if (forceApi) await this.dataManager.repository.getPrice(currentTicker, { forceRefresh: true });

                const pagePurchases = this.getFilteredPurchasesFromPage(false);
                const targetAssetPurchases = this.dataManager.getAssetHistoryPurchases(pagePurchases, currentTicker);

                // ATH: complete history of this asset, prefetched now so it builds
                // in parallel with the period history below (see _getAthHistory).
                athSource = {
                    scope: `asset:${currentTicker}`,
                    purchases: targetAssetPurchases,
                    producer: () => targetAssetPurchases.length === 0
                        ? this.dataManager.calculateAssetHistory(currentTicker, 'all')
                        : this.dataManager.calculateGenericHistory(targetAssetPurchases, 'all', true)
                };
                this._prefetchAthHistory(athSource);

                // Orchestration de fetch inchangée (choix d'appel réseau selon la
                // période affichée — pas un calcul financier, voir doc de
                // dataManager.buildAssetPortfolioSnapshot ci-contre pour pourquoi
                // elle reste ici plutôt que dans DataManager).
                graphData = await this._getCachedHistory(`asset:${currentTicker}`, targetAssetPurchases, this.currentPeriod, () =>
                    targetAssetPurchases.length === 0
                        ? this.dataManager.calculateAssetHistory(currentTicker, this.currentPeriod)
                        : this.dataManager.calculateGenericHistory(targetAssetPurchases, this.currentPeriod, true));

                todayGraphData = await this._resolveTodayData(targetAssetPurchases, [], true, graphData);
                // Taux USD/EUR figé à la date de chaque transaction (invariant 9) —
                // mémoïsé par dataManager, pas de coût réseau supplémentaire ici.
                const singleAssetFxMap = await this.dataManager.getHistoricalFxMap(targetAssetPurchases);

                // SSOT (audit architecture) : la partie CALCUL (yesterdayCloseMap →
                // holdings → résumé → PortfolioSnapshot canonique) vit désormais
                // dans DataManager, seule productrice de ces métriques — cette vue
                // ne fait plus que l'appeler et lire son résultat.
                const assetSnapshot = this.dataManager.buildAssetPortfolioSnapshot(currentTicker, targetAssetPurchases, todayGraphData, singleAssetFxMap);
                targetHoldings = assetSnapshot.holdings;
                targetSummary = assetSnapshot.summary;
                portfolioSnapshot = assetSnapshot.portfolioSnapshot;

                // FINANCIAL TRUTH OVER KPI RECONCILIATION (validation architecture
                // 2026-09-24, Phase 4) : le graphique affiché (`graphData`) et le
                // PortfolioSnapshot live (`portfolioSnapshot`) restent deux choses
                // séparées — le dernier point du graphique n'est PLUS forcé à
                // égaler le snapshot live (voir dataManager.js, ex-
                // alignLastPointToLiveSnapshot, supprimée). Le graphique représente
                // la dernière observation historique réellement disponible ; le
                // KPI (via portfolioKPIs, alimenté indépendamment par
                // _computeAggregateKPIs -> portfolioSnapshot) reste la valorisation
                // live "maintenant" — les deux peuvent légitimement différer.

                const name = targetAssetPurchases[0]?.name || currentTicker;
                titleConfig = { mode: 'asset', label: `${currentTicker} • ${name}`, icon: this.dataManager.isCryptoTicker(currentTicker) ? '₿' : '📊' };

            // === MODE PORTFOLIO GLOBAL / FILTRÉ ===
            } else {
                titleConfig = this.investmentsPage.getChartTitleConfig();
                const allPurchases = this.getFilteredPurchasesFromPage(false);
                const { assets: assetPurchases, cash: cashPurchases } = this.dataManager.splitCanonicalPurchases(allPurchases);

                // Whole ledger of the view (securities + cash) — shared by the period
                // history below and the ATH's all-time history, which is prefetched
                // now so it builds in parallel with the snapshot (see _getAthHistory).
                const historyPurchases = [...assetPurchases, ...cashPurchases];
                athSource = {
                    scope: 'portfolio',
                    purchases: historyPurchases,
                    producer: () => this.dataManager.calculateHistory(historyPurchases, 'all')
                };
                this._prefetchAthHistory(athSource);

                if (titleConfig.mode === 'asset') {
                    isSingleAsset = true;
                    currentTicker = this.filterManager.getSelectedTickers().values().next().value;
                }

                // MarketDataRepository (validation architecture 2026-09-24) —
                // remplace l'ancien fetchBatchPrices()+livePriceSnapshot()+
                // buildTodaySnapshot() manuels : même résultat (le Repository
                // fait exactement cette séquence en interne, voir
                // marketDataRepository.js::_computeSnapshot — fetchBatchPrices
                // PUIS capture de livePriceSnapshot SANS AUCUN await entre les
                // deux, garantie anti-race inchangée), mais désormais coalescé
                // avec les AUTRES appelants concurrents du même portefeuille
                // (refreshDataInBackground/loadPortfolioData, voir
                // dashboardApp.js init()) au lieu de relancer sa propre
                // résolution à chaque cycle. Cache-first/SWR : forceApi=false
                // -> rendu immédiat depuis le dernier snapshot exploitable
                // (refresh en tâche de fond si périmé) ; forceApi=true ->
                // refresh explicite attendu (bouton période, auto-refresh).
                //
                // SNAPSHOT FINANCIER UNIQUE (cause racine de l'audit : "Fin"/le
                // tooltip du dernier point/Clôture hier pouvaient différer de "Total
                // Value"/"Var Today" parce que le graphique (HistoryCalculator) et
                // calculateHoldings lisaient storage.getCurrentPrice()/
                // getConversionRate() à deux instants distincts). Un seul appel
                // résout "aujourd'hui" — todayGraphData ET targetHoldings/
                // targetSummary en sortent réconciliés par construction (mêmes prix,
                // même taux), jamais deux jeux de données pour le même instant.
                //
                // IMPORTANT (cache-first) : snapshotStartedAt pour la garde
                // anti-race de portfolioKPIs doit rester "maintenant" — QUAND
                // CE CYCLE DE RENDU A COMMENCÉ à demander un snapshot — jamais
                // l'horodatage interne du snapshot servi par le Repository.
                // Avec un cache-first, un GET peut légitimement renvoyer des
                // données calculées il y a plusieurs secondes/minutes : réutiliser
                // CET horodatage-là ferait passer un rendu pourtant plus récent
                // pour "plus ancien" aux yeux de la garde anti-race (bug trouvé :
                // portefeuille → actif → portefeuille pouvait rester bloqué sur
                // les KPI de l'actif si le cache portefeuille datait d'avant la
                // sélection de l'actif).
                snapshotStartedAt = Date.now();
                const repoResult = await this.dataManager.repository.getSnapshot(assetPurchases, cashPurchases, {
                    forceRefresh: forceApi,
                    // A period switch only changes the historical window. A
                    // concurrent live SWR refresh would compete with 20-30
                    // historical requests and trigger Worker 429 responses.
                    revalidate: this.currentPeriod === 1
                });
                const snapshot = repoResult.snapshot._engine;
                if (repoResult.previousSession) {
                    this.investmentsPage.renderData?.(snapshot.holdings,
                        { ...snapshot.summary, totalDayChangeEUR: null, dayChangePct: null }, snapshot.cashReserve.total);
                    this.showMessage(`Dernier portefeuille connu : ${new Date(repoResult.snapshot.generatedAt).toLocaleString()}. Actualisation en cours.`);
                    return;
                }
                // Degraded: show when the prices were really observed.
                this.snapshotFreshness = { stale: repoResult.stale, degraded: repoResult.degraded,
                    generatedAt: repoResult.degraded ? (repoResult.pricesAsOf ?? repoResult.snapshot.generatedAt) : repoResult.snapshot.generatedAt };
                todayGraphData = snapshot.todayGraphData;
                targetHoldings = snapshot.holdings;
                targetSummary = snapshot.summary;
                targetCashReserve = snapshot.cashReserve;
                portfolioSnapshot = snapshot.portfolioSnapshot;

                // Sur l'onglet 1D, le graphique affiché EST le snapshot d'aujourd'hui
                // (zéro appel réseau supplémentaire). Sur une autre période (1W, 1M…),
                // une série plus large est construite séparément pour l'affichage —
                // "aujourd'hui" (Var Today/Clôture hier/Total Value) reste
                // exclusivement défini par le snapshot ci-dessus, jamais par le
                // dernier point de cette série-là.
                graphData = (this.currentPeriod === 1)
                    ? todayGraphData
                    : await this._getCachedHistory('portfolio', historyPurchases, this.currentPeriod,
                        () => this.dataManager.calculateHistory(historyPurchases, this.currentPeriod));

                // FINANCIAL TRUTH OVER KPI RECONCILIATION (validation architecture
                // 2026-09-24, Phase 4) : voir le même commentaire en mode actif
                // unique ci-dessus — plus aucun alignement du dernier point sur le
                // snapshot live, sur AUCUNE période (1D comme 1W/1M/...).
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
                const benchmarkWindow = this._getBenchmarkWindow(graphData);
                if (benchmarkWindow) {
                    const interval = this.dataManager.getIntervalForPeriod ? this.dataManager.getIntervalForPeriod(this.currentPeriod) : '1d';
                    benchmarkData = await this.api.getHistoricalPricesWithRetry(
                        this.currentBenchmark, benchmarkWindow.startTs, benchmarkWindow.endTs, interval);
                }
            }

            // A period/filter/mode request issued while this calculation was in
            // flight owns the next paint. Never expose this superseded result.
            if (requestId !== this._updateRequestId || this._pendingPeriod !== undefined) return;

            if (!this._isValidHistoryData(graphData)) {
                const hasPreviousChart = !!this.chart;
                this.showMessage(graphData?.dataQuality?.valid === false
                    ? (hasPreviousChart
                        ? 'Données de marché indisponibles pour cette période. Le dernier graphique validé est conservé.'
                        : 'Données de marché indisponibles pour cette période.')
                    : 'Pas de données disponibles pour cette période');
            } else {
                const kpiData = this._computeAggregateKPIs({ portfolioSnapshot, snapshotStartedAt });
                this.renderChart(canvas, graphData, targetSummary, titleConfig, benchmarkData, currentTicker, this.lastYesterdayClose, kpiData, athSource);
                committed = true;
                if (info) info.style.display = 'none';
                this._syncToolbarState(isSingleAsset || isIndexMode ? null : this.snapshotFreshness);

                if (!isSingleAsset && !isIndexMode) {
                    // SSOT (audit architecture) : plus de 4e argument "chartStats" —
                    // investmentsPage.renderData ne doit plus recevoir de valeur issue
                    // du graphique pour ses KPI secondaires, uniquement les positions
                    // canoniques (targetHoldings/targetSummary), seule source qu'elle
                    // est autorisée à agréger (voir investmentsPage.js::renderData).
                    this.investmentsPage.renderData(targetHoldings, targetSummary, targetCashReserve.total);
                }
            }

        } catch (err) {
            if (requestId !== this._updateRequestId) return;
            console.error('[HistoricalChart] update failed:', err);
            this.showMessage('Erreur lors du calcul');
        } finally {
            this.isLoading = false;
            if (this._pendingPeriod !== undefined) {
                const next = this._pendingPeriod;
                this._pendingPeriod = undefined;
                void this.changePeriod(next);
                return;
            }
            if (this._pendingUpdate) {
                const p = this._pendingUpdate; this._pendingUpdate = null;
                void this.update(p.showLoading, p.forceApi);
                return;
            }
            // An invalid refresh must not erase a chart that was already
            // validated: the Chart.js instance is deliberately kept above, so
            // reveal it again once the loader closes. With no previous chart,
            // the empty canvas remains hidden and only the message is shown.
            if (requestId === this._updateRequestId) this._setLoadingState(false, { reveal: committed || !!this.chart });
        }
    }

    // SÉLECTEUR PUR (audit architecture SSOT) — Total Value / Total Return /
    // Var Today ne sont plus JAMAIS calculés ici : ils sont simplement LUS sur
    // le PortfolioSnapshot canonique (dataManager.buildPortfolioSnapshot,
    // produit en amont par buildTodaySnapshot/buildAssetPortfolioSnapshot/
    // buildIndexSnapshot — les 3 seuls producteurs). Cette fonction ne fait
    // qu'adapter les noms de champs canoniques (totalValue/totalReturn/dayPnl)
    // au vocabulaire historique de ce fichier (varTodayAbs/varTodayPct) pour
    // ne pas devoir renommer tous les appelants en aval (renderChart,
    // kpiManager, portfolioKPIs) — zéro arithmétique.
    //
    // BUG FOUND (audit cohérence KPI/tableau, régression du fix précédent) :
    // cette fonction calculait ELLE-MÊME Var Today ici, avec un repli sur
    // targetSummary.totalDayChangeEUR SEULEMENT en dernier recours. Le chemin
    // PRINCIPAL — celui réellement emprunté dès qu'un todayGraphData/dailyTwr
    // existait, c'est-à-dire le mode portefeuille normal, celui du rapport
    // initial (KPI=121,41€ vs Σ table=362,08€) — appliquait un ratio
    // `dailyTwr` (time-weighted, neutralisé aux cash-flows) au TOTAL du
    // portefeuille : `totalValue - totalValue/dTwr`. Cette formule n'a AUCUNE
    // raison de tomber sur la même valeur que Σ asset.dayChange : un TWR
    // journalier est un ratio composé sur le portefeuille entier (pondéré par
    // la séquence des cash-flows intra-journaliers), pas une somme additive
    // des variations €. Les deux peuvent légitimement diverger dès qu'un
    // achat/vente a lieu dans la journée — exactement le scénario du rapport.
    // Fix définitif : plus aucune formule locale du tout — cette fonction ne
    // sait littéralement plus calculer Var Today, seulement le lire.
    _computeAggregateKPIs({ portfolioSnapshot, snapshotStartedAt = null }) {
        if (!portfolioSnapshot) {
            return { totalValue: 0, cash: 0, totalReturn: 0, totalReturnPct: 0, varTodayAbs: null, varTodayPct: null, investedAssetOnly: 0, snapshotStartedAt, snapshotId: null };
        }
        return {
            portfolioSnapshot,
            totalValue: portfolioSnapshot.totalValue,
            cash: portfolioSnapshot.cash,
            totalReturn: portfolioSnapshot.totalReturn,
            totalReturnPct: portfolioSnapshot.totalReturnPct,
            varTodayAbs: portfolioSnapshot.dayPnl,
            varTodayPct: portfolioSnapshot.dayPnlPct,
            investedAssetOnly: portfolioSnapshot.invested,
            snapshotStartedAt: snapshotStartedAt ?? portfolioSnapshot.snapshotStartedAt,
            snapshotId: portfolioSnapshot.snapshotId
        };
    }

    // BUG FOUND: #view-toggle means two different things depending on what's
    // shown, but investmentsPage.js/dashboardApp.js only ever build it ONCE at
    // page load, as "Valeur (€)" / "Performance (%)" — meant for the portfolio
    // view. In single-asset drill-down, isPerformanceView/isUnitView below are
    // both gated to require the OTHER mode's data-view value ('unit'), which
    // this toggle can now never produce — so a drilled-down asset was
    // permanently stuck on the total-value curve (graphData.values) while
    // referenceClose stayed the per-share previousClose (native ticker price),
    // a basis mismatch that showed up as a nonsensical "Clôture Hier" and
    // silently disabled PRU + the purchase-point markers (both isUnitView-only).
    // Rebuild the two buttons to match the active mode — only when the mode
    // actually changed, so a user's choice within a mode isn't reset on every
    // render (auto-refresh included).
    _syncViewToggle(isSingleAssetMode, isIndexMode) {
        const container = document.getElementById('view-toggle');
        if (!container) return;
        const wantAsset = isSingleAssetMode && !isIndexMode;
        const mode = wantAsset ? 'asset' : 'portfolio';
        if (container.dataset.mode === mode) return;
        mountViewToggle(container, mode, () => this.update(false, false));
    }

    _loadRefLinePref(key) {
        try {
            const v = localStorage.getItem(`chart_refline_${key}`);
            return v === null ? true : v === '1';
        } catch (e) { return true; }
    }

    // Small independent checkboxes (not a mutually-exclusive toggle) next to
    // #view-toggle: "Clôture" only makes sense on the 1D view, "PRU" only in
    // single-asset unit-price mode, "ATH" only where a high is a performance
    // signal — the TWR performance view or the unit-price view (`athKind`),
    // never a € total that includes contributions. Built once and
    // shown/hidden per mode afterwards, so a user's choice survives renders.
    _syncReferenceLineToggles(isSingleAssetMode, athKind = null) {
        const anchor = document.getElementById('view-toggle');
        if (!anchor) return;
        let container = document.getElementById('ref-lines-toggle');
        if (!container) {
            container = document.createElement('div');
            container.id = 'ref-lines-toggle';
            container.className = 'chart-chip-group';
            anchor.parentNode.insertBefore(container, anchor.nextSibling);
            // The Dashboard does not expose Clôture/PRU, but it does expose ATH
            // for the global portfolio. Investments adds all three controls.
            // Each chip carries a dashed swatch in its line's colour (see
            // css/chart-toolbar.css), so the chips also act as the legend.
            const lines = this.ui
                ? [['close', 'Clôture', 'Clôture de la veille (vue 1J)'], ['pru', 'PRU', 'Prix de revient unitaire moyen'], ['ath', 'ATH', '']]
                : [['ath', 'ATH', '']];
            lines.forEach(([key, label, title]) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'chart-chip';
                btn.dataset.refline = key;
                if (title) btn.title = title;
                btn.innerHTML = `<span class="chart-chip-swatch" aria-hidden="true"></span><span>${label}</span>`;
                const syncPressed = () => {
                    btn.classList.toggle('active', this.refLineVisibility[key]);
                    btn.setAttribute('aria-pressed', String(!!this.refLineVisibility[key]));
                };
                syncPressed();
                btn.addEventListener('click', () => {
                    this.refLineVisibility[key] = !this.refLineVisibility[key];
                    syncPressed();
                    try { localStorage.setItem(`chart_refline_${key}`, this.refLineVisibility[key] ? '1' : '0'); } catch (e) { /* ignore */ }
                    this.update(false, false);
                });
                container.appendChild(btn);
            });
        }
        const closeBtn = container.querySelector('[data-refline="close"]');
        const pruBtn = container.querySelector('[data-refline="pru"]');
        const athBtn = container.querySelector('[data-refline="ath"]');
        const showClose = !!closeBtn && this.currentPeriod === 1;
        const showPru = !!pruBtn && isSingleAssetMode;
        const showAth = !!athBtn && athKind !== null;
        if (closeBtn) closeBtn.style.display = showClose ? '' : 'none';
        if (pruBtn) pruBtn.style.display = showPru ? '' : 'none';
        if (athBtn) {
            athBtn.style.display = showAth ? '' : 'none';
            athBtn.title = athKind === 'price'
                ? 'Plus haut prix unitaire depuis le premier achat'
                : 'Plus haut historique de la performance (TWR), dans le repère de la période affichée';
        }
        container.style.display = (showClose || showPru || showAth) ? '' : 'none';
    }

    // Toolbar state that is not a button of its own: the benchmark chip tint
    // and the freshness status (replaces the static "00:00"). `freshness` is
    // the portfolio snapshot's {stale, degraded, generatedAt} for this cycle;
    // asset/index views have none and show the time of this render.
    _syncToolbarState(freshness) {
        document.getElementById('benchmark-wrapper')
            ?.classList.toggle('is-active', !!this.currentBenchmark);

        const status = document.getElementById('last-update');
        if (!status) return;
        const at = new Date(Number.isFinite(Number(freshness?.generatedAt)) ? Number(freshness.generatedAt)
            : (Date.parse(freshness?.generatedAt) || Date.now()));
        const time = at.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        const state = freshness?.degraded ? 'degraded' : (freshness?.stale ? 'stale' : 'fresh');
        const text = { degraded: `Partiel · ${time}`, stale: `Différé · ${time}`, fresh: `À jour · ${time}` }[state];
        const title = {
            degraded: 'Certaines cotations n’ont pas pu être actualisées',
            stale: 'Données en cache, actualisation en cours',
            fresh: this.currentPeriod === 1 ? 'Actualisation automatique active' : 'Données à jour'
        }[state];

        status.className = `chart-status is-${state}${state === 'fresh' && this.currentPeriod === 1 ? ' is-live' : ''}`;
        status.title = `${title} — ${at.toLocaleString('fr-FR')}`;
        status.innerHTML = `<span class="chart-status-dot" aria-hidden="true"></span><span class="chart-status-text">${text}</span>`;
    }

    _syncDividendToggle(isSingleAssetMode, isIndexMode) {
        const anchor = document.getElementById('view-toggle');
        if (!anchor) return;
        let container = document.getElementById('dividend-return-toggle');
        if (!container) {
            container = document.createElement('div');
            container.id = 'dividend-return-toggle';
            container.className = 'chart-chip-group';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'chart-chip';
            btn.dataset.option = 'dividends';
            btn.innerHTML = '<i class="fa-solid fa-coins" aria-hidden="true"></i><span>Dividendes</span>';
            btn.title = 'Inclure les dividendes dans la performance';
            btn.addEventListener('click', () => {
                this.includeDividends = !this.includeDividends;
                btn.classList.toggle('active', this.includeDividends);
                btn.setAttribute('aria-pressed', String(this.includeDividends));
                try { localStorage.setItem('chart_include_dividends', this.includeDividends ? '1' : '0'); } catch { /* ignore */ }
                this.update(false, false);
            });
            container.appendChild(btn);
            anchor.parentNode.insertBefore(container, anchor.nextSibling);
        }
        const dividendBtn = container.querySelector('.chart-chip');
        dividendBtn?.classList.toggle('active', this.includeDividends);
        dividendBtn?.setAttribute('aria-pressed', String(this.includeDividends));
        container.style.display = !isIndexMode ? '' : 'none';
    }

    // ========================================================
    // renderChart — Chart.js dataset construction + stats panel + KPI cards
    // ========================================================
    renderChart(canvas, graphData, summary, titleConfig, benchmarkData, currentTicker, referenceCloseIn, kpiData, athSource = null) {
        const isSingleAssetMode = (titleConfig && titleConfig.mode === 'asset');
        const isIndexMode = (titleConfig && titleConfig.mode === 'index');

        this._syncViewToggle(isSingleAssetMode, isIndexMode);
        const viewToggle = document.getElementById('view-toggle');
        const activeView = viewToggle?.querySelector('.toggle-btn.active')?.dataset.view || 'global';
        const isUnitView = isSingleAssetMode && activeView === 'unit';
        const isPerformanceView = !isSingleAssetMode && !isIndexMode && activeView === 'performance';
        const isPerformanceMode = (benchmarkData && !isUnitView && !isIndexMode) || isPerformanceView;
        const athKind = isIndexMode ? null : (isUnitView ? 'price' : (isPerformanceMode ? 'performance' : null));
        // Same creation order as before (both insert right after #view-toggle).
        this._syncReferenceLineToggles(isSingleAssetMode, athKind);
        this._syncDividendToggle(isSingleAssetMode, isIndexMode);

        const displayValues = isUnitView ? graphData.unitPrices : graphData.values;
        const decimals = (isUnitView || isIndexMode) ? 4 : 2;

        const isMeaningfulPoint = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
        let firstIndex = displayValues.findIndex(isMeaningfulPoint);
        let lastIndex = displayValues.length - 1;
        while (lastIndex >= 0 && !isMeaningfulPoint(displayValues[lastIndex], lastIndex)) lastIndex--;
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
        displayValues.forEach((v, i) => {
            if (i >= firstIndex && i <= lastIndex && isMeaningfulPoint(v)) {
                priceHigh = Math.max(priceHigh, v);
                priceLow = Math.min(priceLow, v);
            }
        });
        if (priceHigh === -Infinity) priceHigh = priceEnd;
        if (priceLow === Infinity) priceLow = priceStart;

        // PÉRIODE follows the canonical security TWR shown by the curve.
        // Cash is excluded; dividends are included only when explicitly enabled.
        let perfAbs = 0, perfPct = 0;
        const portfolioPctSeries = this._getPortfolioPerformanceSeries(graphData);
        if (!isIndexMode && !isUnitView && portfolioPctSeries?.length > lastIndex) {
            // Same definition for every range, including All: market P&L
            // accumulated interval by interval, with purchases/sales neutralised
            // as flows. `totalReturn` remains the separate unrealised-gain KPI;
            // using it here used to lose gains realised by partial sales (A7).
            const period = periodPerformance(graphData, {
                includeDividends: this.includeDividends,
                firstIndex,
                lastIndex
            });
            perfAbs = period.amount ?? 0;
            perfPct = period.percent ?? 0;
        } else {
            perfAbs = priceEnd - priceStart;
            perfPct = priceStart !== 0 ? (perfAbs / priceStart) * 100 : 0;
        }

        let referenceClose = referenceCloseIn ?? graphData.yesterdayClose ?? priceStart;
        if (!referenceClose || isNaN(referenceClose)) referenceClose = priceStart;

        // VAR TODAY : dérivé de kpiData.varTodayAbs, lui-même calculé (voir
        // historicalChart::_computeAggregateKPIs) à partir de graphData —
        // et graphData EST désormais le snapshot unique construit par
        // dataManager.buildTodaySnapshot() (voir update()) : priceEnd
        // (displayValues[lastIndex]) et referenceClose (graphData.yesterdayClose)
        // ci-dessus proviennent DÉJÀ des mêmes prix/taux que kpiData.totalValue —
        // il n'y a plus deux snapshots à réconcilier après coup. PÉRIODE (perfAbs/
        // perfPct, lu plus haut depuis graphData.twr) reste volontairement
        // indépendant de Var Today : sur l'onglet 1D les deux coïncident parce que
        // periodDenominator == dayDenominator pour une fenêtre d'un seul jour, pas
        // parce que l'un écrase l'autre.
        let vsYesterdayAbs = null, vsYesterdayPct = null;
        if (!isIndexMode && kpiData?.varTodayAbs !== null && kpiData?.varTodayAbs !== undefined && !isNaN(kpiData.varTodayAbs)) {
            vsYesterdayAbs = kpiData.varTodayAbs;
            vsYesterdayPct = kpiData.varTodayPct || 0;
        } else if (priceEnd !== null && referenceClose) {
            vsYesterdayAbs = priceEnd - referenceClose;
            vsYesterdayPct = referenceClose !== 0 ? (vsYesterdayAbs / referenceClose) * 100 : 0;
        }

        // "Fin" est le dernier point RÉEL du graphique — jamais substitué par
        // kpiData.totalValue après coup (voir audit : ce genre de substitution
        // ciblée sur le dernier point est justement ce qui produisait un tooltip
        // incohérent avec la courbe). Depuis buildTodaySnapshot(), les deux sont
        // déjà la même valeur par construction pour le portefeuille en vue 1D.
        const displayPriceEnd = priceEnd;

        const isPositive = (vsYesterdayAbs !== null ? vsYesterdayAbs : perfAbs) >= 0;
        const mainColor = isPositive ? '#2ecc71' : '#e74c3c';

        const avgPrice = this._computeAvgPrice(currentTicker, isIndexMode, kpiData?.portfolioSnapshot);

        const athReference = this._resolveAthReference(athKind, athSource, graphData, firstIndex, lastIndex);
        // While the all-time history is still building, the stats bar keeps
        // the ATH block's place with a loading state (no layout jump later).
        const athLoading = !athReference && !!athKind && this.refLineVisibility.ath && this._isAthPending(athSource);
        this.kpiManager.updateAthStats?.(athReference?.details ?? (athLoading ? { loading: true } : null));

        this._renderChartJs(canvas, graphData, displayValues, isPerformanceMode, benchmarkData, isUnitView, isIndexMode, currentTicker, mainColor, referenceClose, firstIndex, lastIndex, titleConfig, kpiData, avgPrice, athReference);

        this._renderTitle(titleConfig, currentTicker, isSingleAssetMode);

        this.kpiManager.updateKPIs({
            isIndexMode, isSingleAsset: isSingleAssetMode, isUnitView, currentPeriod: this.currentPeriod,
            perfAbs, perfPct, isPositive,
            vsYesterdayAbs, vsYesterdayPct, useTodayVar: vsYesterdayAbs !== null,
            referenceClose, finalYesterdayClose: this.lastYesterdayClose,
            priceStart, priceEnd: displayPriceEnd, priceHigh, priceLow, avgPrice, decimals
        });

        // BUG FOUND (KPI top cards non synchronisés en mode actif) : cette
        // condition excluait `isSingleAssetMode` — en mode actif (drill-down
        // OU vue portefeuille filtrée sur un seul ticker), portfolioKPIs
        // n'était donc JAMAIS mis à jour, et les 4 cartes du haut restaient
        // figées sur le dernier snapshot PORTEFEUILLE affiché avant la
        // sélection de cet actif. kpiData est pourtant déjà calculé plus haut
        // de façon mode-agnostique (_computeAggregateKPIs, à partir de
        // targetSummary/targetCashReserve — l'actif seul en mode 'asset',
        // cash=0 puisque targetCashReserve n'est jamais renseigné dans cette
        // branche de update()) : aucun second moteur, aucune formule
        // spéciale, on lui fait juste atteindre portfolioKPIs dans TOUS les
        // modes sauf l'index (qui n'a pas de notion de "Total Return
        // portefeuille" à afficher — comportement inchangé pour lui).
        if (!isIndexMode) {
            const periodMap = { 1: '1d', 2: '2d', 7: '1w', 30: '1m', 90: '3m', 180: '6m', 365: '1y', 730: '2y' };
            portfolioKPIs.updateFromSnapshot(kpiData?.portfolioSnapshot, {
                period: periodMap[this.currentPeriod] || String(this.currentPeriod),
                snapshotStartedAt: kpiData?.snapshotStartedAt ?? null
            });
        }

        return { historicalDayChange: vsYesterdayAbs, historicalDayChangePct: vsYesterdayPct };
    }

    // ATH reference line — pure selector + formatting. The calculation lives
    // in the engine (dataManager.computeAthReference); this only picks the
    // all-time series of the active scope and formats the label.
    _resolveAthReference(athKind, athSource, graphData, firstIndex, lastIndex) {
        if (!athKind || !this.refLineVisibility.ath) return null;
        const allHistory = this._getAthHistory(athSource, graphData);
        if (!allHistory) return null;
        const ath = this.dataManager.computeAthReference({
            kind: athKind, allHistory, visibleHistory: graphData,
            firstIndex, lastIndex, includeDividends: this.includeDividends
        });
        if (!ath) return null;
        const label = ath.kind === 'price'
            ? `ATH ${ath.value.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} €`
            : `ATH ${ath.value >= 0 ? '+' : ''}${ath.value.toFixed(2)}%`;

        // Stats-bar details: pure reads of the series at the point where the
        // engine located the ATH — no recomputation here.
        const series = ath.at.source === 'visible' ? graphData : allHistory;
        const i = ath.at.index;
        const read = (arr) => (Array.isArray(arr) && arr[i] !== null && arr[i] !== undefined && Number.isFinite(Number(arr[i]))) ? Number(arr[i]) : null;
        const returnPct = this.includeDividends && Array.isArray(series.totalReturnPctWithDividends)
            ? series.totalReturnPctWithDividends : series.totalReturnPct;
        const details = {
            kind: ath.kind,
            timestamp: read(series.timestamps),
            intraday: ath.at.source === 'visible' && typeof this.currentPeriod === 'number' && this.currentPeriod <= 2,
            price: ath.kind === 'price' ? ath.value : null,
            totalValue: ath.kind === 'performance' ? read(series.values) : null,
            totalReturn: ath.kind === 'performance' ? read(this._getPortfolioReturnSeries(series)) : null,
            totalReturnPct: ath.kind === 'performance' ? read(returnPct) : null,
            fromAthPct: ath.fromAthPct
        };
        return { value: ath.value, label, details };
    }

    _computeAvgPrice(currentTicker, isIndexMode, portfolioSnapshot) {
        if (!currentTicker || isIndexMode) return 0;
        return portfolioSnapshot?.positions
            ?.find(position => position.ticker.toUpperCase() === currentTicker.toUpperCase())
            ?.avgPrice || 0;
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
        this._updateBackButton(titleText);
    }

    // A small "✕" back-to-portfolio affordance next to the title, shown only in
    // index mode (dashboard market cards) — until now the only entry point in
    // the app with no way back: clicking an index card again also deselects it
    // (see dashboardApp.js), but that alone isn't discoverable without a visible
    // control. No-op on pages (investments.html) that never enter index mode.
    _updateBackButton(titleText) {
        const container = titleText.closest('.chart-title');
        if (!container) return;
        let btn = container.querySelector('.chart-back-btn');
        if (this.currentMode !== 'index') {
            btn?.remove();
            return;
        }
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'chart-back-btn';
            btn.title = 'Revenir au portefeuille';
            btn.innerHTML = '<i class="fas fa-xmark"></i>';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showPortfolioChart();
            });
            container.appendChild(btn);
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
    background: linear-gradient(145deg, rgba(12, 19, 35, 0.98), rgba(7, 12, 24, 0.98));
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 10px;
    padding: 8px 10px;
    min-width: 208px;
    max-width: min(300px, calc(100vw - 24px));
    box-shadow: 0 12px 30px rgba(0,0,0,0.38), 0 1px 0 rgba(255,255,255,0.04) inset;
    backdrop-filter: blur(10px);
    font-family: 'Inter', sans-serif;
    color: #f1f5f9;
    opacity: 0; transform: translateY(2px);
    transition: opacity 0.08s ease, transform 0.08s ease;
}
.hc-tooltip.visible { opacity: 1; transform: translateY(0); }
.hc-tooltip .hc-tt-title {
    color: #94a3b8; font-size: 10.5px; font-weight: 650;
    letter-spacing: 0.035em; line-height: 1.2;
    padding-bottom: 6px; margin-bottom: 3px;
    border-bottom: 1px solid rgba(148,163,184,0.12);
}
.hc-tooltip .hc-tt-row {
    display: grid; grid-template-columns: 7px minmax(72px, 1fr) auto;
    align-items: center; gap: 7px;
    min-height: 25px; white-space: nowrap;
}
.hc-tooltip .hc-tt-marker {
    width: 5px; height: 5px; border-radius: 50%;
    background: #64748b; box-shadow: 0 0 0 3px rgba(100,116,139,0.10);
}
.hc-tooltip .hc-tt-marker.positive { background: #20c997; box-shadow: 0 0 0 3px rgba(32,201,151,0.10); }
.hc-tooltip .hc-tt-marker.negative { background: #ff5c5c; box-shadow: 0 0 0 3px rgba(255,92,92,0.10); }
.hc-tooltip .hc-tt-marker.buy { background: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.15); }
.hc-tooltip .hc-tt-label { color: #cbd5e1; font-size: 11.5px; font-weight: 550; }
.hc-tooltip .hc-tt-values { display: flex; align-items: baseline; justify-content: flex-end; gap: 6px; font-variant-numeric: tabular-nums; }
.hc-tooltip .hc-tt-eur { color: #f8fafc; font-size: 12.5px; font-weight: 700; }
.hc-tooltip .hc-tt-pct {
    min-width: 52px; padding: 2px 5px; border-radius: 5px;
    text-align: right; font-size: 10.5px; font-weight: 700;
    background: rgba(148,163,184,0.08);
}
.hc-tooltip .hc-tt-pct.positive { color: #20c997; background: rgba(32,201,151,0.10); }
.hc-tooltip .hc-tt-pct.negative { color: #ff6b6b; background: rgba(255,92,92,0.10); }
`;
        document.head.appendChild(style);
    }

    // Every KPI row (hover tooltip AND the drag-selection box) renders
    // through this one function — name / amount / percentage, same grid,
    // same weight, no row visually singled out and no divider between them.
    _renderKpiRowsHtml(titleText, rows) {
        const rowsHtml = rows.map(r => {
            const tone = r.positive ? 'positive' : 'negative';
            return `<div class="hc-tt-row"><span class="hc-tt-marker ${r.marker || tone}"></span><span class="hc-tt-label">${r.label}</span><span class="hc-tt-values"><span class="hc-tt-eur">${r.eur ?? ''}</span>${r.pct != null ? `<span class="hc-tt-pct ${tone}">${r.pct}</span>` : ''}</span></div>`;
        }).join('');
        return `<div class="hc-tt-title">${titleText}</div>${rowsHtml}`;
    }

    // The unified rows (Total Value / Total Return, plus Benchmark + the
    // delta against it when one is active) at a single point in time — used
    // for the normal hover tooltip. Restricted to genuine portfolio views:
    // an index or a single asset's unit price has no "invested" or "cash" to
    // build Total Return from.
    _buildKpiRows(idx, opts) {
        const { graphData, pctSeries, eurFmt, pctFmt, isIndexMode, isUnitView, isPerformanceMode, displayValues } = opts;
        if (isIndexMode || isUnitView) {
            const v = displayValues?.[idx];
            if (v == null || isNaN(v)) return [];
            const label = isUnitView ? 'Prix' : 'Cours';
            const rows = isPerformanceMode
                ? [{ icon: '📊', label, eur: null, pct: pctFmt(v), positive: v >= 0 }]
                : [{ icon: '📊', label, eur: eurFmt(v), pct: null, positive: true }];
            if (isUnitView && this.currentPeriod === 1) {
                this._pushDayPnlRow(rows, idx, graphData, eurFmt, pctFmt);
            }
            if (isUnitView) this._pushTransactionRows(rows, idx, graphData, eurFmt);
            return rows;
        }

        const val = graphData.values?.[idx];
        if (val == null || isNaN(val)) return [];
        const pct = pctSeries?.[idx];

        // SSOT (audit architecture — bug des 297,18€ : Total Value historique
        // combiné à un cash/invested "courant" pour fabriquer un Total Return
        // hybride). Ce tooltip ne calcule plus RIEN : `graphData.totalReturn`/
        // `totalReturnPct`/`dayPnl`/`dayPnlPct` sont des séries déjà résolues
        // par le moteur (voir HistoryCalculator._buildSeries — même formule
        // que le snapshot live, calculée une fois, jamais recalculée ici), et
        // le dernier point de CES séries est garanti égal au PortfolioSnapshot
        // live par dataManager.alignLastPointToLiveSnapshot (appelé dans
        // update(), jamais ici). Aucune condition "idx === lastIndex" dans ce
        // fichier : la distinction "maintenant vs point passé" est déjà
        // tranchée EN AMONT, dans la donnée elle-même — ce code lit un index
        // de tableau, un point c'est tout, jamais deux sources différentes
        // combinées pour un même nombre.
        const rows = [{ icon: '📊', label: 'Total Value', eur: eurFmt(val), pct: (pct != null && !isNaN(pct)) ? pctFmt(pct) : null, positive: (pct ?? 0) >= 0 }];

        const totalReturn = this._getPortfolioReturnSeries(graphData)?.[idx];
        const canonicalPct = this.includeDividends && Array.isArray(graphData.totalReturnPctWithDividends)
            ? graphData.totalReturnPctWithDividends[idx]
            : graphData.totalReturnPct?.[idx];
        if (totalReturn != null && !isNaN(totalReturn)) {
            rows.push({ icon: '💰', label: 'Total Return', eur: eurFmt(totalReturn), pct: pctFmt(canonicalPct), positive: totalReturn >= 0 });
        }
        const period = periodPerformance(graphData, { includeDividends: this.includeDividends, lastIndex: idx });
        if (period.amount !== null || period.percent !== null) {
            rows.push({ label: 'Période', eur: eurFmt(period.amount), pct: pctFmt(period.percent), positive: period.amount >= 0 });
        }

        // En vue 1D, HistoryCalculator fournit une Var Today explicite pour
        // chaque point, déjà neutralisée des flux par sa référence quotidienne.
        // Cette vue ne fait que lire et formater ces deux séries canoniques.
        if (this.currentPeriod === 1) {
            this._pushDayPnlRow(rows, idx, graphData, eurFmt, pctFmt);
        }

        this._pushBenchmarkRows(rows, idx, pct, opts);
        return rows;
    }

    // Buys/sells executed on the hovered point: quantity and unit price.
    _pushTransactionRows(rows, idx, graphData, eurFmt) {
        const qtyFmt = n => n.toLocaleString('fr-FR', { maximumFractionDigits: 6 });
        for (const p of graphData.purchasePoints || []) {
            if (p.x !== idx || !Number.isFinite(p.y)) continue;
            const sell = p.side === 'sell';
            const qty = Number(p.quantity);
            rows.push({
                label: `${sell ? 'Vente' : 'Achat'} · ${Number.isFinite(qty) ? qtyFmt(qty) : '?'} ${qty > 1 ? 'parts' : 'part'}`,
                eur: eurFmt(p.y), pct: null, positive: !sell, marker: sell ? 'negative' : 'buy'
            });
        }
    }

    _pushDayPnlRow(rows, idx, graphData, eurFmt, pctFmt) {
        const dp = graphData.dayPnl?.[idx];
        if (dp == null || isNaN(dp)) return;
        const dpPct = graphData.dayPnlPct?.[idx];
        rows.push({
            icon: '📅', label: 'Var Today', eur: eurFmt(dp),
            pct: Number.isFinite(dpPct) ? pctFmt(dpPct) : null,
            positive: dp >= 0
        });
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
        const { graphData, pctSeries, eurFmt, pctFmt } = opts;
        const v0 = graphData.values?.[i0], v1 = graphData.values?.[i1];
        if (v0 == null || v1 == null || isNaN(v0) || isNaN(v1)) return [];

        // SSOT (audit architecture) : lecture pure de graphData.totalReturn —
        // voir _buildKpiRows pour l'explication complète. i1 au dernier index
        // est déjà garanti égal au PortfolioSnapshot live par
        // dataManager.alignLastPointToLiveSnapshot (appelé dans update()) —
        // rien à recalculer ni à distinguer ici.
        const pct1 = pctSeries?.[i1];
        const rows = [{ icon: '📊', label: 'Total Value', eur: eurFmt(v1), pct: (pct1 != null && !isNaN(pct1)) ? pctFmt(pct1) : null, positive: (pct1 ?? 0) >= 0 }];

        const totalReturn = this._getPortfolioReturnSeries(graphData)?.[i1];
        const canonicalPct = this.includeDividends && Array.isArray(graphData.totalReturnPctWithDividends)
            ? graphData.totalReturnPctWithDividends[i1]
            : graphData.totalReturnPct?.[i1];
        if (totalReturn != null && !isNaN(totalReturn)) {
            rows.push({ icon: '💰', label: 'Total Return', eur: eurFmt(totalReturn), pct: pctFmt(canonicalPct), positive: totalReturn >= 0 });
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
        // Transaction markers are listed by _pushTransactionRows, not as a
        // curve value.
        const dataPoints = tt.dataPoints.filter(dp => dp.dataset.label !== 'Base 0%' && !dp.dataset.isTransactionMarker);
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
    _renderChartJs(canvas, graphData, displayValues, isPerformanceMode, benchmarkData, isUnitView, isIndexMode, currentTicker, mainColor, referenceClose, firstIndex, lastIndex, titleConfig, kpiData, avgPrice, athReference = null) {
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
        const pctSeries = (!isIndexMode && !isUnitView)
            ? this._getPortfolioPerformanceSeries(graphData)
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
                // FINANCIAL TRUTH OVER KPI RECONCILIATION (validation architecture
                // 2026-09-24, Phase 4) : tension=0 (jamais de spline qui inventerait
                // une trajectoire visuelle entre deux observations réelles) et
                // spanGaps=false (un point `null` doit rester un trou visible,
                // jamais relié artificiellement à travers une absence de donnée).
                pointRadius: 0, tension: 0, spanGaps: false,
                segment: { borderColor: (c) => segmentColor(c, 0) },
                isMain: true
            });

            if (benchmarkData && graphData.timestamps) {
                const benchData = this._buildBenchmarkPerformanceSeries(benchmarkData, graphData.timestamps, firstIndex);
                if (benchData?.some(value => value !== null)) {
                    datasets.push({ label: 'Benchmark (%)', data: benchData, borderColor: '#A855F7', borderWidth: 2, fill: false, pointRadius: 0, tension: 0, spanGaps: false });
                    benchPctSeries = benchData;
                    benchmarkLabel = document.getElementById('benchmark-select')?.selectedOptions?.[0]?.textContent?.trim() || 'Benchmark';
                }
            }
            datasets.push({ label: 'Base 0%', data: Array(graphData.labels.length).fill(0), borderColor: 'rgba(255,255,255,0.2)', borderWidth: 1, borderDash: [5, 5], fill: false, pointRadius: 0 });
        } else {
            if (!isIndexMode && !isUnitView && graphData.invested) {
                datasets.push({ label: 'Investi (€)', data: graphData.invested, borderColor: '#3b82f6', borderWidth: 2, fill: false, pointRadius: 0, borderDash: [5, 5], hidden: true, tension: 0, spanGaps: false });
            }
            let label = isUnitView ? 'Prix unitaire (€)' : (isIndexMode ? 'Cours' : 'Total Value (€)');
            const bicolorRef = (this.currentPeriod === 1 && referenceClose > 0) ? referenceClose : null;

            datasets.push({
                label, data: displayValues, borderColor: mainColor,
                backgroundColor: (c) => makeGradient(c.chart, bicolorRef || 0),
                // FINANCIAL TRUTH OVER KPI RECONCILIATION (validation architecture
                // 2026-09-24, Phase 4) : voir commentaire du dataset "Total Value (%)"
                // plus haut — même règle (tension=0, spanGaps=false).
                borderWidth: 3, fill: true, tension: 0, pointRadius: 0, spanGaps: false,
                ...(bicolorRef ? { segment: { borderColor: (c) => segmentColor(c, bicolorRef) } } : {}),
                isMain: true
            });
            if (this.currentPeriod === 1 && referenceClose > 0 && this.refLineVisibility.close) {
                datasets.push({ label: 'Clôture hier', data: Array(graphData.labels.length).fill(referenceClose), borderColor: '#95a5a6', borderWidth: 2, borderDash: [6, 4], fill: false, pointRadius: 0 });
            }
            // PRU line: only meaningful on the same per-share scale as the unit
            // price curve — plotting it against the total-value curve (Valeur €)
            // would compare a per-share average against a price×quantity total.
            // Shown on every period (not just 1D), unlike Clôture Hier above.
            if (isUnitView && avgPrice > 0 && this.refLineVisibility.pru) {
                datasets.push({ label: 'PRU', data: Array(graphData.labels.length).fill(avgPrice), borderColor: '#FF9F43', borderWidth: 2, borderDash: [6, 4], fill: false, pointRadius: 0 });
            }
            if (isUnitView && graphData.purchasePoints?.length) {
                // Buys ▲ blue (green would vanish on the green curve), sells ▼ red. `x` is the point index (see
                // HistoryCalculator._buildPurchasePoints).
                const markers = [
                    { side: 'buy', label: 'Achats', color: '#3b82f6', rotation: 0 },
                    { side: 'sell', label: 'Ventes', color: '#ff5c5c', rotation: 180 }
                ];
                for (const m of markers) {
                    // Aligned on the labels: Chart.js 4 resolves both a
                    // duplicated category label and a numeric x to the
                    // dataset index, never to the axis position.
                    const data = Array(graphData.labels.length).fill(null);
                    for (const p of graphData.purchasePoints) {
                        if ((p.side || 'buy') === m.side && Number.isInteger(p.x) && p.x < data.length) data[p.x] = p.y;
                    }
                    if (!data.some(v => v !== null)) continue;
                    datasets.push({
                        label: m.label, data, isTransactionMarker: true, showLine: false, spanGaps: false, fill: false,
                        pointStyle: 'triangle', rotation: m.rotation,
                        // White outline keeps the marker readable over the curve and its fill.
                        backgroundColor: m.color, borderColor: '#ffffff', borderWidth: 2,
                        pointRadius: 11, pointHoverRadius: 14, pointHoverBorderWidth: 2
                    });
                }
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
        const tooltipOpts = { canvas, graphData, isPerformanceMode, isIndexMode, isUnitView, displayValues, pctSeries, eurFmt, pctFmt, kpiData, dragState, benchPctSeries, benchmarkLabel, lastIndex };

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

        // ATH is drawn by this plugin rather than as a dataset, so it never
        // takes part in the y-axis auto-scale: a far-away ATH must not flatten
        // the visible curve. When it sits above the visible range, only a
        // badge pinned to the top edge (▲) is shown. The badge is on the left
        // so it never hides the latest point, which ends on the right.
        const athPlugin = {
            id: 'athReference',
            afterDatasetsDraw: (chart) => {
                if (!athReference || !Number.isFinite(athReference.value)) return;
                const area = chart.chartArea, yScale = chart.scales.y;
                if (!area || !yScale || athReference.value < yScale.min) return;
                const aboveScale = athReference.value > yScale.max;
                const y = aboveScale ? area.top : yScale.getPixelForValue(athReference.value);
                if (!Number.isFinite(y)) return;

                const c = chart.ctx;
                c.save();
                if (!aboveScale) {
                    c.beginPath();
                    c.setLineDash([4, 5]);
                    c.strokeStyle = 'rgba(250, 204, 21, 0.92)';
                    c.lineWidth = 1.5;
                    c.moveTo(area.left, y);
                    c.lineTo(area.right, y);
                    c.stroke();
                    c.setLineDash([]);
                }

                const label = aboveScale ? `▲ ${athReference.label}` : athReference.label;
                c.font = "600 10px Inter, sans-serif";
                const paddingX = 7;
                const width = c.measureText(label).width + paddingX * 2;
                const height = 20;
                const x = area.left + 6;
                // Above the line when there is room, otherwise just below it.
                const top = aboveScale
                    ? area.top + 4
                    : Math.min(y - height - 4 >= area.top ? y - height - 4 : y + 4, area.bottom - height - 4);

                c.beginPath();
                if (typeof c.roundRect === 'function') c.roundRect(x, top, width, height, 5);
                else c.rect(x, top, width, height);
                c.fillStyle = 'rgba(45, 37, 8, 0.92)';
                c.fill();
                c.strokeStyle = 'rgba(250, 204, 21, 0.38)';
                c.lineWidth = 1;
                c.stroke();
                c.fillStyle = '#fde047';
                c.textBaseline = 'middle';
                c.fillText(label, x + paddingX, top + height / 2 + 0.5);
                c.restore();
            }
        };

        this.chart = new Chart(ctx, {
            type: 'line',
            data: { labels: graphData.labels, datasets },
            plugins: [selectionPlugin, athPlugin],
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        // Always false: the HTML tooltip (external) is the only
                        // renderer. Re-enabling it anywhere (e.g. after a click
                        // or a zoom) paints Chart.js's own canvas tooltip on top
                        // of it — the "tooltip shown twice" bug.
                        enabled: false,
                        external: (context) => this._renderExternalTooltip(context, tooltipOpts)
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { autoSkip: true, maxTicksLimit: 10, maxRotation: 0 }
                    },
                    // Tick values are raw floats (53.400000000000006): format them
                    // with just enough decimals for the tick step, never more.
                    y: {
                        ticks: {
                            callback: (v, _i, ticks) => {
                                const step = ticks?.length > 1 ? Math.abs(ticks[1].value - ticks[0].value) : 0;
                                // Fewest decimals that write the step exactly (0.2 → 1, 0.25 → 2, 500 → 0).
                                let decimals = 2;
                                if (step > 0) {
                                    decimals = 4;
                                    for (let d = 0; d <= 4; d++) {
                                        const scaled = step * 10 ** d;
                                        if (Math.abs(scaled - Math.round(scaled)) < 1e-6 * Math.max(1, scaled)) { decimals = d; break; }
                                    }
                                }
                                if (isPerformanceMode) return `${v.toFixed(Math.max(2, decimals))}%`;
                                return Number(v).toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
                            }
                        }
                    }
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
            if (this.chart) this.chart.update('none');
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
                if (this.chart) this.chart.update('none');
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
