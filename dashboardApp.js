import { Storage } from './storage.js';
import { PriceAPI } from './api.js';
import { MarketStatus } from './marketStatus.js?v=2';
import { DataManager } from './dataManager.js';
import { HistoricalChart } from './historicalChart.js?v=9';

class DashboardApp {
    constructor() {
        this.storage = new Storage();
        this.api = new PriceAPI(this.storage);
        this.marketStatus = new MarketStatus(this.storage);
        this.dataManager = new DataManager(this.storage, this.api);
        
        // Mock interface pour le graphique
        this.mockPageInterface = {
            filterManager: { getSelectedTickers: () => new Set() },
            currentSearchQuery: '',
            currentAssetTypeFilter: '',
            currentBrokerFilter: '',
            getChartTitleConfig: () => ({ mode: 'global', label: 'Global Portfolio', icon: '📈' }),
            renderData: () => {} 
        };

        this.chart = null;
        this.init();
    }

    async init() {
        console.log('🚀 Dashboard Init...');
        this.marketStatus.startAutoRefresh('market-status-container', 'full');
        
        await this.loadPortfolioData();
        
        // NEWS : On charge les news après avoir les données
        this.loadNews();
        this.loadMarketIndices();
        
        // GRAPH : On initialise le graphique à la fin
        // Petit délai pour s'assurer que le conteneur est prêt
        setTimeout(() => this.initHistoricalChart(), 100);

        setInterval(() => this.refreshDashboard(), 5 * 60 * 1000);
    }

    async loadPortfolioData() {
        try {
            const purchases = this.storage.getPurchases();
            if (purchases.length === 0) return;

            // 1. Récupération des prix
            const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
            await this.api.fetchBatchPrices(tickers);
            
            // 2. Calculs
            const holdings = this.dataManager.calculateHoldings(purchases.filter(p => p.assetType !== 'Cash'));
            const summary = this.dataManager.calculateSummary(holdings);
            
            // 3. Rendu KPIs et Allocation
            this.renderKPIs(summary);
            this.renderAllocation(holdings, summary.totalCurrentEUR);

        } catch (error) {
            console.error("Erreur chargement portfolio:", error);
        }
    }

    renderKPIs(data) {
        const fmt = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(v); // Format anglais comme demandé précédemment
        const pct = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
        const setClass = (el, v) => { if(el) el.className = 'kpi-change-pct ' + (v >= 0 ? 'stat-positive' : 'stat-negative'); };

        const safeText = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };

        safeText('dashboard-total-value', fmt(data.totalCurrentEUR));
        safeText('dashboard-total-return', fmt(data.gainTotal));
        safeText('dashboard-total-return-pct', pct(data.gainPct));
        setClass(document.getElementById('dashboard-total-return-pct'), data.gainPct);

        safeText('dashboard-day-change', fmt(data.totalDayChangeEUR));
        safeText('dashboard-day-change-pct', pct(data.dayChangePct));
        setClass(document.getElementById('dashboard-day-change-pct'), data.totalDayChangeEUR);

        if (data.bestAsset) {
            safeText('dashboard-top-gainer-name', data.bestAsset.name);
            const el = document.getElementById('dashboard-top-gainer-name'); if(el) el.title = data.bestAsset.name;
            safeText('dashboard-top-gainer-pct', pct(data.bestAsset.gainPct));
        }
        if (data.worstAsset) {
            safeText('dashboard-top-loser-name', data.worstAsset.name);
            const el = document.getElementById('dashboard-top-loser-name'); if(el) el.title = data.worstAsset.name;
            safeText('dashboard-top-loser-pct', pct(data.worstAsset.gainPct));
        }

        safeText('dashboard-top-sector', data.topSector || 'ETF'); // Fallback si undefined
    }

    // === NOUVEAU RENDU ALLOCATION (BARRE + LISTE) ===
    renderAllocation(holdings, totalValue) {
        const container = document.getElementById('dashboard-allocation-container');
        if (!container || totalValue === 0) return;

        // Agréger par type
        const categories = {
            'ETF': { value: 0, color: '#10b981', label: 'ETF' }, // Vert
            'Stock': { value: 0, color: '#3b82f6', label: 'Actions' }, // Bleu
            'Crypto': { value: 0, color: '#f59e0b', label: 'Cryptos' }, // Jaune
            'Other': { value: 0, color: '#6b7280', label: 'Autres' } // Gris
        };

        holdings.forEach(h => {
            let type = h.assetType;
            if (type !== 'ETF' && type !== 'Stock' && type !== 'Crypto') type = 'Other';
            if (categories[type]) categories[type].value += h.currentValue;
        });

        // Calculer pourcentages et trier
        const data = Object.values(categories)
            .filter(c => c.value > 0)
            .map(c => ({
                ...c,
                pct: (c.value / totalValue) * 100
            }))
            .sort((a, b) => b.value - a.value); // Trier par valeur décroissante

        const fmt = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(v);

        // Générer HTML
        let barHTML = '<div class="allocation-bar">';
        let listHTML = '<div class="allocation-list">';

        data.forEach(item => {
            // Barre segmentée
            barHTML += `<div class="alloc-segment" style="width: ${item.pct}%; background-color: ${item.color};" title="${item.label}: ${item.pct.toFixed(1)}%"></div>`;
            
            // Ligne de liste
            listHTML += `
                <div class="alloc-row">
                    <div class="alloc-info">
                        <div class="alloc-dot" style="background-color: ${item.color};"></div>
                        <span class="alloc-pct">${item.pct.toFixed(1)}%</span>
                        <span class="alloc-label">${item.label}</span>
                    </div>
                    <span class="alloc-value">${fmt(item.value)}</span>
                </div>
            `;
        });

        barHTML += '</div>';
        listHTML += '</div>';

        container.innerHTML = `<div class="allocation-container">${barHTML}${listHTML}</div>`;
    }

    // === FIX GRAPHIQUE ===
    initHistoricalChart() {
        try {
            // Détruire l'ancien si nécessaire (pour éviter les doublons)
            if (this.chart && this.chart.chart) {
                this.chart.chart.destroy();
            }

            this.chart = new HistoricalChart(this.storage, this.dataManager, null, this.mockPageInterface);
            
            document.querySelectorAll('.chart-controls-inline .period-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    document.querySelectorAll('.chart-controls-inline .period-btn').forEach(b => b.classList.remove('active'));
                    e.target.classList.add('active');
                    this.chart.currentPeriod = parseInt(e.target.dataset.period);
                    this.chart.update(true, true);
                });
            });

            this.chart.currentPeriod = 1;
            // Appel direct à update au lieu de loadPageWithCacheFirst pour forcer le calcul dans le contexte Dashboard
            this.chart.update(true, false); 
        } catch (e) {
            console.error("Erreur init graph:", e);
        }
    }

    // === FIX NEWS (Diversité + Lien Google News) ===
    async loadNews() {
        const container = document.getElementById('news-container');
        const purchases = this.storage.getPurchases();
        
        // Utiliser un Map pour unicité par Ticker (et éviter d'avoir 10 fois Bitcoin)
        const uniqueMap = new Map();
        purchases.forEach(p => {
            if (!uniqueMap.has(p.ticker)) {
                uniqueMap.set(p.ticker, { ticker: p.ticker, name: p.name, type: p.assetType });
            }
        });
        
        const uniqueAssets = Array.from(uniqueMap.values());

        if (uniqueAssets.length === 0) {
            if(container) container.innerHTML = '<div class="news-empty">No news available</div>';
            return;
        }

        const news = this.generateMockNews(uniqueAssets);
        
        if(container) {
            container.innerHTML = news.map(n => `
                <a href="${n.url}" target="_blank" class="news-item">
                    <div class="news-content">
                        <div class="news-ticker" style="background:${this.getColorFor(n.ticker)}">${n.ticker}</div>
                        <div class="news-title">${n.title}</div>
                        <div class="news-meta">
                            <span>${n.source}</span> • <span>${n.time}</span>
                        </div>
                    </div>
                </a>
            `).join('');
        }
    }

    generateMockNews(assets) {
        const headlines = [
            "reports record quarterly earnings",
            "launches new strategic partnership",
            "shares jump on market optimism",
            "faces new regulatory scrutiny",
            "announces major expansion plans",
            "analysts upgrade price target"
        ];
        const sources = ['Bloomberg', 'Reuters', 'CNBC', 'Financial Times', 'Yahoo Finance'];

        // Mélanger les actifs pour ne pas toujours prendre les premiers
        const shuffledAssets = assets.sort(() => 0.5 - Math.random());

        // Générer 10 news
        return Array.from({length: 10}).map((_, i) => {
            // Utiliser modulo pour cycler à travers les actifs si moins de 10 actifs
            const asset = shuffledAssets[i % shuffledAssets.length];
            const headline = headlines[Math.floor(Math.random() * headlines.length)];
            
            // Lien Google Actualités spécifique
            // tbm=nws force l'onglet "Actualités"
            const query = encodeURIComponent(`${asset.name} stock news`);
            const url = `https://www.google.com/search?q=${query}&tbm=nws`;

            return {
                ticker: asset.ticker,
                title: `${asset.name} ${headline}`,
                source: sources[Math.floor(Math.random() * sources.length)],
                time: `${Math.floor(Math.random() * 12) + 1}h ago`,
                url: url
            };
        });
    }

    getColorFor(ticker) {
        let hash = 0;
        for (let i = 0; i < ticker.length; i++) hash = ticker.charCodeAt(i) + ((hash << 5) - hash);
        const hue = Math.abs(hash % 360);
        return `hsl(${hue}, 70%, 40%)`;
    }

    async loadMarketIndices() {
        const updateIndex = (id, ticker) => {
            const elChange = document.getElementById(id + '-change');
            if(!elChange) return;
            
            const data = this.storage.getCurrentPrice(ticker);
            if (data && data.price && data.previousClose) {
                const change = ((data.price - data.previousClose) / data.previousClose) * 100;
                elChange.textContent = (change > 0 ? '+' : '') + change.toFixed(2) + '%';
                elChange.className = 'market-val ' + (change >= 0 ? 'stat-positive' : 'stat-negative');
            }
        };

        // On s'assure d'avoir les données
        // Note: Si l'API échoue, on aura des tirets, c'est normal
        await this.api.fetchBatchPrices(['^GSPC', '^FCHI', 'BTC-EUR']);
        
        updateIndex('index-sp500', '^GSPC');
        updateIndex('index-cac40', '^FCHI');
        updateIndex('index-btc', 'BTC-EUR');
    }

    refreshDashboard() {
        this.loadPortfolioData();
        if(this.chart) this.chart.update(false, true);
    }
}

document.addEventListener('DOMContentLoaded', () => new DashboardApp());