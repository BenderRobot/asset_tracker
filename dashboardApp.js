// ========================================
// dashboardApp.js - Tableau de bord du portfolio
// ========================================

import { Storage } from './storage.js';
import { PriceAPI } from './api.js';
import { MarketStatus } from './marketStatus.js';

class DashboardApp {
    constructor() {
        this.storage = new Storage();
        this.api = new PriceAPI(this.storage);
        this.marketStatus = new MarketStatus(this.storage);
        this.chart = null;
        this.selectedPeriod = '1D';
        this.newsCache = new Map();
        
        this.init();
    }

    async init() {
        console.log('Initialisation du Dashboard...');
        
        // Ajouter l'animation pulse pour le market status
        this.marketStatus.injectPulseAnimation();
        
        // Afficher le statut du marché
        this.renderMarketStatus();
        
        // Charger les données du portfolio
        await this.loadPortfolioData();
        
        // Initialiser le graphique
        this.initChart();
        
        // Charger les actualités
        this.loadNews();
        
        // Charger les indices de marché
        this.loadMarketIndices();
        
        // Événements
        this.attachEventListeners();
        
        // Auto-refresh toutes les 5 minutes
        setInterval(() => this.refreshDashboard(), 5 * 60 * 1000);
    }

    renderMarketStatus() {
        const container = document.getElementById('market-status-container');
        if (container) {
            container.innerHTML = this.marketStatus.createStatusBadge();
        }
    }

    async loadPortfolioData() {
        try {
            console.log('Chargement des données du portfolio...');
            const purchases = this.storage.getPurchases();
            console.log(`${purchases.length} transactions trouvées`);
            
            if (purchases.length === 0) {
                console.log('Aucune transaction, affichage état vide');
                this.renderEmptyState();
                return;
            }

            // Grouper par ticker
            const grouped = this.groupByTicker(purchases);
            console.log(`${grouped.size} actifs uniques`);
            
            // Rafraîchir les prix
            console.log('Rafraîchissement des prix...');
            await this.refreshPrices(grouped);
            
            // Calculer les KPIs
            console.log('Calcul des KPIs...');
            this.calculateAndRenderKPIs(grouped);
            
            console.log('Chargement du portfolio terminé');
        } catch (error) {
            console.error('Erreur chargement portfolio:', error);
            this.showError('Erreur de chargement des données: ' + error.message);
        }
    }

    groupByTicker(purchases) {
        const grouped = new Map();
        
        purchases.forEach(purchase => {
            const ticker = purchase.ticker.toUpperCase();
            
            if (!grouped.has(ticker)) {
                grouped.set(ticker, {
                    ticker,
                    name: purchase.name,
                    assetType: purchase.assetType || 'Stock',
                    currency: purchase.currency || 'EUR',
                    positions: []
                });
            }
            
            grouped.get(ticker).positions.push(purchase);
        });
        
        return grouped;
    }

    async refreshPrices(grouped) {
        const tickers = Array.from(grouped.keys());
        
        // Utiliser fetchBatchPrices qui existe dans l'API
        await this.api.fetchBatchPrices(tickers);
    }

    calculateAndRenderKPIs(grouped) {
        console.log('Début calcul KPIs...');
        let totalValue = 0;
        let totalInvested = 0;
        let totalDayChange = 0;
        let assetsWithPrices = 0;
        
        const assets = [];
        
        grouped.forEach((group, ticker) => {
            const priceData = this.storage.getCurrentPrice(ticker);
            
            console.log(`${ticker}: prix disponible =`, priceData);
            
            if (!priceData || !priceData.price) {
                console.warn(`Prix manquant pour ${ticker}`);
                return;
            }
            
            const currentPrice = priceData.price;
            const previousClose = priceData.previousClose || currentPrice;
            
            let quantity = 0;
            let invested = 0;
            
            group.positions.forEach(position => {
                quantity += position.quantity;
                invested += position.price * position.quantity;
            });
            
            const currentValue = currentPrice * quantity;
            const gainLoss = currentValue - invested;
            const gainPct = invested > 0 ? (gainLoss / invested) * 100 : 0;
            
            // Variation journée
            const dayChange = (currentPrice - previousClose) * quantity;
            const dayChangePct = previousClose > 0 ? ((currentPrice - previousClose) / previousClose) * 100 : 0;
            
            totalValue += currentValue;
            totalInvested += invested;
            totalDayChange += dayChange;
            assetsWithPrices++;
            
            console.log(`${ticker}: valeur=${currentValue}, investi=${invested}, gain=${gainPct}%`);
            
            assets.push({
                ticker,
                name: group.name,
                assetType: group.assetType,
                currentValue,
                invested,
                gainLoss,
                gainPct,
                dayChange,
                dayChangePct
            });
        });
        
        console.log(`Total: ${assetsWithPrices}/${grouped.size} actifs avec prix`);
        console.log(`Valeur totale: ${totalValue}, Investi: ${totalInvested}`);
        
        if (assetsWithPrices === 0) {
            console.warn('Aucun prix disponible, affichage message d\'erreur');
            this.showError('Aucun prix disponible. Cliquez sur Actualiser.');
            return;
        }
        
        const totalReturn = totalValue - totalInvested;
        const totalReturnPct = totalInvested > 0 ? (totalReturn / totalInvested) * 100 : 0;
        const dayChangePct = (totalValue - totalDayChange) > 0 ? (totalDayChange / (totalValue - totalDayChange)) * 100 : 0;
        
        // Top Gainer et Loser
        const sortedByGain = [...assets].sort((a, b) => b.gainPct - a.gainPct);
        const topGainer = sortedByGain[0];
        const topLoser = sortedByGain[sortedByGain.length - 1];
        
        // Secteur dominant (simplifié par type d'actif)
        const assetTypes = {};
        assets.forEach(asset => {
            assetTypes[asset.assetType] = (assetTypes[asset.assetType] || 0) + asset.currentValue;
        });
        const topSector = Object.entries(assetTypes).sort((a, b) => b[1] - a[1])[0];
        
        // Allocation Actions vs Crypto
        const stocksValue = (assetTypes['Stock'] || 0) + (assetTypes['ETF'] || 0);
        const cryptoValue = assetTypes['Crypto'] || 0;
        const stocksPct = totalValue > 0 ? (stocksValue / totalValue) * 100 : 0;
        const cryptoPct = totalValue > 0 ? (cryptoValue / totalValue) * 100 : 0;
        
        // Render KPIs
        console.log('Affichage des KPIs...');
        this.renderKPIs({
            totalValue,
            totalReturn,
            totalReturnPct,
            totalDayChange,
            dayChangePct,
            topGainer,
            topLoser,
            assetsCount: grouped.size,
            totalInvested,
            topSector: topSector ? topSector[0] : '-',
            stocksPct,
            cryptoPct
        });
        
        // Mettre à jour le graphique avec les données
        this.updateChartData(totalValue, totalDayChange);
    }

    renderKPIs(data) {
        // Valeur Totale
        document.getElementById('dashboard-total-value').textContent = 
            this.formatCurrency(data.totalValue);
        
        const returnEl = document.getElementById('dashboard-total-return');
        returnEl.textContent = this.formatCurrency(data.totalReturn);
        returnEl.className = 'kpi-change ' + (data.totalReturn >= 0 ? 'stat-positive' : 'stat-negative');
        
        const returnPctEl = document.getElementById('dashboard-total-return-pct');
        returnPctEl.textContent = `(${data.totalReturnPct >= 0 ? '+' : ''}${data.totalReturnPct.toFixed(2)}%)`;
        returnPctEl.className = 'kpi-change-pct ' + (data.totalReturn >= 0 ? 'stat-positive' : 'stat-negative');
        
        // Variation Jour
        const dayChangeEl = document.getElementById('dashboard-day-change');
        dayChangeEl.textContent = this.formatCurrency(data.totalDayChange);
        dayChangeEl.className = 'kpi-value ' + (data.totalDayChange >= 0 ? 'stat-positive' : 'stat-negative');
        
        const dayChangePctEl = document.getElementById('dashboard-day-change-pct');
        dayChangePctEl.textContent = `(${data.dayChangePct >= 0 ? '+' : ''}${data.dayChangePct.toFixed(2)}%)`;
        dayChangePctEl.className = 'kpi-change-pct ' + (data.totalDayChange >= 0 ? 'stat-positive' : 'stat-negative');
        
        // Top Gainer
        if (data.topGainer) {
            document.getElementById('dashboard-top-gainer-ticker').textContent = data.topGainer.ticker;
            const gainerPctEl = document.getElementById('dashboard-top-gainer-pct');
            gainerPctEl.textContent = `+${data.topGainer.gainPct.toFixed(2)}%`;
            gainerPctEl.className = 'kpi-change-pct stat-positive';
        }
        
        // Top Loser
        if (data.topLoser) {
            document.getElementById('dashboard-top-loser-ticker').textContent = data.topLoser.ticker;
            const loserPctEl = document.getElementById('dashboard-top-loser-pct');
            loserPctEl.textContent = `${data.topLoser.gainPct.toFixed(2)}%`;
            loserPctEl.className = 'kpi-change-pct stat-negative';
        }
        
        // Autres KPIs
        document.getElementById('dashboard-assets-count').textContent = data.assetsCount;
        document.getElementById('dashboard-invested').textContent = this.formatCurrency(data.totalInvested);
        document.getElementById('dashboard-top-sector').textContent = data.topSector;
        document.getElementById('dashboard-allocation').textContent = 
            `${data.stocksPct.toFixed(0)}% / ${data.cryptoPct.toFixed(0)}%`;
    }

    initChart() {
        const ctx = document.getElementById('performance-chart');
        if (!ctx) return;
        
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Valeur du Portfolio',
                    data: [],
                    borderColor: 'rgb(59, 130, 246)',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        backgroundColor: 'rgba(26, 34, 56, 0.95)',
                        titleColor: '#fff',
                        bodyColor: '#9fa6bc',
                        borderColor: '#2d3548',
                        borderWidth: 1,
                        padding: 12,
                        displayColors: false,
                        callbacks: {
                            title: (items) => {
                                return items[0].label;
                            },
                            label: (context) => {
                                return this.formatCurrency(context.parsed.y);
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            color: 'rgba(45, 53, 72, 0.5)',
                            drawBorder: false
                        },
                        ticks: {
                            color: '#9fa6bc',
                            maxTicksLimit: 8
                        }
                    },
                    y: {
                        grid: {
                            color: 'rgba(45, 53, 72, 0.5)',
                            drawBorder: false
                        },
                        ticks: {
                            color: '#9fa6bc',
                            callback: (value) => this.formatCurrency(value, 0)
                        }
                    }
                }
            }
        });
    }

    updateChartData(currentValue, dayChange) {
        if (!this.chart) return;
        
        // Générer des données fictives pour la journée (en attendant les vraies données historiques)
        const now = new Date();
        const labels = [];
        const data = [];
        
        if (this.selectedPeriod === '1D') {
            // Données intraday (9h30 - 16h00)
            const startValue = currentValue - dayChange;
            const interval = dayChange / 13; // 13 points de données
            
            for (let i = 0; i <= 13; i++) {
                const hour = 9 + Math.floor((i * 30) / 60);
                const minute = (i * 30) % 60;
                labels.push(`${hour}:${minute.toString().padStart(2, '0')}`);
                data.push(startValue + (interval * i) + (Math.random() * interval * 0.2));
            }
        } else {
            // Autres périodes - données simplifiées
            const days = this.selectedPeriod === '5D' ? 5 : this.selectedPeriod === '1M' ? 30 : 90;
            for (let i = days; i >= 0; i--) {
                const date = new Date(now);
                date.setDate(date.getDate() - i);
                labels.push(date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
                data.push(currentValue * (0.95 + Math.random() * 0.1));
            }
        }
        
        this.chart.data.labels = labels;
        this.chart.data.datasets[0].data = data;
        this.chart.update('none');
        
        // Mettre à jour la légende
        document.getElementById('chart-current-value').textContent = this.formatCurrency(currentValue);
        const changeEl = document.getElementById('chart-change');
        const changePct = ((dayChange / (currentValue - dayChange)) * 100);
        changeEl.textContent = `${dayChange >= 0 ? '+' : ''}${this.formatCurrency(dayChange)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`;
        changeEl.className = 'chart-change ' + (dayChange >= 0 ? 'stat-positive' : 'stat-negative');
    }

    async loadNews() {
        const container = document.getElementById('news-container');
        container.innerHTML = '<div class="news-loading"><i class="fas fa-spinner fa-spin"></i><span>Chargement des actualités...</span></div>';
        
        try {
            const purchases = this.storage.getPurchases();
            const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))].slice(0, 10);
            
            if (tickers.length === 0) {
                container.innerHTML = '<div class="news-empty">Aucun actif dans votre portfolio</div>';
                return;
            }
            
            // Simuler des actualités (en production, utiliser une vraie API)
            const news = this.generateMockNews(tickers);
            this.renderNews(news);
            
        } catch (error) {
            console.error('Erreur chargement actualités:', error);
            container.innerHTML = '<div class="news-error">Erreur de chargement des actualités</div>';
        }
    }

    generateMockNews(tickers) {
        const headlines = [
            'annonce des résultats trimestriels dépassant les attentes',
            'lance un nouveau produit innovant sur le marché',
            'acquisition stratégique pour renforcer sa position',
            'partenariat majeur avec un acteur de l\'industrie',
            'investissement important dans la R&D',
            'expansion sur de nouveaux marchés internationaux',
            'dividende en hausse pour les actionnaires',
            'analyse positive des experts du secteur'
        ];
        
        const sources = ['Reuters', 'Bloomberg', 'Les Échos', 'Financial Times', 'Yahoo Finance'];
        
        return tickers.slice(0, 8).map((ticker, index) => {
            const headline = headlines[Math.floor(Math.random() * headlines.length)];
            const purchase = this.storage.getPurchases().find(p => p.ticker.toUpperCase() === ticker);
            
            return {
                ticker,
                title: `${purchase?.name || ticker} ${headline}`,
                source: sources[Math.floor(Math.random() * sources.length)],
                time: `Il y a ${Math.floor(Math.random() * 24)} heures`,
                assetType: purchase?.assetType || 'Stock'
            };
        });
    }

    renderNews(newsArray) {
        const container = document.getElementById('news-container');
        
        if (newsArray.length === 0) {
            container.innerHTML = '<div class="news-empty">Aucune actualité disponible</div>';
            return;
        }
        
        container.innerHTML = newsArray.map(news => `
            <div class="news-item" data-type="${news.assetType.toLowerCase()}">
                <div class="news-content">
                    <div class="news-ticker">${news.ticker}</div>
                    <div class="news-title">${news.title}</div>
                    <div class="news-meta">
                        <span class="news-source">${news.source}</span>
                        <span class="news-time">${news.time}</span>
                    </div>
                </div>
                <div class="news-icon">
                    <i class="fas fa-external-link-alt"></i>
                </div>
            </div>
        `).join('');
    }

    async loadMarketIndices() {
        try {
            // Charger S&P 500
            await this.loadIndex('^GSPC', 'sp500');
            
            // Charger CAC 40
            await this.loadIndex('^FCHI', 'cac40');
            
            // Charger Bitcoin
            await this.loadIndex('BTC-USD', 'btc');
            
            // Charger Ethereum
            await this.loadIndex('ETH-USD', 'eth');
            
        } catch (error) {
            console.error('Erreur chargement indices:', error);
        }
    }

    async loadIndex(ticker, id) {
        try {
            // Utiliser fetchBatchPrices pour un seul ticker
            await this.api.fetchBatchPrices([ticker]);
            const priceData = this.storage.getCurrentPrice(ticker);
            
            if (priceData && priceData.price) {
                const isUSD = ticker.includes('USD') || ticker.includes('^');
                const currency = isUSD ? 'USD' : 'EUR';
                const symbol = isUSD ? '$' : '€';
                
                document.getElementById(`index-${id}`).textContent = 
                    symbol + priceData.price.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                
                const change = priceData.change || 0;
                const changePct = priceData.changePercent || 0;
                const changeEl = document.getElementById(`index-${id}-change`);
                
                changeEl.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`;
                changeEl.className = 'market-index-change ' + (change >= 0 ? 'stat-positive' : 'stat-negative');
            }
        } catch (error) {
            console.warn(`Erreur chargement ${ticker}:`, error);
        }
    }

    attachEventListeners() {
        // Boutons de période du graphique
        document.querySelectorAll('.chart-period-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.chart-period-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.selectedPeriod = e.target.dataset.period;
                this.loadPortfolioData();
            });
        });
        
        // Refresh graphique
        const refreshChartBtn = document.getElementById('refresh-chart-btn');
        if (refreshChartBtn) {
            refreshChartBtn.addEventListener('click', () => this.loadPortfolioData());
        }
        
        // Filtres actualités
        document.querySelectorAll('.news-filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.news-filter-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.filterNews(e.target.dataset.filter);
            });
        });
        
        // Refresh actualités
        const refreshNewsBtn = document.getElementById('refresh-news-btn');
        if (refreshNewsBtn) {
            refreshNewsBtn.addEventListener('click', () => this.loadNews());
        }
    }

    filterNews(filter) {
        const newsItems = document.querySelectorAll('.news-item');
        
        newsItems.forEach(item => {
            if (filter === 'all') {
                item.style.display = 'flex';
            } else {
                const type = item.dataset.type;
                item.style.display = (filter === 'stocks' && (type === 'stock' || type === 'etf')) ||
                                     (filter === 'crypto' && type === 'crypto') ? 'flex' : 'none';
            }
        });
    }

    async refreshDashboard() {
        console.log('Rafraîchissement du dashboard...');
        await this.loadPortfolioData();
        await this.loadMarketIndices();
    }

    renderEmptyState() {
        const container = document.querySelector('.container');
        container.innerHTML += `
            <div class="empty-state">
                <i class="fas fa-chart-line fa-3x"></i>
                <h3>Aucune donnée disponible</h3>
                <p>Ajoutez des transactions pour voir votre dashboard</p>
                <a href="index.html" class="btn-primary">Ajouter une transaction</a>
            </div>
        `;
    }

    showError(message) {
        console.error(message);
        
        // Afficher un message d'erreur dans l'interface
        const container = document.querySelector('.container');
        const errorDiv = document.createElement('div');
        errorDiv.className = 'dashboard-error';
        errorDiv.innerHTML = `
            <i class="fas fa-exclamation-triangle"></i>
            <p>${message}</p>
            <button onclick="location.reload()" class="btn-primary">Actualiser la page</button>
        `;
        
        // Insérer après le header
        const header = document.querySelector('h1');
        if (header && header.nextSibling) {
            header.parentNode.insertBefore(errorDiv, header.nextSibling);
        }
    }

    formatCurrency(value, decimals = 2) {
        return new Intl.NumberFormat('fr-FR', {
            style: 'currency',
            currency: 'EUR',
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        }).format(value);
    }
}

// Initialisation
document.addEventListener('DOMContentLoaded', () => {
    new DashboardApp();
});
