const STORAGE_KEY = 'customRssFeeds';
const NEWS_STORAGE_KEY = 'newsCache_v2'; // v2 = force bust du cache stale

import { Storage } from './storage.js';
import { PriceAPI } from './api.js';
import { DataManager } from './dataManager.js';
import { fetchGeminiSummary, fetchGeminiContext } from './geminiService.js';

// Même proxy que dashboardApp.js — fonctionne avec timeout 30s
const PROXY_URL = 'https://fetchrss-ff7p645u3q-uc.a.run.app?url=';
const ARTICLE_LIMIT_PER_FEED = 6;

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
        this.api = new PriceAPI(this.storage);
        this.dataManager = new DataManager(this.storage, this.api);

        this.myAssetsFilter = false;
        this.currentModalNewsItem = null;
        this.currentGeminiSummary = null;
    }

    loadFeeds() {
        const defaultFeeds = [
            { label: 'Macro FR',          query: 'Marchés Bourse Paris CAC40 économie française' },
            { label: 'Wall Street',        query: 'Wall Street Dow Jones Nasdaq S&P500' },
            { label: 'Crypto',             query: 'Bitcoin Ethereum crypto DeFi blockchain' },
            { label: 'Tech',               query: 'NVIDIA Apple Microsoft Meta Alphabet bourse' },
            { label: 'Énergie & Matières', query: 'pétrole gaz or matières premières énergie bourse' },
            { label: 'Immobilier',         query: 'immobilier France SCPI investissement locatif' },
            { label: 'Politique Monétaire',query: 'inflation BCE Fed taux intérêt banque centrale' },
            { label: 'Startups & VC',      query: 'startup IPO financement levée fonds venture capital' },
        ];

        try {
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
            const customFeeds = stored.filter(f => f.editable === true).map(f => ({ label: f.label, query: f.label }));
            return defaultFeeds.concat(customFeeds).map((f, i) => ({ ...f, id: i + 1000 }));
        } catch (e) {
            return defaultFeeds;
        }
    }

    loadNewsCache() {
        try {
            const cached = JSON.parse(localStorage.getItem(NEWS_STORAGE_KEY));
            if (cached && cached.data.length > 0 && new Date(cached.timestamp).toDateString() === new Date().toDateString()) {
                return cached.data;
            }
        } catch (e) {}
        return [];
    }

    saveNewsCache(news) {
        localStorage.setItem(NEWS_STORAGE_KEY, JSON.stringify({ timestamp: Date.now(), data: news }));
    }

    // Même logique exacte que dashboardApp.js::fetchGoogleRSS — prouvée fonctionnelle
    fetchGoogleRSS(feed) {
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(feed.query)}&hl=fr&gl=FR&ceid=FR:fr`;
        const url = PROXY_URL + encodeURIComponent(rssUrl);

        return fetch(url, { signal: AbortSignal.timeout(30000) })
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.text();
            })
            .then(xmlText => {
                const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
                if (doc.querySelector('parsererror')) throw new Error('Invalid XML');

                return Array.from(doc.querySelectorAll('item')).slice(0, ARTICLE_LIMIT_PER_FEED).map(item => {
                    const pubDate = item.querySelector('pubDate')?.textContent || '';
                    const fullTitle = item.querySelector('title')?.textContent || 'Sans titre';
                    const parts = fullTitle.split(' - ');
                    const source = parts.length > 1 ? parts.pop().trim() : feed.label;
                    const title = parts.join(' - ').trim();
                    const datetime = pubDate ? new Date(pubDate).getTime() : Date.now();

                    return {
                        title,
                        link: item.querySelector('link')?.textContent || '#',
                        source,
                        label: feed.label,
                        datetime,
                        formattedDate: formatFullDateTime(datetime, true),
                    };
                });
            })
            .catch(err => {
                console.warn(`[${feed.label}] Échec RSS:`, err.message);
                return [];
            });
    }

    async fetchAllNews() {
        const container = document.getElementById('news-feed-container');
        const total = this.feeds.length;
        let loaded = 0;

        container.innerHTML = `<div class="loading"><i class="fas fa-circle-notch fa-spin"></i><br>Chargement... <span id="feed-progress">0/${total}</span> flux</div>`;

        const updateProgress = () => {
            loaded++;
            const el = document.getElementById('feed-progress');
            if (el) el.textContent = `${loaded}/${total}`;
        };

        const results = await Promise.allSettled(
            this.feeds.map(feed =>
                this.fetchGoogleRSS(feed).then(articles => { updateProgress(); return articles; })
            )
        );

        const seen = new Set();
        const allArticles = results
            .filter(r => r.status === 'fulfilled')
            .flatMap(r => r.value)
            .filter(a => {
                const key = a.title.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

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
        const h = Math.abs(hash) % 360;
        const s = 65 + (Math.abs(hash) % 15);
        const l = 32 + (Math.abs(hash) % 8);
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
                return assetNames.some(name => titleLower.includes(name));
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
            </a>`;
        }).join('');

        container.querySelectorAll('.news-card').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                this.openNewsModal(news[item.dataset.index]);
            });
        });
    }

    renderFilterSelect() {
        const select = document.getElementById('filter-feed-select');
        if (!select) return;
        const uniqueLabels = [...new Set(this.feeds.map(f => f.label))].sort();
        select.innerHTML = `<option value="">Tout</option>` +
            uniqueLabels.map(label =>
                `<option value="${label}" ${this.currentFilter === label ? 'selected' : ''}>${label}</option>`
            ).join('');
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    getHoldingDetailsForNews(newsItem) {
        const allPurchases = this.storage.getPurchases().filter(p => p.assetType !== 'Cash' && p.assetType !== 'Dividend');
        const allHoldings = this.dataManager.calculateHoldings(allPurchases);
        const newsTitleLower = (newsItem.title || newsItem.name).toLowerCase();

        const foundHolding = allHoldings.find(h => {
            const nameLower = h.name.toLowerCase();
            const tickerLower = h.ticker.toLowerCase();
            return newsTitleLower.includes(nameLower) || nameLower.includes(newsTitleLower) || newsTitleLower.includes(tickerLower);
        });

        return (foundHolding && foundHolding.quantity > 0) ? foundHolding : null;
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
            summaryDiv.innerHTML = 'Analyse indisponible (Erreur API).';
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

        fetchGeminiContext(newsItem.title, currentSummary, this.getHoldingDetailsForNews(newsItem))
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
            localStorage.removeItem(NEWS_STORAGE_KEY);
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

document.addEventListener('DOMContentLoaded', () => {
    new NewsApp().init();
});
