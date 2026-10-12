// benderrobot/asset_tracker/asset_tracker-52109016fe138d6ac9b283096e2de3cfbb9437bb/dashboardApp.js

// ========================================
// dashboardApp.js - VERSION CORRIGÉE FINALE (Unification + Fix Erreur Critique + GCP Proxy)
// ========================================
import { Storage } from './storage.js';
import { PriceAPI } from './api.js';
import { MarketStatus } from './marketStatus.js';
import { DataManager } from './dataManager.js';
import { HistoricalChart } from './historicalChart.js';
import { mountViewToggle } from './chartViewToggle.js';
import { ChartKPIManager } from './chartKPIManager.js'; // NOUVEAU : Pour sparkline
import { fetchGeminiSummary, fetchGeminiContext } from './geminiService.js';
import { UIComponents } from './ui.js';
import { NotificationManager } from './NotificationManager.js';
import { FCMManager } from './fcmManager.js'; // NEW: FCM for Android notifications

import { GEMINI_PROXY_URL } from './config.js';
import { auth } from './firebaseConfig.js';
import { getAuthHeader } from './authFetchHeaders.js';
import { portfolioKPIs } from './portfolioKPIs.js'; // NEW: Centralized KPI management
import { marketDataMetrics } from './marketDataMetrics.js';
import { mountPerformerTable } from './performerTable.js';
import { selectIndexDisplayInstrument } from './indexFutures.js';
import { ALLOCATION_TYPES, buildAllocationTimeline, calculateCurrentAllocation } from './allocation.js';
import { buildNewsHoldingDetails, getHeldAssetNames } from './newsHoldingMatcher.js';
import { buildWatchlistContext } from './watchlistContext.js';
import { DEFAULT_DASHBOARD_INDICES } from './appDataContext.js';
import { normalizeDashboardIndices, presentDashboardQuote, scheduledMarketStatus } from './dashboardMarketData.js';
import { MarketTicker, selectPortfolioMovers } from './marketTicker.js';
import { selectDailyContributions, selectContributionHighlights, auditDashboardSnapshot } from './dashboardContributions.js';

const SPARKLINE_TTL_MS = 5 * 60 * 1000;
const marketCardStateClass = view => {
    if (view.status === 'Cours ancien' || view.status === 'Actualisation indisponible') return 'is-stale';
    return { OPEN: 'is-open', CONTINUOUS: 'is-continuous', CLOSED: 'is-closed' }[view.session] || 'is-unknown';
};

// --- OUTILS DE SYNCHRONISATION (PROXY & COULEURS) ---
const PROXY_URL = 'https://fetchrss-ff7p645u3q-uc.a.run.app?url='; // Custom secure proxy (Node.js backend)

function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
}

function getColorForSource(sourceName) {
    let hash = 0;
    sourceName = sourceName || 'Inconnu';
    for (let i = 0; i < sourceName.length; i++) {
        hash = sourceName.charCodeAt(i) + ((hash << 5) - hash);
    }

    const h = hash % 360;
    const s = 75 + (hash % 10);
    const l = 35 + (hash % 5);

    return `hsl(${h}, ${s}%, ${l}%)`;
}
// --------------------------------------------------------


export class DashboardApp {
    constructor() {
        this.storage = new Storage();
        this.api = new PriceAPI(this.storage);
        this.marketStatus = new MarketStatus(this.storage);
        this.dataManager = new DataManager(this.storage, this.api);
        this.chartKPIManager = new ChartKPIManager(this.api, this.storage, this.dataManager, this.marketStatus);
        this.ui = new UIComponents(this.storage, this.dataManager);
        // Même convention que watchlistApp.js/analyticsApp.js/realEstateApp.js —
        // expose l'application à la console du navigateur (ex. outils de
        // diagnostic chargés à la demande depuis audit/tools/).
        window.dashboardApp = this;
        this.notificationManager = new NotificationManager(this.dataManager); // <-- NEW

        this.mockPageInterface = {
            filterManager: { getSelectedTickers: () => new Set() },
            currentSearchQuery: '',
            currentAssetTypeFilter: '',
            currentBrokerFilter: '',
            getChartTitleConfig: () => ({ mode: 'global', label: 'Portefeuille global', icon: 'chart-line-up' }),
            // Dashboard n'a pas de filtres ticker/type/courtier (toujours portefeuille
            // global) — historicalChart.js délègue maintenant à getFilteredPurchasesFromPage
            // de la "page" pour éviter un doublon avec investmentsPage.js ; ce mock doit donc
            // fournir la même méthode (sans filtre = tous les achats).
            getFilteredPurchasesFromPage: (ignoreTickerFilter) => this.storage.getPurchases(),
            renderData: (holdings, summary, cash) => {
                // HistoricalChart publishes the canonical PortfolioSnapshot.
                // This compatibility callback must never write headline KPIs.
            }
        };

        this.chart = null;
        this.currentModalNewsItem = null;
        this.currentGeminiSummary = null;
        this._newsModalGeneration = 0;
        this._newsSummaryRequestSeq = 0;
        this._newsContextRequestSeq = 0;
        this._newsSummaryAbortController = null;
        this._newsContextAbortController = null;
        this.portfolioNews = [];
        this.globalNews = [];
        this.lastHoldings = [];
        this.lastPortfolioSnapshot = null;

        // ANTI-RACE : refreshDataInBackground() et loadPortfolioData() sont toutes
        // les deux lancées sans attente au démarrage (voir init()) et calculent
        // chacune leurs propres holdings/summary de façon indépendante avant
        // d'écrire les KPI secondaires (Top Gainer/Loser, Allocation). Sans garde,
        // celle qui répond en dernier "gagne" même si elle a démarré AVANT
        // l'autre et lu des prix plus anciens. Un ticket incrémenté au DÉBUT de
        // chaque appel, vérifié juste avant d'écrire, garantit qu'un calcul plus
        // ancien ne peut jamais écraser le résultat d'un calcul démarré après lui.
        this._portfolioRenderGen = 0;

        this.selectedAssetFilter = '';

        // Initialize FCM for Android notifications
        this.fcmManager = new FCMManager();
        this.fcmManager.init().then(success => {
            if (success) {
                console.log('[Dashboard] FCM initialized successfully');
            } else {
                console.log('[Dashboard] FCM initialization failed or not supported');
            }
        }).catch(err => console.warn('[Dashboard] FCM init error:', err));

        this.init();
    }

    async init() {
        console.log('Dashboard Init...');

        // Portfolio movers ticker: fed by each snapshot, no network timer of its own.
        this.marketTicker = new MarketTicker(document.getElementById('market-ticker'), item => this.selectTickerAsset(item));
        this.setupTickerSource();

        // === CRITICAL: Subscribe to centralized KPIs ===
        this.subscribeToKPIs();

        // === NOTIFICATION SYSTEM ===
        // NotificationModal removed (migrated to dedicated page)

        // === WAIT FOR AUTH FIRST ===
        // Firebase Auth takes time to initialize, so wait for it
        await this.waitForAuth();

        // Show onboarding banner if no transactions yet
        this.checkOnboardingBanner();

        // All dashboard consumers share one canonical snapshot cycle.
        this._unsubscribeSnapshot = this.dataManager.repository.subscribe(result => this.renderSnapshot(result));
        this.loadPortfolioData();

        // Setup controls AVANT l'init du graphique pour que activeView soit déjà lisible
        // (initHistoricalChart tourne dans un setTimeout(50ms) mais loadMarketIndices est awaited
        //  → le setTimeout se déclenche pendant l'await, avant que setupChartControls ait pu s'exécuter)
        this.setupEventListeners();
        this.setupChartControls();
        this.setupNewsControls();
        this.setupIndicesModal();
        this.setupKPIModals();

        // Other initializations
        setTimeout(() => this.initHistoricalChart(), 50);
        this.loadPortfolioNews();
        this.loadGlobalNews();
        await this.loadMarketIndices();
        await this.refreshSelectedTicker();

        //Auto-refresh every 30 seconds to keep KPIs (Top Asset, Asset Allocation) in sync with Index prices
        if (this._refreshInterval) clearInterval(this._refreshInterval);
        this._refreshInterval = setInterval(() => this.refreshDashboard(), 30 * 1000);

    }

    /**
     * Subscribe to centralized KPIs from portfolioKPIs
     * CRITICAL: This is called ONCE at init and displays KPIs whenever graph updates them
     */
    subscribeToKPIs() {
        if (this._kpiListener) portfolioKPIs.removeListener(this._kpiListener);
        this._kpiListener = (kpis) => {
            // Exploring a market changes the chart, not the portfolio headline.
            if (this.chart && this.chart.currentMode !== 'portfolio') return;
            if (!kpis || kpis.source !== 'snapshot' || (this.chart?.currentMode === 'portfolio' && this._latestPortfolioSnapshotId && kpis.snapshotId !== this._latestPortfolioSnapshotId)) {
                return;
            }

            console.log('[Dashboard] ✅ Displaying KPIs from graph:', kpis);

            // SINGLE SOURCE OF TRUTH pour le formatage : délègue à ui.updateTopKPIs
            // (au lieu d'une 2e copie de fmt/fmtPct/updateEl). kpis.totalValue inclut
            // déjà le cash (voir portfolioKPIs.js) → cashReserveTotal=0 ici pour ne
            // pas le compter deux fois.
            const adaptedSummary = {
                totalCurrentEUR: kpis.totalValue,
                totalInvestedEUR: kpis.invested,
                gainTotal: kpis.totalReturn,
                gainPct: kpis.totalReturnPct,
                totalDayChangeEUR: kpis.varToday,
                dayChangePct: kpis.varTodayPct,
                cash: kpis.cash
            };
            this.ui.updateTopKPIs(adaptedSummary, kpis.cash, null);

            console.log('[Dashboard] ✅ KPIs displayed successfully via IDs');
        };
        portfolioKPIs.addListener(this._kpiListener);
    }

    /**
     * Wait for Firebase Auth to be ready
     */
    async waitForAuth() {
        return new Promise(resolve => {
            const unsub = auth.onAuthStateChanged(user => {
                unsub();
                if (user) console.log('[Auth] User ready:', user.uid);
                else console.log('[Auth] No user');
                resolve();
            });
        });
    }

    checkOnboardingBanner() {
        const purchases = this.storage.getPurchases();
        const hasTransactions = purchases && purchases.filter(p => p.assetType !== 'Cash').length > 0;
        const banner = document.getElementById('onboarding-banner');
        if (banner) banner.style.display = hasTransactions ? 'none' : 'block';
    }

    setupNewsControls() {
        this.renderAssetSelect();

        document.getElementById('refresh-global-news-btn')?.addEventListener('click', () => {
            this.loadGlobalNews(true);
        });

        document.getElementById('portfolio-asset-select')?.addEventListener('change', (e) => {
            this.selectedAssetFilter = e.target.value;
            this.loadPortfolioNews(true);
        });

        document.getElementById('refresh-portfolio-news')?.addEventListener('click', () => {
            this.loadPortfolioNews(true);
        });
    }

    // --- NOUVEAU : Setup du toggle Valeur / Performance ---
    setupChartControls() {
        const toggleContainer = document.getElementById('view-toggle');
        if (toggleContainer) {
            toggleContainer.style.display = 'flex';
            // Same builder as historicalChart.js's _syncViewToggle(), which
            // rebuilds it for single-asset mode; the 'portfolio' mode tag it
            // sets avoids a needless rebuild on the very first render.
            mountViewToggle(toggleContainer, 'portfolio', () => this.chart?.update(false, false));
        }
    }

    /**
     * Détermine si un actif cote 24/7 (vraiment 7 jours sur 7)
     * Pattern crypto : BTC-EUR, ETH-EUR, SOL-EUR, BNB-EUR, XRP-EUR...
     */
    is247Asset(ticker) {
        return /^[A-Z]+-[A-Z]{3}$/.test(ticker);
    }

    // Voir _portfolioRenderGen dans le constructeur : à appeler au tout début
    // d'un calcul KPI secondaire (avant tout await), puis _isLatestPortfolioRender
    // juste avant d'écrire le résultat.
    _beginPortfolioRender() {
        return ++this._portfolioRenderGen;
    }
    _isLatestPortfolioRender(ticket) {
        if (ticket !== this._portfolioRenderGen) {
            console.warn(`[Dashboard] Rendu KPI secondaire #${ticket} ignoré — un calcul démarré après lui (#${this._portfolioRenderGen}) a la priorité.`);
            return false;
        }
        return true;
    }

    /**
     * Refresh data in background and update cache
     */
    async refreshDataInBackground() {
        return this.loadPortfolioData();
    }

    renderSnapshot(result) {
        const { snapshot, stale, degraded, previousSession } = result;
        const { holdings, cashReserve } = snapshot._engine;
        const engineSummary = previousSession
            ? { ...snapshot._engine.summary, totalDayChangeEUR: null, dayChangePct: null }
            : snapshot._engine.summary;
        // The top cards can render before the chart: PortfolioSnapshot is the
        // canonical result already shared by KPI/table/chart and includes cash.
        // Passing the engine summary here kept the cards dependent on a later
        // graph publication and could leave them as "-" on a cache-first load.
        const canonicalSummary = {
            totalCurrentEUR: snapshot.portfolioSnapshot.totalValue,
            totalInvestedEUR: snapshot.portfolioSnapshot.invested,
            gainTotal: snapshot.portfolioSnapshot.totalReturn,
            gainPct: snapshot.portfolioSnapshot.totalReturnPct,
            totalDayChangeEUR: previousSession ? null : snapshot.portfolioSnapshot.dayPnl,
            dayChangePct: previousSession ? null : snapshot.portfolioSnapshot.dayPnlPct,
            cash: snapshot.portfolioSnapshot.cash,
            movementsCount: engineSummary.movementsCount || 0
        };
        this._latestPortfolioSnapshotId = snapshot.snapshotId;
        this.lastHoldings = holdings;
        const portfolio = snapshot.portfolioSnapshot;
        const staleInstruments = [...new Set([...(portfolio.staleInstruments || []), ...(result.staleInstruments || [])])];
        this._portfolioTickerItems = selectPortfolioMovers(holdings, {
            priceQuotes: snapshot._engine.todayGraphData?.resolvedPrices,
            lastSessionPerformance: snapshot._engine.todayGraphData?.perTickerLastSessionPerformance,
            staleInstruments,
            staleAll: !!(stale || degraded) && staleInstruments.length === 0
        });
        if (this.tickerSource?.type === 'portfolio') this.marketTicker?.update(this._portfolioTickerItems);
        this.renderDailyContributions(portfolio, { previousSession, stale: !!(stale || degraded),
            reconciliation: auditDashboardSnapshot(snapshot) });
        this.lastCashTotal = cashReserve.total;
        // Copie décorée pour les consommateurs secondaires (notamment Gemini
        // Actualités). Ne jamais muter le snapshot partagé du repository.
        this.lastPortfolioSnapshot = {
            ...snapshot.portfolioSnapshot,
            snapshotId: snapshot.snapshotId,
            pricesTimestamp: result.pricesAsOf ?? snapshot.portfolioSnapshot.pricesTimestamp,
            sourceStale: !!(snapshot.portfolioSnapshot.sourceStale || stale || degraded),
            staleInstruments: [...new Set([
                ...(snapshot.portfolioSnapshot.staleInstruments || []),
                ...(result.staleInstruments || [])
            ])],
            refreshError: result.lastRefreshFailure || null
        };
        this.lastCashTransactions = this.dataManager.splitCanonicalPurchases(this.storage.getPurchases?.() || []).cash;
        // Le sélecteur d'actualités représente lui aussi le portefeuille
        // courant : le reconstruire depuis les positions canoniques empêche un
        // actif totalement vendu de rester visible via l'historique brut.
        this.renderAssetSelect();
        this.renderKPIs(engineSummary, cashReserve.total, holdings);
        this.renderAllocation(holdings, cashReserve.total);
        this.ui.updatePortfolioSummary(canonicalSummary, canonicalSummary.movementsCount, canonicalSummary.cash, null);
        if (stale || degraded) {
            this.showCacheBadge();
            const badge = document.getElementById('cache-badge');
            // Date réelle des cotations utilisées, pas celle du recalcul.
            const asOf = result.pricesAsOf ?? snapshot.generatedAt;
            if (badge) badge.textContent = `Dernier état connu · ${new Date(asOf).toLocaleString()}${degraded ? ' · actualisation indisponible' : ''}`;
        } else this.hideCacheBadge();
        if (snapshot.portfolioSnapshot.status === 'valid') marketDataMetrics.recordInitialRender();
        if (!stale && !degraded && snapshot.portfolioSnapshot.status === 'valid' && this._notifiedSnapshotId !== snapshot.snapshotId) {
            this._notifiedSnapshotId = snapshot.snapshotId;
            this.notificationManager?.checkAll(this.storage.currentData, engineSummary);
        }
    }

    setupTickerSource() {
        try { this.tickerSource = JSON.parse(localStorage.getItem('dashboard_ticker_source_v1')) || { type: 'portfolio' }; }
        catch { this.tickerSource = { type: 'portfolio' }; }
        if (!['portfolio', 'indices', 'group'].includes(this.tickerSource.type)) this.tickerSource = { type: 'portfolio' };
        const button = document.getElementById('ticker-source-button');
        const menu = document.getElementById('ticker-source-menu');
        if (!button || !menu) return;
        const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
        button.addEventListener('click', () => {
            if (!menu.hidden) { close(); return; }
            this.renderTickerSourceMenu();
            menu.hidden = false;
            button.setAttribute('aria-expanded', 'true');
            menu.querySelector('button')?.focus();
        });
        menu.addEventListener('click', event => {
            const option = event.target.closest('[data-source-type]');
            if (!option) return;
            this.tickerSource = { type: option.dataset.sourceType, id: option.dataset.groupId || undefined };
            try { localStorage.setItem('dashboard_ticker_source_v1', JSON.stringify(this.tickerSource)); } catch { /* storage optional */ }
            close();
            button.focus();
            this.renderTickerSourceMenu();
            this.refreshSelectedTicker();
        });
        document.addEventListener('click', event => {
            if (!button.contains(event.target) && !menu.contains(event.target)) close();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !menu.hidden) { close(); button.focus(); }
        });
        menu.addEventListener('keydown', event => {
            const options = [...menu.querySelectorAll('button')];
            const current = options.indexOf(document.activeElement);
            if (event.key === 'Tab') { close(); return; }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
            options[next]?.focus();
        });
        const groupsChanged = () => { this.renderTickerSourceMenu(); this.refreshSelectedTicker(); };
        window.addEventListener('watchlist-groups-updated', groupsChanged);
        window.addEventListener('watchlist-updated', groupsChanged);
        this.renderTickerSourceMenu();
    }

    renderTickerSourceMenu() {
        const menu = document.getElementById('ticker-source-menu');
        const label = document.getElementById('ticker-source-name');
        if (!menu || !label) return;
        const groups = this.storage.getWatchlistGroups?.() || [];
        if (this.tickerSource.type === 'group' && !groups.some(group => String(group.id) === String(this.tickerSource.id))) {
            this.tickerSource = { type: 'portfolio' };
            try { localStorage.setItem('dashboard_ticker_source_v1', JSON.stringify(this.tickerSource)); } catch { /* storage optional */ }
        }
        const current = this.tickerSource;
        label.textContent = current.type === 'indices' ? 'Indices' : current.type === 'group'
            ? groups.find(group => String(group.id) === String(current.id))?.name || 'Watchlist' : 'Mes actifs';
        menu.replaceChildren();
        const options = [{ type: 'portfolio', name: 'Mes actifs' }, { type: 'indices', name: 'Indices' },
            ...groups.map(group => ({ type: 'group', id: String(group.id), name: group.name }))];
        for (const option of options) {
            const node = document.createElement('button');
            node.type = 'button';
            node.setAttribute('role', 'menuitemradio');
            node.setAttribute('aria-checked', String(current.type === option.type && (option.type !== 'group' || String(current.id) === option.id)));
            node.dataset.sourceType = option.type;
            if (option.id) node.dataset.groupId = option.id;
            node.textContent = option.type === 'group' ? `Watchlist · ${option.name}` : option.name;
            menu.append(node);
        }
    }

    quoteTickerItem(ticker, name, quote) {
        const view = presentDashboardQuote(ticker, quote);
        return { ticker, name, pct: view.pct, pctText: view.pctText, priceText: view.priceText,
            amountText: '', state: view.session === 'OPEN' ? 'open' : view.session === 'CLOSED' ? 'closed'
                : view.session === 'CONTINUOUS' ? 'continuous' : 'unknown',
            stateLabel: view.status, freshnessLabel: view.time, stale: !!quote?.stale, detail: view.detail };
    }

    async refreshSelectedTicker() {
        const generation = this._tickerSourceGeneration = (this._tickerSourceGeneration || 0) + 1;
        const source = this.tickerSource || { type: 'portfolio' };
        const empty = document.querySelector('#market-ticker .ticker-empty-label');
        if (empty) empty.textContent = source.type === 'portfolio' ? 'Aucune position cotée à afficher.' : 'Aucun actif à afficher dans cette sélection.';
        if (source.type === 'portfolio') {
            this.marketTicker?.update(this._portfolioTickerItems || []);
        } else if (source.type === 'indices') {
            this.marketTicker?.update((this._lastMarketRows || []).map(row => this.quoteTickerItem(row.targetTicker, row.idx.name, row.quote)));
        } else {
            const group = (this.storage.getWatchlistGroups?.() || []).find(item => String(item.id) === String(source.id));
            if (!group) { this.tickerSource = { type: 'portfolio' }; this.renderTickerSourceMenu(); this.marketTicker?.update(this._portfolioTickerItems || []); return; }
            const watchlist = this.storage.getWatchlist?.() || [];
            const tickers = [...new Set((Array.isArray(group.tickers) ? group.tickers : []).filter(ticker => typeof ticker === 'string' && ticker))];
            if (!tickers.length) { this.marketTicker?.update([]); return; }
            const quotes = await Promise.all(tickers.map(ticker => this.api.fetchIndexDataForDashboard(ticker).catch(() => null)));
            if (generation !== this._tickerSourceGeneration) return;
            this.marketTicker?.update(tickers.map((ticker, index) => this.quoteTickerItem(ticker,
                watchlist.find(item => item.ticker === ticker)?.name || ticker, quotes[index])));
        }
    }

    renderDailyContributions(snapshot, { previousSession = false, stale = false, reconciliation = null } = {}) {
        const data = selectDailyContributions(snapshot, { previousSession });
        const highlights = document.getElementById('dashboard-contribution-highlights');
        const state = document.getElementById('dashboard-contribution-state');
        const panel = document.getElementById('dashboard-contributions');
        if (!panel && !highlights) return;
        const money = value => `${value > 0 ? '+' : ''}${new Intl.NumberFormat('fr-FR', {
            style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2
        }).format(value)}`;
        if (highlights) {
            highlights.replaceChildren();
            const card = highlights.closest('.contribution-kpi-card');
            if (card) card.dataset.status = data.status;
            if (data.status === 'previous-session' || data.status === 'unavailable') {
                const empty = document.createElement('p');
                empty.className = 'contribution-kpi-empty';
                empty.textContent = data.status === 'previous-session' ? 'Variation du jour indisponible' : 'Contributions indisponibles';
                highlights.append(empty);
            } else {
                const { best, worst } = selectContributionHighlights(data);
                for (const [label, rows, emptyText] of [
                    ['Top du jour', best, 'Aucune hausse'],
                    ['Pires du jour', worst, 'Aucune baisse']
                ]) {
                    const group = document.createElement('div');
                    group.className = 'contribution-kpi-group';
                    const heading = document.createElement('span');
                    heading.className = 'contribution-kpi-group-label';
                    heading.textContent = label;
                    group.append(heading);
                    if (!rows.length) {
                        const empty = document.createElement('span');
                        empty.className = 'contribution-kpi-placeholder';
                        empty.textContent = emptyText;
                        group.append(empty);
                    }
                    for (const row of rows) {
                        const line = document.createElement('div');
                        line.className = 'contribution-kpi-row';
                        const name = document.createElement('span');
                        name.className = 'contribution-kpi-name';
                        name.textContent = row.name;
                        name.title = row.name;
                        const impact = document.createElement('strong');
                        impact.className = row.impact > 0 ? 'stat-positive' : 'stat-negative';
                        impact.textContent = money(row.impact);
                        line.append(name, impact);
                        group.append(line);
                    }
                    highlights.append(group);
                }
            }
        }
        if (state) {
            // A cached snapshot between two refreshes isn't worth a note here;
            // only data problems are reported under the card.
            state.textContent = data.status === 'partial' ? 'Décomposition partielle' : data.status === 'mismatch' ? 'Écart à vérifier' : '';
        }
        if (!panel) return;
        const summary = panel.querySelector('.contributions-summary');
        const note = panel.querySelector('.contributions-note');
        const table = panel.querySelector('.contributions-table');
        const body = table?.querySelector('tbody');
        if (!summary || !note || !table || !body) return;
        const percent = value => value === null ? '—' : `${value > 0 ? '+' : ''}${value.toLocaleString('fr-FR', {
            minimumFractionDigits: 2, maximumFractionDigits: 2
        })} %`;
        const weightPercent = value => value === null ? '—' : `${value.toLocaleString('fr-FR', {
            minimumFractionDigits: 2, maximumFractionDigits: 2
        })} %`;
        panel.dataset.status = data.status;
        table.hidden = data.status === 'previous-session' || data.status === 'unavailable' || data.rows.length === 0;
        body.replaceChildren();
        for (const row of data.rows) {
            const tr = document.createElement('tr');
            const name = document.createElement('td');
            const title = document.createElement('strong');
            title.textContent = row.name;
            const ticker = document.createElement('small');
            ticker.textContent = row.ticker;
            const mobileWeight = document.createElement('small');
            mobileWeight.className = 'contribution-mobile-weight';
            mobileWeight.textContent = `Poids ${weightPercent(row.weight)}`;
            name.append(title, ticker, mobileWeight);
            const weight = document.createElement('td');
            weight.textContent = weightPercent(row.weight);
            const variation = document.createElement('td');
            variation.textContent = percent(row.pct);
            const impact = document.createElement('td');
            impact.textContent = row.impact === null ? '—' : money(row.impact);
            impact.className = row.impact > 0 ? 'stat-positive' : row.impact < 0 ? 'stat-negative' : '';
            tr.append(name, weight, variation, impact);
            body.append(tr);
        }
        if (data.status === 'previous-session') {
            summary.textContent = 'Variation du jour indisponible';
            note.textContent = 'Le dernier snapshot date d’une autre journée. Les variations du bandeau peuvent correspondre à la dernière séance.';
        } else if (data.status === 'unavailable') {
            summary.textContent = 'Contributions indisponibles';
            note.textContent = 'Une valorisation fiable du portefeuille est nécessaire pour expliquer la variation du jour.';
        } else if (data.status === 'complete') {
            summary.textContent = `Somme des positions ${money(data.explained)} = Variation du jour ${money(data.total)}`;
            note.textContent = data.rows.length ? 'Impact en euros sur le portefeuille, classé par importance. Poids calculé sur la valeur totale, liquidités incluses.' : 'Aucune position n’a contribué à la variation du jour.';
        } else if (data.status === 'partial') {
            summary.textContent = `Impact connu ${money(data.explained)} · Variation du jour ${money(data.total)}`;
            note.textContent = `${data.missing} position${data.missing > 1 ? 's' : ''} sans variation calculable : décomposition partielle, rapprochement non confirmé.`;
        } else {
            summary.textContent = `Somme des positions ${money(data.explained)} · Variation du jour ${money(data.total)}`;
            note.textContent = `Écart non expliqué : ${money(data.residual)}. Vérifier les données avant d’interpréter les contributions.`;
        }
        if (stale && !['previous-session', 'unavailable'].includes(data.status)) {
            note.textContent += ' · Dernier état connu : actualisation à confirmer.';
        }
        const audit = panel.querySelector('.contributions-audit');
        if (audit) {
            audit.dataset.status = reconciliation?.status || 'unavailable';
            audit.textContent = previousSession ? 'Contrôle du jour en attente d’un nouveau snapshot.'
                : reconciliation?.status === 'complete' ? 'Contrôle automatique : variation, valeur totale et gain rapprochés du même snapshot.'
                : reconciliation?.status === 'partial' ? `Contrôle incomplet : ${reconciliation.incomplete.join(', ')}${reconciliation.missingDayPnl ? ` (${reconciliation.missingDayPnl} position${reconciliation.missingDayPnl > 1 ? 's' : ''} sans variation)` : ''}.`
                : reconciliation?.status === 'mismatch' ? `Écart détecté : ${reconciliation.issues.map(issue => `${issue.label} (${money(issue.residual)})`).join(' · ')}.`
                : '';
        }
    }

    /**
     * Show cache indicator badge
     */
    showCacheBadge() {
        const existingBadge = document.getElementById('cache-badge');
        if (existingBadge) return;

        const badge = document.createElement('div');
        badge.id = 'cache-badge';
        badge.style.cssText = `
            position: fixed;
            top: 70px;
            right: 20px;
            background: linear-gradient(135deg, rgba(59, 130, 246, 0.95), rgba(37, 99, 235, 0.95));
            color: white;
            padding: 10px 16px;
            border-radius: 8px;
            font-size: 12px;
            z-index: 10000;
            display: flex;
            align-items: center;
            gap: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            font-weight: 500;
        `;
        badge.innerHTML = `
            <i class="ph ph-arrows-clockwise ph-spin"></i>
            Mise à jour en cours...
        `;
        document.body.appendChild(badge);
    }

    /**
     * Hide cache indicator badge
     */
    hideCacheBadge() {
        const badge = document.getElementById('cache-badge');
        if (badge) {
            badge.style.transition = 'opacity 0.3s';
            badge.style.opacity = '0';
            setTimeout(() => badge.remove(), 300);
        }
    }

    /**
     * Détermine si un actif cote 24/5 (24h/jour mais pas le weekend)
     * Forex : *=X  |  Commodities : *=F
     */
    is245Asset(ticker) {
        return ticker.includes('=X') || ticker.endsWith('=F');
    }

    /**
     * Détermine le statut du marché pour un ticker donné
     * @returns 'PRE_MARKET' | 'MARKET_OPEN' | 'POST_MARKET' | 'WEEKEND' | '24_7'
     */
    getMarketStatus(ticker) {
        return scheduledMarketStatus(ticker);
    }

    renderAssetSelect() {
        const selectEl = document.getElementById('portfolio-asset-select');
        if (!selectEl) return;

        const assetMap = new Map();
        (this.lastHoldings || []).forEach(asset => {
            if ((asset.quantity || 0) > 0.0001) {
                assetMap.set(asset.ticker, { ticker: asset.ticker, name: asset.name || asset.ticker });
            }
        });
        const sortedAssets = Array.from(assetMap.values()).sort((a, b) => a.name.localeCompare(b.name));

        // Si l'actif sélectionné vient d'être vendu en totalité, revenir à
        // la vue globale au lieu de conserver un filtre fantôme invisible.
        if (this.selectedAssetFilter && !sortedAssets.some(asset => asset.name === this.selectedAssetFilter)) {
            this.selectedAssetFilter = '';
        }

        selectEl.innerHTML = '<option value="">Tout voir (Max 15)</option>' +
            sortedAssets.map(asset =>
                `<option value="${escHtml(asset.name)}" ${this.selectedAssetFilter === asset.name ? 'selected' : ''}>${escHtml(asset.ticker)} - ${escHtml(asset.name)}</option>`
            ).join('');
    }

    // --- FONCTIONS OBSOLÈTES SUPPRIMÉES ---
    // updateDayChangeFromGraph et updateTotalValueFromGraph ne sont plus nécessaires
    // et leur absence est corrigée par la nouvelle implémentation de mockPageInterface.renderData

    setupEventListeners() {
        window.addEventListener('purchases-updated', () => {
            this.loadPortfolioData();
            this.chart?.update(false, false);
        });
        document.getElementById('dashboard-back-portfolio')?.addEventListener('click', async event => {
            const button = event.currentTarget;
            await this.chart?.showPortfolioChart();
            button.hidden = true;
        });
        const closeBtn = document.getElementById('close-news-modal');
        const modal = document.getElementById('news-modal');
        const analyzeContextBtn = document.getElementById('analyze-context-btn');

        const closeModal = () => {
            if (modal) {
                const closeGeneration = ++this._newsModalGeneration;
                this._newsSummaryRequestSeq++;
                this._newsContextRequestSeq++;
                this._newsSummaryAbortController?.abort();
                this._newsContextAbortController?.abort();
                this._newsSummaryAbortController = null;
                this._newsContextAbortController = null;
                modal.classList.remove('show');
                const contextBox = document.getElementById('modal-news-context');
                if (contextBox) contextBox.style.display = 'none';
                setTimeout(() => {
                    if (this._newsModalGeneration === closeGeneration) modal.style.display = 'none';
                }, 300);
            }
        };
        if (closeBtn) closeBtn.onclick = closeModal;
        if (modal) modal.onclick = (e) => { if (e.target === modal) closeModal(); };

        if (analyzeContextBtn) analyzeContextBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleContextAnalysis();
        });
    }

    initHistoricalChart() {
        try {
            if (this.chart) { this.chart.destroy(); this.chart = null; }

            const mockInvestmentsPage = {
                filterManager: this.mockPageInterface.filterManager,
                currentSearchQuery: this.mockPageInterface.currentSearchQuery,
                currentAssetTypeFilter: this.mockPageInterface.currentAssetTypeFilter,
                currentBrokerFilter: this.mockPageInterface.currentBrokerFilter,
                getChartTitleConfig: this.mockPageInterface.getChartTitleConfig,
                getFilteredPurchasesFromPage: this.mockPageInterface.getFilteredPurchasesFromPage,
                renderData: this.mockPageInterface.renderData
            };

            this.chart = new HistoricalChart(this.storage, this.dataManager, null, mockInvestmentsPage);

            // Bind events for BOTH desktop and mobile buttons
            const allPeriodBtns = document.querySelectorAll('.chart-controls-inline .period-btn, .chart-controls-bottom-mobile .period-btn');
            if (allPeriodBtns.length > 0) {
                allPeriodBtns.forEach(btn => {
                    const newBtn = btn.cloneNode(true);
                    btn.parentNode.replaceChild(newBtn, btn);
                    newBtn.addEventListener('click', async (e) => {
                        if (newBtn.classList.contains('period-disabled')) return;
                        // Update active state on ALL buttons (desktop & mobile) to keep them in sync
                        document.querySelectorAll('.period-btn').forEach(b => {
                            if (b.dataset.period === e.target.dataset.period) {
                                b.classList.add('active');
                            } else {
                                b.classList.remove('active');
                            }
                        });

                        const rawPeriod = e.target.dataset.period;
                        const period = (rawPeriod === 'all' || rawPeriod === 'ytd') ? rawPeriod : parseInt(rawPeriod);
                        await this.chart.changePeriod(period);
                    });
                });
            }

            this.chart.updatePeriodButtonsAvailability();

            const benchmarkSelect = document.getElementById('benchmark-select');
            if (benchmarkSelect) {
                const newSelect = benchmarkSelect.cloneNode(true);
                benchmarkSelect.parentNode.replaceChild(newSelect, benchmarkSelect);
                newSelect.addEventListener('change', (e) => {
                    this.chart.currentBenchmark = e.target.value || null;
                    this.chart.update(true, false);
                });
            }

            this.chart.currentPeriod = 1;
            this.chart.update(true, false);
        } catch (e) { console.error("Erreur init graph:", e); }
    }

    async loadPortfolioData() {
        const purchases = this.storage.getPurchases();
        const cash = purchases.filter(p => ['cash', 'dividend'].includes((p.assetType || '').toLowerCase()) || p.type === 'dividend');
        const assets = purchases.filter(p => !cash.includes(p) && (p.assetType || '').toLowerCase() !== 'real estate');
        try {
            const result = await this.dataManager.repository.getSnapshot(assets, cash);
            this.renderSnapshot(result);
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.warn('[Dashboard snapshot]', error);
                this.showCacheBadge();
                const badge = document.getElementById('cache-badge');
                if (badge) badge.textContent = 'Données de marché indisponibles';
            }
        }
    }

    renderAllocation(holdings, cashTotal = 0) {
        const container = document.getElementById('dashboard-allocation-container');
        if (!container) return;
        const allocation = calculateCurrentAllocation(holdings, 'market', cashTotal);
        if (!allocation.valid) {
            container.innerHTML = `<div style="color:var(--text-muted);font-size:11px;text-align:center;padding:16px 6px;">Allocation indisponible · cours manquant pour ${allocation.unavailable.map(escHtml).join(', ')}</div>`;
            return;
        }

        if (allocation.rows.length === 0) {
            container.innerHTML = '<div style="color:var(--text-muted); font-size:12px; text-align:center; padding: 20px;">Aucune donnée.</div>';
            return;
        }

        const fmt = (v) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);

        let barHTML = '<div class="allocation-bar">';
        let listHTML = '<div class="allocation-list" style="flex-grow: 1;">'; // Ajout de flex-grow: 1 pour la robustesse

        allocation.rows.forEach(item => {
            barHTML += `<div class="alloc-segment" style="width: ${item.pct}%; background-color: ${item.color};"></div>`;
            listHTML += `<div class="alloc-row">
                <div class="alloc-left">
                    <span class="alloc-dot" style="background-color: ${item.color};"></span>
                    <span class="alloc-pct">${item.pct.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %</span>
                    <span class="alloc-label">${item.label}</span>
                </div>
                <div class="alloc-right"><span>${fmt(item.value)}</span></div>
            </div>`;
        });

        barHTML += '</div>'; listHTML += '</div>';

        // CORRECTION: Ajout de style="display: flex; flex-direction: column; height: 100%;" au wrapper pour forcer l'empilement vertical.
        container.innerHTML = `<div class="allocation-wrapper" style="display:flex;flex-direction:column;height:100%;">${barHTML}${listHTML}</div>`;
    }

    renderKPIs(data, cashTotal = 0, holdings = []) {
        this.lastHoldings = holdings;
        // NOTE: Les 3 cartes principales (Total Value, Return, Var Today) sont mises à jour ailleurs.

        // --- 1. Nettoyage des anciennes KPIs (Top Gainer, Top Loser, Top Holdings) ---
        // SINGLE SOURCE OF TRUTH : topPerformers/worstPerformers viennent de
        // dataManager.calculateSummary (même tri que bestAsset/worstAsset) — on ne
        // re-trie plus holdings ici indépendamment. Fallback pour les appelants qui
        // ne fournissent pas encore ces champs (ex: zeroSummary, état vide).
        const topGainers = data.topPerformers || [...holdings].sort((a, b) => b.gainPct - a.gainPct).slice(0, 3);
        this.injectListIntoCard('dashboard-top-gainer-name', topGainers, 'gainer');

        const topLosers = data.worstPerformers || [...holdings].sort((a, b) => a.gainPct - b.gainPct).slice(0, 3);
        this.injectListIntoCard('dashboard-top-loser-name', topLosers, 'loser');

        // Rendu des Top Holdings (Top Sector devient Top Holdings)
        const topAssets = [...holdings].sort((a, b) => b.currentValue - a.currentValue).slice(0, 3);
        this.injectListIntoCard('dashboard-top-sector', topAssets, 'asset');

        const sectorTitle = document.getElementById('dashboard-top-sector')?.closest('.kpi-card')?.querySelector('.kpi-label');
        if (sectorTitle) sectorTitle.textContent = 'Principales positions';
    }

    injectListIntoCard(elementId, items, type) {
        const targetEl = document.getElementById(elementId);
        if (!targetEl) return;
        const card = targetEl.closest('.kpi-card');
        if (!card) return;

        let listHTML = '<div class="kpi-list-container">';
        items.forEach(item => {
            // CRITICAL FIX: Add null-safety for gainPct and currentValue
            const safeGainPct = Number.isFinite(item.gainPct) ? item.gainPct : null;
            const safeCurrentValue = Number.isFinite(item.currentValue) ? item.currentValue : null;

            let valueHTML = type === 'asset'
                ? (safeCurrentValue === null ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(safeCurrentValue))
                : (safeGainPct === null ? '—' : (safeGainPct > 0 ? '+' : '') + safeGainPct.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' %');
            let valueColor = type === 'asset' || safeGainPct === null ? 'text-primary' : (safeGainPct >= 0 ? 'stat-positive' : 'stat-negative');
            let subValueHTML = item.currentPrice ? item.currentPrice.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }) : '';

            listHTML += `
                <div class="kpi-list-row">
                    <div class="kpi-row-left">
                        <span class="kpi-row-name" title="${escHtml(item.name)}">${escHtml(item.name)}</span>
                    </div>
                    <div class="kpi-row-right">
                        <div class="${valueColor}">${valueHTML}</div>
                        ${subValueHTML ? `<div class="kpi-sub-value">${subValueHTML}</div>` : ''}
                    </div>
                </div>`;
        });
        listHTML += '</div>';

        targetEl.innerHTML = listHTML;
        targetEl.classList.add('kpi-list-host');
        card.querySelector('.kpi-meta')?.remove();
    }

    cleanText(text) {
        if (typeof text !== 'string') return '';
        return text.replace(/'/g, "\\'").replace(/"/g, '\\"');
    }

    async loadPortfolioNews() {
        const names = this.selectedAssetFilter ? [this.selectedAssetFilter] : getHeldAssetNames(this.storage.getPurchases());
        const requests = names.map(name => () => this.fetchGoogleRSS(`${name} actualité financière`, this.selectedAssetFilter ? 8 : 2)
            .then(items => items.map(item => ({ ...item, assetName: name }))));
        return this.loadNewsFeed('portfolio', requests, names.join('|'), names.length ? 'Aucune actualité récente pour cette sélection.' : 'Ajoutez des actifs pour retrouver leurs actualités.');
    }

    async loadGlobalNews() {
        const topics = [
            { query: 'Marchés Bourse Paris', label: 'Macro FR' },
            { query: 'Wall Street économie', label: 'Wall Street' },
            { query: 'Crypto Bitcoin actu', label: 'Crypto' },
            { query: 'Inflation BCE Fed', label: 'Politique monétaire' }
        ];
        return this.loadNewsFeed('global', topics.map(topic => () => this.fetchGoogleRSS(topic.query, 4, topic.label)), 'macro', 'Aucune actualité récente.');
    }

    async loadNewsFeed(type, requests, selection, emptyMessage) {
        const container = document.getElementById(`news-${type}-container`);
        if (!container) return;
        this._newsFeedGeneration ??= {};
        this._newsFeedSelection ??= {};
        this._newsFeedCache ??= {};
        const ticket = this._newsFeedGeneration[type] = (this._newsFeedGeneration[type] || 0) + 1;
        const sameSelection = this._newsFeedSelection[type] === selection;
        if (!sameSelection) {
            container.replaceChildren();
            this._newsFeedCache[type] = new Map();
            this[`${type}News`] = [];
        }
        this._newsFeedSelection[type] = selection;
        this._newsFeedCache[type] ??= new Map();
        container.setAttribute('aria-busy', 'true');
        this.showNewsState(container, 'Actualisation des actualités…');
        const results = await Promise.allSettled(requests.map(request => Promise.resolve().then(request)));
        if (ticket !== this._newsFeedGeneration[type]) return;
        const cache = this._newsFeedCache[type];
        // Successful empty responses clear that source; failed responses keep
        // only their own last articles, visibly marked as potentially old.
        results.forEach((result, i) => { if (result.status === 'fulfilled') cache.set(i, result.value); });
        const failures = results.filter(result => result.status === 'rejected').length;
        const articles = this.deduplicateNews([...cache.values()].flat()).sort((a, b) => b.datetime - a.datetime).slice(0, 15);
        this[`${type}News`] = articles;
        this.renderNewsList(container, articles, type);
        container.setAttribute('aria-busy', 'false');
        if (failures) {
            const message = failures === requests.length ? 'Actualités indisponibles.' : 'Certaines sources sont indisponibles.';
            this.showNewsState(container, message + (articles.length ? ' Derniers articles conservés ; vérifiez leur date.' : ''), () => type === 'portfolio' ? this.loadPortfolioNews() : this.loadGlobalNews());
        } else if (!articles.length) {
            this.showNewsState(container, emptyMessage);
        }
        if (type === 'portfolio') this.renderAssetSelect();
    }

    showNewsState(container, message, retry = null) {
        container.querySelector('.news-feed-state')?.remove();
        const state = document.createElement('div');
        state.className = 'news-feed-state';
        state.setAttribute('role', 'status');
        const text = document.createElement('span');
        text.textContent = message;
        state.append(text);
        if (retry) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'dashboard-text-button';
            button.textContent = 'Réessayer';
            button.onclick = retry;
            state.append(button);
        }
        container.prepend(state);
    }

    fetchGoogleRSS(query, limit = 1, fixedLabel = null) {
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=fr&gl=FR&ceid=FR:fr`;

        const url = PROXY_URL + encodeURIComponent(rssUrl);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        // fetchRSS exige le token d'un compte invité
        return getAuthHeader()
            .then(headers => fetch(url, { signal: controller.signal, headers }))
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.text();
            })
            .then(xmlText => {
                const data = new window.DOMParser().parseFromString(xmlText, "text/xml");
                if (data.querySelector('parsererror') || !data.querySelector('rss, feed')) throw new Error('Flux RSS invalide');

                return Array.from(data.querySelectorAll("item")).slice(0, limit).map(item => {
                    const pubDate = item.querySelector("pubDate")?.textContent;
                    const fullTitle = item.querySelector("title")?.textContent || "";
                    const description = item.querySelector("description")?.textContent || "";
                    const parts = fullTitle.split(" - ");
                    const source = parts.length > 1 ? parts.pop() : "Google";

                    return {
                        ticker: fixedLabel || source,
                        name: query,
                        title: parts.length ? parts.join(" - ") : fullTitle,
                        source: source,
                        url: item.querySelector("link")?.textContent,
                        datetime: pubDate ? new Date(pubDate).getTime() / 1000 : Date.now() / 1000,
                        fullDescription: description,
                        label: fixedLabel || 'Macro Éco'
                    };
                });
            })
            .finally(() => clearTimeout(timeoutId));
    }

    renderNewsList(container, newsData, type) {
        if (newsData.length === 0) {
            container.replaceChildren();
            return;
        }

        container.innerHTML = newsData.map((n, i) => {
            const formattedDate = this.formatFullDateTime(n.datetime * 1000);
            const sourceColor = getColorForSource(n.source);

            return `
                <div class="news-item-compact" data-type="${type}" data-index="${i}">
                    <div class="news-meta-row">
                        <span class="news-ticker-tag" style="background-color: ${sourceColor}; color: white;">${escHtml(n.source)}</span>
                        <span>${formattedDate}</span>
                    </div>
                    <div class="news-title-compact">${escHtml(n.title)}</div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.news-item-compact').forEach(item => {
            item.addEventListener('click', () => {
                const idx = parseInt(item.dataset.index, 10);
                const dataType = item.dataset.type;
                const data = dataType === 'portfolio' ? this.portfolioNews[idx] : this.globalNews[idx];
                if (!data) return;
                this.openNewsModal(data);
            });
        });
    }

    deduplicateNews(newsArray) {
        const unique = [];
        const seen = new Set();
        for (const item of newsArray) {
            const clean = item.title.trim();
            if (!seen.has(clean)) {
                seen.add(clean);
                unique.push(item);
            }
        }
        return unique;
    }

    async openNewsModal(newsItem) {
        console.log('[openNewsModal] Called with:', newsItem?.title);

        const modal = document.getElementById('news-modal');
        if (!modal) {
            console.error('[openNewsModal] Modal element not found!');
            return;
        }



        const modalGeneration = ++this._newsModalGeneration;
        const requestId = ++this._newsSummaryRequestSeq;
        this._newsSummaryAbortController?.abort();
        this._newsContextAbortController?.abort();
        this._newsContextRequestSeq++;
        const abortController = new AbortController();
        this._newsSummaryAbortController = abortController;

        this.currentModalNewsItem = newsItem;
        this.currentGeminiSummary = null;

        const contextBox = document.getElementById('modal-news-context');
        if (contextBox) { contextBox.classList.remove('show'); contextBox.style.display = 'none'; }

        const pubDateEl = document.getElementById('modal-news-pubdate');
        if (pubDateEl) pubDateEl.textContent = newsItem.formattedDate;

        const sourceColor = getColorForSource(newsItem.source);
        document.getElementById('modal-news-ticker').textContent = newsItem.source;
        document.getElementById('modal-news-ticker').style.backgroundColor = sourceColor;
        document.getElementById('modal-news-title').textContent = newsItem.title;
        document.getElementById('modal-news-link').href = newsItem.url || '#';

        const summaryDiv = document.getElementById('modal-news-summary');
        summaryDiv.innerHTML = '<span class="loading-text">Gemini analyse...</span>';

        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('show'), 10);

        console.log('[openNewsModal] About to call fetchGeminiSummary');

        try {
            const description = newsItem.fullDescription || '';
            const context = `Titre: ${newsItem.title}. Sujet: ${newsItem.name}. Source: ${newsItem.source}. URL: ${newsItem.url || 'indisponible'}. Extrait RSS: ${description || 'indisponible'}.`;

            console.log('[openNewsModal] Calling fetchGeminiSummary with context:', context.substring(0, 100));

            // UTILISATION DU SERVICE CENTRALISÉ
            const summary = await fetchGeminiSummary(context, { signal: abortController.signal });

            if (requestId !== this._newsSummaryRequestSeq
                || modalGeneration !== this._newsModalGeneration
                || this.currentModalNewsItem !== newsItem) return;

            console.log('[openNewsModal] Got summary:', summary);

            this.currentGeminiSummary = summary;
            summaryDiv.innerHTML = summary;
        } catch (error) {
            if (error?.name === 'AbortError') return;
            if (requestId !== this._newsSummaryRequestSeq
                || modalGeneration !== this._newsModalGeneration
                || this.currentModalNewsItem !== newsItem) return;
            console.error('[openNewsModal] Error:', error);
            summaryDiv.innerHTML = "Analyse indisponible (Erreur API).";
        } finally {
            if (this._newsSummaryAbortController === abortController) {
                this._newsSummaryAbortController = null;
            }
        }
    }

    getHoldingDetailsForNews(newsItem) {
        return buildNewsHoldingDetails(
            newsItem,
            this.lastHoldings || [],
            this.lastPortfolioSnapshot,
            buildWatchlistContext(
                this.storage?.getWatchlist?.() || [],
                this.storage?.getWatchlistGroups?.() || []
            )
        );
    }


    /**
     * Gère l'affichage de l'analyse contextuelle (impact) par Gemini.
     */
    handleContextAnalysis() {
        const contextBox = document.getElementById('modal-news-context');
        const contextContent = document.getElementById('modal-context-content');
        if (!contextBox || !contextContent) return;

        const newsItem = this.currentModalNewsItem;
        const currentSummary = this.currentGeminiSummary;

        if (!newsItem || !currentSummary) {
            // ... (Gestion d'erreur inchangée) ...
            contextContent.innerHTML = 'Impossible de trouver le résumé principal.';
            contextBox.style.display = 'block';
            setTimeout(() => contextBox.classList.add('show'), 10);
            return;
        }

        // --- NOUVEAU: Extraction des détails du portefeuille au moment du clic ---
        const holdingDetails = this.getHoldingDetailsForNews(newsItem);
        // -----------------------------------------------------------------------

        if (contextBox.style.display === 'block') {
            const hideRequestId = ++this._newsContextRequestSeq;
            this._newsContextAbortController?.abort();
            this._newsContextAbortController = null;
            contextBox.classList.remove('show');
            setTimeout(() => {
                if (this._newsContextRequestSeq === hideRequestId) contextBox.style.display = 'none';
            }, 300);
            return;
        }

        contextBox.style.display = 'block';
        contextBox.classList.remove('show');
        contextContent.innerHTML = '<span class="loading-text">Gemini contextualise...</span>';
        setTimeout(() => contextBox.classList.add('show'), 10);

        const requestId = ++this._newsContextRequestSeq;
        const modalGeneration = this._newsModalGeneration;
        this._newsContextAbortController?.abort();
        const abortController = new AbortController();
        this._newsContextAbortController = abortController;

        // APPEL CENTRALISÉ avec les données du portefeuille. Une réponse d'un
        // ancien article ne peut jamais remplacer celle de l'article courant.
        fetchGeminiContext(newsItem.title, currentSummary, holdingDetails, { signal: abortController.signal })
            .then(contextSummary => {
                if (requestId !== this._newsContextRequestSeq
                    || modalGeneration !== this._newsModalGeneration
                    || this.currentModalNewsItem !== newsItem) return;
                contextContent.innerHTML = contextSummary;
            })
            .catch(error => {
                if (error?.name === 'AbortError') return;
                if (requestId !== this._newsContextRequestSeq
                    || modalGeneration !== this._newsModalGeneration
                    || this.currentModalNewsItem !== newsItem) return;
                contextContent.innerHTML = "Échec de l'analyse contextuelle.";
            })
            .finally(() => {
                if (this._newsContextAbortController === abortController) {
                    this._newsContextAbortController = null;
                }
            });
    }

    formatFullDateTime(timestamp, includeTime = true) {
        const date = new Date(timestamp);
        const options = { day: '2-digit', month: 'short', year: 'numeric' };
        if (includeTime) { options.hour = '2-digit'; options.minute = '2-digit'; }
        return date.toLocaleString('fr-FR', options);
    }

    getColorFor(ticker) {
        return getColorForSource(ticker);
    }


    async loadMarketIndices() {
        const container = document.getElementById('market-overview-container');
        if (!container) return;
        const generation = this._marketGeneration = (this._marketGeneration || 0) + 1;
        const indices = this.getCustomIndices();
        const rows = await Promise.all(indices.map(async idx => {
            let instrument = selectIndexDisplayInstrument(idx.ticker, this.getMarketStatus(idx.ticker));
            const fetchQuote = ticker => this.api.fetchIndexDataForDashboard(ticker).catch(() => null);
            let quote = await fetchQuote(instrument.ticker);
            if ((!quote || quote.stale) && instrument.isFuture) {
                const cash = await fetchQuote(idx.ticker);
                if (cash && !cash.stale) {
                    quote = cash;
                    instrument = { ticker: idx.ticker, isFuture: false, future: null };
                } else if (!quote) {
                    quote = cash;
                    instrument = { ticker: idx.ticker, isFuture: false, future: null };
                }
            }
            if (!quote) {
                const prior = this._lastMarketRows?.find(row => row.targetTicker === instrument.ticker);
                if (prior?.quote) quote = { ...prior.quote, stale: true };
            }
            return { idx, quote, targetTicker: instrument.ticker, isFuturesSwap: instrument.isFuture, future: instrument.future };
        }));
        if (generation !== this._marketGeneration) return;
        this._lastMarketRows = rows;
        container.querySelector('.market-loading')?.remove();
        const keys = new Set(rows.map(row => row.idx.ticker));
        container.querySelectorAll('.market-card').forEach(card => {
            if (!keys.has(card.dataset.followedTicker)) card.remove();
        });
        const notificationQuotes = {};
        for (const row of rows) {
            const { idx, quote, targetTicker, isFuturesSwap, future } = row;
            const view = presentDashboardQuote(targetTicker, quote);
            if (quote && !quote.stale) {
                this.storage.setCurrentPrice(targetTicker, { ...quote, lastUpdate: quote.quoteAsOf ?? quote.lastQuoteTime ?? null });
                // Never evaluate cash-index rules against the future or stale data.
                if (!isFuturesSwap && view.pct !== null && (quote.quoteAsOf || quote.lastQuoteTime) && view.status !== 'Cours ancien') {
                    const stored = this.storage.currentData?.[targetTicker];
                    if (stored) {
                        stored.changePercent = view.pct;
                        stored.change = quote.price - quote.previousClose;
                        notificationQuotes[targetTicker] = stored;
                    }
                }
            }
            const cardId = `market-card-${idx.ticker.replace(/[^a-zA-Z0-9]/g, '-')}`;
            let card = document.getElementById(cardId);
            if (!card) {
                card = document.createElement('div');
                card.id = cardId;
                card.className = 'market-card';
                card.dataset.followedTicker = idx.ticker;
                card.innerHTML = `<button type="button" class="market-card-open">
                    <span class="market-card-title"></span><span class="market-source-badge market-source-future"></span>
                    <span class="market-card-price"></span><span class="market-card-change"></span>
                    <span class="market-card-session"></span><span class="market-card-time"></span>
                </button><div class="market-card-actions">
                    <button type="button" class="market-card-move-up" title="Monter" aria-label="Monter dans la liste"><i class="ph ph-arrow-up" aria-hidden="true"></i></button>
                    <button type="button" class="market-card-move-down" title="Descendre" aria-label="Descendre dans la liste"><i class="ph ph-arrow-down" aria-hidden="true"></i></button>
                    <button type="button" class="market-card-delete"><i class="ph ph-x" aria-hidden="true"></i></button>
                </div>`;
                container.append(card);
            }
            // Re-append existing nodes in the saved order, including after a refresh.
            container.append(card);
            card.dataset.instrumentTicker = targetTicker;
            const isContract = targetTicker.endsWith('=F');
            card.dataset.instrumentType = isContract ? 'future' : 'cash';
            card.classList.toggle('market-card-future', isFuturesSwap);
            card.querySelector('.market-card-title').textContent = idx.name;
            const contractLabel = isContract ? `FUTURE · ${isFuturesSwap ? future.code : targetTicker}` : '';
            const showFuturesLabel = isContract && view.status === 'Séance ouverte';
            // One futures marker per card: the bottom pill while the contract
            // trades, the top badge otherwise (closed or old quote).
            const futureBadge = card.querySelector('.market-source-future');
            futureBadge.hidden = !isContract || showFuturesLabel;
            futureBadge.textContent = contractLabel;
            card.querySelector('.market-card-price').textContent = view.priceText;
            const change = card.querySelector('.market-card-change');
            change.textContent = view.pctText;
            change.className = `market-card-change ${view.tone}`;
            const session = card.querySelector('.market-card-session');
            session.textContent = showFuturesLabel ? 'Futures' : view.status;
            session.className = `market-card-session${showFuturesLabel ? ' is-futures' : ''}`;
            session.title = showFuturesLabel ? `${contractLabel} · séance ouverte` : '';
            card.querySelector('.market-card-time').textContent = view.time;
            // Colour code: card edge follows the day's direction, the session
            // pill follows the market state (open / 24/7 / closed / stale).
            card.classList.remove('stat-positive', 'stat-negative', 'stat-neutral', 'is-open', 'is-closed', 'is-continuous', 'is-stale', 'is-unknown');
            card.classList.add(view.tone, marketCardStateClass(view));
            const open = card.querySelector('.market-card-open');
            open.title = view.detail;
            open.disabled = !quote;
            open.setAttribute('aria-label', `${idx.name}, ${view.priceText}, ${view.pctText}. ${view.detail}. Afficher le graphique`);
            open.onclick = () => this.selectMarketRow(row);
            const remove = card.querySelector('.market-card-delete');
            remove.setAttribute('aria-label', `Retirer ${idx.name} des marchés favoris`);
            remove.title = `Retirer ${idx.name}`;
            remove.onclick = () => this.removeIndex(idx.ticker);
            const position = rows.indexOf(row);
            const up = card.querySelector('.market-card-move-up');
            const down = card.querySelector('.market-card-move-down');
            up.disabled = position === 0;
            down.disabled = position === rows.length - 1;
            up.setAttribute('aria-label', `Monter ${idx.name} dans la liste`);
            down.setAttribute('aria-label', `Descendre ${idx.name} dans la liste`);
            up.onclick = () => this.moveIndex(idx.ticker, -1);
            down.onclick = () => this.moveIndex(idx.ticker, 1);
        }
        let empty = container.querySelector('.markets-empty');
        if (!rows.length && !empty) {
            empty = document.createElement('p');
            empty.className = 'markets-empty';
            empty.textContent = 'Ajoutez un marché avec le bouton +.';
            container.append(empty);
        } else if (rows.length) empty?.remove();
        if (Object.keys(notificationQuotes).length) this.notificationManager?.checkAll(notificationQuotes);
        if (this.tickerSource?.type === 'indices') this.refreshSelectedTicker();
        this.renderMarketSparklines(rows, generation);
    }

    // Day sparklines behind the market cards. Intraday history is cached a few
    // minutes per instrument so the 30 s quote cycle doesn't refetch it.
    async renderMarketSparklines(rows, generation) {
        if (!this.chartKPIManager) return;
        this._sparkCache ??= new Map();
        await Promise.all(rows.map(async row => {
            if (!row.quote) return;
            const view = presentDashboardQuote(row.targetTicker, row.quote);
            let entry = this._sparkCache.get(row.targetTicker);
            if (!entry || Date.now() - entry.at > SPARKLINE_TTL_MS) {
                const data = await this.chartKPIManager.fetchIndexData(row.targetTicker, '1D', view.session !== 'OPEN' || view.status === 'Cours ancien').catch(() => null);
                entry = { at: Date.now(), data };
                this._sparkCache.set(row.targetTicker, entry);
            }
            if (generation !== this._marketGeneration) return;
            const card = document.getElementById(`market-card-${row.idx.ticker.replace(/[^a-zA-Z0-9]/g, '-')}`);
            if (!card || card.dataset.instrumentTicker !== row.targetTicker) return;
            const color = view.pct > 0 ? '#10b981' : view.pct < 0 ? '#ef4444' : '#9fa6bc';
            const reference = row.quote.previousClose ?? entry.data?.values?.[0];
            let spark = card.querySelector('.market-card-spark');
            if (!spark) {
                spark = document.createElement('div');
                spark.className = 'market-card-spark';
                spark.setAttribute('aria-hidden', 'true');
                card.prepend(spark);
            }
            spark.innerHTML = this.chartKPIManager.generateSparkline(entry.data, reference, row.targetTicker, color);
        }));
    }

    // Holding clicked in the ticker: its own chart, with a way back.
    async selectTickerAsset(item) {
        if (!this.chart) return;
        document.querySelectorAll('.market-card.active-index').forEach(card => card.classList.remove('active-index'));
        const back = document.getElementById('dashboard-back-portfolio');
        if (this.chart.currentMode === 'asset' && this.chart.selectedAssets?.[0] === item.ticker) {
            await this.chart.showPortfolioChart();
            if (back) back.hidden = true;
            return;
        }
        if (back) back.hidden = false;
        await this.chart.showAssetChart(item.ticker);
        if (window.innerWidth < 768) document.querySelector('.dashboard-chart-section')?.scrollIntoView({ behavior: 'smooth' });
    }

    async selectMarketRow(row) {
        if (!this.chart || !row.quote) return;
        const selected = this.chart.currentMode === 'index' && this.chart.selectedAssets?.[0] === row.targetTicker;
        document.querySelectorAll('.market-card').forEach(card => card.classList.toggle('active-index', !selected && card.dataset.followedTicker === row.idx.ticker));
        const back = document.getElementById('dashboard-back-portfolio');
        if (selected) {
            await this.chart.showPortfolioChart();
            if (back) back.hidden = true;
        } else {
            if (back) back.hidden = false;
            await this.chart.showIndex(row.targetTicker, row.isFuturesSwap ? `${row.idx.name} · Future ${row.future.code}` : row.idx.name);
        }
    }

    // =============================================
    // INDICES MODULAIRES
    // =============================================

    getCustomIndices() {
        try {
            const saved = localStorage.getItem('dashboard_indices_v1');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed)) {
                    const normalized = normalizeDashboardIndices(parsed);
                    if (JSON.stringify(normalized) !== JSON.stringify(parsed)) this.saveCustomIndices(normalized);
                    return normalized;
                }
            }
        } catch (e) {}
        return DEFAULT_DASHBOARD_INDICES.map(index => ({ ...index }));
    }

    saveCustomIndices(indices) {
        localStorage.setItem('dashboard_indices_v1', JSON.stringify(indices));
    }

    addIndex(item) {
        const current = this.getCustomIndices();
        if (current.find(i => i.ticker === item.ticker)) return;
        current.push(item);
        this.saveCustomIndices(current);
        this.loadMarketIndices();
    }

    removeIndex(ticker) {
        const current = this.getCustomIndices();
        const updated = current.filter(i => i.ticker !== ticker);
        this.saveCustomIndices(updated);
        const cardId = `market-card-${ticker.replace(/[^a-zA-Z0-9]/g, '-')}`;
        document.getElementById(cardId)?.remove();
        this.loadMarketIndices();
    }

    moveIndex(ticker, direction) {
        const current = this.getCustomIndices();
        const from = current.findIndex(item => item.ticker === ticker);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= current.length) return;
        [current[from], current[to]] = [current[to], current[from]];
        this.saveCustomIndices(current);
        this.loadMarketIndices();
    }

    getIndicesCatalogue() {
        const cdn = 'https://cdn.jsdelivr.net/npm/openmoji@14.0.0/color/svg/';
        return {
            'Indices': [
                // US
                { ticker: '^GSPC',     name: 'S&P 500',       icon: `${cdn}1F1FA-1F1F8.svg`, format: 'index' },
                { ticker: '^NDX',      name: 'Nasdaq 100',    icon: `${cdn}1F4BB.svg`,        format: 'index' },
                { ticker: '^DJI',      name: 'Dow Jones',     icon: `${cdn}1F1FA-1F1F8.svg`, format: 'index' },
                { ticker: '^RUT',      name: 'Russell 2000',  icon: `${cdn}1F1FA-1F1F8.svg`, format: 'index' },
                // Europe
                { ticker: '^FCHI',     name: 'CAC 40',        icon: `${cdn}1F1EB-1F1F7.svg`, format: 'index' },
                { ticker: '^STOXX50E', name: 'Euro Stoxx 50', icon: `${cdn}1F1EA-1F1FA.svg`, format: 'index' },
                { ticker: '^GDAXI',    name: 'DAX 40',        icon: `${cdn}1F1E9-1F1EA.svg`, format: 'index' },
                { ticker: '^FTSE',     name: 'FTSE 100',      icon: `${cdn}1F1EC-1F1E7.svg`, format: 'index' },
                { ticker: '^IBEX',     name: 'IBEX 35',       icon: `${cdn}1F1EA-1F1F8.svg`, format: 'index' },
                // Asie / Pacifique
                { ticker: '^N225',     name: 'Nikkei 225',    icon: `${cdn}1F1EF-1F1F5.svg`, format: 'index' },
                { ticker: '^HSI',      name: 'Hang Seng',     icon: `${cdn}1F1ED-1F1F0.svg`, format: 'index' },
                { ticker: '^KS11',     name: 'KOSPI (Corée)', icon: `${cdn}1F1F0-1F1F7.svg`, format: 'index' },
                { ticker: '^BSESN',    name: 'BSE Sensex',    icon: `${cdn}1F1EE-1F1F3.svg`, format: 'index' },
                { ticker: '^AXJO',     name: 'ASX 200',       icon: `${cdn}1F1E6-1F1FA.svg`, format: 'index' },
            ],
            'Volatilité': [
                { ticker: '^VIX',  name: 'VIX (S&P 500)',   icon: `${cdn}1F4C9.svg`, format: 'index' },
                { ticker: '^VXN',  name: 'VXN (NASDAQ)',    icon: `${cdn}1F4C9.svg`, format: 'index' },
                { ticker: '^RVX',  name: 'RVX (Russell)',   icon: `${cdn}1F4C9.svg`, format: 'index' },
                { ticker: '^VVIX', name: 'VVIX (Volatilité du VIX)', icon: `${cdn}1F4C9.svg`, format: 'index' },
            ],
            'Taux': [
                { ticker: '^TNX', name: 'US 10 ans',  icon: `${cdn}1F3E6.svg`, format: 'index' },
                { ticker: '^TYX', name: 'US 30 ans',  icon: `${cdn}1F3E6.svg`, format: 'index' },
                { ticker: '^FVX', name: 'US 5 ans',   icon: `${cdn}1F3E6.svg`, format: 'index' },
                { ticker: '^IRX', name: 'US 3 mois',  icon: `${cdn}1F3E6.svg`, format: 'index' },
            ],
            'Crypto': [
                { ticker: 'BTC-EUR',  name: 'Bitcoin',   icon: '₿', format: 'crypto' },
                { ticker: 'ETH-EUR',  name: 'Ethereum',  icon: 'Ξ', format: 'crypto' },
                { ticker: 'SOL-EUR',  name: 'Solana',    icon: '◎', format: 'crypto' },
                { ticker: 'BNB-EUR',  name: 'BNB',       icon: '⬡', format: 'crypto' },
                { ticker: 'XRP-EUR',  name: 'XRP',       icon: '✕', format: 'crypto' },
                { ticker: 'ADA-EUR',  name: 'Cardano',   icon: '₳', format: 'crypto' },
                { ticker: 'DOGE-EUR', name: 'Dogecoin',  icon: 'Ð', format: 'crypto' },
                { ticker: 'AVAX-EUR', name: 'Avalanche', icon: 'A', format: 'crypto' },
                { ticker: 'LINK-EUR', name: 'Chainlink', icon: '⬡', format: 'crypto' },
            ],
            'Métaux': [
                { ticker: 'GC=F', name: 'Or (Gold)',        icon: `${cdn}1FA99.svg`,  format: 'commodity' },
                { ticker: 'SI=F', name: 'Argent (Silver)',  icon: `${cdn}1FA99.svg`,  format: 'commodity' },
                { ticker: 'PL=F', name: 'Platine',          icon: `${cdn}1FA99.svg`,  format: 'commodity' },
                { ticker: 'HG=F', name: 'Cuivre',           icon: `${cdn}1FA99.svg`,  format: 'commodity' },
                { ticker: 'CL=F', name: 'Pétrole WTI',      icon: `${cdn}1F6E2.svg`,  format: 'commodity' },
                { ticker: 'BZ=F', name: 'Pétrole Brent',    icon: `${cdn}1F6E2.svg`,  format: 'commodity' },
                { ticker: 'NG=F', name: 'Gaz Naturel',      icon: `${cdn}1F525.svg`,  format: 'commodity' },
                { ticker: 'ZW=F', name: 'Blé (Wheat)',      icon: `${cdn}1F33E.svg`,  format: 'commodity' },
                { ticker: 'ZC=F', name: 'Maïs (Corn)',      icon: `${cdn}1F33D.svg`,  format: 'commodity' },
            ],
            'Forex': [
                { ticker: 'EURUSD=X', name: 'EUR / USD', icon: `${cdn}1F4B1.svg`,        format: 'forex' },
                { ticker: 'GBPUSD=X', name: 'GBP / USD', icon: `${cdn}1F1EC-1F1E7.svg`, format: 'forex' },
                { ticker: 'USDJPY=X', name: 'USD / JPY', icon: `${cdn}1F1EF-1F1F5.svg`, format: 'forex' },
                { ticker: 'EURGBP=X', name: 'EUR / GBP', icon: `${cdn}1F4B1.svg`,        format: 'forex' },
                { ticker: 'USDCHF=X', name: 'USD / CHF', icon: `${cdn}1F1E8-1F1ED.svg`, format: 'forex' },
                { ticker: 'AUDUSD=X', name: 'AUD / USD', icon: `${cdn}1F1E6-1F1FA.svg`, format: 'forex' },
                { ticker: 'USDCAD=X', name: 'USD / CAD', icon: `${cdn}1F1E8-1F1E6.svg`, format: 'forex' },
                { ticker: 'USDCNY=X', name: 'USD / CNY', icon: `${cdn}1F1E8-1F1F3.svg`, format: 'forex' },
                { ticker: 'NZDUSD=X', name: 'NZD / USD', icon: `${cdn}1F1F3-1F1FF.svg`, format: 'forex' },
            ],
        };
    }

    setupIndicesModal() {
        const modal = document.getElementById('add-index-modal');
        const close = document.getElementById('close-index-modal');
        this.closeIndicesModal = () => {
            if (modal) modal.style.display = 'none';
            document.body.classList.remove('market-dialog-open');
            this._indicesTrigger?.focus();
        };
        document.getElementById('add-index-btn')?.addEventListener('click', () => {
            if (!modal) return;
            this._indicesTrigger = document.activeElement;
            modal.style.display = 'flex';
            document.body.classList.add('market-dialog-open');
            const search = document.getElementById('add-index-search');
            if (search) search.value = '';
            this.renderIndexModal('Indices');
            close?.focus();
        });

        close?.addEventListener('click', this.closeIndicesModal);

        modal?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) this.closeIndicesModal();
        });
        modal?.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); this.closeIndicesModal(); }
            if (event.key !== 'Tab') return;
            const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        });

        document.querySelectorAll('.index-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                const search = document.getElementById('add-index-search');
                if (search) search.value = '';
                this.renderIndexModal(btn.dataset.tab);
            });
        });
        document.getElementById('add-index-search')?.addEventListener('input', () => this.renderIndexModal(this.activeIndexTab || 'Indices'));
    }

    renderIndexModal(activeTab = 'Indices') {
        this.activeIndexTab = activeTab;
        const catalogue = this.getIndicesCatalogue();
        const currentTickers = new Set(this.getCustomIndices().map(i => i.ticker));

        document.querySelectorAll('.index-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === activeTab);
            btn.setAttribute('aria-pressed', String(btn.dataset.tab === activeTab));
        });

        const grid = document.getElementById('add-index-grid');
        if (!grid) return;

        const watchlistItems = new Map();
        if (activeTab === 'Watchlist') {
            const watchlistAssets = new Map((this.storage.getWatchlist?.() || []).map(asset => [asset.ticker, asset]));
            for (const group of this.storage.getWatchlistGroups?.() || []) {
                for (const ticker of Array.isArray(group.tickers) ? group.tickers : []) {
                    const existing = watchlistItems.get(ticker);
                    if (existing) { if (!existing.groups.includes(group.name)) existing.groups.push(group.name); continue; }
                    watchlistItems.set(ticker, {
                        ticker, name: watchlistAssets.get(ticker)?.name || ticker,
                        icon: '◉', groups: [group.name], format: 'asset'
                    });
                }
            }
        }
        const items = activeTab === 'Watchlist' ? [...watchlistItems.values()] : catalogue[activeTab] || [];
        const normalizeSearch = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr');
        const query = normalizeSearch((document.getElementById('add-index-search')?.value || '').trim());
        const visibleItems = query ? items.filter(item => [item.name, item.ticker, ...(item.groups || [])]
            .some(value => normalizeSearch(value).includes(query))) : items;
        const available = visibleItems.filter(item => !currentTickers.has(item.ticker)).length;
        const followed = visibleItems.length - available;
        const count = document.getElementById('add-index-count');
        if (count) count.textContent = `${available} disponible${available > 1 ? 's' : ''} · ${followed} déjà suivi${followed > 1 ? 's' : ''}`;
        if (!visibleItems.length) {
            grid.innerHTML = `<p class="add-index-empty">${query ? 'Aucun résultat pour cette recherche.' : activeTab === 'Watchlist' ? 'Aucun actif dans les groupes de votre watchlist.' : 'Aucun marché disponible dans cette catégorie.'}</p>`;
            return;
        }
        grid.innerHTML = visibleItems.map(item => {
            const isAdded = currentTickers.has(item.ticker);
            const iconHTML = item.icon.includes('http')
                ? `<img src="${item.icon}" alt="" style="width:22px;height:22px;object-fit:contain;">`
                : `<span style="font-size:18px;line-height:1;">${escHtml(item.icon)}</span>`;
            return `
                <button type="button" class="add-index-item${isAdded ? ' already-added' : ''}" data-ticker="${escHtml(item.ticker)}" ${isAdded ? 'disabled' : ''}>
                    <div class="add-index-item-icon">${iconHTML}</div>
                    <div class="add-index-item-details">
                        <div class="add-index-item-name">${escHtml(item.name)}</div>
                        <div class="add-index-item-ticker">${escHtml(item.ticker)}${item.groups?.length ? ` · ${escHtml(item.groups.join(', '))}` : ''}</div>
                    </div>
                    <span class="add-index-item-action"><i class="ph ${isAdded ? 'ph-check' : 'ph-plus'}" aria-hidden="true"></i><span>${isAdded ? 'Ajouté' : 'Ajouter'}</span></span>
                </button>`;
        }).join('');

        grid.querySelectorAll('.add-index-item:not(.already-added)').forEach(el => {
            el.addEventListener('click', () => {
                const ticker = el.dataset.ticker;
                const item = visibleItems.find(i => i.ticker === ticker);
                if (item) {
                    this.addIndex({ ticker: item.ticker, name: item.name, icon: item.icon, format: item.format });
                    this.renderIndexModal(activeTab);
                    document.getElementById('add-index-search')?.focus();
                }
            });
        });
    }

    setupKPIModals() {
        const grid = document.querySelector('.dashboard-kpi-grid-v2');
        const cards = grid ? [...grid.querySelectorAll(':scope > .kpi-card')] : [];
        cards.forEach(card => {
            const type = card.dataset.kpiType;
            if (!type) return;
            card.dataset.clickable = type;
            const open = () => {
                if (type === 'contributions') this.openContributionsModal();
                else if (type === 'allocation') this.openAllocationModal();
                else this.openKPIModal(type);
            };
            card.addEventListener('click', open);
            card.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                open();
            });
        });

        document.getElementById('close-contributions-modal')?.addEventListener('click', () => this.closeContributionsModal());
        document.getElementById('contributions-modal')?.addEventListener('click', event => {
            if (event.target === event.currentTarget) this.closeContributionsModal();
        });
        document.getElementById('contributions-modal')?.addEventListener('keydown', event => {
            if (event.key === 'Escape') this.closeContributionsModal();
            if (event.key === 'Tab') {
                event.preventDefault();
                document.getElementById('close-contributions-modal')?.focus();
            }
        });

        document.getElementById('close-kpi-modal')?.addEventListener('click', () => {
            document.getElementById('kpi-detail-modal').style.display = 'none';
        });
        document.getElementById('close-allocation-modal')?.addEventListener('click', () => {
            document.getElementById('kpi-allocation-modal').style.display = 'none';
        });
        ['kpi-detail-modal', 'kpi-allocation-modal'].forEach(id => {
            document.getElementById(id)?.addEventListener('click', e => {
                if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
            });
        });
    }

    openContributionsModal() {
        const modal = document.getElementById('contributions-modal');
        if (!modal) return;
        this._contributionsReturnFocus = document.activeElement;
        modal.style.display = 'flex';
        document.getElementById('close-contributions-modal')?.focus();
    }

    closeContributionsModal() {
        const modal = document.getElementById('contributions-modal');
        if (!modal) return;
        modal.style.display = 'none';
        this._contributionsReturnFocus?.focus?.();
    }

    openKPIModal(type) {
        const holdings = this.lastHoldings || [];
        const modal = document.getElementById('kpi-detail-modal');
        const titleEl = document.getElementById('kpi-modal-title');
        const iconEl = document.getElementById('kpi-modal-icon');
        const body = document.getElementById('kpi-modal-body');
        if (!modal) return;

        let sortedItems, titleText, iconClass, iconColor;

        if (type === 'gainer') {
            titleText = 'Meilleures performances — depuis l’achat';
            iconClass = 'ph-trend-up'; iconColor = '#10b981';
        } else if (type === 'loser') {
            titleText = 'Moins bonnes performances — depuis l’achat';
            iconClass = 'ph-trend-down'; iconColor = '#ef4444';
        } else {
            titleText = 'Principales positions — valeur actuelle';
            iconClass = 'ph-stack'; iconColor = '#3b82f6';
            sortedItems = [...holdings]
                .filter(h => h.currentValue != null && h.currentValue > 0)
                .sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0));
        }

        titleEl.textContent = titleText;
        iconEl.className = `ph ${iconClass}`;
        iconEl.style.color = iconColor;

        const fmt = v => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(v);

        // Même composant, mêmes filtres et mêmes totaux que les modals
        // Top/Worst Performers d'Analytics. Les trois colonnes sont triables.
        if (type === 'gainer' || type === 'loser') {
            mountPerformerTable(body, holdings, type, { formatCurrency: fmt });
            modal.style.display = 'flex';
            return;
        }

        const totalValue = sortedItems.reduce((s, h) => s + (h.currentValue || 0), 0);

        let html = `<table class="kpi-detail-table kpi-detail-table--${type}"><thead><tr>`;
        html += '<th>#</th><th>Actif</th><th>Valeur</th><th>% Port.</th><th>Perf.</th>';
        html += '</tr></thead><tbody>';

        sortedItems.forEach((h, i) => {
            const gainPct = h.gainPct ?? 0;
            const color = gainPct >= 0 ? '#10b981' : '#ef4444';
            const sign = gainPct >= 0 ? '+' : '';
            const pct = totalValue > 0 ? (h.currentValue / totalValue) * 100 : 0;
            html += `<tr>
                <td>${i + 1}</td>
                <td><div class="kpi-modal-name">${escHtml(h.name)}</div><div class="kpi-modal-sub">${escHtml(h.ticker)} · ${escHtml(h.assetType || '')}</div></td>
                <td style="font-weight:600;">${fmt(h.currentValue || 0)}</td>
                <td>${pct.toFixed(1)}%</td>
                <td style="color:${color};font-weight:600;">${sign}${gainPct.toFixed(2)}%</td>
            </tr>`;
        });

        html += '</tbody></table>';
        body.innerHTML = html;
        modal.style.display = 'flex';
    }

    openAllocationModal() {
        const modal = document.getElementById('kpi-allocation-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        const wrap = document.getElementById('alloc-svg-wrap');
        const legend = document.getElementById('alloc-modal-legend');
        const breakdown = document.getElementById('alloc-current-breakdown');
        const basisToggle = document.getElementById('alloc-basis-toggle');

        const render = (basis) => this.buildAllocationChart(
            this.lastHoldings || [], wrap, legend, breakdown, basis,
            this.lastCashTotal === undefined ? 0 : this.lastCashTotal,
            this.lastCashTransactions || []
        );

        if (basisToggle) {
            basisToggle.querySelectorAll('.toggle-btn').forEach(btn => {
                btn.onclick = () => {
                    if (btn.classList.contains('active')) return;
                    basisToggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    render(btn.dataset.basis);
                };
            });
        }

        const activeBtn = basisToggle?.querySelector('.toggle-btn.active');
        render(activeBtn?.dataset.basis || 'market');
    }

    buildAllocationChart(holdings, chartWrap, legend, breakdown, basis = 'market', cashTotal = 0, cashTransactions = []) {
        const TYPES = ALLOCATION_TYPES;
        const timeline = buildAllocationTimeline(holdings, basis, new Date(), cashTotal, cashTransactions);
        const { points, activeTypes } = timeline;

        if (!timeline.valid) {
            chartWrap.innerHTML = `<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;text-align:center;">Allocation indisponible<br>Cours manquant pour ${timeline.unavailable.map(escHtml).join(', ')}</div>`;
            legend.innerHTML = '';
            breakdown.innerHTML = '';
            return;
        }

        if (points.length < 2) {
            chartWrap.innerHTML = '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;">Pas assez de données historiques.</div>';
            legend.innerHTML = '';
            this.renderAllocationBreakdown(timeline, breakdown);
            return;
        }

        const W = 780, H = 320, ML = 42, MR = 12, MT = 10, MB = 32;
        const cW = W - ML - MR, cH = H - MT - MB;
        const n = points.length;
        const xScale = i => ML + (n > 1 ? (i / (n - 1)) * cW : cW / 2);
        const yScale = pct => MT + (1 - pct / 100) * cH;

        let svgGrid = '';
        [0, 25, 50, 75, 100].forEach(pct => {
            const y = yScale(pct);
            svgGrid += `<line x1="${ML}" y1="${y}" x2="${W - MR}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
            svgGrid += `<text x="${ML - 5}" y="${y + 4}" font-size="10" fill="#64748b" text-anchor="end">${pct}%</text>`;
        });

        const maxLabels = Math.min(6, n);
        const step = Math.max(1, Math.ceil(n / maxLabels));
        let svgLabels = '';
        points.forEach((p, i) => {
            if (i % step === 0 || i === n - 1) {
                const d = new Date(p.date);
                const label = d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
                svgLabels += `<text x="${xScale(i)}" y="${H - 6}" font-size="10" fill="#64748b" text-anchor="middle">${label}</text>`;
            }
        });

        let svgPaths = '';
        const stackBottom = Array(n).fill(0);
        [...activeTypes].reverse().forEach(k => {
            const color = TYPES[k]?.color || '#999';
            const upper = points.map((p, i) => stackBottom[i] + p.pcts[k]);
            let pathD = points.map((_, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i).toFixed(1)},${yScale(upper[i]).toFixed(1)}`).join(' ');
            for (let i = n - 1; i >= 0; i--) {
                pathD += ` L ${xScale(i).toFixed(1)},${yScale(stackBottom[i]).toFixed(1)}`;
            }
            pathD += ' Z';
            svgPaths += `<path d="${pathD}" fill="${color}" opacity="0.82"/>`;
            upper.forEach((v, i) => stackBottom[i] = v);
        });

        chartWrap.style.position = 'relative';
        chartWrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:100%;display:block;">${svgGrid}${svgPaths}${svgLabels}</svg>`;

        // === TOOLTIP ===
        const tooltipEl = document.createElement('div');
        tooltipEl.style.cssText = 'position:absolute;display:none;background:var(--bg-card);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:10px 14px;font-size:12px;pointer-events:none;z-index:20;box-shadow:0 8px 24px rgba(0,0,0,0.5);min-width:140px;';
        chartWrap.appendChild(tooltipEl);

        const svgEl = chartWrap.querySelector('svg');

        // Hairline verticale
        const hairline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        hairline.setAttribute('y1', MT);
        hairline.setAttribute('y2', H - MB);
        hairline.setAttribute('stroke', 'rgba(255,255,255,0.22)');
        hairline.setAttribute('stroke-width', '1');
        hairline.setAttribute('stroke-dasharray', '4,3');
        hairline.style.display = 'none';
        svgEl.appendChild(hairline);

        svgEl.addEventListener('mousemove', e => {
            const rect = svgEl.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const vbX = (mouseX / rect.width) * W;

            if (vbX < ML || vbX > W - MR) {
                hairline.style.display = 'none';
                tooltipEl.style.display = 'none';
                return;
            }

            const idx = Math.max(0, Math.min(n - 1, Math.round((vbX - ML) / cW * (n - 1))));
            const pt = points[idx];

            // Mettre à jour la hairline
            const lx = xScale(idx).toFixed(1);
            hairline.setAttribute('x1', lx);
            hairline.setAttribute('x2', lx);
            hairline.style.display = '';

            // Contenu du tooltip
            const dateStr = new Date(pt.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
            let html = `<div style="color:var(--text-muted);font-size:11px;margin-bottom:7px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.07);">${dateStr}</div>`;
            [...activeTypes].reverse().forEach(k => {
                const pct = pt.pcts[k] || 0;
                html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                    <span style="width:8px;height:8px;border-radius:2px;background:${TYPES[k].color};flex-shrink:0;display:inline-block;"></span>
                    <span style="color:var(--text-secondary);flex:1;">${TYPES[k].label}</span>
                    <span style="color:var(--text-primary);font-weight:600;">${pct.toFixed(1)}%</span>
                </div>`;
            });
            tooltipEl.innerHTML = html;
            tooltipEl.style.display = 'block';

            // Positionnement : éviter le débordement à droite
            const wrapRect = chartWrap.getBoundingClientRect();
            const tx = e.clientX - wrapRect.left;
            const ty = e.clientY - wrapRect.top;
            const tW = tooltipEl.offsetWidth;
            const left = tx + 16 + tW > chartWrap.offsetWidth ? tx - tW - 16 : tx + 16;
            tooltipEl.style.left = left + 'px';
            tooltipEl.style.top = Math.max(0, ty - 30) + 'px';
        });

        svgEl.addEventListener('mouseleave', () => {
            hairline.style.display = 'none';
            tooltipEl.style.display = 'none';
        });

        legend.innerHTML = activeTypes.map(k => `
            <div style="display:flex;align-items:center;gap:6px;">
                <span style="width:10px;height:10px;border-radius:2px;background:${TYPES[k].color};flex-shrink:0;"></span>
                <span style="font-size:12px;color:var(--text-secondary);">${TYPES[k].label}</span>
            </div>`).join('');

        this.renderAllocationBreakdown(timeline, breakdown);
    }

    renderAllocationBreakdown(allocation, breakdown) {
        const breakdownLabel = allocation.basis === 'market'
            ? 'Répartition actuelle · valeur de marché + cash'
            : 'Répartition actuelle · montants investis + cash';
        const fmtK = v => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v);
        breakdown.innerHTML = `
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px;">${breakdownLabel}</div>
            <div style="display:flex;gap:16px;flex-wrap:wrap;">
                ${allocation.rows.map(row => {
                    return `<div style="display:flex;flex-direction:column;gap:2px;">
                        <span style="font-size:15px;font-weight:700;color:${row.color};">${row.pct.toFixed(1)}%</span>
                        <span style="font-size:11px;color:var(--text-muted);">${row.label} · ${fmtK(row.value)}</span>
                    </div>`;
                }).join('')}
            </div>`;
    }

    async refreshDashboard() {
        if (this._refreshing) return;
        this._refreshing = true;
        try {
            // Le graphique doit être rafraîchi EN PREMIER et attendu : c'est lui qui
            // recalcule et pousse les 3 KPI principaux (Total Value, Total Return, Var Today)
            // via portfolioKPIs. Le lancer en parallèle avec loadPortfolioData() faisait
            // courir deux fetchBatchPrices concurrents sur les mêmes tickers, ce qui pouvait
            // faire échouer/retarder silencieusement la mise à jour des prix live et donc
            // désynchroniser les KPI du haut par rapport au graphique.
            if (document.hidden) return;
            await Promise.all([this.loadPortfolioData(), this.loadMarketIndices()]);
            if (this.tickerSource?.type === 'group') this.refreshSelectedTicker();
            if (this.chart) await this.chart.update(false, false);
        } finally {
            this._refreshing = false;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => new DashboardApp());
