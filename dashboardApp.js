// benderrobot/asset_tracker/asset_tracker-52109016fe138d6ac9b283096e2de3cfbb9437bb/dashboardApp.js

// ========================================
// dashboardApp.js - VERSION CORRIGÉE FINALE (Unification + Fix Erreur Critique)
// ========================================
import { Storage } from './storage.js';                   
import { PriceAPI } from './api.js?v=4';               
import { MarketStatus } from './marketStatus.js?v=2';  
import { DataManager } from './dataManager.js?v=7';     
import { HistoricalChart } from './historicalChart.js?v=9'; 
import { fetchGeminiSummary, fetchGeminiContext } from './geminiService.js';
import { UIComponents } from './ui.js'; // <-- IMPORT UIComponents AJOUTÉ

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
        this.ui = new UIComponents(this.storage); // <-- INSTANCIATION NÉCESSAIRE

        this.mockPageInterface = {
            filterManager: { getSelectedTickers: () => new Set() },
            currentSearchQuery: '',
            currentAssetTypeFilter: '',
            currentBrokerFilter: '',
            getChartTitleConfig: () => ({ mode: 'global', label: 'Global Portfolio', icon: 'Chart' }),
            renderData: (holdings, summary, cash) => {
                if (summary) {
                    // CORRECTION: Utilise la méthode unifiée de ui.js pour mettre à jour les 3 cartes principales
                    // La variable 'summary.movementsCount' n'est pas nécessaire ici, on passe 0 si elle n'existe pas.
                    this.ui.updatePortfolioSummary(summary, summary.movementsCount || 0, cash, this.marketStatus);
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

    renderAssetSelect() {
        const selectEl = document.getElementById('portfolio-asset-select');
        if (!selectEl) return;

        const purchases = this.storage.getPurchases();
        const uniqueAssets = [...new Set(purchases.filter(p => p.assetType !== 'Cash').map(p => ({ ticker: p.ticker, name: p.name })))];
        
        const assetMap = new Map();
        uniqueAssets.forEach(a => assetMap.set(a.name, {ticker: a.ticker, name: a.name}));
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

            const btns = document.querySelectorAll('.chart-controls-inline .period-btn');
            if (btns.length > 0) {
                btns.forEach(btn => {
                    const newBtn = btn.cloneNode(true);
                    btn.parentNode.replaceChild(newBtn, btn);
                    newBtn.addEventListener('click', (e) => {
                        document.querySelectorAll('.chart-controls-inline .period-btn').forEach(b => b.classList.remove('active'));
                        e.target.classList.add('active');
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
                 this.ui.updatePortfolioSummary(zeroSummary, 0, 0, this.marketStatus);
                 return;
            }

            const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
            await this.api.fetchBatchPrices(tickers);

            const assetPurchases = purchases.filter(p => p.assetType !== 'Cash');
            const cashPurchases = purchases.filter(p => p.assetType === 'Cash');

            const holdings = this.dataManager.calculateHoldings(assetPurchases);
            const summary = this.dataManager.calculateSummary(holdings);
            const cashReserve = this.dataManager.calculateCashReserve(cashPurchases);

            // CORRECTION: Utiliser l'UI unifiée pour les 3 cartes principales (évite les 0.00 après chargement)
            this.ui.updatePortfolioSummary(summary, summary.movementsCount, cashReserve.total, this.marketStatus);
            
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
        const modal = document.getElementById('news-modal');
        if (!modal) return;

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
        document.getElementById('modal-news-link').href = newsItem.link || '#';

        const summaryDiv = document.getElementById('modal-news-summary');
        summaryDiv.innerHTML = '<span class="loading-text">Gemini analyse...</span>';

        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('show'), 10);

        try {
            const description = newsItem.fullDescription || '';
            const context = `${newsItem.title}. Sujet: ${newsItem.name}.`;
            
            // UTILISATION DU SERVICE CENTRALISÉ
            const summary = await fetchGeminiSummary(context); 
            
            this.currentGeminiSummary = summary;
            summaryDiv.innerHTML = summary;
        } catch (error) {
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

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
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

    // benderrobot/asset_tracker/asset_tracker-52109016fe138d6ac9b283096e2de3cfbb9437bb/dashboardApp.js

async loadMarketIndices() {
    const container = document.getElementById('market-overview-container');
    if (!container) return;

    // CORRECTION: Retirer le texte de chargement initial si présent
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

    const fragment = document.createDocumentFragment();

    for (const idx of indices) {
        const data = this.storage.getCurrentPrice(idx.ticker) || {};
        
        // CORRECTION 1: INITIALISER sparklineBg ici pour éviter la ReferenceError
        let sparklineBg = ''; 
        
        // CORRECTION: Utiliser la dernière clôture si le prix actuel est nul
        const currentPrice = data.price || data.previousClose || 0; 
        const previousClose = data.previousClose || currentPrice;
        
        const price = currentPrice;
        const validPrev = (previousClose === 0) ? price : previousClose;
        
        const change = price - validPrev;
        const pct = validPrev ? (change / validPrev) * 100 : 0;

        // DÉTERMINATION DE LA CLASSE ET COULEUR PRINCIPALE (Rouge/Vert/Neutre)
        let indicatorColor;
        if (change > 0) indicatorColor = '#10b981';
        else if (change < 0) indicatorColor = '#ef4444';
        else indicatorColor = '#9fa6bc'; // Couleur neutre

        const statusClass = change >= 0 ? 'stat-positive' : 'stat-negative'; 
        
        // CORRECTION FORMATTAGE: Assure le bon nombre de décimales pour les paires
        let priceStr;
        let changeDecimals = 2; // Décimales pour la variation
        if (idx.ticker.includes('BTC')) {
            priceStr = Math.round(price).toLocaleString('fr') + ' €';
        } else if (idx.ticker === 'EURUSD=X') {
            priceStr = price.toFixed(4); // 4 décimales pour les devises
            changeDecimals = 4; 
        } else if (idx.ticker === 'GC=F' || idx.ticker === '^STOXX50E') {
            priceStr = price.toFixed(2).toLocaleString('fr');
        } else {
            priceStr = price.toFixed(2).toLocaleString('fr') + ' €';
        }
        
        const changeStr = `${change >= 0 ? '+' : ''}${change.toFixed(changeDecimals)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
        const changeClass = change >= 0 ? 'stat-positive' : 'stat-negative';
        const assetStatus = this.marketStatus.getAssetStatus(idx.ticker);
        const statusLabel = assetStatus.label;
        const statusColor = assetStatus.color;

        // ————— SPARKLINE EN FOND —————
        try { // Ce bloc est safe car sparklineBg est initialisé au-dessus
            const hist = await this.api.getHistoricalPricesWithRetry(
                idx.ticker,
                Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000),
                Math.floor(Date.now() / 1000),
                '5m'
            );
            const values = Object.values(hist);

            if (values.length > 5) {
                const min = Math.min(...values);
                const max = Math.max(...values);
                const range = max - min || 1;

                const points = values
                    .map((v, i) => {
                        const x = (i / (values.length - 1)) * 100;
                        const y = 88 - ((v - min) / range) * 70;
                        return `${x},${y}`;
                    })
                    .join(' ');

                const color = indicatorColor; // Utilise la couleur principale (Rouge/Vert)
                const gradId = `grad-${idx.ticker.replace(/[^a-z]/gi, '')}`;

                sparklineBg = `
                    <div style="position:absolute; inset:0; opacity:0.38; pointer-events:none; overflow:hidden; border-radius:12px;">
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%; height:100%;">
                            <defs>
                                <linearGradient id="${gradId}" x1="0%" y1="100%" x2="0%" y2="0%">
                                    <stop offset="0%"   stop-color="${color}" stop-opacity="0.7"/>
                                    <stop offset="60%"  stop-color="${color}" stop-opacity="0.25"/>
                                    <stop offset="100%" stop-color="${color}" stop-opacity="0.05"/>
                                </linearGradient>
                            </defs>
                            <polyline fill="none" stroke="${color}" stroke-width="1.6" points="${points}"/>
                            <polygon fill="url(#${gradId})" points="${points},100,100,100,0"/>
                        </svg>
                    </div>`;
            }
        } catch (e) {
            // Sparkline échouée
        }

        // ————— ICÔNE & STRUCTURE INTERNE —————
        const iconHTML = idx.icon.includes('http')
            ? `<img src="${idx.icon}" alt="" style="width:26px; height:26px; object-fit:contain; filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5));">`
            : `<span style="font-size:28px; filter:drop-shadow(0 1px 3px rgba(0,0,0,0.6));">${idx.icon}</span>`;

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
                        ${statusLabel}
                    </span>
                </div>
            </div>
        `;
        
        const cardId = `market-card-${idx.ticker.replace(/[^a-zA-Z0-9]/g, '-')}`;
        let cardElement = document.getElementById(cardId);
        
        if (!cardElement) {
            // --- CRÉATION INITIALE ---
            cardElement = document.createElement('div');
            cardElement.id = cardId;
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
            `;
            fragment.appendChild(cardElement);

            // Attacher le listener au moment de la création
            cardElement.onclick = async () => {
                document.querySelectorAll('.market-card').forEach(c => c.classList.remove('active-index'));
                cardElement.classList.add('active-index');

                await this.api.fetchBatchPrices([idx.ticker], true);

                if (this.chart) {
                    this.chart.showIndex(idx.ticker, idx.name);
                }

                if (window.innerWidth < 768) {
                    document.querySelector('.dashboard-chart-section')?.scrollIntoView({ behavior: 'smooth' });
                }
            };
        }
        
        // --- MISE À JOUR DU CONTENU, DU BORD ET DES CLASSES ---
        const isActive = cardElement.classList.contains('active-index');
        
        // 1. Appliquer la classe de statut (stat-negative/positive) à la carte
        cardElement.className = `market-card ${statusClass}`;

        // 2. Mise à jour du style de la bordure et de l'ombre (couleur dynamique)
        cardElement.style.border = `1px solid ${indicatorColor}50`;
        cardElement.style.boxShadow = `0 0 10px ${indicatorColor}10`; 
        
        // 3. Mise à jour du contenu et préservation de l'état actif
        cardElement.innerHTML = innerHTMLStructure; 
        cardElement.classList.toggle('active-index', isActive);
        
        if (fragment.children.length > 0) {
            container.appendChild(fragment);
        }
	}
}
	refreshDashboard() {
        this.loadPortfolioData();
        if (this.chart) this.chart.update(false, true);
        this.loadMarketIndices();
    }
}

document.addEventListener('DOMContentLoaded', () => new DashboardApp());