// benderrobot/asset_tracker/asset_tracker-52109016fe138d6ac9b283096e2de3cfbb9437bb/dashboardApp.js

// ========================================
// dashboardApp.js - VERSION CORRIGÉE FINALE (Unification + Fix Erreur Critique + GCP Proxy)
// ========================================
import { Storage } from './storage.js?v=4';
import { PriceAPI } from './api.js?v=9';
import { MarketStatus } from './marketStatus.js?v=2';
import { DataManager } from './dataManager.js?v=21';
import { HistoricalChart } from './historicalChart.js?v=27';
import { IndexCardChart } from './indexCardChart.js';
import { ChartKPIManager } from './chartKPIManager.js'; // NOUVEAU : Pour sparkline
import { fetchGeminiSummary, fetchGeminiContext } from './geminiService.js';
import { UIComponents } from './ui.js?v=5';
import { NotificationManager } from './NotificationManager.js';
import { FCMManager } from './fcmManager.js'; // NEW: FCM for Android notifications

import { GEMINI_PROXY_URL } from './config.js';
import { auth } from './firebaseConfig.js';
import { portfolioKPIs } from './portfolioKPIs.js'; // NEW: Centralized KPI management
import { marketDataMetrics } from './marketDataMetrics.js';

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
        // permet d'appeler dashboardApp.dataManager.debugDividendPhantomGap()
        // depuis la console du navigateur (voir dataManager.js, méthode
        // DIAGNOSTIC TEMPORAIRE, à retirer une fois l'audit du 16 346,00€ conclu).
        window.dashboardApp = this;
        this.notificationManager = new NotificationManager(this.dataManager); // <-- NEW

        this.mockPageInterface = {
            filterManager: { getSelectedTickers: () => new Set() },
            currentSearchQuery: '',
            currentAssetTypeFilter: '',
            currentBrokerFilter: '',
            getChartTitleConfig: () => ({ mode: 'global', label: 'Portfolio Global', icon: 'Chart' }),
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
        this.portfolioNews = [];
        this.globalNews = [];
        this.lastHoldings = [];

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

        // Start market status
        this.marketStatus.startAutoRefresh('market-status-container', 'compact');

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
            this.ui.updateTopKPIs(adaptedSummary, kpis.cash, this.marketStatus);

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
            toggleContainer.innerHTML = `
                <div class="toggle-group">
                    <button class="toggle-btn" data-view="global">Valeur (€)</button>
                    <button class="toggle-btn active" data-view="performance">Performance (%)</button>
                </div>
            `;
            // See historicalChart.js's _syncViewToggle() — it owns rebuilding
            // this element for single-asset mode; tagging it here avoids an
            // immediate, needless rebuild on the very first render.
            toggleContainer.dataset.mode = 'portfolio';

            const updateToggle = (view) => {
                toggleContainer.querySelectorAll('.toggle-btn').forEach(btn => {
                    if (btn.dataset.view === view) btn.classList.add('active');
                    else btn.classList.remove('active');
                });

                // Mettre à jour le graphique via this.chart
                if (this.chart) {
                    this.chart.update(false, false);
                }
            };

            toggleContainer.querySelectorAll('.toggle-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const view = e.target.dataset.view;
                    updateToggle(view);
                });
            });
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
        this.renderKPIs(engineSummary, cashReserve.total, holdings);
        this.renderAllocation(holdings, engineSummary.totalCurrentEUR);
        if (this.chart?.currentMode !== 'asset') this.ui.updatePortfolioSummary(canonicalSummary, canonicalSummary.movementsCount, canonicalSummary.cash, this.marketStatus);
        if (stale || degraded) {
            this.showCacheBadge();
            const badge = document.getElementById('cache-badge');
            if (badge) badge.textContent = `Dernier état connu · ${new Date(snapshot.generatedAt).toLocaleString()}${degraded ? ' · actualisation indisponible' : ''}`;
        } else this.hideCacheBadge();
        if (snapshot.portfolioSnapshot.status === 'valid') marketDataMetrics.recordInitialRender();
        if (!stale && !degraded && snapshot.portfolioSnapshot.status === 'valid' && this._notifiedSnapshotId !== snapshot.snapshotId) {
            this._notifiedSnapshotId = snapshot.snapshotId;
            this.notificationManager?.checkAll(this.storage.currentData, engineSummary);
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
            <i class="fas fa-sync fa-spin"></i>
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
    getMarketStatus(ticker, hour, day, minutes = 0) {
        // Weekend
        if (day === 0 || day === 6) {
            if (this.is247Asset(ticker)) return '24_7';
            // Or et EUR/USD sont 24/5, donc fermés le weekend
            return 'WEEKEND';
        }

        // Actifs 24/7 (Bitcoin uniquement)
        if (this.is247Asset(ticker)) return '24_7';

        // Actifs 24/5 (Or, EUR/USD) - cotent 24h en semaine
        if (this.is245Asset(ticker)) return '24_5';

        // Indices européens (Paris timezone 9h-17h30)
        const EU_INDICES = ['^FCHI', '^STOXX50E', '^GDAXI', '^FTSE', '^IBEX'];
        if (EU_INDICES.includes(ticker)) {
            if (hour >= 7 && hour < 9) return 'PRE_MARKET';
            if (hour >= 9 && hour < 17) return 'MARKET_OPEN';
            if (hour === 17 && minutes < 30) return 'MARKET_OPEN';
            return 'POST_MARKET';
        }

        // Indices US + Volatilité CBOE + Taux US (tous sur horaires NYSE)
        const US_INDICES = ['^GSPC', '^IXIC', '^DJI', '^RUT', '^VIX', '^VXN', '^RVX', '^VVIX', '^TNX', '^TYX', '^FVX', '^IRX'];
        if (US_INDICES.includes(ticker)) {
            if (hour >= 10 && hour < 15) return 'PRE_MARKET';
            if (hour === 15 && minutes >= 30) return 'MARKET_OPEN';
            if (hour >= 16 && hour < 22) return 'MARKET_OPEN';
            return 'POST_MARKET';
        }

        // Indices asiatiques / Pacifique (heures approximatives en heure de Paris)
        // Nikkei 225 ^N225  : TSE 9h-15h30 JST    = ~1h-8h30 Paris
        // Hang Seng  ^HSI   : HKEX 9h30-16h HKT   = ~2h30-10h Paris
        // KOSPI      ^KS11  : KRX 9h-15h30 KST    = ~1h-8h30 Paris
        // BSE Sensex ^BSESN : BSE 9h15-15h30 IST  = ~3h45-11h Paris
        // ASX 200    ^AXJO  : ASX 10h-16h AEST     = ~0h-7h Paris
        const ASIAN_INDICES = ['^N225', '^HSI', '^KS11', '^BSESN', '^AXJO'];
        if (ASIAN_INDICES.includes(ticker)) {
            const totalMinutes = hour * 60 + minutes;
            if (totalMinutes < 11 * 60) return 'MARKET_OPEN';
            return 'POST_MARKET';
        }

        return 'POST_MARKET';
    }

    /**
     * Calcule la variation intelligente selon le statut du marché
     * @returns {Object} { variation, variationPct, referencePrice, label, statusIcon }
     */
    getSmartVariation(ticker, currentPrice, previousClose, lastTradingDayClose, lastQuoteTime = null) {
        const now = new Date();
        const hour = now.getHours();
        const minutes = now.getMinutes();
        const day = now.getDay(); // 0 = dimanche, 6 = samedi

        const marketStatus = this.getMarketStatus(ticker, hour, day, minutes);

        let referencePrice, label, statusIcon, priceToUse;

        switch (marketStatus) {
            case 'PRE_MARKET':
                // Matin : Afficher CLOSED au lieu de futures
                priceToUse = currentPrice;
                referencePrice = previousClose; // Clôture veille
                label = 'CLOSED';
                statusIcon = '🔴'; // Icône fermé
                break;

            case 'MARKET_OPEN':
                // Marché ouvert : Variation du jour
                priceToUse = currentPrice;
                referencePrice = previousClose; // Clôture veille
                
                // Si la donnée a plus de 30 minutes de retard pendant l'ouverture des marchés
                if (lastQuoteTime && (Date.now() - lastQuoteTime) > 1800000) {
                    label = 'DELAYED';
                    statusIcon = '🟠'; 
                } else {
                    label = 'LIVE';
                    statusIcon = '🟢';
                }
                break;

            case 'POST_MARKET':
            case 'WEEKEND':
                // Soir/Weekend : Afficher la variation de la dernière séance connue par rapport à la veille
                // Pour un Lundi soir : currentPrice (Lundi Close) vs previousClose (Vendredi Close)
                priceToUse = currentPrice;
                referencePrice = previousClose;
                label = 'CLOSED';
                statusIcon = '🔴';
                break;

            case '24_7':
                // Bitcoin : Toujours variation du jour (prix actuel vs 00:00)
                priceToUse = currentPrice;
                referencePrice = previousClose;
                label = '24/7';
                statusIcon = '🔄';
                break;

            case '24_5':
                // Or, EUR/USD : 24h en semaine, variation du jour
                priceToUse = currentPrice;
                referencePrice = previousClose;
                label = '24/5';
                statusIcon = '🔄';
                break;

            default:
                priceToUse = currentPrice;
                referencePrice = previousClose;
                label = '';
                statusIcon = '';
        }

        const variation = priceToUse - referencePrice;
        const variationPct = referencePrice > 0 ? (variation / referencePrice) * 100 : 0;

        return {
            variation,
            variationPct,
            referencePrice,
            label,
            statusIcon,
            marketStatus
        };
    }

    renderAssetSelect() {
        const selectEl = document.getElementById('portfolio-asset-select');
        if (!selectEl) return;

        const purchases = this.storage.getPurchases();
        const uniqueAssets = [...new Set(purchases.filter(p => p.assetType !== 'Cash').map(p => ({ ticker: p.ticker, name: p.name })))];

        const assetMap = new Map();
        uniqueAssets.forEach(a => assetMap.set(a.name, { ticker: a.ticker, name: a.name }));
        const sortedAssets = Array.from(assetMap.values()).sort((a, b) => a.name.localeCompare(b.name));

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
        const closeBtn = document.getElementById('close-news-modal');
        const modal = document.getElementById('news-modal');
        const analyzeContextBtn = document.getElementById('analyze-context-btn');

        const closeModal = () => {
            if (modal) {
                modal.classList.remove('show');
                const contextBox = document.getElementById('modal-news-context');
                if (contextBox) contextBox.style.display = 'none';
                setTimeout(() => { modal.style.display = 'none'; }, 300);
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

    renderAllocation(holdings, totalValue) { // totalValue here is Global Portfolio Value
        const container = document.getElementById('dashboard-allocation-container');

        // FILTRE STRICT : Uniquement les actifs boursiers
        const marketAssets = holdings.filter(h => {
            const type = (h.assetType || 'Stock').toLowerCase(); // Default to Stock if undefined
            return ['etf', 'stock', 'crypto'].includes(type) && h.currentValue > 0;
        });

        // Recalcul du total spécifique "Boursier" pour les pourcentages
        const marketTotalValue = marketAssets.reduce((sum, h) => sum + h.currentValue, 0);

        if (!container) return;
        if (marketTotalValue === 0) {
            container.innerHTML = '<div style="color:var(--text-muted); font-size:12px; text-align:center; padding: 20px;">Aucun actif boursier (Actions, ETF, Crypto).</div>';
            return;
        }

        const categories = {
            'ETF': { value: 0, color: '#10b981', label: 'ETF' },
            'Stock': { value: 0, color: '#3b82f6', label: 'Actions' },
            'Crypto': { value: 0, color: '#f59e0b', label: 'Cryptos' }
        };

        marketAssets.forEach(h => {
            // Normalisation du type pour matcher les clés (Stock, ETF, Crypto)
            let type = h.assetType || 'Stock';
            // Sécurité : si le casing diffère, on map manuellement
            if (type.toLowerCase() === 'stock') type = 'Stock';
            if (type.toLowerCase() === 'etf') type = 'ETF';
            if (type.toLowerCase() === 'crypto') type = 'Crypto';

            if (categories[type]) {
                categories[type].value += h.currentValue;
            }
        });

        const data = Object.values(categories)
            .filter(c => c.value > 0.01) // Filtrer les valeurs nulles
            .map(c => ({ ...c, pct: (c.value / marketTotalValue) * 100 })) // % basé sur le total Boursier
            .sort((a, b) => b.value - a.value);

        if (data.length === 0) {
            container.innerHTML = '<div style="color:var(--text-muted); font-size:12px; text-align:center; padding: 20px;">Aucune donnée.</div>';
            return;
        }

        const fmt = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);

        let barHTML = '<div class="allocation-bar">';
        let listHTML = '<div class="allocation-list" style="flex-grow: 1;">'; // Ajout de flex-grow: 1 pour la robustesse

        data.forEach(item => {
            barHTML += `<div class="alloc-segment" style="width: ${item.pct}%; background-color: ${item.color};"></div>`;
            listHTML += `<div class="alloc-row">
                <div class="alloc-left">
                    <span class="alloc-dot" style="background-color: ${item.color};"></span>
                    <span class="alloc-pct">${item.pct.toFixed(1)}%</span>
                    <span class="alloc-label">${item.label}</span>
                </div>
                <div class="alloc-right"><span>${fmt(item.value)}</span></div>
            </div>`;
        });

        barHTML += '</div>'; listHTML += '</div>';

        // CORRECTION: Ajout de style="display: flex; flex-direction: column; height: 100%;" au wrapper pour forcer l'empilement vertical.
        container.innerHTML = `<div class="allocation-wrapper" style="display: flex; flex-direction: column; height: 100%;">${barHTML}${listHTML}</div>`;
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
        if (sectorTitle) sectorTitle.textContent = 'Top Holdings';
    }

    injectListIntoCard(elementId, items, type) {
        const targetEl = document.getElementById(elementId);
        if (!targetEl) return;
        const card = targetEl.closest('.kpi-card');
        if (!card) return;

        let listHTML = '<div class="kpi-list-container">';
        items.forEach(item => {
            // CRITICAL FIX: Add null-safety for gainPct and currentValue
            const safeGainPct = item.gainPct ?? 0;
            const safeCurrentValue = item.currentValue ?? 0;

            let valueHTML = type === 'asset'
                ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(safeCurrentValue)
                : (safeGainPct > 0 ? '+' : '') + safeGainPct.toFixed(2) + '%';
            let valueColor = type === 'asset' ? 'text-primary' : (safeGainPct >= 0 ? 'stat-positive' : 'stat-negative');
            let subValueHTML = item.currentPrice ? item.currentPrice.toFixed(2) + ' €' : '';

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

        Array.from(card.children).forEach(child => {
            if (!child.classList.contains('kpi-header')) child.remove();
        });
        card.insertAdjacentHTML('beforeend', listHTML);
    }

    cleanText(text) {
        if (typeof text !== 'string') return '';
        return text.replace(/'/g, "\\'").replace(/"/g, '\\"');
    }

    async loadPortfolioNews(forceRefresh = false) {
        const container = document.getElementById('news-portfolio-container');
        if (!container) return;
        container.innerHTML = '<div style="padding:20px; text-align:center; color:#666"><i class="fas fa-circle-notch fa-spin"></i></div>';

        let uniqueNames = [];
        if (this.selectedAssetFilter) {
            uniqueNames = [this.selectedAssetFilter];
        } else {
            const purchases = this.storage.getPurchases();
            uniqueNames = [...new Set(purchases.filter(p => p.assetType !== 'Cash').map(p => p.name))];
        }

        if (uniqueNames.length === 0) { container.innerHTML = '<div style="padding:20px; text-align:center; color:#666">Aucun actif</div>'; return; }

        const articleLimit = this.selectedAssetFilter ? 8 : 2;

        const promises = uniqueNames.map(name => this.fetchGoogleRSS(`${name} actualité financière`, articleLimit));
        try {
            const results = await Promise.all(promises);
            let allNews = results.flat();

            if (!this.selectedAssetFilter) {
                allNews = this.filterNewsByAssetNames(allNews, uniqueNames);
            }

            const uniqueNews = this.deduplicateNews(allNews).sort((a, b) => b.datetime - a.datetime);
            this.portfolioNews = uniqueNews.slice(0, 15);
            this.renderNewsList(container, this.portfolioNews, 'portfolio');
            this.renderAssetSelect();
        } catch (e) {
            container.innerHTML = '<div style="padding:20px; text-align:center; color:#ef4444">Erreur de chargement des actualités.</div>';
        }
    }

    filterNewsByAssetNames(newsArray, assetNames) {
        const lowerAssetNames = assetNames.map(name => name.toLowerCase());
        return newsArray.filter(n => {
            const titleLower = n.title.toLowerCase();
            return lowerAssetNames.some(name => titleLower.includes(name));
        });
    }

    async loadGlobalNews(forceRefresh = false) {
        const container = document.getElementById('news-global-container');
        if (!container) return;
        container.innerHTML = '<div style="padding:20px; text-align:center; color:#666"><i class="fas fa-circle-notch fa-spin"></i></div>';

        const topics = [
            { query: "Marchés Bourse Paris", label: "Macro FR" },
            { query: "Wall Street économie", label: "Wall Street" },
            { query: "Crypto Bitcoin actu", label: "Crypto" },
            { query: "Inflation BCE Fed", label: "Politique Monétaire" }
        ];

        const promises = topics.map(t => this.fetchGoogleRSS(t.query, 4, t.label));
        try {
            const results = await Promise.all(promises);
            const allNews = results.flat().sort((a, b) => b.datetime - a.datetime);
            this.globalNews = this.deduplicateNews(allNews).slice(0, 15);
            this.renderNewsList(container, this.globalNews, 'global');
        } catch (e) {
            container.innerHTML = '<div style="padding:20px; text-align:center; color:#ef4444">Erreur de chargement des actualités.</div>';
        }
    }

    fetchGoogleRSS(query, limit = 1, fixedLabel = null) {
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=fr&gl=FR&ceid=FR:fr`;

        const url = PROXY_URL + encodeURIComponent(rssUrl);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        return fetch(url, { signal: controller.signal })
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.text();
            })
            .then(xmlText => {
                const data = new window.DOMParser().parseFromString(xmlText, "text/xml");

                return Array.from(data.querySelectorAll("item")).slice(0, limit).map(item => {
                    const pubDate = item.querySelector("pubDate")?.textContent;
                    const fullTitle = item.querySelector("title")?.textContent || "";
                    const description = item.querySelector("description")?.textContent || "";
                    const parts = fullTitle.split(" - ");
                    const source = parts.length > 1 ? parts.pop() : "Google";

                    return {
                        ticker: fixedLabel || source,
                        name: query,
                        title: parts.join(" - "),
                        source: source,
                        url: item.querySelector("link")?.textContent,
                        datetime: pubDate ? new Date(pubDate).getTime() / 1000 : Date.now() / 1000,
                        fullDescription: description,
                        label: fixedLabel || 'Macro Éco'
                    };
                });
            })
            .catch(e => {
                console.warn(`Échec Fetch RSS pour "${query}":`, e);
                return [];
            })
            .finally(() => clearTimeout(timeoutId));
    }

    renderNewsList(container, newsData, type) {
        if (newsData.length === 0) {
            container.innerHTML = '<div style="padding:20px; text-align:center; color:#666">Aucune news.</div>';
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
            const context = `${newsItem.title}. Sujet: ${newsItem.name}.`;

            console.log('[openNewsModal] Calling fetchGeminiSummary with context:', context.substring(0, 100));

            // UTILISATION DU SERVICE CENTRALISÉ
            const summary = await fetchGeminiSummary(context);

            console.log('[openNewsModal] Got summary:', summary);

            this.currentGeminiSummary = summary;
            summaryDiv.textContent = summary;
        } catch (error) {
            console.error('[openNewsModal] Error:', error);
            summaryDiv.innerHTML = "Analyse indisponible (Erreur API).";
        }
    }

    getHoldingDetailsForNews(newsItem) {
        const allHoldings = this.lastHoldings || [];

        // 1. Déterminer le nom de la société à partir du titre de la news (ex: "AST SpaceMobile")
        // La structure de la news est: TITRE (ex: "AST SpaceMobile, Inc. étend...")
        const newsTitle = newsItem.title || newsItem.name;

        // 2. Recherche stricte par Nom/Ticker (plus fiable que le match de sous-chaîne sur name)
        // La recherche 'Find' est suffisante car chaque actif est unique.
        const foundHolding = allHoldings.find(h =>
            // Tentative A: Le nom de l'actif du portefeuille est inclus dans le titre de la news
            newsTitle.includes(h.name) ||
            // Tentative B: Match par le ticker exact si la news le contient
            newsTitle.includes(h.ticker)
        );

        if (foundHolding) {
            // S'assurer que le DataManager a retourné des chiffres valides
            if (foundHolding.quantity > 0) {
                return foundHolding;
            }
        }

        return null; // Retourne null si aucune position détenue n'est trouvée
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
            contextBox.classList.remove('show');
            setTimeout(() => contextBox.style.display = 'none', 300);
            return;
        }

        contextBox.style.display = 'block';
        contextBox.classList.remove('show');
        contextContent.innerHTML = '<span class="loading-text">Gemini contextualise...</span>';
        setTimeout(() => contextBox.classList.add('show'), 10);

        // APPEL CENTRALISÉ avec les données du portefeuille
        fetchGeminiContext(newsItem.title, currentSummary, holdingDetails)
            .then(contextSummary => { contextContent.textContent = contextSummary; })
            .catch(() => { contextContent.innerHTML = "Échec de l'analyse contextuelle."; });
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

        if (container.querySelector('.market-loading') || container.children.length === 0) {
            container.innerHTML = '';
        }

        const indices = this.getCustomIndices();

        // Supprimer les cartes dont l'indice a été retiré de la liste
        const activeTickers = new Set(indices.map(i => `market-card-${i.ticker.replace(/[^a-zA-Z0-9]/g, '-')}`));
        container.querySelectorAll('.market-card').forEach(card => {
            if (!activeTickers.has(card.id)) card.remove();
        });

        // Récupération de tous les prix en une seule fois (via Promise.all pour paralléliser)
        const fetchPromises = indices.map(async (idx) => {
            let dashboardData = null;
            let targetTicker = idx.ticker;
            let isFuturesSwap = false;

            // PAS DE FUTURES : Toujours utiliser le ticker réel de l'indice
            // Si fermé → dernière journée, si ouvert → live
            const now = new Date();
            const hour = now.getHours();
            const min = now.getMinutes();

            // EU Futures (08:00 - 09:00 : Pre-market Europe)
            /* DESACTIVÉ CAR TICKERS FCE=F / FESX=F RETOURNENT 404
            if (idx.ticker === '^FCHI' || idx.ticker === '^STOXX50E') {
                // Marché officiel ouvre à 09:00. Avant (depuis 08:00), on affiche les futures.
                // On peut aussi étendre après 17:30 si voulu, mais la demande spécifique est "à partir de 8h00".
                const isPreMarketEU = (hour === 8);

                if (isPreMarketEU) {
                    if (idx.ticker === '^FCHI') targetTicker = 'FCE=F';      // CAC 40 Futures
                    if (idx.ticker === '^STOXX50E') targetTicker = 'FESX=F'; // Euro Stoxx 50 Futures
                    isFuturesSwap = true;
                }
            }
            */

            try {
                // Utilisation de la nouvelle méthode précise (avec ticker potentiellement swapé)
                console.log(`[Dashboard] Fetching data for ${targetTicker}...`);
                dashboardData = await this.api.fetchIndexDataForDashboard(targetTicker);

                if (!dashboardData) {
                    console.warn(`[Dashboard] No data returned for ${targetTicker}`);
                }

                // Si succès, on met à jour le cache
                if (dashboardData) {
                    this.storage.setCurrentPrice(idx.ticker, {
                        price: dashboardData.price,
                        previousClose: dashboardData.previousClose,
                        currency: dashboardData.currency,
                        marketState: dashboardData.marketState, // Sera probablement 'REGULAR' pour les Futures
                        lastUpdate: dashboardData.fetchedAt || Date.now()
                    });
                    console.log(`[Dashboard] ✓ ${idx.ticker}: ${dashboardData.price}`);
                }
            } catch (e) {
                console.error(`[Dashboard] Error fetching ${targetTicker}:`, e);
            }

            // Fallback sur le cache si l'appel échoue
            if (!dashboardData) {
                const cached = this.storage.getCurrentPrice(idx.ticker);
                if (cached) {
                    dashboardData = {
                        price: cached.price,
                        previousClose: cached.previousClose,
                        lastTradingDayClose: cached.lastTradingDayClose ?? null,
                        marketState: cached.marketState || 'UNKNOWN',
                        stale: true
                    };
                }
            }

            // Récupération des données pour le sparkline
            let indexData = null;
            let truePreviousClose = null;

            // Logic allowFallback: Disable fallback to yesterday if market is strictly OPEN
            let allowFallback = true;
            const dayOfWeek = now.getDay();
            const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

            if (isWeekday) {
                if (idx.ticker === '^FCHI' || idx.ticker === '^STOXX50E') {
                    // EU Open 09:00 - 17:35
                    if (hour >= 9 && hour < 18) {
                        allowFallback = false;
                    }
                }
                if (idx.ticker === '^GSPC' || idx.ticker === '^IXIC') {
                    // US Open 15:30 - 22:00
                    if ((hour > 15 || (hour === 15 && min >= 30)) && hour < 22) {
                        allowFallback = false;
                    }
                }
            }

            try {
                indexData = await this.chartKPIManager.fetchIndexData(targetTicker, '1D', allowFallback);
                if (indexData) truePreviousClose = indexData.truePreviousClose;
            } catch (e) { console.warn(`[Sparkline ${targetTicker}] Error:`, e.message); }

            return { idx, dashboardData, indexData, truePreviousClose, isFuturesSwap, targetTicker }; // Modified to include targetTicker
        });

        const results = await Promise.all(fetchPromises);

        for (const { idx, dashboardData, indexData, truePreviousClose, isFuturesSwap, targetTicker } of results) {

            let currentPrice = dashboardData ? dashboardData.price : 0;
            let apiPreviousClose = dashboardData ? dashboardData.previousClose : 0;
            const lastTradingDayClose = dashboardData ? dashboardData.lastTradingDayClose : 0;

            // VALIDATION CRITIQUE: Ne jamais permettre de variation avec des prix à zéro
            if (currentPrice <= 0 || apiPreviousClose <= 0) {
                console.error(`[Card ${idx.ticker}] Invalid price data - current: ${currentPrice}, previous: ${apiPreviousClose}`);
                // Essayer d'utiliser le cache comme dernier recours
                const cached = this.storage.getCurrentPrice(idx.ticker);
                if (cached && cached.price > 0 && cached.previousClose > 0) {
                    currentPrice = cached.price;
                    apiPreviousClose = cached.previousClose;
                    console.log(`[Card ${idx.ticker}] Recovered from cache - price: ${currentPrice}, previousClose: ${apiPreviousClose}`);
                } else {
                    // Si vraiment aucune donnée valide, skip cette carte (ne pas l'afficher avec 0%)
                    console.warn(`[Card ${idx.ticker}] Skipping - no valid data available`);
                    continue; // Passer à la prochaine carte
                }
            }

            let sparklineBg = '';

            // 2. LOGIQUE CORRIGÉE : Utiliser lastTradingDayClose si previousClose === currentPrice
            // Cela arrive quand le marché est fermé et que l'API retourne le dernier prix comme previousClose
            let referenceClose = apiPreviousClose;

            // Si previousClose === currentPrice, c'est que l'API n'a pas de vraie clôture veille
            // Dans ce cas, utiliser lastTradingDayClose qui contient la vraie clôture de J-1
            if (Math.abs(apiPreviousClose - currentPrice) < 0.01 && lastTradingDayClose > 0) {
                referenceClose = lastTradingDayClose;
                console.log(`[Card ${idx.ticker}] Using lastTradingDayClose (${lastTradingDayClose.toFixed(2)}) instead of previousClose (${apiPreviousClose.toFixed(2)}) for variation`);
            } else if (apiPreviousClose > 0) {
                referenceClose = apiPreviousClose;
            } else {
                referenceClose = currentPrice; // Fallback ultime
            }

            // Debug: vérifier 
            console.log(`[Card ${idx.ticker}] price: ${currentPrice}, apiPreviousClose: ${apiPreviousClose}, Ref: ${referenceClose}`);

            // NOUVELLE LOGIQUE : Variation intelligente
            const smartVar = this.getSmartVariation(
                idx.ticker,
                currentPrice,
                referenceClose,
                lastTradingDayClose || referenceClose,
                indexData ? indexData.lastQuoteTime : null
            );

            const change = smartVar.variation;
            const pct = smartVar.variationPct;

            // CRITICAL FIX: Update currentData with the smart variation so Notifications see it
            // CRITICAL FIX: Update currentData with the smart variation so Notifications see it
            // Ensure storage.currentData exists
            if (!this.storage.currentData) {
                this.storage.currentData = {};
            }

            if (this.storage.currentData[idx.ticker]) {
                this.storage.currentData[idx.ticker].changePercent = pct;
                this.storage.currentData[idx.ticker].change = change;
            } else {
                // Should exist, but just in case
                this.storage.currentData[idx.ticker] = {
                    changePercent: pct,
                    change: change,
                    price: currentPrice
                };
            }


            let statusLabel = smartVar.label;
            // if (isFuturesSwap) statusLabel = 'FUTURES'; // SUPPRIMÉ: On laisse getSmartVariation décider ('CLOSED' ou 'LIVE')

            const statusIcon = smartVar.statusIcon;
            const indicatorColor = change > 0 ? '#10b981' : change < 0 ? '#ef4444' : '#9fa6bc';

            // Générer le sparkline maintenant qu'on a la bonne couleur et la bonne référence
            if (indexData) {
                sparklineBg = this.chartKPIManager.generateSparkline(indexData, smartVar.referencePrice, idx.ticker, indicatorColor);
            }

            // Classe de statut pour la variation
            const finalStatusClass = change > 0 ? 'stat-positive' : change < 0 ? 'stat-negative' : 'stat-positive';

            // Formatage prix selon le format de l'actif
            const fmt = idx.format || (
                idx.ticker.endsWith('=X') ? 'forex' :
                idx.ticker.endsWith('=F') ? 'commodity' :
                idx.ticker.includes('-EUR') || idx.ticker.includes('-USD') ? 'crypto' : 'index'
            );
            let priceStr, changeDecimals = 2;
            if (fmt === 'crypto') {
                if (currentPrice >= 1) {
                    priceStr = Math.round(currentPrice).toLocaleString('fr') + ' €';
                } else {
                    priceStr = currentPrice.toFixed(4) + ' €';
                    changeDecimals = 4;
                }
            } else if (fmt === 'forex' || fmt === 'commodity') {
                priceStr = currentPrice.toFixed(4);
                changeDecimals = 4;
            } else {
                priceStr = currentPrice.toLocaleString('fr', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            }

            const changeStr = `${change >= 0 ? '+' : ''}${change.toFixed(changeDecimals)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
            const changeClass = change >= 0 ? 'stat-positive' : 'stat-negative';

            // Extraire les KPIs depuis indexData
            let kpiHTML = '';
            if (indexData && indexData.values && indexData.values.length > 0) {
                // STATS (DEBUT/FIN/HAUT/BAS) DÉSACTIVÉES SUR DEMANDE UTILISATEUR
                // kpiHTML = ...
            }

            // Utiliser statusColor basé sur le statut
            let statusColor = '#9fa6bc';
            if (statusLabel === 'LIVE') statusColor = '#10b981'; // Green
            else if (statusLabel === 'DELAYED') statusColor = '#f59e0b'; // Orange
            else if (statusLabel === 'CLOSED') statusColor = '#ef4444'; // Red
            else statusColor = change >= 0 ? '#10b981' : change < 0 ? '#ef4444' : '#9fa6bc';

            // Icône normalisée (Conteneur fixe pour éviter les décalages de hauteur sur BTC)
            const iconContent = idx.icon.includes('http')
                ? `<img src="${idx.icon}" alt="" style="width:100%; height:100%; object-fit:contain; filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5));">`
                : `<span style="font-size:24px; line-height:1; filter:drop-shadow(0 1px 3px rgba(0,0,0,0.6)); display:flex; align-items:center; justify-content:center; height:100%; width:100%;">${escHtml(idx.icon)}</span>`;

            const iconHTML = `<div style="width:26px; height:26px; display:flex; align-items:center; justify-content:center;">${iconContent}</div>`;

            const innerHTMLStructure = `
				<button class="market-card-delete" title="Supprimer"><i class="fas fa-trash-alt"></i></button>
				${sparklineBg}
				<div style="position:relative; z-index:2; display:flex; justify-content:space-between; align-items:flex-start;">
					<span style="font-weight:600; font-size:13px; color:#e2e8f0; line-height:1.3;">${escHtml(idx.name)}</span>
					${iconHTML}
				</div>
				<div style="position:relative; z-index:2;">
					<div style="font-size:16px; font-weight:700; color:#fff; margin:2px 0;">${priceStr}</div>
					<div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
						<span class="${changeClass}" style="font-size:11.5px; font-weight:600;">${changeStr}</span>
						<span style="color:${statusColor}; border:1px solid ${statusColor}; padding:3px 8px; border-radius:6px; font-weight:700; font-size:9px; background:rgba(255,255,255,0.1); text-transform:uppercase; letter-spacing:0.4px;">
							${statusIcon} ${statusLabel}
						</span>
					</div>
					${kpiHTML}
				</div>`;

            // ID unique de la carte
            const cardId = `market-card-${idx.ticker.replace(/[^a-zA-Z0-9]/g, '-')}`;
            let cardElement = document.getElementById(cardId);

            // Sauvegarde de l'état actif AVANT toute modification
            const wasActive = cardElement ? cardElement.classList.contains('active-index') : false;

            // Création de la carte si elle n'existe pas encore
            if (!cardElement) {
                cardElement = document.createElement('div');
                cardElement.id = cardId;
                cardElement.className = 'market-card';
                cardElement.style.cssText = `
					position:relative;
					overflow:hidden;
					border-radius:12px;
					background:#0f172a;
					height:112px;
					display:flex;
					flex-direction:column;
					justify-content:space-between;
					padding:10px 12px 12px;
					box-sizing:border-box;
					cursor:pointer;
					transition:all 0.25s ease;
				`;
                container.appendChild(cardElement);
            }

            // Nettoyage des anciennes classes de statut
            cardElement.classList.remove('stat-positive', 'stat-negative', 'active-index');

            // Application de la nouvelle couleur du jour
            cardElement.classList.add(finalStatusClass);
            cardElement.style.border = `1px solid ${indicatorColor}50`;
            cardElement.style.boxShadow = `0 0 10px ${indicatorColor}10`;

            // Mise à jour du contenu
            cardElement.innerHTML = innerHTMLStructure;

            // Bouton suppression
            const delBtn = cardElement.querySelector('.market-card-delete');
            if (delBtn) {
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.removeIndex(idx.ticker);
                };
            }

            // Restauration de la surbrillance si c'était la carte active
            if (wasActive) {
                cardElement.classList.add('active-index');
            }

            // Event listener (toujours à jour)
            cardElement.onclick = async () => {
                // Recliquer sur la carte déjà active désélectionne l'indice et
                // revient à la vue portefeuille — jusqu'ici il n'existait aucun
                // moyen de revenir en arrière une fois un indice sélectionné.
                const wasActive = cardElement.classList.contains('active-index');
                document.querySelectorAll('.market-card').forEach(c => c.classList.remove('active-index'));
                if (wasActive) {
                    if (this.chart) this.chart.showPortfolioChart();
                    return;
                }
                cardElement.classList.add('active-index');

                await this.dataManager.repository.getPrice(targetTicker, { forceRefresh: true });
                if (this.chart) {
                    this.chart.showIndex(targetTicker, idx.name); // Use targetTicker (Futures if applicable)
                }
                if (window.innerWidth < 768) {
                    document.querySelector('.dashboard-chart-section')?.scrollIntoView({ behavior: 'smooth' });
                }
            };
        }

        // Nettoyage final du loader
        const loader = container.querySelector('.market-loading');
        if (loader) loader.remove();

        // TRIGGER NOTIFICATIONS FOR INDICES
        if (this.notificationManager && this.storage.currentData) {
            this.notificationManager.checkAll(this.storage.currentData);
        }
    }

    // =============================================
    // INDICES MODULAIRES
    // =============================================

    getCustomIndices() {
        const cdn = 'https://cdn.jsdelivr.net/npm/openmoji@14.0.0/color/svg/';
        const defaults = [
            { ticker: '^GSPC',     name: 'S&P 500',       icon: `${cdn}1F1FA-1F1F8.svg`, format: 'index' },
            { ticker: '^IXIC',     name: 'NASDAQ 100',    icon: `${cdn}1F4BB.svg`,        format: 'index' },
            { ticker: '^FCHI',     name: 'CAC 40',        icon: `${cdn}1F1EB-1F1F7.svg`, format: 'index' },
            { ticker: '^STOXX50E', name: 'EURO STOXX 50', icon: `${cdn}1F1EA-1F1FA.svg`, format: 'index' },
            { ticker: 'BTC-EUR',   name: 'BITCOIN',       icon: '₿',                      format: 'crypto' },
            { ticker: 'GC=F',      name: 'OR (GOLD)',     icon: `${cdn}1FA99.svg`,        format: 'commodity' },
            { ticker: 'EURUSD=X',  name: 'EUR / USD',     icon: `${cdn}1F4B1.svg`,        format: 'forex' },
        ];
        try {
            const saved = localStorage.getItem('dashboard_indices_v1');
            if (saved) return JSON.parse(saved);
        } catch (e) {}
        return defaults;
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
    }

    getIndicesCatalogue() {
        const cdn = 'https://cdn.jsdelivr.net/npm/openmoji@14.0.0/color/svg/';
        return {
            'Indices': [
                // US
                { ticker: '^GSPC',     name: 'S&P 500',       icon: `${cdn}1F1FA-1F1F8.svg`, format: 'index' },
                { ticker: '^IXIC',     name: 'NASDAQ 100',    icon: `${cdn}1F4BB.svg`,        format: 'index' },
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
        document.getElementById('add-index-btn')?.addEventListener('click', () => {
            document.getElementById('add-index-modal').style.display = 'flex';
            this.renderIndexModal('Indices');
        });

        document.getElementById('close-index-modal')?.addEventListener('click', () => {
            document.getElementById('add-index-modal').style.display = 'none';
        });

        document.getElementById('add-index-modal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
        });

        document.querySelectorAll('.index-tab').forEach(btn => {
            btn.addEventListener('click', () => this.renderIndexModal(btn.dataset.tab));
        });
    }

    renderIndexModal(activeTab = 'Indices') {
        const catalogue = this.getIndicesCatalogue();
        const currentTickers = new Set(this.getCustomIndices().map(i => i.ticker));

        document.querySelectorAll('.index-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === activeTab);
        });

        const grid = document.getElementById('add-index-grid');
        if (!grid) return;

        const items = catalogue[activeTab] || [];
        grid.innerHTML = items.map(item => {
            const isAdded = currentTickers.has(item.ticker);
            const iconHTML = item.icon.includes('http')
                ? `<img src="${item.icon}" alt="" style="width:22px;height:22px;object-fit:contain;">`
                : `<span style="font-size:18px;line-height:1;">${escHtml(item.icon)}</span>`;
            return `
                <div class="add-index-item${isAdded ? ' already-added' : ''}" data-ticker="${escHtml(item.ticker)}">
                    <div class="add-index-item-icon">${iconHTML}</div>
                    <div>
                        <div class="add-index-item-name">${escHtml(item.name)}</div>
                        <div class="add-index-item-ticker">${escHtml(item.ticker)}</div>
                    </div>
                    <span class="add-index-item-action" style="color:${isAdded ? '#10b981' : '#818cf8'};">${isAdded ? '✓' : '+'}</span>
                </div>`;
        }).join('');

        grid.querySelectorAll('.add-index-item:not(.already-added)').forEach(el => {
            el.addEventListener('click', () => {
                const ticker = el.dataset.ticker;
                const item = items.find(i => i.ticker === ticker);
                if (item) {
                    this.addIndex(item);
                    document.getElementById('add-index-modal').style.display = 'none';
                }
            });
        });
    }

    setupKPIModals() {
        // Sélection par position dans la grille — les IDs internes disparaissent
        // après injectListIntoCard(), mais les .kpi-card eux-mêmes restent stables
        const grid = document.querySelector('.dashboard-kpi-grid-v2');
        const cards = grid ? [...grid.querySelectorAll(':scope > .kpi-card')] : [];
        const types = ['gainer', 'loser', 'asset', 'allocation'];
        cards.forEach((card, i) => {
            const type = types[i];
            if (!type) return;
            card.dataset.clickable = type;
            card.addEventListener('click', () => {
                if (type === 'allocation') this.openAllocationModal();
                else this.openKPIModal(type);
            });
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

    openKPIModal(type) {
        const holdings = this.lastHoldings || [];
        const modal = document.getElementById('kpi-detail-modal');
        const titleEl = document.getElementById('kpi-modal-title');
        const iconEl = document.getElementById('kpi-modal-icon');
        const body = document.getElementById('kpi-modal-body');
        if (!modal) return;

        let sortedItems, titleText, iconClass, iconColor;

        if (type === 'gainer') {
            titleText = 'Top Gainer — Actifs en plus-value';
            iconClass = 'fa-arrow-trend-up'; iconColor = '#10b981';
            sortedItems = [...holdings]
                .filter(h => h.gainPct != null && h.gainEUR != null)
                .sort((a, b) => (b.gainPct ?? -Infinity) - (a.gainPct ?? -Infinity));
        } else if (type === 'loser') {
            titleText = 'Top Loser — Actifs en moins-value';
            iconClass = 'fa-arrow-trend-down'; iconColor = '#ef4444';
            sortedItems = [...holdings]
                .filter(h => h.gainPct != null && h.gainEUR != null)
                .sort((a, b) => (a.gainPct ?? Infinity) - (b.gainPct ?? Infinity));
        } else {
            titleText = 'Top Holdings — Valeur du portefeuille';
            iconClass = 'fa-layer-group'; iconColor = '#3b82f6';
            sortedItems = [...holdings]
                .filter(h => h.currentValue != null && h.currentValue > 0)
                .sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0));
        }

        titleEl.textContent = titleText;
        iconEl.className = `fas ${iconClass}`;
        iconEl.style.color = iconColor;

        const fmt = v => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(v);
        const totalValue = sortedItems.reduce((s, h) => s + (h.currentValue || 0), 0);

        let html = `<table class="kpi-detail-table kpi-detail-table--${type}"><thead><tr>`;
        if (type === 'gainer' || type === 'loser') {
            html += '<th>#</th><th>Actif</th><th>Investi</th><th>Valeur</th><th>+/- €</th><th>+/- %</th>';
        } else {
            html += '<th>#</th><th>Actif</th><th>Valeur</th><th>% Port.</th><th>Perf.</th>';
        }
        html += '</tr></thead><tbody>';

        sortedItems.forEach((h, i) => {
            const gainPct = h.gainPct ?? 0;
            const gainEUR = h.gainEUR ?? 0;
            const color = gainPct >= 0 ? '#10b981' : '#ef4444';
            const sign = gainPct >= 0 ? '+' : '';
            if (type === 'gainer' || type === 'loser') {
                html += `<tr>
                    <td>${i + 1}</td>
                    <td><div class="kpi-modal-name">${escHtml(h.name)}</div><div class="kpi-modal-sub">${escHtml(h.ticker)} · ${escHtml(h.assetType || '')}</div></td>
                    <td>${fmt(h.invested || 0)}</td>
                    <td>${fmt(h.currentValue || 0)}</td>
                    <td style="color:${color};font-weight:600;">${sign}${fmt(gainEUR)}</td>
                    <td style="color:${color};font-weight:600;">${sign}${gainPct.toFixed(2)}%</td>
                </tr>`;
            } else {
                const pct = totalValue > 0 ? (h.currentValue / totalValue) * 100 : 0;
                html += `<tr>
                    <td>${i + 1}</td>
                    <td><div class="kpi-modal-name">${escHtml(h.name)}</div><div class="kpi-modal-sub">${escHtml(h.ticker)} · ${escHtml(h.assetType || '')}</div></td>
                    <td style="font-weight:600;">${fmt(h.currentValue || 0)}</td>
                    <td>${pct.toFixed(1)}%</td>
                    <td style="color:${color};font-weight:600;">${sign}${gainPct.toFixed(2)}%</td>
                </tr>`;
            }
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

        const render = (basis) => this.buildAllocationChart(this.lastHoldings || [], wrap, legend, breakdown, basis);

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
        render(activeBtn?.dataset.basis || 'invested');
    }

    buildAllocationChart(holdings, chartWrap, legend, breakdown, basis = 'invested') {
        const TYPES = {
            'ETF':         { color: '#10b981', label: 'ETF' },
            'Stock':       { color: '#3b82f6', label: 'Actions' },
            'Crypto':      { color: '#f59e0b', label: 'Cryptos' },
            'Real Estate': { color: '#8b5cf6', label: 'Immobilier' },
        };
        const typeKeys = Object.keys(TYPES);

        const normalizeType = raw => {
            const r = (raw || '').toLowerCase();
            if (r === 'etf') return 'ETF';
            if (r === 'stock') return 'Stock';
            if (r === 'crypto') return 'Crypto';
            if (r === 'real estate' || r === 'realestate') return 'Real Estate';
            return 'Stock';
        };

        const events = [];
        holdings.forEach(h => {
            const type = normalizeType(h.assetType);
            const purchases = (h.purchases || []).filter(p => p.quantity > 0 && p.date);
            if (!purchases.length) return;
            const totalRaw = purchases.reduce((s, p) => s + p.price * p.quantity, 0);
            // Vue "Portefeuille": valorise les quantités historiques au prix ACTUEL
            // (pas de vrai mark-to-market historique), pour rester cohérent avec
            // "Répartition actuelle" sans appel API supplémentaire. Un actif sans
            // currentValue live (ex: cotation manquante) contribue pour 0, comme
            // dans "Répartition actuelle" — pas de repli sur le prix d'achat, pour
            // que le dernier point du graphique corresponde toujours au résumé.
            const pricePerUnitEUR = (h.quantity > 0 && h.currentValue > 0) ? h.currentValue / h.quantity : 0;
            purchases.forEach(p => {
                const weight = totalRaw > 0 ? (p.price * p.quantity) / totalRaw : 1 / purchases.length;
                const amount = basis === 'market' ? pricePerUnitEUR * p.quantity : p.price * p.quantity;
                events.push({ date: p.date.substring(0, 10), type, amount });
            });
        });

        if (events.length < 2) {
            chartWrap.innerHTML = '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;">Pas assez de données historiques.</div>';
            legend.innerHTML = '';
            breakdown.innerHTML = '';
            return;
        }

        events.sort((a, b) => a.date.localeCompare(b.date));

        const cumulative = {};
        typeKeys.forEach(k => cumulative[k] = 0);
        const timePoints = [];

        events.forEach(e => {
            cumulative[e.type] = (cumulative[e.type] || 0) + e.amount;
            const last = timePoints[timePoints.length - 1];
            if (last && last.date === e.date) {
                last.cum = { ...cumulative };
            } else {
                timePoints.push({ date: e.date, cum: { ...cumulative } });
            }
        });

        const todayStr = new Date().toISOString().substring(0, 10);
        if (timePoints[timePoints.length - 1]?.date !== todayStr) {
            timePoints.push({ date: todayStr, cum: { ...cumulative } });
        }

        const points = timePoints.map(tp => {
            const total = typeKeys.reduce((s, k) => s + (tp.cum[k] || 0), 0);
            const pcts = {};
            typeKeys.forEach(k => pcts[k] = total > 0 ? (tp.cum[k] || 0) / total * 100 : 0);
            return { date: tp.date, pcts };
        });

        const activeTypes = typeKeys.filter(k => (cumulative[k] || 0) > 0);

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

        // Basis "market": valeur actuelle réelle par type (currentValue).
        // Basis "invested": montant investi par type (cumulative, déjà calculé plus haut).
        let byType, totalByType, breakdownLabel;
        if (basis === 'market') {
            byType = {};
            typeKeys.forEach(k => byType[k] = 0);
            holdings.forEach(h => {
                const t = normalizeType(h.assetType);
                if ((h.currentValue || 0) > 0) byType[t] += h.currentValue;
            });
            breakdownLabel = 'Répartition actuelle (valeur totale)';
        } else {
            byType = cumulative;
            breakdownLabel = 'Répartition actuelle (montant investi)';
        }
        totalByType = typeKeys.reduce((s, k) => s + (byType[k] || 0), 0);

        const fmtK = v => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v);
        breakdown.innerHTML = `
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px;">${breakdownLabel}</div>
            <div style="display:flex;gap:16px;flex-wrap:wrap;">
                ${activeTypes.map(k => {
                    const pct = totalByType > 0 ? ((byType[k] || 0) / totalByType) * 100 : 0;
                    return `<div style="display:flex;flex-direction:column;gap:2px;">
                        <span style="font-size:15px;font-weight:700;color:${TYPES[k].color};">${pct.toFixed(1)}%</span>
                        <span style="font-size:11px;color:var(--text-muted);">${TYPES[k].label} · ${fmtK(byType[k] || 0)}</span>
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
            if (this.chart) await this.chart.update(false, false);
        } finally {
            this._refreshing = false;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => new DashboardApp());
