// benderrobot/asset_tracker/asset_tracker-d2b20147fdbaa70dfad9c7d62d05505272e63ca2/dashboardApp.js

// ========================================
// dashboardApp.js - (Fix Allocation & Sparkline)
// ========================================

import { Storage } from './storage.js';
import { PriceAPI } from './api.js?v=4';
import { MarketStatus } from './marketStatus.js?v=2';
import { DataManager } from './dataManager.js?v=7';
import { HistoricalChart } from './historicalChart.js?v=9';

const GEMINI_API_KEY = "AIzaSyCSFjArNaC35wbZLLGXOlPEO4HJO7hN7pw"; 

class DashboardApp {
    constructor() {
        this.storage = new Storage();
        this.api = new PriceAPI(this.storage);
        this.marketStatus = new MarketStatus(this.storage);
        this.dataManager = new DataManager(this.storage, this.api);
        
        this.mockPageInterface = {
            filterManager: { getSelectedTickers: () => new Set() },
            currentSearchQuery: '',
            currentAssetTypeFilter: '',
            currentBrokerFilter: '',
            getChartTitleConfig: () => ({ mode: 'global', label: 'Global Portfolio', icon: '📈' }),
            
            renderData: (holdings, summary, cash) => {
                if (summary) {
                    this.updateDayChangeFromGraph(summary.totalDayChangeEUR, summary.dayChangePct);
                    this.updateTotalValueFromGraph(summary.totalCurrentEUR, cash);
                }
            } 
        };

        this.chart = null;
        this.corsProxies = [
            'https://api.allorigins.win/raw?url=',
            'https://corsproxy.io/?',
            'https://api.codetabs.com/v1/proxy?quest='
        ];

        this.init();
    }

    async init() {
        console.log('🚀 Dashboard Init...');
        this.marketStatus.startAutoRefresh('market-status-container', 'compact');
        await this.loadPortfolioData();
        setTimeout(() => this.initHistoricalChart(), 50);
        this.loadPortfolioNews();
        this.loadGlobalNews();
        this.loadMarketIndices();
        setInterval(() => this.refreshDashboard(), 5 * 60 * 1000);
        this.setupEventListeners();
    }

    updateDayChangeFromGraph(amount, percent) {
        const valEl = document.getElementById('dashboard-day-change');
        const pctEl = document.getElementById('dashboard-day-change-pct');
        
        if (valEl && pctEl) {
            const valFormatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(amount);
            const sign = amount > 0 ? '+' : '';
            const pctFormatted = `${sign}${percent.toFixed(2)}%`;
            
            valEl.textContent = valFormatted;
            pctEl.textContent = pctFormatted;
            
            const colorClass = amount >= 0 ? 'stat-positive' : 'stat-negative';
            pctEl.className = 'kpi-change-pct ' + colorClass;
        }
    }

    updateTotalValueFromGraph(assetValue, cashValue) {
        const el = document.getElementById('dashboard-total-value');
        if (el) {
            const total = (assetValue || 0) + (cashValue || 0);
            el.textContent = new Intl.NumberFormat('en-US', { 
                style: 'currency', 
                currency: 'EUR' 
            }).format(total);
        }
    }

    setupEventListeners() {
        const closeBtn = document.getElementById('close-news-modal');
        const modal = document.getElementById('news-modal');
        const refreshPortfolioBtn = document.getElementById('refresh-portfolio-news');

        if (refreshPortfolioBtn) refreshPortfolioBtn.addEventListener('click', () => this.loadPortfolioNews());
        
        const closeModal = () => {
            if (modal) {
                modal.classList.remove('show');
                setTimeout(() => { modal.style.display = 'none'; }, 300);
            }
        };

        if(closeBtn) closeBtn.onclick = closeModal;
        if(modal) modal.onclick = (e) => { if(e.target === modal) closeModal(); };
    }

    initHistoricalChart() {
        try {
            if (this.chart && this.chart.chart) this.chart.chart.destroy();
            
            // Mock InvestmentsPage for HistoricalChart
            const mockInvestmentsPage = {
                filterManager: this.mockPageInterface.filterManager,
                currentSearchQuery: this.mockPageInterface.currentSearchQuery,
                currentAssetTypeFilter: this.mockPageInterface.currentAssetTypeFilter,
                currentBrokerFilter: this.mockPageInterface.currentBrokerFilter,
                getChartTitleConfig: this.mockPageInterface.getChartTitleConfig,
                renderData: this.mockPageInterface.renderData
            };

            this.chart = new HistoricalChart(this.storage, this.dataManager, null, mockInvestmentsPage); // Pass mock

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
            if (purchases.length === 0) return;
            
            const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
            await this.api.fetchBatchPrices(tickers);
            
            const assetPurchases = purchases.filter(p => p.assetType !== 'Cash');
            const cashPurchases = purchases.filter(p => p.assetType === 'Cash');
            
            const holdings = this.dataManager.calculateHoldings(assetPurchases);
            const summary = this.dataManager.calculateSummary(holdings);
            const cashReserve = this.dataManager.calculateCashReserve(cashPurchases);
            
            this.renderKPIs(summary, cashReserve.total, holdings);
            // === CORRECTION : La fonction est bien appelée ici ===
            this.renderAllocation(holdings, summary.totalCurrentEUR); 
        } catch (error) { console.error("Erreur chargement portfolio:", error); }
    }

    // === CORRECTION : RÉINTÉGRATION DE RENDER ALLOCATION ===
    renderAllocation(holdings, totalValue) {
        const container = document.getElementById('dashboard-allocation-container');
        if (!container || totalValue === 0) return;
        
        const categories = { 
            'ETF': { value: 0, color: '#10b981', label: 'ETF' }, 
            'Stock': { value: 0, color: '#3b82f6', label: 'Actions' }, 
            'Crypto': { value: 0, color: '#f59e0b', label: 'Cryptos' }, 
            'Other': { value: 0, color: '#6b7280', label: 'Autres' } 
        };
        
        holdings.forEach(h => { 
            let type = h.assetType; 
            if (type !== 'ETF' && type !== 'Stock' && type !== 'Crypto') type = 'Other'; 
            if (categories[type]) categories[type].value += h.currentValue; 
        });
        
        const data = Object.values(categories)
            .filter(c => c.value > 0)
            .map(c => ({ ...c, pct: (c.value / totalValue) * 100 }))
            .sort((a, b) => b.value - a.value);
            
        const fmt = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(v);
        
        let barHTML = '<div class="allocation-bar">';
        let listHTML = '<div class="allocation-list">';
        
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
        
        barHTML += '</div>'; 
        listHTML += '</div>';
        
        container.innerHTML = `<div class="allocation-wrapper">${barHTML}${listHTML}</div>`;
    }

    renderKPIs(data, cashTotal = 0, holdings = []) {
        const fmt = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(v);
        const pct = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
        const safeText = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
        const setClass = (id, val) => { const el = document.getElementById(id); if(el) el.className = 'kpi-change-pct ' + (val >= 0 ? 'stat-positive' : 'stat-negative'); };

        // 1. TOTAL VALUE
        safeText('dashboard-total-value', fmt(data.totalCurrentEUR + cashTotal));
        // AJOUT : Mise à jour du sous-titre "Invested"
        safeText('dashboard-invested-subtitle', `Invested: ${fmt(data.totalInvestedEUR)}`);

        // 2. TOTAL RETURN
        safeText('dashboard-total-return', fmt(data.gainTotal));
        safeText('dashboard-total-return-pct', pct(data.gainPct));
        setClass('dashboard-total-return-pct', data.gainPct);
        
        // 3. DAY CHANGE (Initial - sera écrasé par le graph plus tard, but utile pour le chargement)
        safeText('dashboard-day-change', fmt(data.totalDayChangeEUR));
        safeText('dashboard-day-change-pct', pct(data.dayChangePct));
        setClass('dashboard-day-change-pct', data.totalDayChangeEUR);

        // ... (Reste du code pour les listes Top Gainer/Loser inchangé) ...
        const topGainers = [...holdings].sort((a, b) => b.gainPct - a.gainPct).slice(0, 3);
        this.injectListIntoCard('dashboard-top-gainer-name', topGainers, 'gainer');

        const topLosers = [...holdings].sort((a, b) => a.gainPct - b.gainPct).slice(0, 3);
        this.injectListIntoCard('dashboard-top-loser-name', topLosers, 'loser');

        const topAssets = [...holdings].sort((a, b) => b.currentValue - a.currentValue).slice(0, 3);
        this.injectListIntoCard('dashboard-top-sector', topAssets, 'asset');
        
        const sectorTitle = document.getElementById('dashboard-top-sector')?.closest('.kpi-card')?.querySelector('.kpi-label');
        if(sectorTitle) sectorTitle.textContent = 'Top Holdings';
    }

    // === MODIFICATION : SUPPRESSION DES TICKERS ===
    injectListIntoCard(elementId, items, type) {
        const targetEl = document.getElementById(elementId);
        if (!targetEl) return;

        const card = targetEl.closest('.kpi-card');
        if (!card) return;

        const header = card.querySelector('.kpi-header');
        let listHTML = '<div class="kpi-list-container">';
        
        items.forEach(item => {
            let valueHTML = '';
            let subValueHTML = '';
            let valueColor = '';

            if (type === 'asset') {
                valueHTML = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(item.currentValue);
                valueColor = 'text-primary';
                subValueHTML = ''; 
            } else {
                valueHTML = (item.gainPct > 0 ? '+' : '') + item.gainPct.toFixed(2) + '%';
                valueColor = item.gainPct >= 0 ? 'stat-positive' : 'stat-negative';
                subValueHTML = item.currentPrice ? item.currentPrice.toFixed(2) + ' €' : '';
            }

            listHTML += `
                <div class="kpi-list-row">
                    <div class="kpi-row-left">
                        <span class="kpi-row-name" title="${item.name}" style="max-width: 140px; font-weight:600; font-size: 13px;">${item.name}</span>
                    </div>
                    <div class="kpi-row-right">
                        <div class="${valueColor}">${valueHTML}</div>
                        ${subValueHTML ? `<div class="kpi-sub-value">${subValueHTML}</div>` : ''}
                    </div>
                </div>
            `;
        });
        
        listHTML += '</div>';

        Array.from(card.children).forEach(child => {
            if (!child.classList.contains('kpi-header')) {
                child.remove();
            }
        });
        
        card.insertAdjacentHTML('beforeend', listHTML);
    }

    async loadPortfolioNews() {
        const container = document.getElementById('news-portfolio-container');
        if (!container) return;
        container.innerHTML = '<div style="padding:20px; text-align:center; color:#666"><i class="fas fa-circle-notch fa-spin"></i></div>';

        const purchases = this.storage.getPurchases();
        const uniqueNames = [...new Set(purchases.map(p => p.name))];

        if (uniqueNames.length === 0) {
            container.innerHTML = '<div style="padding:20px; text-align:center; color:#666">Aucun actif</div>';
            return;
        }

        const promises = [];
        const selected = uniqueNames.sort(() => 0.5 - Math.random()).slice(0, 4);
        selected.forEach(name => promises.push(this.fetchGoogleRSS(`${name} actualité financière`)));

        try {
            const results = await Promise.all(promises);
            const allNews = results.flat().sort((a, b) => b.datetime - a.datetime);
            this.portfolioNews = this.deduplicateNews(allNews).slice(0, 15);
            this.renderNewsList(container, this.portfolioNews, 'portfolio');
        } catch (e) {
            container.innerHTML = '<div style="padding:20px; text-align:center; color:#ef4444">Erreur</div>';
        }
    }

    async loadGlobalNews() {
        const container = document.getElementById('news-global-container');
        if (!container) return;
        container.innerHTML = '<div style="padding:20px; text-align:center; color:#666"><i class="fas fa-circle-notch fa-spin"></i></div>';

        const topics = ["Marchés Bourse Paris", "Wall Street économie", "Crypto Bitcoin actu", "Inflation BCE Fed"];
        const promises = topics.map(t => this.fetchGoogleRSS(t));

        try {
            const results = await Promise.all(promises);
            const allNews = results.flat().sort((a, b) => b.datetime - a.datetime);
            this.globalNews = this.deduplicateNews(allNews).slice(0, 15);
            this.renderNewsList(container, this.globalNews, 'global');
        } catch (e) {
            container.innerHTML = '<div style="padding:20px; text-align:center; color:#ef4444">Erreur</div>';
        }
    }

    async fetchGoogleRSS(query) {
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=fr&gl=FR&ceid=FR:fr`;
        for (const proxy of this.corsProxies) {
            try {
                const response = await fetch(proxy + encodeURIComponent(rssUrl), { signal: AbortSignal.timeout(3000) });
                if (response.ok) {
                    const str = await response.text();
                    const data = new window.DOMParser().parseFromString(str, "text/xml");
                    return Array.from(data.querySelectorAll("item")).slice(0, 3).map(item => {
                        const pubDate = item.querySelector("pubDate")?.textContent;
                        const fullTitle = item.querySelector("title")?.textContent || "";
                        const parts = fullTitle.split(" - ");
                        const source = parts.length > 1 ? parts.pop() : "Google";
                        return {
                            ticker: query.split(' ')[0].substring(0, 4).toUpperCase(),
                            name: query,
                            title: parts.join(" - "),
                            source: source,
                            url: item.querySelector("link")?.textContent,
                            datetime: pubDate ? new Date(pubDate).getTime() / 1000 : Date.now() / 1000
                        };
                    });
                }
            } catch (e) { }
        }
        return [];
    }

    renderNewsList(container, newsData, type) {
        if (newsData.length === 0) {
            container.innerHTML = '<div style="padding:20px; text-align:center; color:#666">Aucune news</div>';
            return;
        }
        container.innerHTML = newsData.map((n, i) => `
            <div class="news-item-compact" data-type="${type}" data-index="${i}">
                <div class="news-meta-row">
                    <span class="news-ticker-tag" style="color:${this.getColorFor(n.ticker)}">${n.ticker}</span>
                    <span>${this.timeSince(n.datetime)}</span>
                </div>
                <div class="news-title-compact">${n.title}</div>
            </div>
        `).join('');

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
        if(!modal) return;

        document.getElementById('modal-news-ticker').textContent = newsItem.ticker;
        document.getElementById('modal-news-ticker').style.backgroundColor = this.getColorFor(newsItem.ticker);
        document.getElementById('modal-news-title').textContent = newsItem.title;
        document.getElementById('modal-news-link').href = newsItem.url || '#';
        
        const summaryDiv = document.getElementById('modal-news-summary');
        summaryDiv.innerHTML = '<span class="loading-text">✨ Gemini analyse le marché...</span>';
        
        modal.style.display = 'flex';
        setTimeout(() => { modal.classList.add('show'); }, 10);

        try {
            const summary = await this.fetchGeminiSummary(newsItem.title, newsItem.name);
            summaryDiv.innerHTML = summary;
        } catch (error) {
            summaryDiv.innerHTML = "Analyse indisponible.";
        }
    }

    async fetchGeminiSummary(title, companyName) {
        if (!GEMINI_API_KEY || GEMINI_API_KEY.length < 20) {
            await new Promise(r => setTimeout(r, 500));
            return `<strong>Mode Démo :</strong> Clé API manquante.`;
        }

        const models = ['gemini-1.5-flash', 'gemini-pro'];
        const prompt = `Tu es un analyste financier. Résume cette news en français (max 2 phrases). Titre: "${title}". Sujet: ${companyName}`;

        for (const model of models) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
                });
                if (response.ok) {
                    const data = await response.json();
                    if (data.candidates && data.candidates[0].content) {
                        let text = data.candidates[0].content.parts[0].text;
                        return text.replace(/\n/g, '<br>').replace(/\*\*/g, '');
                    }
                }
            } catch (e) { console.warn(e); }
        }
        return "IA indisponible.";
    }

    timeSince(timestamp) {
        const seconds = Math.floor((new Date() - (timestamp * 1000)) / 1000);
        let interval = seconds / 3600;
        if (interval > 1) return Math.floor(interval) + "h";
        interval = seconds / 60;
        if (interval > 1) return Math.floor(interval) + "m";
        return "Now";
    }

    getColorFor(ticker) {
        const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
        let hash = 0;
        if (!ticker) return colors[0];
        for (let i = 0; i < ticker.length; i++) hash = ticker.charCodeAt(i) + ((hash << 5) - hash);
        return colors[Math.abs(hash) % colors.length];
    }

    // DANS dashboardApp.js

    // ============================================================
    // CHARGEMENT ET AFFICHAGE DES INDICES (Interactive & Précise)
    // ============================================================
    async loadMarketIndices() {
        const container = document.getElementById('market-overview-container');
        if (!container) return;
        
        // URL de base pour les émojis (Drapeaux et symboles)
        const cdnBase = "https://cdn.jsdelivr.net/npm/openmoji@14.0.0/color/svg/";

        const indices = [
            { ticker: '^GSPC', name: 'S&P 500', icon: `<img src="${cdnBase}1F1FA-1F1F8.svg" alt="US">` },
            { ticker: '^IXIC', name: 'NASDAQ 100', icon: `<img src="${cdnBase}1F4BB.svg" alt="Tech">` },
            { ticker: '^FCHI', name: 'CAC 40', icon: `<img src="${cdnBase}1F1EB-1F1F7.svg" alt="FR">` },
            { ticker: '^STOXX50E', name: 'EURO STOXX 50', icon: `<img src="${cdnBase}1F1EA-1F1FA.svg" alt="EU">` },
            { ticker: 'BTC-EUR', name: 'BITCOIN', icon: '₿' }, 
            { ticker: 'GC=F', name: 'OR (GOLD)', icon: `<img src="${cdnBase}1FA99.svg" alt="Gold">` },
            { ticker: 'EURUSD=X', name: 'EUR / USD', icon: `<img src="${cdnBase}1F4B1.svg" alt="Forex">` }
        ];

        // 1. Récupération des données et des données HISTORIQUES 1D (intervalle 5m)
        try {
            await this.api.fetchBatchPrices(indices.map(i => i.ticker));
            
            // Récupérer l'historique 1D pour tous les indices
            const historyPromises = indices.map(idx => {
                // Pour les indices, on utilise une période de 1 jour avec un intervalle de 5m
                const today = new Date();
                const endTs = Math.floor(today.getTime() / 1000);
                const startTs = endTs - (24 * 60 * 60) - (2 * 60 * 60); // 1D + buffer
                
                return this.dataManager.api.getHistoricalPricesWithRetry(idx.ticker, startTs, endTs, '5m');
            });
            const allHistory = await Promise.all(historyPromises);
            
            indices.forEach((idx, i) => {
                idx.history = allHistory[i];
            });
            
        } catch (e) { console.warn("Erreur fetch indices", e); }

        // 2. Nettoyage avant remplissage
        container.innerHTML = '';
        
        // 3. Récupération du statut global (Heure/Weekend)
        const marketStatus = this.marketStatus.getStatus();

        // 4. Boucle de création des cartes
        indices.forEach(idx => {
            const data = this.storage.getCurrentPrice(idx.ticker);
            
            // -- Variables d'affichage par défaut --
            let priceDisplay = '--'; 
            let changeDisplay = '--'; 
            let changeClass = 'neutral'; 
            let assetStatus = marketStatus.shortLabel; 
            let dotColor = marketStatus.color;
            let chartLineHTML = ''; // <-- NOUVEAU
            
            // ... (Logique de Statut Spécifique par Actif - inchangée) ...
            if (idx.ticker.includes('BTC')) {
                assetStatus = '24/7';
                dotColor = '#10b981'; // Vert
            } else if (idx.ticker.includes('=X')) {
                if (marketStatus.state === 'CLOSED') { assetStatus = 'Fermé'; dotColor = '#fbbf24'; } else { assetStatus = 'En direct'; dotColor = '#10b981'; }
            } else if (idx.ticker === '^GSPC' || idx.ticker === '^IXIC') {
                if (marketStatus.state === 'CLOSED') { assetStatus = 'Clôture'; dotColor = '#fbbf24'; } else if (marketStatus.state === 'OPEN_US') { assetStatus = 'En direct'; dotColor = '#10b981'; } else { assetStatus = 'Futures'; dotColor = '#8b5cf6'; }
            } else if (idx.ticker === '^FCHI' || idx.ticker === '^STOXX50E') {
                if (marketStatus.state === 'OPEN') { assetStatus = 'En direct'; dotColor = '#10b981'; } else { assetStatus = 'Clôture'; dotColor = '#fbbf24'; }
            }

            // -- Formatage des Prix --
            if (data && data.price) {
                const price = data.price;
                const prev = data.previousClose || price;
                const change = price - prev;
                const pct = (change / prev) * 100;
                
                let currencySymbol = '';
                if (idx.ticker.includes('BTC')) currencySymbol = ' €';
                else if (idx.ticker === 'GC=F' || idx.ticker === 'EURUSD=X') currencySymbol = ' $';
                
                // 4 décimales pour le Forex, 2 pour le reste
                const digits = idx.ticker.includes('=X') ? 4 : 2;
                
                priceDisplay = price.toLocaleString('en-US', { 
                    minimumFractionDigits: digits, 
                    maximumFractionDigits: digits 
                }) + currencySymbol;
                
                const sign = change >= 0 ? '+' : '';
                changeDisplay = `${sign}${change.toFixed(digits)} (${sign}${pct.toFixed(2)}%)`;
                changeClass = change >= 0 ? 'stat-positive' : 'stat-negative';
            }
            
            // -- NOUVEAU : Calcul des points du Sparkline --
            if (idx.history && Object.keys(idx.history).length > 1) {
                const prices = Object.values(idx.history).map(v => parseFloat(v));
                
                if (prices.length > 0) {
                    const min = Math.min(...prices);
                    const max = Math.max(...prices);
                    const range = max - min;
                    const normalized = prices.map(p => range > 0 ? (p - min) / range : 0.5); // Normalisation [0, 1]
                    
                    // On utilise SVG pour le sparkline (plus performant que Chart.js pour 7 cartes)
                    const svgWidth = 100; // Largeur fixe
                    const svgHeight = 30; // Hauteur fixe
                    const points = normalized.map((n, i) => {
                        const x = (i / (normalized.length - 1)) * svgWidth;
                        const y = svgHeight - (n * svgHeight); // Inverser l'axe Y
                        return `${x},${y}`;
                    }).join(' ');

                    const strokeColor = changeClass === 'stat-positive' ? '#10b981' : '#ef4444';
                    
                    chartLineHTML = `
                        <div class="market-chart-mini" style="height: 30px; margin-top: 8px;">
                            <svg viewBox="0 0 ${svgWidth} ${svgHeight}" preserveAspectRatio="none" style="width: 100%; height: 100%;">
                                <polyline fill="none" 
                                          stroke="${strokeColor}" 
                                          stroke-width="1.5" 
                                          points="${points}" />
                            </svg>
                        </div>
                    `;
                }
            }


            // -- Création de l'élément DOM (Carte) --
            const card = document.createElement('div');
            card.className = 'market-card';
            
            // On ajoute le HTML interne
            card.innerHTML = `
                
                ${chartLineHTML} <div class="market-header">
                    <span class="market-name">${idx.name}</span>
                    <span class="market-icon">${idx.icon}</span>
                </div>
                
                <div class="market-price">${priceDisplay}</div>
                
                <div class="market-change-row" style="display:flex; justify-content:space-between; width:100%; align-items:center; margin-top:4px;">
                    <span class="${changeClass}" style="font-size:12px;">${changeDisplay}</span>
                    
                    <span style="
                        font-size: 9px; 
                        color: ${dotColor}; 
                        border: 1px solid ${dotColor}; 
                        padding: 2px 6px; 
                        border-radius: 4px; 
                        background: rgba(255,255,255,0.05);
                        text-transform: uppercase;
                        font-weight: 600;
                        letter-spacing: 0.3px;
                    ">
                        ${assetStatus}
                    </span>
                </div>
            `;

            // -- INTERACTION AU CLIC --
            card.addEventListener('click', () => {
                // 1. Gestion visuelle
                document.querySelectorAll('.market-card').forEach(c => c.classList.remove('active-index'));
                card.classList.add('active-index');

                // 2. Appel au graphique
                if (this.chart) {
                    console.log(`🌍 Affichage Indice : ${idx.name} (${idx.ticker})`);
                    this.chart.showIndex(idx.ticker, idx.name);
                    
                    if (window.innerWidth < 768) {
                        const chartSection = document.querySelector('.dashboard-chart-section');
                        if (chartSection) chartSection.scrollIntoView({ behavior: 'smooth' });
                    }
                }
            });

            // Ajout de la carte au conteneur
            container.appendChild(card);
        });
    }

	refreshDashboard() {
        this.loadPortfolioData();
        if(this.chart) this.chart.update(false, true);
        this.loadMarketIndices();
    }
}

document.addEventListener('DOMContentLoaded', () => new DashboardApp());