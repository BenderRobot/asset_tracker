import { marketCalendarEngine } from './MarketCalendarEngine.js';
import { quoteSession } from './dashboardMarketData.js';

const PAUSE_KEY = 'dashboard_ticker_paused_v1';
const DRAG_THRESHOLD_PX = 5;
// After a manual scroll or drag, wait before auto-scrolling again.
const RESUME_DELAY_MS = 3000;
const readPause = () => { try { return localStorage.getItem(PAUSE_KEY) === 'true'; } catch { return false; } };
// Beyond this many positions, keep only the best and worst movers.
const MOVERS_PER_SIDE = 6;

const pctFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eurFormat = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sessionDayFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: '2-digit', month: '2-digit' });
const quoteTimeFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
// HistoryCalculator stops preferring a live price after ten minutes.
const OLD_QUOTE_MS = 10 * 60000;

/**
 * Portfolio positions shown in the ticker, best to worst daily move.
 * Open markets and cryptos use today's move; closed markets show their last
 * session (e.g. Friday's move during the weekend), flagged as closed.
 */
export function selectPortfolioMovers(holdings, {
    now = Date.now(), calendar = marketCalendarEngine, priceQuotes = null,
    lastSessionPerformance = null, staleInstruments = [], staleAll = false
} = {}) {
    const staleTickers = new Set(staleInstruments);
    const items = (holdings || []).flatMap(h => {
        if (!h?.ticker || h.ticker.startsWith('CASH-') || h.assetType === 'Real Estate') return [];
        if (h.priceDataUnavailable || !(h.quantity > 0)) return [];
        const pct = Number.isFinite(h.displayDayPct) ? h.displayDayPct : h.dayPct;
        if (!Number.isFinite(pct)) return [];
        const change = Number.isFinite(h.displayDayChange) ? h.displayDayChange : h.dayChange;
        const continuous = calendar.getTradingModel(h.ticker) === 'crypto_24_7';
        const futureOrForex = h.ticker.endsWith('=F') || h.ticker.endsWith('=X');
        const metadata = calendar.getProviderMetadata?.(h.ticker);
        const observed = futureOrForex ? quoteSession(h.ticker, metadata, now) : null;
        const session = continuous || futureOrForex ? null : calendar.getSession(h.ticker, new Date(now));
        const providerSession = session?.source === 'provider';
        const exchangeClosed = !continuous && !futureOrForex && calendar.getTradingDayStatus(h.ticker, new Date(now)) === 'HOLIDAY_CONFIRMED';
        const tradeObservedToday = providerSession && Number.isFinite(metadata?.lastQuoteTimeMs)
            && metadata.lastQuoteTimeMs >= session.openUTCMs && metadata.lastQuoteTimeMs <= now;
        const tradeObservedInFutureSession = futureOrForex && observed === 'OPEN'
            && Number.isFinite(metadata?.lastQuoteTimeMs)
            && metadata.lastQuoteTimeMs >= metadata.regularSession.startMs && metadata.lastQuoteTimeMs <= now;
        const open = futureOrForex ? tradeObservedInFutureSession
            : !exchangeClosed && tradeObservedToday && now < session.closeUTCMs;
        const closed = futureOrForex ? observed === 'CLOSED'
            : exchangeClosed || (session && ['provider', 'official-calendar'].includes(session.source) && now >= session.closeUTCMs);
        const state = continuous ? 'continuous' : open ? 'open' : closed ? 'closed' : 'unknown';
        let stateLabel = continuous ? 'Marché 24/7' : open ? 'Séance observée' : 'Séance non confirmée';
        if (closed) {
            const lastSession = lastSessionPerformance?.get(h.ticker);
            const sessionCloseTs = lastSession?.sessionCloseTs;
            // A guessed weekday is not evidence of the session that produced
            // this figure (Friday may have been a holiday).
            stateLabel = lastSession?.sessionCloseObserved && Number.isFinite(sessionCloseTs)
                && sessionCloseTs > 0 && sessionCloseTs <= now
                ? `Fermé · séance du ${sessionDayFormat.format(sessionCloseTs)}`
                : 'Fermé · date de séance inconnue';
        }
        const quote = priceQuotes?.get(h.ticker);
        const receivedAt = Number.isFinite(quote?.lastUpdate) && quote.lastUpdate > 0 && quote.lastUpdate <= now
            ? quote.lastUpdate : null;
        const refreshFailed = staleTickers.has(h.ticker) || !!quote?.stale;
        const indicativeOpen = (futureOrForex && observed === 'OPEN')
            || (session?.source === 'heuristic-fallback' && now >= session.openUTCMs && now < session.closeUTCMs);
        const oldDuringSession = (open || continuous || indicativeOpen) && receivedAt !== null && now - receivedAt > OLD_QUOTE_MS;
        const stale = staleAll || refreshFailed || oldDuringSession;
        const timeLabel = receivedAt === null ? 'heure inconnue' : quoteTimeFormat.format(receivedAt);
        const freshnessLabel = refreshFailed ? `Actualisation indisponible · ${timeLabel}`
            : oldDuringSession ? `Cours ancien · ${timeLabel}`
            : staleAll ? `À actualiser · ${timeLabel}`
            : receivedAt === null ? 'Heure de la donnée inconnue' : `Donnée ${timeLabel}`;
        return [{
            ticker: h.ticker, name: h.name || h.ticker, price: h.currentPrice, pct,
            change: Number.isFinite(change) ? change : null,
            state, stateLabel, freshnessLabel, stale,
            detail: `${stateLabel} · ${freshnessLabel}${receivedAt === null ? '' : ' (heure de récupération)'}`
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
        this.viewport = root.querySelector('.market-ticker-viewport');
        this.setupScrolling();
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
            // The end of a click-and-drag is not a selection.
            if (this.suppressClick) { this.suppressClick = false; event.preventDefault(); return; }
            const node = event.target.closest('[data-ticker]');
            const item = node && this.items.get(node.dataset.ticker);
            if (item) this.onSelect(item);
        });
        this.syncPause();
    }

    // Auto-scroll drives the viewport's own scrollLeft (not a CSS transform),
    // so trackpad/touch scrolling and click-and-drag move the same position.
    // Two identical groups make the loop seamless in both directions.
    setupScrolling() {
        const viewport = this.viewport;
        if (!viewport) return;
        this.position = 0;
        this.lastInteraction = 0;
        this.hovered = false;
        const touch = () => { this.lastInteraction = Date.now(); };
        viewport.addEventListener('scroll', () => {
            // Ignore the scroll events produced by the animation itself.
            if (Math.abs(viewport.scrollLeft - Math.round(this.position)) <= 1) return;
            this.position = viewport.scrollLeft;
            if (this.wrap()) viewport.scrollLeft = this.position;
            touch();
        }, { passive: true });
        viewport.addEventListener('wheel', touch, { passive: true });
        viewport.addEventListener('touchstart', touch, { passive: true });
        this.root.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') this.hovered = true; });
        this.root.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') this.hovered = false; });

        let drag = null;
        viewport.addEventListener('pointerdown', event => {
            // A drag ending outside an item emits no click: never swallow a later one.
            this.suppressClick = false;
            if (event.pointerType !== 'mouse' || event.button !== 0) return;
            drag = { x: event.clientX, start: viewport.scrollLeft, moved: false, id: event.pointerId };
        });
        viewport.addEventListener('pointermove', event => {
            if (!drag || event.pointerId !== drag.id) return;
            const dx = event.clientX - drag.x;
            if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
            if (!drag.moved) {
                drag.moved = true;
                viewport.setPointerCapture?.(event.pointerId);
                this.root.classList.add('is-dragging');
            }
            this.position = drag.start - dx;
            // Wrapped: re-anchor the drag so the content keeps following the pointer.
            if (this.wrap()) drag.start = this.position + dx;
            viewport.scrollLeft = this.position;
            touch();
        });
        const endDrag = event => {
            if (!drag || event.pointerId !== drag.id) return;
            if (drag.moved) this.suppressClick = true;
            drag = null;
            this.root.classList.remove('is-dragging');
            touch();
        };
        viewport.addEventListener('pointerup', endDrag);
        viewport.addEventListener('pointercancel', endDrag);
        this.dragging = () => !!drag?.moved;

        if (typeof requestAnimationFrame !== 'function') return;
        let last = null;
        const step = now => {
            const dt = last === null ? 0 : Math.min(now - last, 100) / 1000;
            last = now;
            if (this.shouldAutoScroll()) {
                this.position += this.speed * dt;
                this.wrap();
                viewport.scrollLeft = this.position;
            }
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    get loopWidth() {
        const copy = this.track?.querySelector('.market-ticker-copy');
        const group = this.track?.querySelector('.market-ticker-group');
        // Hidden copy (static list, mobile, reduced motion): plain scrolling.
        return copy && group && copy.offsetWidth > 0 ? group.offsetWidth : 0;
    }

    get speed() {
        return this.loopWidth / (this.durationSec || 45);
    }

    // Keeps the position inside the first group; true when it jumped.
    wrap() {
        const width = this.loopWidth;
        if (!width) return false;
        if (this.position >= width) { this.position -= width; return true; }
        if (this.position < 0) { this.position += width; return true; }
        return false;
    }

    shouldAutoScroll() {
        if (this.paused || this.hovered || this.dragging?.() || !this.loopWidth) return false;
        if (Date.now() - this.lastInteraction < RESUME_DELAY_MS) return false;
        if (this.root.matches?.(':focus-within')) return false;
        if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
        return true;
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
            // Same pace as the former CSS animation: one group per max(45 s, 9 s/item).
            this.durationSec = Math.max(45, items.length * 9);
            this.position = 0;
            if (this.viewport) this.viewport.scrollLeft = 0;
        }
        this.root.classList.toggle('is-empty', items.length === 0);
        for (const node of this.track.querySelectorAll('[data-ticker]')) {
            const item = this.items.get(node.dataset.ticker);
            const tone = item.pct > 0 ? 'stat-positive' : item.pct < 0 ? 'stat-negative' : 'stat-neutral';
            const pctText = item.pctText ?? (Number.isFinite(item.pct)
                ? `${item.pct > 0 ? '▲ +' : item.pct < 0 ? '▼ ' : ''}${pctFormat.format(item.pct)} %` : '—');
            const priceText = item.priceText ?? (Number.isFinite(item.price) ? eurFormat.format(item.price) : '—');
            const amountText = item.amountText ?? (Number.isFinite(item.change)
                ? `${item.change > 0 ? '+' : ''}${eurFormat.format(item.change)}` : '');
            node.classList.remove('is-open', 'is-closed', 'is-continuous', 'is-unknown', 'is-stale');
            node.classList.add(`is-${item.state}`);
            node.classList.toggle('is-stale', !!item.stale);
            node.querySelector('.ticker-name').textContent = item.name;
            node.querySelector('.ticker-price').textContent = priceText;
            const change = node.querySelector('.ticker-change');
            change.textContent = pctText;
            change.className = `ticker-change ${tone}`;
            node.querySelector('.ticker-state').textContent = `${item.stateLabel}${item.freshnessLabel ? ` · ${item.freshnessLabel}` : ''}`;
            const amount = node.querySelector('.ticker-amount');
            amount.textContent = amountText;
            amount.className = `ticker-amount ${tone}`;
            node.title = `${item.name} (${item.ticker}) · ${item.detail || item.stateLabel}`;
            if (node.tagName === 'BUTTON') {
                node.setAttribute('aria-label', `${item.name}, ${priceText}, ${pctText}${amountText ? `, ${amountText}` : ''}. ${item.detail || item.stateLabel}. Afficher le graphique`);
            }
        }
        this.updateOverflow();
    }
}
