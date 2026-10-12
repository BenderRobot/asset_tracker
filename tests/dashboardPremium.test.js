// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { normalizeDashboardIndices, normalizeDashboardQuote, presentDashboardQuote, quoteSession, scheduledMarketStatus } from '../src/dashboardMarketData.js';
import { MarketTicker, selectPortfolioMovers } from '../src/marketTicker.js';
import { selectDailyContributions, selectContributionHighlights, auditDashboardSnapshot } from '../src/dashboardContributions.js';
import { PriceAPI } from '../src/api.js';
import { createFakeStorage } from './helpers.js';
import { marketCalendarEngine } from '../src/MarketCalendarEngine.js';
import { clearMarketTransportCache } from '../src/marketDataTransport.js';
import { portfolioKPIs } from '../src/portfolioKPIs.js';

let DashboardApp;
beforeAll(async () => {
    const original = document.addEventListener.bind(document);
    const spy = vi.spyOn(document, 'addEventListener').mockImplementation((type, ...args) => {
        if (type !== 'DOMContentLoaded') original(type, ...args);
    });
    ({ DashboardApp } = await import('../src/dashboardApp.js'));
    spy.mockRestore();
});
afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); document.body.replaceChildren();
    marketCalendarEngine._providerMetadata.clear();
    clearMarketTransportCache();
});
const NOW = Date.parse('2026-10-09T15:00:00Z');
const sec = date => Date.parse(date) / 1000;
function chart(meta = {}) {
    return {
        meta: { regularMarketPrice: 110, regularMarketTime: NOW / 1000, currency: 'USD',
            exchangeTimezoneName: 'America/New_York',
            currentTradingPeriod: { regular: { start: sec('2026-10-09T13:30:00Z'), end: sec('2026-10-09T20:00:00Z') } }, ...meta },
        timestamp: [sec('2026-10-08T13:30:00Z'), sec('2026-10-09T13:30:00Z')],
        indicators: { quote: [{ close: [100, 110] }] }
    };
}

describe('Dashboard quote contract', () => {
    it('preserves index points and native currencies without using the range-opening reference', () => {
        const quote = normalizeDashboardQuote('^NDX', chart({ chartPreviousClose: 75 }), NOW);
        expect(quote).toMatchObject({ price: 110, previousClose: 100, currency: 'USD', unit: 'pts', quoteAsOf: NOW, marketState: 'OPEN' });
        expect(presentDashboardQuote('^NDX', quote, NOW).pct).toBeCloseTo(10);
        expect(normalizeDashboardQuote('GC=F', chart(), NOW)).toMatchObject({ currency: 'USD', unit: 'USD' });
        expect(normalizeDashboardQuote('AAPL', chart(), NOW)).toMatchObject({ currency: 'USD', price: 110 });
        expect(normalizeDashboardQuote('EURUSD=X', chart(), NOW).unit).toBe('USD / EUR');
        expect(normalizeDashboardQuote('^TNX', chart(), NOW).unit).toBe('%');
    });
    it('uses the previous session relative to the quote on a closed weekend', () => {
        const sunday = Date.parse('2026-10-11T11:00:00Z');
        const quote = normalizeDashboardQuote('^NDX', chart(), sunday);
        expect(quote.previousClose).toBe(100);
        expect(presentDashboardQuote('^NDX', quote, sunday)).toMatchObject({ status: 'Dernière séance', session: 'CLOSED' });
        expect(presentDashboardQuote('^NDX', quote, sunday).time).toContain('09/10');
    });
    it('treats gold futures as closed over the weekend despite a Sunday-long provider period', () => {
        const sunday = Date.parse('2026-10-11T19:35:00Z');
        const quote = normalizeDashboardQuote('GC=F', chart({
            regularMarketTime: sec('2026-10-09T20:59:59Z'), instrumentType: 'FUTURE',
            currentTradingPeriod: { regular: { start: sec('2026-10-11T04:00:00Z'), end: sec('2026-10-12T03:59:00Z') } }
        }), sunday);
        expect(presentDashboardQuote('GC=F', quote, sunday)).toMatchObject({ session: 'CLOSED', status: 'Dernière séance' });
        // Globex reopens Sunday 18:00 New York time.
        expect(quoteSession('GC=F', quote, Date.parse('2026-10-11T22:30:00Z'))).toBe('OPEN');
    });
    it('does not show an open market on a published holiday or after an early close', () => {
        const holiday = Date.parse('2026-07-03T15:00:00Z');
        const staleSchedule = { regularSession: { startMs: holiday - 3600000, endMs: holiday + 3600000 },
            exchangeTimezone: 'America/New_York' };
        expect(quoteSession('^NDX', staleSchedule, holiday)).toBe('CLOSED');
        expect(scheduledMarketStatus('^NDX', new Date(holiday))).toBe('POST_MARKET');
        const early = Date.parse('2026-11-27T18:30:00Z');
        expect(quoteSession('^GSPC', { ...staleSchedule, regularSession: {
            startMs: Date.parse('2026-11-27T14:30:00Z'), endMs: Date.parse('2026-11-27T21:00:00Z')
        } }, early)).toBe('CLOSED');
        expect(quoteSession('^FCHI', { regularSession: {
            startMs: Date.parse('2026-12-24T08:00:00Z'), endMs: Date.parse('2026-12-24T16:30:00Z')
        }, exchangeTimezone: 'Europe/Paris' }, Date.parse('2026-12-24T13:30:00Z'))).toBe('UNKNOWN');
        expect(scheduledMarketStatus('^FCHI', new Date('2026-12-24T13:30:00Z'))).toBe('UNKNOWN');
        expect(quoteSession('^FCHI', { regularSession: {
            startMs: Date.parse('2026-12-24T08:00:00Z'), endMs: Date.parse('2026-12-24T13:00:00Z')
        }, exchangeTimezone: 'Europe/Paris' }, Date.parse('2026-12-24T13:30:00Z'))).toBe('CLOSED');
    });
    it('never invents a zero variation or a live quote when reference/time are absent', () => {
        const data = chart({ regularMarketTime: undefined, chartPreviousClose: 110 });
        data.timestamp = [];
        const quote = normalizeDashboardQuote('^NDX', data, NOW);
        const view = presentDashboardQuote('^NDX', quote, NOW);
        expect(quote.previousClose).toBeNull();
        expect(view).toMatchObject({ pct: null, pctText: '—', time: 'Heure du cours inconnue', status: 'Séance ouverte' });
        expect(view.detail).not.toMatch(/LIVE|temps réel/i);
        expect(presentDashboardQuote('^NDX', null, NOW).priceText).toBe('—');
    });
    it('does not assume an equal previous close is an error', () => {
        const quote = normalizeDashboardQuote('^NDX', chart({ previousClose: 110 }), NOW);
        expect(presentDashboardQuote('^NDX', quote, NOW).pct).toBe(0);
    });
    it('labels old and failed refreshes without refreshing the quote timestamp', () => {
        const quote = normalizeDashboardQuote('^NDX', chart({ regularMarketTime: NOW / 1000 - 3600 }), NOW);
        expect(presentDashboardQuote('^NDX', quote, NOW).status).toBe('Cours ancien');
        expect(presentDashboardQuote('^NDX', { ...quote, stale: true }, NOW).status).toBe('Actualisation indisponible');
    });
    it('requires a contiguous UTC midnight anchor for every crypto, including ETH', () => {
        const data = chart({ instrumentType: 'CRYPTOCURRENCY', currency: 'EUR' });
        data.timestamp = [sec('2026-10-08T00:00:00Z'), sec('2026-10-09T00:00:00Z')];
        const quote = normalizeDashboardQuote('ETH-EUR', data, NOW);
        expect(quote).toMatchObject({ previousClose: 100, referenceAsOf: Date.parse('2026-10-09T00:00:00Z'), changeBasis: 'Depuis 00:00 UTC' });
        data.timestamp[0] -= 86400;
        expect(normalizeDashboardQuote('ETH-EUR', data, NOW).previousClose).toBeNull();
    });
    it('does not assert a session for an unrelated provider date or unknown exchange', () => {
        expect(quoteSession('^HSI', normalizeDashboardQuote('^HSI', chart(), NOW), NOW + 3 * 86400000)).toBe('UNKNOWN');
        expect(scheduledMarketStatus('^HSI', new Date(NOW))).toBe('UNKNOWN');
        // US/Europe daylight-saving dates differ in March: resolve in NY time.
        expect(scheduledMarketStatus('^NDX', new Date('2026-03-16T13:45:00Z'))).toBe('MARKET_OPEN');
    });
    it('migrates only the mislabelled Nasdaq and deduplicates saved preferences', () => {
        expect(normalizeDashboardIndices([
            { ticker: '^IXIC', name: 'NASDAQ 100' }, { ticker: '^NDX', name: 'Nasdaq 100' },
            { ticker: '^IXIC', name: 'Nasdaq Composite' }, null
        ])).toEqual([{ ticker: '^NDX', name: 'Nasdaq 100' }, { ticker: '^IXIC', name: 'Nasdaq Composite' }]);
    });
    it('coalesces the card/ticker quote request and keeps the last native quote on failure', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
        const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ chart: { result: [chart()] } }) });
        vi.stubGlobal('fetch', fetch);
        const api = new PriceAPI(createFakeStorage());
        const [a, b] = await Promise.all([api.fetchIndexDataForDashboard('^NDX'), api.fetchIndexDataForDashboard('^NDX')]);
        expect(a).toBe(b); expect(fetch).toHaveBeenCalledTimes(1);
        vi.setSystemTime(NOW + 31000);
        fetch.mockResolvedValue({ ok: false, status: 503 });
        const fallback = await api.fetchIndexDataForDashboard('^NDX');
        expect(fallback).toMatchObject({ stale: true, quoteAsOf: NOW, currency: 'USD', price: 110 });
    });
});

describe('Dashboard ticker and feeds', () => {
    function tickerRoot() {
        document.body.innerHTML = '<section id="ticker"><div class="market-ticker-track"></div><button data-ticker-pause></button></section>';
        return document.getElementById('ticker');
    }
    const holding = (ticker, displayDayPct, extra = {}) => ({
        ticker, name: ticker, quantity: 1, currentPrice: 10, displayDayPct, displayDayChange: displayDayPct, ...extra
    });
    it('retains focused nodes on price updates, exposes one keyboard list and persists pause', () => {
        const root = tickerRoot(); const select = vi.fn();
        const ticker = new MarketTicker(root, select);
        const item = { ticker: 'AMAT', name: 'Applied Materials', price: 455, pct: 2, change: 9, state: 'open', stateLabel: 'Séance ouverte' };
        ticker.update([item]);
        const node = root.querySelector('.market-ticker-item'); node.focus();
        ticker.update([{ ...item, price: 460, pct: 3 }]);
        expect(root.querySelector('.market-ticker-item')).toBe(node);
        expect(document.activeElement).toBe(node);
        expect(node.classList.contains('is-open')).toBe(true);
        expect(root.querySelector('.market-ticker-copy').getAttribute('aria-hidden')).toBe('true');
        expect(root.querySelector('.market-ticker-copy').querySelector('button')).toBeNull();
        node.click(); expect(select.mock.calls[0][0].price).toBe(460);
        root.querySelector('[data-ticker-pause]').click();
        expect(root.classList.contains('is-paused')).toBe(true);
        expect(new MarketTicker(root, select).paused).toBe(true);
    });
    it('shows weekend cryptos live and Friday movers as closed', () => {
        const saturday = Date.parse('2026-10-10T12:00:00Z');
        const items = selectPortfolioMovers([
            holding('BTC-EUR', 0.8), holding('AMAT', 3.1), holding('RIBER.PA', -2.4),
            holding('REIT', 5, { assetType: 'Real Estate' }), holding('KO', null, { dayPct: null })
        ], { now: saturday, lastSessionPerformance: new Map([
            ['AMAT', { sessionCloseTs: Date.parse('2026-10-09T20:00:00Z'), sessionCloseObserved: true }],
            ['RIBER.PA', { sessionCloseTs: Date.parse('2026-10-09T15:30:00Z'), sessionCloseObserved: true }]
        ]) });
        expect(items.map(i => i.ticker)).toEqual(['AMAT', 'BTC-EUR', 'RIBER.PA']);
        expect(items.find(i => i.ticker === 'BTC-EUR')).toMatchObject({ state: 'continuous' });
        const closed = items.find(i => i.ticker === 'AMAT');
        expect(closed.state).toBe('closed');
        expect(closed.stateLabel).toContain('ven.');
        expect(closed.stateLabel).toContain('09/10');
        const [unverified] = selectPortfolioMovers([holding('AMAT', 3.1)], { now: saturday });
        expect(unverified.stateLabel).toContain('date de séance inconnue');
        const [fallback] = selectPortfolioMovers([holding('AMAT', 3.1)], { now: saturday,
            lastSessionPerformance: new Map([['AMAT', { sessionCloseTs: Date.parse('2026-10-09T20:00:00Z'), sessionCloseObserved: false }]]) });
        expect(fallback.stateLabel).toContain('date de séance inconnue');
    });
    it('marks a held US stock closed on an exchange holiday while crypto continues', () => {
        const holiday = Date.parse('2026-07-03T15:00:00Z');
        marketCalendarEngine.ingestProviderMetadata('AMAT', {
            exchangeTimezoneName: 'America/New_York', instrumentType: 'EQUITY', regularMarketTime: holiday / 1000,
            currentTradingPeriod: { regular: { start: (holiday - 3600000) / 1000, end: (holiday + 3600000) / 1000 } }
        });
        const items = selectPortfolioMovers([holding('AMAT', 2), holding('BTC-EUR', 1)], { now: holiday });
        expect(items.find(item => item.ticker === 'AMAT').state).toBe('closed');
        expect(items.find(item => item.ticker === 'BTC-EUR').state).toBe('continuous');
    });
    it('closes a held stock after an official half day even if Yahoo still reports regular hours', () => {
        const after = Date.parse('2026-11-27T18:30:00Z');
        marketCalendarEngine.ingestProviderMetadata('AMAT', {
            exchangeTimezoneName: 'America/New_York', instrumentType: 'EQUITY',
            regularMarketTime: Date.parse('2026-11-27T17:30:00Z') / 1000,
            currentTradingPeriod: { regular: {
                start: Date.parse('2026-11-27T14:30:00Z') / 1000,
                end: Date.parse('2026-11-27T21:00:00Z') / 1000
            } }
        });
        expect(selectPortfolioMovers([holding('AMAT', 2)], { now: after })[0].state).toBe('closed');
    });
    it('keeps only the best and worst movers of a large portfolio', () => {
        const items = selectPortfolioMovers(Array.from({ length: 20 }, (_, i) => holding(`T${i}`, i - 10)), { now: NOW });
        expect(items).toHaveLength(12);
        expect(items[0].pct).toBe(9);
        expect(items.at(-1).pct).toBe(-10);
    });
    it('never calls a heuristic or holiday-unknown session confirmed', () => {
        const calendar = {
            getTradingModel: () => 'exchange_us',
            getSession: () => ({ source: 'heuristic-fallback', openUTCMs: NOW - 3600000, closeUTCMs: NOW + 3600000 }),
            getTradingDayStatus: () => 'HOLIDAY_UNKNOWN'
        };
        const [item] = selectPortfolioMovers([holding('AMAT', 2)], {
            now: NOW, calendar, priceQuotes: new Map([['AMAT', { lastUpdate: NOW - 60000 }]])
        });
        expect(item).toMatchObject({ state: 'unknown', stale: false });
        expect(item.stateLabel).toBe('Séance non confirmée');
        expect(item.freshnessLabel).toContain('Donnée');
        calendar.getSession = () => ({ source: 'provider', openUTCMs: NOW - 3600000, closeUTCMs: NOW + 3600000 });
        const [scheduledOnly] = selectPortfolioMovers([holding('AMAT', 2)], { now: NOW, calendar });
        expect(scheduledOnly.state).toBe('unknown');
        calendar.getProviderMetadata = () => ({ lastQuoteTimeMs: NOW - 60000 });
        const [confirmed] = selectPortfolioMovers([holding('AMAT', 2)], { now: NOW, calendar });
        expect(confirmed.state).toBe('open');
    });
    it('marks a retained or old quote on the affected position', () => {
        const quotes = new Map([['BTC-EUR', { lastUpdate: NOW - 45 * 60000 }]]);
        const [item] = selectPortfolioMovers([holding('BTC-EUR', 1)], { now: NOW, priceQuotes: quotes });
        expect(item).toMatchObject({ state: 'continuous', stale: true });
        const root = tickerRoot();
        new MarketTicker(root, () => {}).update([item]);
        expect(root.querySelector('.market-ticker-item').classList.contains('is-stale')).toBe(true);
        expect(root.querySelector('.ticker-state').textContent).toContain('Cours ancien');
        const [failed, healthy] = selectPortfolioMovers([
            holding('AMAT', 2), holding('GOOGL', 1)
        ], { now: NOW, staleInstruments: ['AMAT'], priceQuotes: new Map([
            ['AMAT', { lastUpdate: NOW - 60000 }], ['GOOGL', { lastUpdate: NOW - 60000 }]
        ]) });
        expect(failed.freshnessLabel).toContain('Actualisation indisponible');
        expect(healthy.stale).toBe(false);
    });
    it('uses the weekly break for a held future, even when provider hours claim Sunday is open', () => {
        const sunday = Date.parse('2026-10-11T20:00:00Z');
        marketCalendarEngine.ingestProviderMetadata('GC=F', {
            exchangeTimezoneName: 'America/New_York', instrumentType: 'FUTURE',
            currentTradingPeriod: { regular: { start: sunday / 1000 - 3600, end: sunday / 1000 + 3600 } }
        });
        const [item] = selectPortfolioMovers([holding('GC=F', 1)], { now: sunday });
        expect(item.state).toBe('closed');
    });
    function newsApp() {
        document.body.innerHTML = '<div id="news-global-container"></div><div id="news-portfolio-container"></div>';
        const app = Object.create(DashboardApp.prototype);
        app.renderAssetSelect = vi.fn();
        return app;
    }
    const article = { title: 'Actualité', source: 'Source', ticker: 'Source', url: 'https://example.com/a', datetime: NOW / 1000 };
    it('distinguishes successful empty news from network failure and retries locally', async () => {
        const app = newsApp();
        await app.loadNewsFeed('global', [() => Promise.resolve([])], 'macro', 'Aucune actualité récente.');
        expect(document.body.textContent).toContain('Aucune actualité récente');
        await app.loadNewsFeed('global', [() => Promise.reject(Error('offline'))], 'macro', 'Aucune actualité récente.');
        expect(document.body.textContent).toContain('Actualités indisponibles');
        expect(document.body.textContent).not.toContain('Aucune actualité récente');
        app.loadGlobalNews = vi.fn();
        document.querySelector('.news-feed-state button').click();
        expect(app.loadGlobalNews).toHaveBeenCalledOnce();
    });
    it('keeps articles per failed source and explicitly marks partial results', async () => {
        const app = newsApp();
        await app.loadNewsFeed('global', [() => Promise.resolve([article]), () => Promise.resolve([])], 'macro', 'Vide');
        await app.loadNewsFeed('global', [() => Promise.reject(Error('offline')), () => Promise.resolve([])], 'macro', 'Vide');
        expect(document.body.textContent).toContain('Certaines sources sont indisponibles');
        expect(document.body.textContent).toContain('Derniers articles conservés');
        expect(app.globalNews).toHaveLength(1);
    });
    it('ignores a late response after a different asset selection', async () => {
        const app = newsApp(); let resolve;
        const first = app.loadNewsFeed('portfolio', [() => new Promise(done => { resolve = done; })], 'first', 'Vide');
        await Promise.resolve();
        await app.loadNewsFeed('portfolio', [() => Promise.resolve([])], 'second', 'Aucun article pour le second actif');
        resolve([article]); await first;
        expect(document.body.textContent).toContain('Aucun article pour le second actif');
        expect(app.portfolioNews).toEqual([]);
    });
    it('refreshes secondary KPI rows after the initial render and keeps missing values unknown', () => {
        const app = Object.create(DashboardApp.prototype);
        document.body.innerHTML = '<div class="kpi-card"><div class="kpi-header"></div><div id="dashboard-top-gainer-name"></div></div>';
        app.injectListIntoCard('dashboard-top-gainer-name', [{ name: 'A', gainPct: 3 }], 'gainer');
        app.injectListIntoCard('dashboard-top-gainer-name', [{ name: 'B', gainPct: null }], 'gainer');
        expect(document.body.textContent).toContain('B');
        expect(document.body.textContent).toContain('—');
        expect(document.body.textContent).not.toContain('3,00');
    });
    it('keeps the portfolio headline when a market publishes chart KPIs', () => {
        const app = Object.create(DashboardApp.prototype);
        app.chart = { currentMode: 'index' };
        app.ui = { updateTopKPIs: vi.fn() };
        app.subscribeToKPIs();
        try {
            app._kpiListener({ source: 'snapshot', totalValue: 6000, snapshotId: 'index' });
            expect(app.ui.updateTopKPIs).not.toHaveBeenCalled();
            app.chart.currentMode = 'portfolio';
            app._kpiListener({ source: 'snapshot', totalValue: 35000, cash: 100, snapshotId: 'portfolio' });
            expect(app.ui.updateTopKPIs).toHaveBeenCalledWith(expect.objectContaining({ totalCurrentEUR: 35000 }), 100, null);
        } finally { portfolioKPIs.removeListener(app._kpiListener); }
    });
    it('requests one quote per market and retains unavailable instruments', async () => {
        const app = Object.create(DashboardApp.prototype);
        document.body.innerHTML = '<div id="market-overview-container"></div>';
        const fetchQuote = vi.fn().mockResolvedValue(null);
        Object.assign(app, {
            getCustomIndices: () => [{ ticker: '^NDX', name: 'Nasdaq 100' }], getMarketStatus: () => 'MARKET_OPEN',
            api: { fetchIndexDataForDashboard: fetchQuote },
            storage: { currentData: {}, setCurrentPrice: vi.fn() }
        });
        await app.loadMarketIndices();
        expect(fetchQuote).toHaveBeenCalledOnce();
        expect(document.querySelector('.market-card-open').disabled).toBe(true);
        expect(document.body.textContent).toContain('Indisponible');
        expect(document.querySelector('.market-card').classList.contains('stat-neutral')).toBe(true);
    });
});

describe('Daily portfolio contributions', () => {
    const position = (ticker, dayPnl, currentValue = 100, dayPnlPct = 1) => ({
        ticker, name: ticker, quantity: 1, currentValue, dayPnl, dayPnlPct
    });
    const snapshot = positions => ({ status: 'valid', totalValue: 1000, dayPnl: 30, positions });
    it('audits the live snapshot without changing amounts or hiding a missing component', () => {
        const positions = [
            { ...position('AAA', 45, 600), totalReturn: 100 },
            { ...position('BBB', -15, 300), totalReturn: -20 }
        ];
        const result = { portfolioSnapshot: { ...snapshot(positions), cash: 100, totalReturn: 80 },
            _engine: { summary: { totalDayChangeEUR: 30 } } };
        expect(auditDashboardSnapshot(result)).toMatchObject({ status: 'complete', issues: [] });
        result.portfolioSnapshot.totalValue = 1005;
        expect(auditDashboardSnapshot(result)).toMatchObject({ status: 'mismatch',
            issues: [{ label: 'Valeur totale', residual: 5 }] });
        result.portfolioSnapshot.totalValue = 1000;
        positions[1].dayPnl = null;
        expect(auditDashboardSnapshot(result)).toMatchObject({ status: 'partial', missingDayPnl: 1 });
        positions[1].dayPnl = -15;
        positions[1].currentValue = null;
        expect(auditDashboardSnapshot(result)).toMatchObject({ status: 'partial', incomplete: ['Valeur totale'] });
    });
    it('uses canonical daily P&L and reconciles its sum with Var Today', () => {
        const data = selectDailyContributions(snapshot([
            { ...position('AAA', 50, 200, 5), displayDayPnl: 500 },
            position('BBB', -20, 100, -2), position('CCC', 0, 50, 0)
        ]));
        expect(data).toMatchObject({ status: 'complete', total: 30, explained: 30, residual: 0, missing: 0 });
        expect(data.rows.map(row => row.ticker)).toEqual(['AAA', 'BBB']);
        expect(data.rows[0]).toMatchObject({ impact: 50, weight: 20 });
    });
    it('keeps missing attribution and mismatches visible instead of inventing a complete total', () => {
        expect(selectDailyContributions(snapshot([position('AAA', 30), position('BBB', null)])))
            .toMatchObject({ status: 'partial', missing: 1, explained: 30 });
        expect(selectDailyContributions(snapshot([position('AAA', 20)])))
            .toMatchObject({ status: 'mismatch', residual: 10 });
        expect(selectDailyContributions(snapshot([position('AAA', 30)]), { previousSession: true }).status)
            .toBe('previous-session');
    });
    it('renders an explicit partial state and hides the previous-day table', () => {
        document.body.innerHTML = `<section id="dashboard-contributions"><p class="contributions-summary"></p>
            <div class="contributions-table-wrap"><table class="contributions-table"><tbody></tbody></table></div>
            <p class="contributions-note"></p></section>`;
        const app = Object.create(DashboardApp.prototype);
        const data = snapshot([position('AAA', 30), position('BBB', null)]);
        app.renderDailyContributions(data);
        expect(document.querySelector('#dashboard-contributions').dataset.status).toBe('partial');
        expect(document.querySelector('.contributions-note').textContent).toContain('décomposition partielle');
        app.renderDailyContributions(data, { previousSession: true });
        expect(document.querySelector('.contributions-table').hidden).toBe(true);
        expect(document.querySelector('.contributions-summary').textContent).toBe('Variation du jour indisponible');
    });
    it('selects two positive and two negative daily impacts', () => {
        const rows = [position('A', 8), position('B', -3), position('C', 30), position('D', -20), position('E', 12), position('F', -9)]
            .map(p => ({ ticker: p.ticker, impact: p.dayPnl }));
        expect(selectContributionHighlights({ rows })).toMatchObject({
            best: [{ ticker: 'C' }, { ticker: 'E' }],
            worst: [{ ticker: 'D' }, { ticker: 'F' }]
        });
        expect(selectContributionHighlights({ rows: rows.filter(row => row.impact > 0) }).worst).toEqual([]);
    });
    it('opens the full table from the compact card and preserves data-quality states', () => {
        document.body.innerHTML = `<div class="dashboard-kpi-grid-v2"><div class="kpi-card contribution-kpi-card" data-kpi-type="contributions" tabindex="0">
            <div id="dashboard-contribution-highlights"></div><div id="dashboard-contribution-state"></div></div></div>
            <div id="contributions-modal" style="display:none"><button id="close-contributions-modal">Fermer</button>
            <section id="dashboard-contributions"><p class="contributions-summary"></p>
            <div class="contributions-table-wrap"><table class="contributions-table"><tbody></tbody></table></div>
            <p class="contributions-note"></p></section></div>`;
        const app = Object.create(DashboardApp.prototype);
        app.setupKPIModals();
        const data = snapshot([position('AAA', 45), position('BBB', -15), position('CCC', null)]);
        app.renderDailyContributions(data);
        expect(document.querySelector('#dashboard-contribution-highlights').textContent).toContain('AAA');
        expect(document.querySelector('#dashboard-contribution-highlights').textContent).toContain('BBB');
        expect(document.querySelector('#dashboard-contribution-state').textContent).toContain('partielle');
        document.querySelector('.contribution-kpi-card').click();
        expect(document.getElementById('contributions-modal').style.display).toBe('flex');
        expect(document.querySelectorAll('.contributions-table tbody tr')).toHaveLength(3);
        document.getElementById('close-contributions-modal').click();
        expect(document.getElementById('contributions-modal').style.display).toBe('none');
        app.renderDailyContributions(data, { previousSession: true });
        expect(document.querySelector('.contributions-table').hidden).toBe(true);
        expect(document.querySelector('#dashboard-contribution-highlights').textContent).toContain('indisponible');
    });
});
