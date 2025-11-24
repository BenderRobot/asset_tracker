// ========================================
// dashboardApp.js - VERSION COMPLÈTE & FONCTIONNELLE (v12 - FINAL)
// Identique à ton ancien + toutes les améliorations
// ========================================
import { Storage } from './storage.js';                    // default
import { PriceAPI } from './api.js?v=4';                // named
import { MarketStatus } from './marketStatus.js?v=2';   // named
import { DataManager } from './dataManager.js?v=7';     // named → CORRIGÉ ICI
import { HistoricalChart } from './historicalChart.js?v=9'; // named
import { GEMINI_API_KEY } from './config.js';

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
            getChartTitleConfig: () => ({ mode: 'global', label: 'Global Portfolio', icon: 'Chart' }),
            renderData: (holdings, summary, cash) => {
                if (summary) {
                    this.updateDayChangeFromGraph(summary.totalDayChangeEUR, summary.dayChangePct);
                    this.updateTotalValueFromGraph(summary.totalCurrentEUR, cash);
                }
            }
        };

        this.chart = null;
        this.corsProxies = [
            'https://corsproxy.io/?',
            'https://api.codetabs.com/v1/proxy?quest=',
            'https://proxy.cors.sh/'
        ];
        this.currentProxyIndex = 0;
        this.currentModalNewsItem = null;
        this.currentGeminiSummary = null;
        this.portfolioNews = [];
        this.globalNews = [];

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
            pctEl.className = 'kpi-change-pct ' + (amount >= 0 ? 'stat-positive' : 'stat-negative');
        }
    }

    updateTotalValueFromGraph(assetValue, cashValue) {
        const el = document.getElementById('dashboard-total-value');
        if (el) {
            const total = (assetValue || 0) + (cashValue || 0);
            el.textContent = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(total);
        }
    }

    setupEventListeners() {
        const closeBtn = document.getElementById('close-news-modal');
        const modal = document.getElementById('news-modal');
        const refreshPortfolioBtn = document.getElementById('refresh-portfolio-news');
        const analyzeContextBtn = document.getElementById('analyze-context-btn');

        if (refreshPortfolioBtn) refreshPortfolioBtn.addEventListener('click', () => this.loadPortfolioNews());

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
            if (purchases.length === 0) return;

            const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
            await this.api.fetchBatchPrices(tickers);

            const assetPurchases = purchases.filter(p => p.assetType !== 'Cash');
            const cashPurchases = purchases.filter(p => p.assetType === 'Cash');

            const holdings = this.dataManager.calculateHoldings(assetPurchases);
            const summary = this.dataManager.calculateSummary(holdings);
            const cashReserve = this.dataManager.calculateCashReserve(cashPurchases);

            this.renderKPIs(summary, cashReserve.total, holdings);
            this.renderAllocation(holdings, summary.totalCurrentEUR);
        } catch (error) { console.error("Erreur chargement portfolio:", error); }
    }

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
            if (!categories[type]) type = 'Other';
            categories[type].value += h.currentValue;
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

        barHTML += '</div>'; listHTML += '</div>';
        container.innerHTML = `<div class="allocation-wrapper">${barHTML}${listHTML}</div>`;
    }

    renderKPIs(data, cashTotal = 0, holdings = []) {
        const fmt = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(v);
        const pct = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
        const safeText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        const setClass = (id, val) => { const el = document.getElementById(id); if (el) el.className = 'kpi-change-pct ' + (val >= 0 ? 'stat-positive' : 'stat-negative'); };

        safeText('dashboard-total-value', fmt(data.totalCurrentEUR + cashTotal));
        safeText('dashboard-invested-subtitle', `Invested: ${fmt(data.totalInvestedEUR)}`);
        safeText('dashboard-total-return', fmt(data.gainTotal));
        safeText('dashboard-total-return-pct', pct(data.gainPct));
        setClass('dashboard-total-return-pct', data.gainPct);
        safeText('dashboard-day-change', fmt(data.totalDayChangeEUR));
        safeText('dashboard-day-change-pct', pct(data.dayChangePct));
        setClass('dashboard-day-change-pct', data.totalDayChangeEUR);

        const topGainers = [...holdings].sort((a, b) => b.gainPct - a.gainPct).slice(0, 3);
        this.injectListIntoCard('dashboard-top-gainer-name', topGainers, 'gainer');
        const topLosers = [...holdings].sort((a, b) => a.gainPct - b.gainPct).slice(0, 3);
        this.injectListIntoCard('dashboard-top-loser-name', topLosers, 'loser');
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

    async loadPortfolioNews() {
        const container = document.getElementById('news-portfolio-container');
        if (!container) return;
        container.innerHTML = '<div style="padding:20px; text-align:center; color:#666"><i class="fas fa-circle-notch fa-spin"></i></div>';

        const purchases = this.storage.getPurchases();
        const uniqueNames = [...new Set(purchases.map(p => p.name))];
        if (uniqueNames.length === 0) { container.innerHTML = '<div style="padding:20px; text-align:center; color:#666">Aucun actif</div>'; return; }

        const promises = uniqueNames.map(name => this.fetchGoogleRSS(`${name} actualité financière`, 1));
        try {
            const results = await Promise.all(promises);
            const allNews = results.flat();
            const uniqueNews = this.deduplicateNews(allNews).sort((a, b) => b.datetime - a.datetime);
            this.portfolioNews = uniqueNews.slice(0, 25);
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
        const promises = topics.map(t => this.fetchGoogleRSS(t, 4));
        try {
            const results = await Promise.all(promises);
            const allNews = results.flat().sort((a, b) => b.datetime - a.datetime);
            this.globalNews = this.deduplicateNews(allNews).slice(0, 15);
            this.renderNewsList(container, this.globalNews, 'global');
        } catch (e) {
            container.innerHTML = '<div style="padding:20px; text-align:center; color:#ef4444">Erreur</div>';
        }
    }

    async fetchGoogleRSS(query, limit = 1) {
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=fr&gl=FR&ceid=FR:fr`;
        for (const proxy of this.corsProxies) {
            try {
                const response = await fetch(proxy + encodeURIComponent(rssUrl), { signal: AbortSignal.timeout(3000) });
                if (response.ok) {
                    const str = await response.text();
                    const data = new window.DOMParser().parseFromString(str, "text/xml");
                    return Array.from(data.querySelectorAll("item")).slice(0, limit).map(item => {
                        const pubDate = item.querySelector("pubDate")?.textContent;
                        const fullTitle = item.querySelector("title")?.textContent || "";
                        const description = item.querySelector("description")?.textContent || "";
                        const parts = fullTitle.split(" - ");
                        const source = parts.length > 1 ? parts.pop() : "Google";
                        return {
                            ticker: query.split(' ')[0].substring(0, 4).toUpperCase(),
                            name: query,
                            title: parts.join(" - "),
                            source: source,
                            url: item.querySelector("link")?.textContent,
                            datetime: pubDate ? new Date(pubDate).getTime() / 1000 : Date.now() / 1000,
                            fullDescription: description
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
        container.innerHTML = newsData.map((n, i) => {
            const formattedDate = this.formatFullDateTime(n.datetime * 1000);
            return `
                <div class="news-item-compact" data-type="${type}" data-index="${i}">
                    <div class="news-meta-row">
                        <span class="news-ticker-tag" style="color:${this.getColorFor(n.ticker)}">${n.ticker}</span>
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
        if (pubDateEl) pubDateEl.textContent = this.formatFullDateTime(newsItem.datetime * 1000, true);

        document.getElementById('modal-news-ticker').textContent = newsItem.ticker;
        document.getElementById('modal-news-ticker').style.backgroundColor = this.getColorFor(newsItem.ticker);
        document.getElementById('modal-news-title').textContent = newsItem.title;
        document.getElementById('modal-news-link').href = newsItem.url || '#';

        const summaryDiv = document.getElementById('modal-news-summary');
        summaryDiv.innerHTML = '<span class="loading-text">Gemini analyse le marché...</span>';

        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('show'), 10);

        try {
            const description = newsItem.fullDescription || '';
            const summary = await this.fetchGeminiSummary(newsItem.title, newsItem.name, description);
            this.currentGeminiSummary = summary;
            summaryDiv.innerHTML = summary;
        } catch (error) {
            summaryDiv.innerHTML = "Analyse indisponible.";
        }
    }

    async fetchGeminiSummary(title, companyName, fullDescription = null) {
        if (!GEMINI_API_KEY || GEMINI_API_KEY.length < 20) {
            await new Promise(r => setTimeout(r, 500));
            return `<strong>Mode Démo :</strong> Clé API manquante.`;
        }

        const prompt = `Tu es un analyste financier. Résume cette news en français (max 2 phrases). Titre: "${this.cleanText(title)}". Sujet: ${this.cleanText(companyName)}${fullDescription ? `. Description: "${this.cleanText(fullDescription)}"` : ''}`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            });
            if (response.ok) {
                const data = await response.json();
                if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
                    return data.candidates[0].content.parts[0].text.replace(/\n/g, '<br>').replace(/\*\*/g, '');
                }
            }
        } catch (e) { console.warn(e); }
        return "IA indisponible.";
    }

    async fetchGeminiContext(title, summary) {
        if (!GEMINI_API_KEY || GEMINI_API_KEY.length < 20) return `<strong>Mode Démo :</strong> Clé API manquante.`;

        const prompt = `Agis comme un analyste financier chevronné. En te basant sur ce résumé, explique en 1 à 3 phrases l'impact potentiel (opportunité ou risque) de cette nouvelle sur l'actif concerné.\nTitre: "${this.cleanText(title)}"\nRésumé: "${this.cleanText(summary)}"`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
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
        const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
        let hash = 0;
        for (let i = 0; i < (ticker || '').length; i++) hash = ticker.charCodeAt(i) + ((hash << 5) - hash);
        return colors[Math.abs(hash) % colors.length];
    }

    // =============================================
    // INDICES + STATUT PRÉCIS + SPARKLINE
    // =============================================
    async loadMarketIndices() {
		const container = document.getElementById('market-overview-container');
		if (!container) return;

		// CDN OpenMoji (fiable, rapide, pas de CORS)
		const cdn = "https://cdn.jsdelivr.net/npm/openmoji@14.0.0/color/svg/";
		const indices = [
			{ ticker: '^GSPC',     name: 'S&P 500',        icon: `${cdn}1F1FA-1F1F8.svg` },
			{ ticker: '^IXIC',     name: 'NASDAQ 100',     icon: `${cdn}1F4BB.svg` },
			{ ticker: '^FCHI',     name: 'CAC 40',         icon: `${cdn}1F1EB-1F1F7.svg` },
			{ ticker: '^STOXX50E', name: 'EURO STOXX 50',  icon: `${cdn}1F1EA-1F1FA.svg` },
			{ ticker: 'BTC-EUR',   name: 'BITCOIN',        icon: '₿' },
			{ ticker: 'GC=F',      name: 'OR (GOLD)',      icon: `${cdn}1FA99.svg` },
			{ ticker: 'EURUSD=X',  name: 'EUR / USD',      icon: `${cdn}1F4B1.svg` }
		];

		//Force le rafraîchissement des prix (bypass cache)
		// try {
			// await this.api.fetchBatchPrices(indices.map(i => i.ticker), true);
		// } catch (e) {
			// console.warn('fetchBatchPrices failed:', e);
		// }

		container.innerHTML = '';

		for (const idx of indices) {
			const data   = this.storage.getCurrentPrice(idx.ticker) || {};
			const price  = data.price || 0;
			const prev   = data.previousClose || price;
			const change = price - prev;
			const pct    = prev ? (change / prev) * 100 : 0;

			const priceStr = idx.ticker.includes('BTC')
				? Math.round(price).toLocaleString('fr') + ' €'
				: idx.ticker === 'EURUSD=X'
					? price.toFixed(4)
					: price.toFixed(2);

			const changeStr  = `${change >= 0 ? '+' : ''}${change.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
			const changeClass = change >= 0 ? 'stat-positive' : 'stat-negative';
			const assetStatus = this.marketStatus.getAssetStatus(idx.ticker);
			const statusLabel = assetStatus.label;
			const statusColor = assetStatus.color;

			// ————— SPARKLINE EN FOND —————
			let sparklineBg = '';
			try {
				const hist   = await this.api.getHistoricalPricesWithRetry(
					idx.ticker,
					Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000),
					Math.floor(Date.now() / 1000),
					'5m'
				);
				const values = Object.values(hist);

				if (values.length > 5) {
					const min   = Math.min(...values);
					const max   = Math.max(...values);
					const range = max - min || 1;

					const points = values
						.map((v, i) => {
							const x = (i / (values.length - 1)) * 100;
							const y = 88 - ((v - min) / range) * 70;
							return `${x},${y}`;
						})
						.join(' ');

					const color  = change >= 0 ? '#10b981' : '#ef4444';
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
				// Sparkline échouée → on ignore silencieusement
			}

			// ————— ICÔNE —————
			const iconHTML = idx.icon.includes('http')
				? `<img src="${idx.icon}" alt="" style="width:26px; height:26px; object-fit:contain; filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5));">`
				: `<span style="font-size:28px; filter:drop-shadow(0 1px 3px rgba(0,0,0,0.6));">${idx.icon}</span>`;

			// ————— CARTE —————
			const card = document.createElement('div');
			card.className = 'market-card';
			card.style.cssText = `
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

			card.innerHTML = `
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

			// ————— CLIC SUR LA CARTE —————
			card.onclick = async () => {
				document.querySelectorAll('.market-card').forEach(c => c.classList.remove('active-index'));
				card.classList.add('active-index');

				// Refresh immédiat du ticker cliqué
				await this.api.fetchBatchPrices([idx.ticker], true);
				this.loadMarketIndices();

				if (this.chart) {
					this.chart.showIndex(idx.ticker, idx.name);
				}

				if (window.innerWidth < 768) {
					document.querySelector('.dashboard-chart-section')?.scrollIntoView({ behavior: 'smooth' });
				}
			};

			container.appendChild(card);
		}
	}
	
	refreshDashboard() {
        this.loadPortfolioData();
        if (this.chart) this.chart.update(false, true);
        this.loadMarketIndices();
    }
}

document.addEventListener('DOMContentLoaded', () => new DashboardApp());