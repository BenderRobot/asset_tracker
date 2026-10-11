import { marketCalendarEngine } from './MarketCalendarEngine.js';

const PAUSE_KEY = 'dashboard_ticker_paused_v1';
const readPause = () => { try { return localStorage.getItem(PAUSE_KEY) === 'true'; } catch { return false; } };
// Beyond this many positions, keep only the best and worst movers.
const MOVERS_PER_SIDE = 6;

const pctFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eurFormat = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sessionDayFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: '2-digit', month: '2-digit' });

// Last civil day whose session is over: today after the close, otherwise the
// previous trading day (weekends skipped; holidays aren't known here).
function lastSessionDay(ticker, now, calendar) {
    const today = new Date(now);
    const session = calendar.getSession(ticker, today);
    if (session && now >= session.closeUTCMs) return today;
    const day = new Date(today);
    for (let i = 0; i < 7; i++) {
        day.setDate(day.getDate() - 1);
        if (calendar.isTradingDay(ticker, day)) return day;
    }
    return null;
}

/**
 * Portfolio positions shown in the ticker, best to worst daily move.
 * Open markets and cryptos use today's move; closed markets show their last
 * session (e.g. Friday's move during the weekend), flagged as closed.
 */
export function selectPortfolioMovers(holdings, { now = Date.now(), calendar = marketCalendarEngine } = {}) {
    const items = (holdings || []).flatMap(h => {
        if (!h?.ticker || h.ticker.startsWith('CASH-') || h.assetType === 'Real Estate') return [];
        if (h.priceDataUnavailable || !(h.quantity > 0)) return [];
        const pct = Number.isFinite(h.displayDayPct) ? h.displayDayPct : h.dayPct;
        if (!Number.isFinite(pct)) return [];
        const change = Number.isFinite(h.displayDayChange) ? h.displayDayChange : h.dayChange;
        const continuous = calendar.getTradingModel(h.ticker) === 'crypto_24_7';
        const open = continuous || calendar.isMarketOpen(h.ticker, now);
        let stateLabel = continuous ? 'Marché 24/7' : 'Séance ouverte';
        if (!open) {
            const day = lastSessionDay(h.ticker, now, calendar);
            stateLabel = day ? `Fermé · séance du ${sessionDayFormat.format(day)}` : 'Fermé · dernière séance';
        }
        return [{
            ticker: h.ticker, name: h.name || h.ticker, price: h.currentPrice, pct,
            change: Number.isFinite(change) ? change : null,
            state: continuous ? 'continuous' : open ? 'open' : 'closed', stateLabel
        }];
    }).sort((a, b) => b.pct - a.pct);
    if (items.length <= MOVERS_PER_SIDE * 2) return items;
    return [...items.slice(0, MOVERS_PER_SIDE), ...items.slice(-MOVERS_PER_SIDE)];
}

// A view of the dashboard portfolio snapshot: no network request or timer here.
export class MarketTicker {
    constructor(root, onSelect) {
        this.root = root;
        this.onSelect = onSelect;
        this.items = new Map();
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
            const node = event.target.closest('[data-ticker]');
            const item = node && this.items.get(node.dataset.ticker);
            if (item) this.onSelect(item);
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

    update(items) {
        if (!this.root || !this.track) return;
        this.items = new Map(items.map(item => [item.ticker, item]));
        const keys = JSON.stringify([...this.items.keys()]);
        if (keys !== this.keys) {
            this.keys = keys;
            this.track.replaceChildren();
            for (let copy = 0; copy < 2; copy++) {
                const group = document.createElement('div');
                group.className = `market-ticker-group${copy ? ' market-ticker-copy' : ''}`;
                if (copy) group.setAttribute('aria-hidden', 'true');
                for (const item of items) {
                    const node = document.createElement(copy ? 'span' : 'button');
                    if (!copy) node.type = 'button';
                    node.className = 'market-ticker-item';
                    node.dataset.ticker = item.ticker;
                    for (const name of ['name', 'price', 'change', 'state', 'amount']) {
                        const span = document.createElement('span');
                        span.className = `ticker-${name}`;
                        node.append(span);
                    }
                    group.append(node);
                }
                this.track.append(group);
            }
            this.track.style.setProperty('--ticker-duration', `${Math.max(45, items.length * 9)}s`);
        }
        this.root.classList.toggle('is-empty', items.length === 0);
        for (const node of this.track.querySelectorAll('[data-ticker]')) {
            const item = this.items.get(node.dataset.ticker);
            const tone = item.pct > 0 ? 'stat-positive' : item.pct < 0 ? 'stat-negative' : 'stat-neutral';
            const pctText = `${item.pct > 0 ? '▲ +' : item.pct < 0 ? '▼ ' : ''}${pctFormat.format(item.pct)} %`;
            const priceText = Number.isFinite(item.price) ? eurFormat.format(item.price) : '—';
            const amountText = item.change === null ? '' : `${item.change > 0 ? '+' : ''}${eurFormat.format(item.change)}`;
            node.classList.remove('is-open', 'is-closed', 'is-continuous');
            node.classList.add(`is-${item.state}`);
            node.querySelector('.ticker-name').textContent = item.name;
            node.querySelector('.ticker-price').textContent = priceText;
            const change = node.querySelector('.ticker-change');
            change.textContent = pctText;
            change.className = `ticker-change ${tone}`;
            node.querySelector('.ticker-state').textContent = item.stateLabel;
            const amount = node.querySelector('.ticker-amount');
            amount.textContent = amountText;
            amount.className = `ticker-amount ${tone}`;
            node.title = `${item.name} (${item.ticker}) · ${item.stateLabel}`;
            if (node.tagName === 'BUTTON') {
                node.setAttribute('aria-label', `${item.name}, ${priceText}, ${pctText}${amountText ? `, ${amountText}` : ''}. ${item.stateLabel}. Afficher le graphique`);
            }
        }
        this.updateOverflow();
    }
}
