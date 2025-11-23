// ========================================
// dashboardApp.js - Version Finale (Réparée)
// ========================================

import { Storage } from './storage.js';
import { PriceAPI } from './api.js?v=4';
import { MarketStatus } from './marketStatus.js?v=2';
import { DataManager } from './dataManager.js?v=7';
import { HistoricalChart } from './historicalChart.js?v=9';

// CLÉ API GEMINI (Définie ici pour éviter les erreurs d'import)
const GEMINI_API_KEY = "AIzaSyCSFjArNaC35wbZLLGXOlPEO4HJO7hN7pw"; 

class DashboardApp {
    constructor() {
        this.storage = new Storage();
        this.api = new PriceAPI(this.storage);
        this.marketStatus = new MarketStatus(this.storage);
        this.dataManager = new DataManager(this.storage, this.api);
        
        // Interface mock pour le graphique
        this.mockPageInterface = {
            filterManager: { getSelectedTickers: () => new Set() },
            currentSearchQuery: '',
            currentAssetTypeFilter: '',
            currentBrokerFilter: '',
            getChartTitleConfig: () => ({ mode: 'global', label: 'Global Portfolio', icon: '📈' }),
            renderData: () => {} 
        };

        this.chart = null;
        // Proxies pour Google RSS
        this.corsProxies = [
            'https://api.allorigins.win/raw?url=',
            'https://corsproxy.io/?',
            'https://api.codetabs.com/v1/proxy?quest='
        ];

        this.init();
    }

    async init() {
        console.log('🚀 Dashboard Init...');
        this.marketStatus.startAutoRefresh('market-status-container', 'full');
        
        // 1. Données & Graphique
        await this.loadPortfolioData();
        setTimeout(() => this.initHistoricalChart(), 50);
        
        // 2. Actualités (3 Flux)
        this.loadPortfolioNews();
        this.loadGlobalNews();
        
        // 3. Indices (Colonne Droite)
        this.loadMarketIndices();
        
        // Refresh auto
        setInterval(() => this.refreshDashboard(), 5 * 60 * 1000);
        
        // Events
        this.setupEventListeners();
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

    // === GRAPHIQUE ===
    initHistoricalChart() {
        try {
            if (this.chart && this.chart.chart) this.chart.chart.destroy();
            this.chart = new HistoricalChart(this.storage, this.dataManager, null, this.mockPageInterface);
            
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

    // === CHARGEMENT DONNÉES ===
    async loadPortfolioData() {
        try {
            const purchases = this.storage.getPurchases();
            if (purchases.length === 0) return;
            const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
            await this.api.fetchBatchPrices(tickers);
            const holdings = this.dataManager.calculateHoldings(purchases.filter(p => p.assetType !== 'Cash'));
            const summary = this.dataManager.calculateSummary(holdings);
            this.renderKPIs(summary);
            this.renderAllocation(holdings, summary.totalCurrentEUR);
        } catch (error) { console.error("Erreur chargement portfolio:", error); }
    }

    renderKPIs(data) {
        const fmt = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(v);
        const pct = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
        const safeText = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
        const setClass = (id, val) => { const el = document.getElementById(id); if(el) el.className = 'kpi-change-pct ' + (val >= 0 ? 'stat-positive' : 'stat-negative'); };

        safeText('dashboard-total-value', fmt(data.totalCurrentEUR));
        safeText('dashboard-total-return', fmt(data.gainTotal));
        safeText('dashboard-total-return-pct', pct(data.gainPct));
        setClass('dashboard-total-return-pct', data.gainPct);

        safeText('dashboard-day-change', fmt(data.totalDayChangeEUR));
        safeText('dashboard-day-change-pct', pct(data.dayChangePct));
        setClass('dashboard-day-change-pct', data.totalDayChangeEUR);

        if (data.bestAsset) {
            safeText('dashboard-top-gainer-name', data.bestAsset.name);
            safeText('dashboard-top-gainer-pct', pct(data.bestAsset.gainPct));
        }
        if (data.worstAsset) {
            safeText('dashboard-top-loser-name', data.worstAsset.name);
            safeText('dashboard-top-loser-pct', pct(data.worstAsset.gainPct));
        }

        const sectorCardName = document.getElementById('dashboard-top-sector');
        if (sectorCardName && data.topSector) {
            const parent = sectorCardName.closest('.kpi-card');
            if (parent) {
                const header = parent.querySelector('.kpi-header').outerHTML;
                parent.innerHTML = `${header}<div class="kpi-name-large" style="margin-bottom: 4px;">${data.topSector.name}</div><div class="kpi-sector-details"><span class="kpi-sector-value">${fmt(data.topSector.value)}</span><span class="kpi-sector-pct">${data.topSector.pct.toFixed(1)}% du portfolio</span></div>`;
            }
        }
    }

    renderAllocation(holdings, totalValue) {
        const container = document.getElementById('dashboard-allocation-container');
        if (!container || totalValue === 0) return;
        const categories = { 'ETF': { value: 0, color: '#10b981', label: 'ETF' }, 'Stock': { value: 0, color: '#3b82f6', label: 'Actions' }, 'Crypto': { value: 0, color: '#f59e0b', label: 'Cryptos' }, 'Other': { value: 0, color: '#6b7280', label: 'Autres' } };
        holdings.forEach(h => { let type = h.assetType; if (type !== 'ETF' && type !== 'Stock' && type !== 'Crypto') type = 'Other'; if (categories[type]) categories[type].value += h.currentValue; });
        const data = Object.values(categories).filter(c => c.value > 0).map(c => ({ ...c, pct: (c.value / totalValue) * 100 })).sort((a, b) => b.value - a.value);
        const fmt = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(v);
        let barHTML = '<div class="allocation-bar">';
        let listHTML = '<div class="allocation-list">';
        data.forEach(item => {
            barHTML += `<div class="alloc-segment" style="width: ${item.pct}%; background-color: ${item.color};"></div>`;
            listHTML += `<div class="alloc-row"><div class="alloc-left"><span class="alloc-dot" style="background-color: ${item.color};"></span><span class="alloc-pct">${item.pct.toFixed(1)}%</span><span class="alloc-label">${item.label}</span></div><div class="alloc-right"><span class="alloc-value">${fmt(item.value)}</span></div></div>`;
        });
        barHTML += '</div>'; listHTML += '</div>';
        container.innerHTML = `<div class="allocation-wrapper">${barHTML}${listHTML}</div>`;
    }

    // === FLUX NEWS ===
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

    // === MODALE & GEMINI ===
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

    // === INDICES (Avec Logos OpenMoji & BTC Unicode) ===
    async loadMarketIndices() {
        const container = document.getElementById('market-overview-container');
        if (!container) return;
        
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

        await this.api.fetchBatchPrices(indices.map(i => i.ticker));
        let html = '';
        indices.forEach(idx => {
            const data = this.storage.getCurrentPrice(idx.ticker);
            let priceDisplay = '--'; let changeDisplay = '--'; let changeClass = 'neutral'; let dotClass = 'closed';
            if (data && data.price) {
                const price = data.price;
                const prev = data.previousClose || price;
                const change = price - prev;
                const pct = (change / prev) * 100;
                
                let currencySymbol = '';
                if (idx.ticker.includes('BTC')) currencySymbol = ' €';
                else if (idx.ticker === 'GC=F' || idx.ticker === 'EURUSD=X') currencySymbol = ' $';
                
                const digits = idx.ticker.includes('=X') ? 4 : 2;
                priceDisplay = price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + currencySymbol;
                const sign = change >= 0 ? '+' : '';
                changeDisplay = `${sign}${change.toFixed(digits)} (${sign}${pct.toFixed(2)}%)`;
                changeClass = change >= 0 ? 'stat-positive' : 'stat-negative';
                dotClass = (idx.ticker.includes('BTC') || this.marketStatus.getStatus().isOpen) ? 'open' : 'closed';
            }
            html += `<div class="market-card"><div class="market-header"><span class="market-name">${idx.name}</span><span class="market-icon">${idx.icon}</span></div><div class="market-price">${priceDisplay}</div><div class="market-change-row"><div class="market-dot ${dotClass}"></div><span class="${changeClass}">${changeDisplay}</span></div></div>`;
        });
        container.innerHTML = html;
    }

    refreshDashboard() {
        this.loadPortfolioData();
        if(this.chart) this.chart.update(false, true);
        this.loadMarketIndices();
    }
}

document.addEventListener('DOMContentLoaded', () => new DashboardApp());