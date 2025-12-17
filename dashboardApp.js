// benderrobot/asset_tracker/asset_tracker-52109016fe138d6ac9b283096e2de3cfbb9437bb/dashboardApp.js

// ========================================
// dashboardApp.js - VERSION CORRIGÉE FINALE (Unification + Fix Erreur Critique + GCP Proxy)
// ========================================
import { Storage } from './storage.js';
import { PriceAPI } from './api.js?v=4';
import { MarketStatus } from './marketStatus.js?v=2';
import { DataManager } from './dataManager.js?v=7';
import { HistoricalChart } from './historicalChart.js?v=9';
import { IndexCardChart } from './indexCardChart.js';
import { ChartKPIManager } from './chartKPIManager.js'; // NOUVEAU : Pour sparkline
import { fetchGeminiSummary, fetchGeminiContext } from './geminiService.js';
import { UIComponents } from './ui.js'; // <-- IMPORT UIComponents AJOUTÉ
import { GEMINI_PROXY_URL } from './config.js'; // <-- IMPORT GCP PROXY

// --- OUTILS DE SYNCHRONISATION (PROXY & COULEURS) ---
const PROXY_URL = 'https://corsproxy.io/?';

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


class DashboardApp {
    constructor() {
        this.storage = new Storage();
        this.api = new PriceAPI(this.storage);
        this.marketStatus = new MarketStatus(this.storage);
        this.dataManager = new DataManager(this.storage, this.api);
        this.chartKPIManager = new ChartKPIManager(this.api, this.storage, this.dataManager, this.marketStatus); // NOUVEAU
        this.ui = new UIComponents(this.storage); // <-- INSTANCIATION NÉCESSAIRE

        this.mockPageInterface = {
            filterManager: { getSelectedTickers: () => new Set() },
            currentSearchQuery: '',
            currentAssetTypeFilter: '',
            currentBrokerFilter: '',
            getChartTitleConfig: () => ({ mode: 'global', label: 'Portfolio Global', icon: 'Chart' }),
            renderData: (holdings, summary, cash) => {
                if (summary) {
                    // CORRECTION: Utilise la méthode unifiée de ui.js pour mettre à jour les 3 cartes principales
                    // La variable 'summary.movementsCount' n'est pas nécessaire ici, on passe 0 si elle n'existe pas.
                    // MODIF: On passe null pour marketStatus afin de ne PAS afficher le badge "EN DIRECT" sur le Dashboard
                    this.ui.updatePortfolioSummary(summary, summary.movementsCount || 0, cash, null);
                }
            }
        };

        this.chart = null;
        this.currentModalNewsItem = null;
        this.currentGeminiSummary = null;
        this.portfolioNews = [];
        this.globalNews = [];

        this.selectedAssetFilter = '';

        this.init();
    }

    async init() {
        console.log('Dashboard Init...');
        this.marketStatus.startAutoRefresh('market-status-container', 'compact');
        await this.loadPortfolioData();
        setTimeout(() => this.initHistoricalChart(), 50);
        this.loadPortfolioNews();
        this.loadGlobalNews();
        await this.loadMarketIndices();
        setInterval(() => this.refreshDashboard(), 5 * 60 * 1000);
        this.setupEventListeners();


        this.setupChartControls(); // NOUVEAU

        this.setupNewsControls();
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
     */
    is247Asset(ticker) {
        return ticker === 'BTC-EUR';
    }

    /**
     * Détermine si un actif cote 24/5 (24h/jour mais pas le weekend)
     */
    is245Asset(ticker) {
        return ticker === 'EURUSD=X' || ticker === 'GC=F';
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

        // Indices européens (CAC 40, EURO STOXX 50)
        if (ticker === '^FCHI' || ticker === '^STOXX50E') {
            if (hour >= 7 && hour < 9) return 'PRE_MARKET';
            if (hour >= 9 && hour < 17) return 'MARKET_OPEN';
            if (hour === 17 && minutes < 30) return 'MARKET_OPEN';
            return 'POST_MARKET';
        }

        // Indices US (S&P 500, NASDAQ)
        if (ticker === '^GSPC' || ticker === '^IXIC') {
            if (hour >= 10 && hour < 15) return 'PRE_MARKET';
            if (hour === 15 && minutes >= 30) return 'MARKET_OPEN';
            if (hour >= 16 && hour < 22) return 'MARKET_OPEN';
            return 'POST_MARKET';
        }

        return 'POST_MARKET';
    }

    /**
     * Calcule la variation intelligente selon le statut du marché
     * @returns {Object} { variation, variationPct, referencePrice, label, statusIcon }
     */
    getSmartVariation(ticker, currentPrice, previousClose, lastTradingDayClose) {
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
                label = 'LIVE';
                statusIcon = '🟢'; // Icône marché ouvert
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
                `<option value="${asset.name}" ${this.selectedAssetFilter === asset.name ? 'selected' : ''}>${asset.ticker} - ${asset.name}</option>`
            ).join('');
    }

    // --- FONCTIONS OBSOLÈTES SUPPRIMÉES ---
    // updateDayChangeFromGraph et updateTotalValueFromGraph ne sont plus nécessaires
    // et leur absence est corrigée par la nouvelle implémentation de mockPageInterface.renderData

    setupEventListeners() {
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

    handleContextAnalysis() {
        const contextBox = document.getElementById('modal-news-context');
        const contextContent = document.getElementById('modal-context-content');
        if (!contextBox || !contextContent) return;

        const newsItem = this.currentModalNewsItem;
        const currentSummary = this.currentGeminiSummary;

        if (!newsItem || !currentSummary) {
            contextContent.innerHTML = 'Impossible de trouver le résumé principal.';
            contextBox.style.display = 'block';
            setTimeout(() => contextBox.classList.add('show'), 10);
            return;
        }

        if (contextBox.style.display === 'block') {
            contextBox.classList.remove('show');
            setTimeout(() => contextBox.style.display = 'none', 300);
            return;
        }

        contextBox.style.display = 'block';
        contextBox.classList.remove('show');
        contextContent.innerHTML = '<span class="loading-text">Gemini contextualise...</span>';
        setTimeout(() => contextBox.classList.add('show'), 10);

        this.fetchGeminiContext(newsItem.title, currentSummary)
            .then(contextSummary => { contextContent.innerHTML = contextSummary; })
            .catch(() => { contextContent.innerHTML = "Échec de l'analyse contextuelle."; });
    }

    initHistoricalChart() {
        try {
            if (this.chart && this.chart.chart) this.chart.chart.destroy();

            const mockInvestmentsPage = {
                filterManager: this.mockPageInterface.filterManager,
                currentSearchQuery: this.mockPageInterface.currentSearchQuery,
                currentAssetTypeFilter: this.mockPageInterface.currentAssetTypeFilter,
                currentBrokerFilter: this.mockPageInterface.currentBrokerFilter,
                getChartTitleConfig: this.mockPageInterface.getChartTitleConfig,
                renderData: this.mockPageInterface.renderData
            };

            this.chart = new HistoricalChart(this.storage, this.dataManager, null, mockInvestmentsPage);

            // Bind events for BOTH desktop and mobile buttons
            const allPeriodBtns = document.querySelectorAll('.chart-controls-inline .period-btn, .chart-controls-bottom-mobile .period-btn');
            if (allPeriodBtns.length > 0) {
                allPeriodBtns.forEach(btn => {
                    const newBtn = btn.cloneNode(true);
                    btn.parentNode.replaceChild(newBtn, btn);
                    newBtn.addEventListener('click', (e) => {
                        // Update active state on ALL buttons (desktop & mobile) to keep them in sync
                        document.querySelectorAll('.period-btn').forEach(b => {
                            if (b.dataset.period === e.target.dataset.period) {
                                b.classList.add('active');
                            } else {
                                b.classList.remove('active');
                            }
                        });

                        this.chart.currentPeriod = parseInt(e.target.dataset.period);
                        this.chart.update(true, true);
                    });
                });
            }

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
            this.chart.update(true, true);
        } catch (e) { console.error("Erreur init graph:", e); }
    }

    async loadPortfolioData() {
        try {
            const purchases = this.storage.getPurchases();
            if (purchases.length === 0) {
                const zeroSummary = { totalCurrentEUR: 0, totalInvestedEUR: 0, gainTotal: 0, gainPct: 0, totalDayChangeEUR: 0, dayChangePct: 0, movementsCount: 0, assetsCount: 0 };
                this.renderKPIs(zeroSummary, 0, []);
                this.renderAllocation([], 0);
                this.ui.updatePortfolioSummary(zeroSummary, 0, 0, null);
                return;
            }

            const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
            await this.api.fetchBatchPrices(tickers);

            const assetPurchases = purchases.filter(p => {
                const type = (p.assetType || 'Stock').toLowerCase();
                return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend';
            });
            const cashPurchases = purchases.filter(p => {
                const type = (p.assetType || 'Stock').toLowerCase();
                return type === 'cash' || type === 'dividend' || p.type === 'dividend';
            });

            // [MODIFICATION] Pré-calculer les clôtures veille alignées sur le graphique pour cohérence P&L
            const yesterdayCloseMap = await this.dataManager.calculateAllAssetsYesterdayClose(assetPurchases);

            const holdings = this.dataManager.calculateHoldings(assetPurchases, yesterdayCloseMap);
            const summary = this.dataManager.calculateSummary(holdings);
            const cashReserve = this.dataManager.calculateCashReserve(cashPurchases);

            // NE PAS mettre à jour les KPI ici - le graphique s'en chargera avec les données historiques
            // pour éviter d'afficher des valeurs incorrectes qui seront écrasées
            // this.ui.updatePortfolioSummary(summary, summary.movementsCount, cashReserve.total, this.marketStatus);

            // NOTE: renderKPIs s'occupe des cartes secondaires (Top Gainer, Top Loser, Allocation)
            this.renderKPIs(summary, cashReserve.total, holdings);
            this.renderAllocation(holdings, summary.totalCurrentEUR);

        } catch (error) { console.error("Erreur chargement portfolio:", error); }
    }

    renderAllocation(holdings, totalValue) {
        const container = document.getElementById('dashboard-allocation-container');
        if (!container || totalValue === 0) {
            container.innerHTML = '<div style="color:var(--text-muted); font-size:12px; text-align:center; padding: 20px;">No asset data available.</div>';
            return;
        }

        const categories = {
            'ETF': { value: 0, color: '#10b981', label: 'ETF' },
            'Stock': { value: 0, color: '#3b82f6', label: 'Actions' },
            'Crypto': { value: 0, color: '#f59e0b', label: 'Cryptos' },
            'Other': { value: 0, color: '#6b7280', label: 'Autres' }
        };

        holdings.forEach(h => {
            let type = h.assetType;
            if (!categories[type]) type = 'Other';
            categories[type].value += h.currentValue;
        });

        const data = Object.values(categories)
            .filter(c => c.value > 0.01) // Filtrer les valeurs négligeables
            .map(c => ({ ...c, pct: (c.value / totalValue) * 100 }))
            .sort((a, b) => b.value - a.value);

        if (data.length === 0) {
            container.innerHTML = '<div style="color:var(--text-muted); font-size:12px; text-align:center; padding: 20px;">No valuable assets found for allocation.</div>';
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
        // NOTE: Les 3 cartes principales (Total Value, Return, Var Today) sont mises à jour ailleurs.

        // --- 1. Nettoyage des anciennes KPIs (Top Gainer, Top Loser, Top Holdings) ---
        const topGainers = [...holdings].sort((a, b) => b.gainPct - a.gainPct).slice(0, 3);
        this.injectListIntoCard('dashboard-top-gainer-name', topGainers, 'gainer');

        const topLosers = [...holdings].sort((a, b) => a.gainPct - b.gainPct).slice(0, 3);
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
            let valueHTML = type === 'asset'
                ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(item.currentValue)
                : (item.gainPct > 0 ? '+' : '') + item.gainPct.toFixed(2) + '%';
            let valueColor = type === 'asset' ? 'text-primary' : (item.gainPct >= 0 ? 'stat-positive' : 'stat-negative');
            let subValueHTML = item.currentPrice ? item.currentPrice.toFixed(2) + ' €' : '';

            listHTML += `
                <div class="kpi-list-row">
                    <div class="kpi-row-left">
                        <span class="kpi-row-name" title="${item.name}">${item.name}</span>
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

        try {
            const response = fetch(url, { signal: AbortSignal.timeout(4000) });
            return response
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
                });

        } catch (e) {
            console.warn(`Échec Fetch RSS pour "${query}":`, e);
            return Promise.resolve([]);
        }
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
                        <span class="news-ticker-tag" style="background-color: ${sourceColor}; color: white;">${n.source}</span>
                        <span>${formattedDate}</span>
                    </div>
                    <div class="news-title-compact">${n.title}</div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.news-item-compact').forEach(item => {
            item.addEventListener('click', () => {
                const idx = item.dataset.index;
                const dataType = item.dataset.type;
                const data = dataType === 'portfolio' ? this.portfolioNews[idx] : this.globalNews[idx];
                console.log('[News Click] Opening modal for:', data?.title);
                console.log('[News Click] openNewsModal exists?', typeof this.openNewsModal);
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
            summaryDiv.innerHTML = summary;
        } catch (error) {
            console.error('[openNewsModal] Error:', error);
            summaryDiv.innerHTML = "Analyse indisponible (Erreur API).";
        }
    }

    getHoldingDetailsForNews(newsItem) {
        const allPurchases = this.storage.getPurchases().filter(p => p.assetType !== 'Cash');
        const allHoldings = this.dataManager.calculateHoldings(allPurchases);

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
            .then(contextSummary => { contextContent.innerHTML = contextSummary; })
            .catch(() => { contextContent.innerHTML = "Échec de l'analyse contextuelle."; });
    }

    async fetchGeminiContext(title, summary) {
        if (!GEMINI_API_KEY || GEMINI_API_KEY.length < 20) return `<strong>Mode Démo :</strong> Clé API manquante.`;
        const cleanText = (text) => (typeof text !== 'string' ? '' : text.replace(/'/g, "\\'").replace(/"/g, '\\"'));

        const prompt = `Agis comme un analyste financier chevronné. En te basant sur ce résumé, explique en 1 à 3 phrases l'impact potentiel (opportunité ou risque) de cette nouvelle sur l'actif concerné.\nTitre: "${cleanText(title)}"\nRésumé: "${cleanText(summary)}"`;

        try {
            const response = await fetch(GEMINI_PROXY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: prompt })
            });
            if (response.ok) {
                const data = await response.json();
                if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
                    return data.candidates[0].content.parts[0].text.replace(/\n/g, '<br>');
                }
            }
        } catch (e) { console.warn(e); }
        return "Analyse indisponible.";
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
        } else if (container.children.length === 0) {
            container.innerHTML = '<div class="market-loading" style="padding:20px; text-align:center;">Loading...</div>';
        }

        const cdn = "https://cdn.jsdelivr.net/npm/openmoji@14.0.0/color/svg/";
        const indices = [
            { ticker: '^GSPC', name: 'S&P 500', icon: `${cdn}1F1FA-1F1F8.svg` },
            { ticker: '^IXIC', name: 'NASDAQ 100', icon: `${cdn}1F4BB.svg` },
            { ticker: '^FCHI', name: 'CAC 40', icon: `${cdn}1F1EB-1F1F7.svg` },
            { ticker: '^STOXX50E', name: 'EURO STOXX 50', icon: `${cdn}1F1EA-1F1FA.svg` },
            { ticker: 'BTC-EUR', name: 'BITCOIN', icon: '₿' },
            { ticker: 'GC=F', name: 'OR (GOLD)', icon: `${cdn}1FA99.svg` },
            { ticker: 'EURUSD=X', name: 'EUR / USD', icon: `${cdn}1F4B1.svg` }
        ];

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
                        lastUpdate: Date.now()
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
                        lastTradingDayClose: cached.previousClose, // Best guess
                        marketState: 'CLOSED'
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

            const currentPrice = dashboardData ? dashboardData.price : 0;
            const apiPreviousClose = dashboardData ? dashboardData.previousClose : 0;
            const lastTradingDayClose = dashboardData ? dashboardData.lastTradingDayClose : 0;

            let sparklineBg = '';

            // 2. Utiliser directement apiPreviousClose qui contient J-1 (calculé dans api.js)
            const referenceClose = apiPreviousClose || currentPrice;

            // Debug: vérifier 
            console.log(`[Card ${idx.ticker}] price: ${currentPrice}, apiPreviousClose: ${apiPreviousClose}, Ref: ${referenceClose}`);

            // NOUVELLE LOGIQUE : Variation intelligente
            const smartVar = this.getSmartVariation(
                idx.ticker,
                currentPrice,
                referenceClose,
                lastTradingDayClose || referenceClose
            );

            const change = smartVar.variation;
            const pct = smartVar.variationPct;
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

            // Formatage prix - CORRECTION: € uniquement pour BTC, pas pour les indices
            let priceStr, changeDecimals = 2;
            if (idx.ticker.includes('BTC')) {
                priceStr = Math.round(currentPrice).toLocaleString('fr') + ' €';
            } else if (idx.ticker === 'EURUSD=X' || idx.ticker === 'GC=F') {
                priceStr = currentPrice.toFixed(4);
                changeDecimals = 4;
            } else {
                // Indices (^GSPC, ^IXIC, ^FCHI, ^STOXX50E) : afficher les points sans €
                priceStr = currentPrice.toFixed(2).toLocaleString('fr');
            }

            const changeStr = `${change >= 0 ? '+' : ''}${change.toFixed(changeDecimals)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
            const changeClass = change >= 0 ? 'stat-positive' : 'stat-negative';

            // Extraire les KPIs depuis indexData
            let kpiHTML = '';
            if (indexData && indexData.values && indexData.values.length > 0) {
                // STATS (DEBUT/FIN/HAUT/BAS) DÉSACTIVÉES SUR DEMANDE UTILISATEUR
                // kpiHTML = ...
            }

            // Utiliser statusColor basé sur la variation
            const statusColor = change >= 0 ? '#10b981' : change < 0 ? '#ef4444' : '#9fa6bc';

            // Icône normalisée (Conteneur fixe pour éviter les décalages de hauteur sur BTC)
            const iconContent = idx.icon.includes('http')
                ? `<img src="${idx.icon}" alt="" style="width:100%; height:100%; object-fit:contain; filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5));">`
                : `<span style="font-size:24px; line-height:1; filter:drop-shadow(0 1px 3px rgba(0,0,0,0.6)); display:flex; align-items:center; justify-content:center; height:100%; width:100%;">${idx.icon}</span>`;

            const iconHTML = `<div style="width:26px; height:26px; display:flex; align-items:center; justify-content:center;">${iconContent}</div>`;

            const innerHTMLStructure = `
				${sparklineBg}
				<div style="position:relative; z-index:2; display:flex; justify-content:space-between; align-items:flex-start;">
					<span style="font-weight:600; font-size:13px; color:#e2e8f0; line-height:1.3;">${idx.name}</span>
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

            // Restauration de la surbrillance si c'était la carte active
            if (wasActive) {
                cardElement.classList.add('active-index');
            }

            // Event listener (toujours à jour)
            cardElement.onclick = () => {
                document.querySelectorAll('.market-card').forEach(c => c.classList.remove('active-index'));
                cardElement.classList.add('active-index');

                this.api.fetchBatchPrices([targetTicker], true); // Use targetTicker (Futures if applicable)
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
    }

    refreshDashboard() {
        this.loadPortfolioData();
        if (this.chart) this.chart.update(false, true);
        this.loadMarketIndices();
    }
}

document.addEventListener('DOMContentLoaded', () => new DashboardApp());