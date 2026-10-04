// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

function makeApp(fetchQuote) {
    const app = Object.create(DashboardApp.prototype);
    const cache = new Map();
    Object.assign(app, {
        getCustomIndices: () => [{ ticker: '^GSPC', name: 'S&P 500', icon: '🇺🇸', format: 'index' }],
        api: { fetchIndexDataForDashboard: fetchQuote },
        storage: {
            currentData: {},
            setCurrentPrice: (ticker, value) => cache.set(ticker, value),
            getCurrentPrice: ticker => cache.get(ticker) || null
        },
        chartKPIManager: {
            fetchIndexData: vi.fn().mockResolvedValue(null),
            generateSparkline: vi.fn().mockReturnValue('')
        },
        notificationManager: null,
        dataManager: { repository: { getPrice: vi.fn() } },
        chart: null
    });
    document.body.innerHTML = '<div id="market-overview-container"><div class="market-loading"></div></div>';
    return app;
}

describe('Dashboard futures presentation', () => {
    it('shows the followed index through its future with a purple label outside cash hours', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 9, 5, 22, 30));
        const fetchQuote = vi.fn().mockResolvedValue({
            price: 7777.25, previousClose: 7700, lastTradingDayClose: 7650,
            currency: 'USD', marketState: 'REGULAR', fetchedAt: Date.now()
        });
        const app = makeApp(fetchQuote);

        await app.loadMarketIndices();

        expect(fetchQuote).toHaveBeenCalledWith('ES=F');
        const card = document.querySelector('.market-card');
        expect(card.dataset.instrumentTicker).toBe('ES=F');
        expect(card.dataset.instrumentType).toBe('future');
        expect(card.classList.contains('market-card-future')).toBe(true);
        expect(card.textContent).toContain('FUTURE · ES');
        expect(card.style.border).toContain('168, 85, 247');
    });

    it('falls back to the cash index when the futures quote is unavailable', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 9, 5, 22, 30));
        const fetchQuote = vi.fn(async ticker => ticker === 'ES=F' ? null : {
            price: 7700, previousClose: 7650, lastTradingDayClose: 7600,
            currency: 'USD', marketState: 'CLOSED', fetchedAt: Date.now()
        });
        const app = makeApp(fetchQuote);

        await app.loadMarketIndices();

        expect(fetchQuote.mock.calls.map(([ticker]) => ticker)).toEqual(['ES=F', '^GSPC']);
        const card = document.querySelector('.market-card');
        expect(card.dataset.instrumentTicker).toBe('^GSPC');
        expect(card.dataset.instrumentType).toBe('cash');
        expect(card.textContent).not.toContain('FUTURE · ES');
    });
});
