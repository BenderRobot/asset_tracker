import { presentDashboardQuote } from './dashboardMarketData.js';

const PAUSE_KEY = 'dashboard_ticker_paused_v1';
const readPause = () => { try { return localStorage.getItem(PAUSE_KEY) === 'true'; } catch { return false; } };

// A view of the dashboard quote cycle: no network request or timer here.
export class MarketTicker {
    constructor(root, onSelect) {
        this.root = root;
        this.onSelect = onSelect;
        this.rows = new Map();
        this.paused = readPause();
        if (!root) return;
        this.track = root.querySelector('.market-ticker-track');
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.updateOverflow());
            this.resizeObserver.observe(root);
        }
        this.pauseButton = root.querySelector('[data-ticker-pause]');
        this.pauseButton?.addEventListener('click', () => {
            this.paused = !this.paused;
            try { localStorage.setItem(PAUSE_KEY, String(this.paused)); } catch { /* storage optional */ }
            this.syncPause();
        });
        root.addEventListener('click', event => {
            const item = event.target.closest('[data-market-symbol]');
            const row = item && this.rows.get(item.dataset.marketSymbol);
            if (row?.quote) this.onSelect(row);
        });
        this.syncPause();
    }

    syncPause() {
        if (!this.root) return;
        this.root.classList.toggle('is-paused', this.paused);
        this.pauseButton?.setAttribute('aria-pressed', String(this.paused));
        if (this.pauseButton) {
            this.pauseButton.textContent = this.paused ? '▶' : 'Ⅱ';
            this.pauseButton.setAttribute('aria-label', this.paused ? 'Reprendre le défilement des cotations' : 'Mettre en pause le défilement des cotations');
            this.pauseButton.title = this.paused ? 'Reprendre le défilement' : 'Mettre en pause';
        }
    }

    updateOverflow() {
        const viewport = this.root?.querySelector('.market-ticker-viewport');
        const group = this.track?.querySelector('.market-ticker-group');
        if (viewport && group) this.root.classList.toggle('is-static', group.scrollWidth <= viewport.clientWidth);
    }

    update(rows) {
        if (!this.root || !this.track) return;
        this.rows = new Map(rows.map(row => [row.idx.ticker, row]));
        const keys = JSON.stringify([...this.rows.keys()]);
        if (keys !== this.keys) {
            this.keys = keys;
            this.track.replaceChildren();
            for (let copy = 0; copy < 2; copy++) {
                const group = document.createElement('div');
                group.className = `market-ticker-group${copy ? ' market-ticker-copy' : ''}`;
                if (copy) group.setAttribute('aria-hidden', 'true');
                for (const row of rows) {
                    const item = document.createElement(copy ? 'span' : 'button');
                    if (!copy) item.type = 'button';
                    item.className = 'market-ticker-item';
                    item.dataset.marketSymbol = row.idx.ticker;
                    for (const name of ['name', 'price', 'change', 'state']) {
                        const span = document.createElement('span');
                        span.className = `ticker-${name}`;
                        item.append(span);
                    }
                    group.append(item);
                }
                this.track.append(group);
            }
            this.track.style.setProperty('--ticker-duration', `${Math.max(45, rows.length * 12)}s`);
        }
        this.root.classList.toggle('is-empty', rows.length === 0);
        for (const item of this.track.querySelectorAll('[data-market-symbol]')) {
            const row = this.rows.get(item.dataset.marketSymbol);
            const view = presentDashboardQuote(row.targetTicker, row.quote);
            const name = row.isFuturesSwap ? `${row.idx.name} · Future ${row.future.code}`
                : row.targetTicker.endsWith('=F') ? `${row.idx.name} · Future` : row.idx.name;
            item.querySelector('.ticker-name').textContent = name;
            item.querySelector('.ticker-price').textContent = view.priceText;
            const change = item.querySelector('.ticker-change');
            change.textContent = view.pctText;
            change.className = `ticker-change ${view.tone}`;
            item.querySelector('.ticker-state').textContent = `${view.status} · ${view.time}`;
            item.title = `${name} (${row.targetTicker}) · ${view.detail}`;
            if (item.tagName === 'BUTTON') {
                item.disabled = !row.quote;
                item.setAttribute('aria-label', `${name}, ${view.priceText}, ${view.pctText}. ${view.detail}. Afficher le graphique`);
            }
        }
        this.updateOverflow();
    }
}
