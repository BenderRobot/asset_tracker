// benderrobot/asset_tracker/asset_tracker-52109016fe138d6ac9b283096e2de3cfbb9437bb/newsApp.js

// ========================================
// newsApp.js - VERSION FINALE (Centralisation IA Personnalisée)
// ========================================

const STORAGE_KEY = 'customRssFeeds';
const NEWS_STORAGE_KEY = 'newsCache';

import { Storage } from './storage.js';
// AJOUT DES IMPORTS NÉCESSAIRES POUR LE CALCUL DE POSITION
import { PriceAPI } from './api.js';
import { DataManager } from './dataManager.js';
// IMPORT DU SERVICE IA CENTRALISÉ
import { fetchGeminiSummary, fetchGeminiContext } from './geminiService.js';

// Proxy pour contourner les erreurs CORS/403 de Google et autres sources
const PROXY_URL = 'https://corsproxy.io/?';

function formatFullDateTime(timestamp, includeTime = true) {
    const date = new Date(timestamp);
    const options = { day: '2-digit', month: 'short', year: 'numeric' };
    if (includeTime) {
        options.hour = '2-digit';
        options.minute = '2-digit';
    }
    return date.toLocaleString('fr-FR', options);
}

class NewsApp {
    constructor() {
        this.feeds = this.loadFeeds();
        this.currentNews = this.loadNewsCache();
        this.currentFilter = '';

        this.storage = new Storage();
        // INITIALISATION DU DATA MANAGER
        this.api = new PriceAPI(this.storage);
        this.dataManager = new DataManager(this.storage, this.api);

        this.myAssetsFilter = false;

        this.currentModalNewsItem = null;
        this.currentGeminiSummary = null;
    }

    loadFeeds() {
        const defaultFeeds = [
            { id: 1, label: 'Macro FR', url: 'https://news.google.com/rss/search?q=Marchés+Bourse+Paris+OR+CAC40+OR+économie+française&hl=fr&gl=FR&ceid=FR:fr', type: 'Google' },
            { id: 2, label: 'Wall Street', url: 'https://news.google.com/rss/search?q=Wall+Street+OR+Dow+Jones+OR+Nasdaq+OR+S&P500&hl=fr&gl=FR&ceid=FR:fr', type: 'Google' },
            { id: 3, label: 'Les Échos', url: 'https://rss.lesechos.fr/rss/rss_marches_financiers.xml', type: 'RSS Direct' },
            { id: 4, label: 'Boursorama', url: 'https://www.boursorama.com/patrimoine/actualites/rss/', type: 'RSS Direct' },
            { id: 5, label: 'Le Figaro Éco', url: 'https://www.lefigaro.fr/rss/figaro_economie.xml', type: 'RSS Direct' },
            { id: 6, label: 'Investir', url: 'https://rss.investir.lesechos.fr/rss_investir.xml', type: 'RSS Direct' },
            { id: 7, label: 'Reuters FR', url: 'https://www.reuters.com/tools/rss', type: 'RSS Direct' },
            { id: 8, label: 'Bloomberg', url: 'https://feeds.bloomberg.com/markets/news.rss', type: 'RSS Direct' },
            { id: 9, label: 'Financial Times', url: 'https://www.ft.com/rss', type: 'RSS Direct' },
            { id: 10, label: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', type: 'RSS Direct' },
            { id: 11, label: 'Zonebourse', url: 'https://www.zonebourse.com/rss/', type: 'RSS Direct' },
        ];

        try {
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
            const customFeeds = stored.filter(f => f.editable === true);
            return defaultFeeds.concat(customFeeds).map((f, i) => ({ ...f, id: i + 1000 }));
        } catch (e) {
            return defaultFeeds;
        }
    }

    loadNewsCache() {
        try {
            const cached = JSON.parse(localStorage.getItem(NEWS_STORAGE_KEY));
            if (cached && new Date(cached.timestamp).toDateString() === new Date().toDateString()) {
                return cached.data;
            }
        } catch (e) { }
        return [];
    }

    saveNewsCache(news) {
        localStorage.setItem(NEWS_STORAGE_KEY, JSON.stringify({
            timestamp: Date.now(),
            data: news
        }));
    }

    async fetchAllNews() {
        const container = document.getElementById('news-feed-container');
        container.innerHTML = `<div class="loading"><i class="fas fa-circle-notch fa-spin"></i> Chargement des actualités...</div>`;

        const allArticles = [];
        const seen = new Set();
        const ARTICLE_LIMIT_PER_FEED = 5;

        for (const feed of this.feeds) {

            let fetchUrl = PROXY_URL + encodeURIComponent(feed.url);

            try {
                const response = await fetch(fetchUrl, { cache: "no-store", signal: AbortSignal.timeout(5000) });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} ou Timeout`);
                }

                const xmlText = await response.text();

                const doc = new DOMParser().parseFromString(xmlText, "text/xml");
                if (doc.querySelector("parsererror")) {
                    throw new Error('Erreur de parsing XML');
                }

                const items = doc.querySelectorAll("item");
                let count = 0;

                items.forEach(item => {
                    if (count >= ARTICLE_LIMIT_PER_FEED) return;

                    let title = (item.querySelector("title")?.textContent || "Sans titre").trim();
                    const link = item.querySelector("link")?.textContent || "#";
                    const pubDate = item.querySelector("pubDate")?.textContent || new Date().toISOString();
                    let source = item.querySelector("source")?.textContent || feed.label;

                    if (feed.type === 'Google' && title.includes(" - ")) {
                        const parts = title.split(" - ");
                        source = parts.pop().trim();
                        title = parts.join(" - ").trim();
                    }

                    const key = title.toLowerCase();
                    if (!seen.has(key)) {
                        seen.add(key);
                        allArticles.push({
                            title,
                            link,
                            source: source || "Inconnu",
                            label: feed.label,
                            datetime: new Date(pubDate).getTime(),
                            formattedDate: formatFullDateTime(new Date(pubDate).getTime(), true)
                        });
                        count++;
                    }
                });
            } catch (err) {
                console.warn(`Échec ${feed.label}:`, err.message);
            }
        }

        allArticles.sort((a, b) => b.datetime - a.datetime);
        this.currentNews = allArticles.slice(0, 200);
        this.saveNewsCache(this.currentNews);
        this.renderNewsFeed();
        this.renderFilterSelect();
        this.setupModalEventListeners();
    }

    getUniqueAssetNames() {
        const purchases = this.storage.getPurchases();
        const uniqueNames = [...new Set(purchases.filter(p => p.assetType !== 'Cash').map(p => p.name))];
        return uniqueNames.filter(name => name.trim().length > 0);
    }

    getColorForSource(sourceName) {
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

    renderNewsFeed() {
        const container = document.getElementById('news-feed-container');
        let news = this.currentNews;

        if (this.currentFilter && this.currentFilter !== '') {
            news = news.filter(n => n.label === this.currentFilter);
        }

        if (this.myAssetsFilter) {
            const assetNames = this.getUniqueAssetNames().map(name => name.toLowerCase());
            news = news.filter(n => {
                const titleLower = n.title.toLowerCase();
                return assetNames.some(name => titleLower.includes(name.toLowerCase()));
            });
        }

        if (news.length === 0) {
            container.innerHTML = '<div class="loading">Aucune actualité trouvée.</div>';
            return;
        }

        container.innerHTML = news.map((n, i) => {
            const sourceColor = this.getColorForSource(n.source);
            const isRedundant = n.source.trim() === n.label.trim();
            const labelContent = isRedundant ? '' : this.escapeHtml(n.label);

            return `
            <a href="#" class="news-card" data-index="${i}">
                <div class="news-card-header">
                    <span class="source-tag" style="background-color: ${sourceColor};" data-source="${this.escapeHtml(n.source)}">${this.escapeHtml(n.source)}</span>
                    <span class="feed-label">${labelContent}</span>
                </div>
                <h3 class="news-card-title">${this.escapeHtml(n.title)}</h3>
                <div class="news-card-footer">
                    <span><i class="fas fa-clock"></i> ${n.formattedDate}</span>
                    <i class="fas fa-external-link-alt"></i>
                </div>
            </a>
        `}).join('');

        container.querySelectorAll('.news-card').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const idx = item.dataset.index;
                // BUGFIX: Use 'news' (the filtered array) instead of 'this.currentNews' (the global array)
                // because 'idx' corresponds to the position in the filtered list.
                const data = news[idx];
                this.openNewsModal(data);
            });
        });
    }

    renderFilterSelect() {
        const select = document.getElementById('filter-feed-select');
        if (!select) return;

        const uniqueLabels = [...new Set(this.feeds.map(f => f.label))].sort();
        const options = `<option value="">Tout</option>` +
            uniqueLabels.map(label =>
                `<option value="${label}" ${this.currentFilter === label ? 'selected' : ''}>${label}</option>`
            ).join('');

        select.innerHTML = options;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Tente de déterminer l'objet de position (Holdings) correspondant à un article de news.
     * @param {object} newsItem - L'objet de la news (name/title)
     * @returns {object|null} L'objet de position calculé par DataManager, ou null.
     */
    getHoldingDetailsForNews(newsItem) {
        const allPurchases = this.storage.getPurchases().filter(p => p.assetType !== 'Cash');
        // NOTE: On suppose que les prix ont déjà été rafraîchis pour avoir la dernière position.
        const allHoldings = this.dataManager.calculateHoldings(allPurchases);

        const newsTitleLower = (newsItem.title || newsItem.name).toLowerCase();

        const foundHolding = allHoldings.find(h => {
            const nameLower = h.name.toLowerCase();
            const tickerLower = h.ticker.toLowerCase();

            // Tentative A: Le nom de l'actif contient le titre ou vice-versa (plus robuste)
            const nameMatch = newsTitleLower.includes(nameLower) || nameLower.includes(newsTitleLower);

            // Tentative B: Match par le Ticker exact
            const tickerMatch = newsTitleLower.includes(tickerLower);

            return nameMatch || tickerMatch;
        });

        if (foundHolding && foundHolding.quantity > 0) {
            return foundHolding;
        }

        return null;
    }

    async openNewsModal(newsItem) {
        const modal = document.getElementById('news-modal');
        if (!modal) return;

        this.currentModalNewsItem = newsItem;
        this.currentGeminiSummary = null;

        const contextBox = document.getElementById('modal-news-context');
        if (contextBox) { contextBox.classList.remove('show'); contextBox.style.display = 'none'; }

        const pubDateEl = document.getElementById('modal-news-pubdate');
        if (pubDateEl) pubDateEl.textContent = formatFullDateTime(newsItem.datetime, true);

        const sourceColor = this.getColorForSource(newsItem.source);
        document.getElementById('modal-news-ticker').textContent = newsItem.source;
        document.getElementById('modal-news-ticker').style.backgroundColor = sourceColor;
        document.getElementById('modal-news-title').textContent = newsItem.title;
        document.getElementById('modal-news-link').href = newsItem.link || '#';

        const summaryDiv = document.getElementById('modal-news-summary');
        summaryDiv.innerHTML = '<span class="loading-text">Gemini analyse...</span>';

        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('show'), 10);

        try {
            const context = `Titre: "${newsItem.title}". Source: ${newsItem.source}. Sujet: ${newsItem.label}`;
            const summary = await fetchGeminiSummary(context);
            this.currentGeminiSummary = summary;
            summaryDiv.innerHTML = summary;
        } catch (error) {
            summaryDiv.innerHTML = "Analyse indisponible (Erreur API).";
        }
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

        // NOUVEAU: Récupérer les détails de la position pour cet actif
        const holdingDetails = this.getHoldingDetailsForNews(newsItem);

        // APPEL CENTRALISÉ avec les données du portefeuille
        fetchGeminiContext(newsItem.title, currentSummary, holdingDetails)
            .then(contextSummary => { contextContent.innerHTML = contextSummary; })
            .catch(() => { contextContent.innerHTML = "Échec de l'analyse contextuelle."; });
    }

    setupModalEventListeners() {
        const modal = document.getElementById('news-modal');
        const closeBtn = document.getElementById('close-news-modal');
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

    setupEventListeners() {
        document.getElementById('refresh-news-btn')?.addEventListener('click', () => {
            this.fetchAllNews();
        });

        const filterAssetsBtn = document.getElementById('filter-my-assets-btn');
        if (filterAssetsBtn) {
            filterAssetsBtn.addEventListener('click', () => {
                this.myAssetsFilter = !this.myAssetsFilter;
                filterAssetsBtn.classList.toggle('active', this.myAssetsFilter);

                if (this.myAssetsFilter) {
                    this.currentFilter = '';
                    const select = document.getElementById('filter-feed-select');
                    if (select) select.value = '';
                }

                this.renderNewsFeed();
            });
        }

        document.getElementById('filter-feed-select')?.addEventListener('change', (e) => {
            this.currentFilter = e.target.value;

            if (this.currentFilter !== '') {
                this.myAssetsFilter = false;
                document.getElementById('filter-my-assets-btn')?.classList.remove('active');
            }

            this.renderNewsFeed();
        });
    }

    init() {
        this.setupEventListeners();
        this.renderFilterSelect();

        if (this.currentNews.length > 0) {
            this.renderNewsFeed();
        } else {
            this.fetchAllNews();
        }
        this.setupModalEventListeners();
    }
}

// Démarrage
document.addEventListener('DOMContentLoaded', () => {
    new NewsApp().init();
});