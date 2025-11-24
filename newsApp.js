// ========================================
// newsApp.js - VERSION ULTRA CLEAN 2025
// Focus 100% actualités + code couleur par source
// ========================================

const STORAGE_KEY = 'customRssFeeds';
const NEWS_STORAGE_KEY = 'newsCache';

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
        this.currentFilter = ''; // '' = tout afficher
    }

    loadFeeds() {
        const defaultFeeds = [
            { id: 1, label: 'Macro FR',        url: 'https://news.google.com/rss/search?q=Marchés+Bourse+Paris+OR+CAC40+OR+économie+française&hl=fr&gl=FR&ceid=FR:fr', type: 'Google' },
            { id: 2, label: 'Wall Street',     url: 'https://news.google.com/rss/search?q=Wall+Street+OR+Dow+Jones+OR+Nasdaq+OR+S&P500&hl=fr&gl=FR&ceid=FR:fr', type: 'Google' },
            { id: 3, label: 'Les Échos',       url: 'https://www.lesechos.fr/rss/les-echos.xml', type: 'RSS Direct' },
            { id: 4, label: 'Boursorama',      url: 'https://www.boursorama.com/bourse/rss/', type: 'RSS Direct' },
            { id: 5, label: 'Le Figaro Éco',   url: 'https://www.lefigaro.fr/rss/figaro_economie.xml', type: 'RSS Direct' },
            { id: 6, label: 'Investir',        url: 'https://investir.lesechos.fr/rss/investir.xml', type: 'RSS Direct' },
            { id: 7, label: 'Reuters FR',      url: 'https://www.reuters.com/tools/rss', type: 'RSS Direct' },
            { id: 8, label: 'Bloomberg',       url: 'https://feeds.bloomberg.com/markets/news.rss', type: 'RSS Direct' },
            { id: 9, label: 'Financial Times', url: 'https://www.ft.com/rss', type: 'RSS Direct' },
            { id: 10, label: 'CoinDesk',       url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', type: 'RSS Direct' },
            { id: 11, label: 'Zonebourse',     url: 'https://www.zonebourse.com/rss/', type: 'RSS Direct' },
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

        for (const feed of this.feeds) {
            let fetchUrl = feed.type === 'Google'
                ? feed.url
                : `https://api.allorigins.win/get?url=${encodeURIComponent(feed.url)}`;

            try {
                const response = await fetch(fetchUrl, { cache: "no-store" });
                if (!response.ok) continue;

                let xmlText = feed.type === 'Google'
                    ? await response.text()
                    : (await response.json()).contents;

                const doc = new DOMParser().parseFromString(xmlText, "text/xml");
                if (doc.querySelector("parsererror")) continue;

                const items = doc.querySelectorAll("item");
                items.forEach(item => {
                    let title = (item.querySelector("title")?.textContent || "Sans titre").trim();
                    const link = item.querySelector("link")?.textContent || "#";
                    const pubDate = item.querySelector("pubDate")?.textContent || new Date().toISOString();
                    let source = item.querySelector("source")?.textContent || feed.label;

                    // Nettoyage Google News : "Titre - Source" → on extrait la source
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
    }

    renderNewsFeed() {
        const container = document.getElementById('news-feed-container');
        let news = this.currentNews;

        if (this.currentFilter && this.currentFilter !== '') {
            news = news.filter(n => n.label === this.currentFilter);
        }

        if (news.length === 0) {
            container.innerHTML = '<div class="loading">Aucune actualité trouvée.</div>';
            return;
        }

        container.innerHTML = news.map(n => `
            <a href="${n.link}" target="_blank" class="news-card">
                <div class="news-card-header">
                    <span class="source-tag" data-source="${this.escapeHtml(n.source)}">${this.escapeHtml(n.source)}</span>
                    <span class="feed-label">${n.label}</span>
                </div>
                <h3 class="news-card-title">${this.escapeHtml(n.title)}</h3>
                <div class="news-card-footer">
                    <span><i class="fas fa-clock"></i> ${n.formattedDate}</span>
                    <i class="fas fa-external-link-alt"></i>
                </div>
            </a>
        `).join('');
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

    setupEventListeners() {
        document.getElementById('refresh-news-btn')?.addEventListener('click', () => {
            this.fetchAllNews();
        });

        document.getElementById('filter-feed-select')?.addEventListener('change', (e) => {
            this.currentFilter = e.target.value;
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
    }
}

// Démarrage
document.addEventListener('DOMContentLoaded', () => {
    new NewsApp().init();
});