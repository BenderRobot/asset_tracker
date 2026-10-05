// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const geminiMocks = vi.hoisted(() => ({
    fetchGeminiSummary: vi.fn(),
    fetchGeminiContext: vi.fn(),
    fetchGeminiDiversificationAdvice: vi.fn(),
    fetchGeminiRiskAdvice: vi.fn()
}));

vi.mock('../src/geminiService.js', () => geminiMocks);

let DashboardApp;
let NewsApp;

beforeAll(async () => {
    const original = document.addEventListener.bind(document);
    const listenerSpy = vi.spyOn(document, 'addEventListener').mockImplementation((type, ...args) => {
        if (type !== 'DOMContentLoaded') original(type, ...args);
    });
    ({ DashboardApp } = await import('../src/dashboardApp.js'));
    ({ NewsApp } = await import('../src/newsApp.js'));
    listenerSpy.mockRestore();
});

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = `
        <div id="news-modal" style="display:none">
            <button id="close-news-modal"></button>
            <span id="modal-news-pubdate"></span>
            <span id="modal-news-ticker"></span>
            <div id="modal-news-title"></div>
            <a id="modal-news-link"></a>
            <div id="modal-news-summary"></div>
            <button id="analyze-context-btn"></button>
            <div id="modal-news-context" style="display:none"><div id="modal-context-content"></div></div>
        </div>`;
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function initializeRequestState(app) {
    app.currentModalNewsItem = null;
    app.currentGeminiSummary = null;
    app._newsModalGeneration = 0;
    app._newsSummaryRequestSeq = 0;
    app._newsContextRequestSeq = 0;
    app._newsSummaryAbortController = null;
    app._newsContextAbortController = null;
}

describe('Gemini news modal request ordering', () => {
    it('News resolves portfolio exposure from the canonical Analytics snapshot', async () => {
        const purchase = { ticker: 'AAPL', assetType: 'Stock' };
        const holding = {
            ticker: 'AAPL', name: 'Apple', assetType: 'Stock', quantity: 2,
            currentValue: 500, purchases: [purchase]
        };
        const marketResult = { snapshot: { snapshotId: 'canonical' } };
        const app = Object.create(NewsApp.prototype);
        app.storage = { getPurchases: vi.fn(() => [purchase]) };
        app.dataManager = {
            getCanonicalMarketSnapshot: vi.fn(async () => marketResult),
            buildAnalyticsSnapshot: vi.fn(async () => ({
                holdings: [holding],
                portfolioSnapshot: {
                    totalValue: 1000, cash: 100, status: 'valid',
                    pricesTimestamp: 1234, sourceStale: false, staleInstruments: []
                }
            })),
            calculateHoldings: vi.fn(() => { throw new Error('local calculation must not be used'); })
        };

        const details = await app.getHoldingDetailsForNews({ title: 'AAPL publie ses résultats' });

        expect(app.dataManager.getCanonicalMarketSnapshot).toHaveBeenCalledWith([purchase]);
        expect(app.dataManager.buildAnalyticsSnapshot).toHaveBeenCalledWith([purchase], marketResult);
        expect(app.dataManager.calculateHoldings).not.toHaveBeenCalled();
        expect(details).toMatchObject({
            ticker: 'AAPL', currentValue: 500, weight: 50,
            portfolioTotalValue: 1000, cashReserve: 100,
            portfolioStatus: 'valid', pricesTimestamp: 1234, sourceStale: false
        });
    });

    it('Dashboard réutilise le dernier snapshot canonique sans recalcul local partiel', () => {
        const app = Object.create(DashboardApp.prototype);
        app.lastHoldings = [{
            ticker: 'AAPL', name: 'Apple', assetType: 'Stock', quantity: 2,
            currentValue: null, purchases: []
        }];
        app.lastCashTotal = 999; // ne doit plus servir de repli
        app.lastPortfolioSnapshot = {
            snapshotId: 'dashboard-snapshot', totalValue: null, cash: null,
            status: 'invalid', invalidReason: 'PRICE_DATA_UNAVAILABLE',
            sourceStale: true, staleInstruments: ['AAPL'], pricesTimestamp: 1234
        };

        const details = app.getHoldingDetailsForNews({ title: 'AAPL publie ses résultats' });

        expect(details).toMatchObject({
            currentValue: null, weight: null, portfolioTotalValue: null, cashReserve: null,
            portfolioStatus: 'invalid', portfolioInvalidReason: 'PRICE_DATA_UNAVAILABLE',
            snapshotId: 'dashboard-snapshot', sourceStale: true
        });
    });

    it('Dashboard ignores a summary from an older article that finishes last', async () => {
        const first = deferred();
        const second = deferred();
        const signals = [];
        geminiMocks.fetchGeminiSummary
            .mockImplementationOnce((_context, options) => { signals.push(options.signal); return first.promise; })
            .mockImplementationOnce((_context, options) => { signals.push(options.signal); return second.promise; });

        const app = Object.create(DashboardApp.prototype);
        initializeRequestState(app);
        const articleA = { title: 'Article A', name: 'A', source: 'Source A', url: 'https://a.test', formattedDate: 'A' };
        const articleB = { title: 'Article B', name: 'B', source: 'Source B', url: 'https://b.test', formattedDate: 'B' };

        const pendingA = app.openNewsModal(articleA);
        const pendingB = app.openNewsModal(articleB);
        expect(signals[0].aborted).toBe(true);

        second.resolve('<strong>Résumé B</strong>');
        await pendingB;
        first.resolve('<strong>Résumé A</strong>');
        await pendingA;

        expect(document.getElementById('modal-news-title').textContent).toBe('Article B');
        expect(document.getElementById('modal-news-summary').innerHTML).toBe('<strong>Résumé B</strong>');
        expect(app.currentGeminiSummary).toBe('<strong>Résumé B</strong>');
    });

    it('News page applies the same last-request-wins rule', async () => {
        const first = deferred();
        const second = deferred();
        const signals = [];
        geminiMocks.fetchGeminiSummary
            .mockImplementationOnce((_context, options) => { signals.push(options.signal); return first.promise; })
            .mockImplementationOnce((_context, options) => { signals.push(options.signal); return second.promise; });

        const app = Object.create(NewsApp.prototype);
        initializeRequestState(app);
        app.getColorForSource = () => '#123456';
        const articleA = { title: 'Article A', label: 'A', source: 'Source A', link: 'https://a.test', datetime: Date.now() };
        const articleB = { title: 'Article B', label: 'B', source: 'Source B', link: 'https://b.test', datetime: Date.now() };

        const pendingA = app.openNewsModal(articleA);
        const pendingB = app.openNewsModal(articleB);
        expect(signals[0].aborted).toBe(true);

        second.resolve('Résumé B');
        await pendingB;
        first.resolve('Résumé A');
        await pendingA;

        expect(document.getElementById('modal-news-title').textContent).toBe('Article B');
        expect(document.getElementById('modal-news-summary').textContent).toBe('Résumé B');
        expect(app.currentGeminiSummary).toBe('Résumé B');
    });

    it('does not inject a contextual analysis after the user hides it', async () => {
        const context = deferred();
        let requestSignal;
        geminiMocks.fetchGeminiContext.mockImplementation((_title, _summary, _holding, options) => {
            requestSignal = options.signal;
            return context.promise;
        });

        const app = Object.create(DashboardApp.prototype);
        initializeRequestState(app);
        app.currentModalNewsItem = { title: 'Article A' };
        app.currentGeminiSummary = 'Résumé A';
        app.getHoldingDetailsForNews = () => null;

        app.handleContextAnalysis();
        expect(document.getElementById('modal-news-context').style.display).toBe('block');
        app.handleContextAnalysis();
        expect(requestSignal.aborted).toBe(true);

        context.resolve('Ancienne analyse');
        await Promise.resolve();
        await Promise.resolve();
        expect(document.getElementById('modal-context-content').innerHTML).not.toContain('Ancienne analyse');
    });
});
