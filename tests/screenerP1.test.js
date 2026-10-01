import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import * as metrics from '../src/screenerMetrics.js';

// Exercise the actual class and real page markup, replacing Firebase and the
// canvas renderer only. Network payloads stay deterministic and credential-free.
const source = readFileSync(new URL('../src/screenerApp.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../screener.html', import.meta.url), 'utf8');
let app, document, dom, charts;
const pending = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
    dom = new JSDOM(html, { url: 'https://asset-tracker.fr/screener.html' });
    document = dom.window.document;
    dom.window.HTMLCanvasElement.prototype.getContext = function () { return { canvas: this }; };
    charts = new Map();
    class Chart {
        constructor(ctx, config) {
            this.canvas = ctx.canvas; this.config = config; this.destroyed = false;
            charts.set(this.canvas, this);
        }
        destroy() { this.destroyed = true; charts.delete(this.canvas); }
        static getChart(canvas) { return charts.get(canvas); }
    }
    const context = vm.createContext({
        ...metrics, document, window: dom.window, Chart, Date, Intl, console,
        setTimeout, clearTimeout,
        Storage: class { getPurchases() { return []; } },
        PROXY: 'https://example.invalid', SP500_SYMBOL: '^GSPC', MIN_ANNUALISED_YEARS: 0.9,
        logger: { error: vi.fn() },
        isNum: v => typeof v === 'number' && Number.isFinite(v),
        escHtml: v => { const el = document.createElement('span'); el.textContent = v ?? ''; return el.innerHTML; },
    });
    vm.runInContext(source.slice(source.indexOf('class ScreenerApp'), source.indexOf("document.addEventListener('DOMContentLoaded'"))
        + '\nglobalThis.App = ScreenerApp;', context);
    app = new context.App();
    app.currentSymbol = 'AAPL';
    app.currentData = {
        quoteSummary: { summaryDetail: { dividendYield: { raw: 0.02 }, dividendRate: { raw: 2 } } },
        currency: { quote: 'USD', priceIso: 'USD', finIso: 'USD' },
        hasFundamentals: true, shareBasis: 1,
        fundamentals: [
            { year: '2024', annualNetIncome: 100, annualCommonStockDividendPaid: -10 },
            { year: '2025', annualNetIncome: 110, annualCommonStockDividendPaid: -12 },
        ],
        rows: [
            { endTs: Date.parse('2024-12-31'), dividendPerShare: 1 },
            { endTs: Date.parse('2025-12-31'), dividendPerShare: 1.2 },
        ],
        priceHistoryLong: [],
    };
});
afterEach(() => { dom.window.close(); vi.restoreAllMocks(); });

describe('P1 screener journeys', () => {
    it('opens Dividend directly and keeps its charts separate from Quantitative', async () => {
        app.safeFetchJson = vi.fn(async () => ({ chart: { result: [{ events: { dividends: {
            1700000000: { amount: 1 },
        } } }] } }));
        await expect(app.renderDividendeTab()).resolves.toBeUndefined();
        expect(app.dividendCharts).toHaveLength(3);
        expect(app.quantCharts).toHaveLength(0);
        const firstCharts = [...app.dividendCharts];
        await app.renderQuantitativeTab();
        expect(firstCharts.every(chart => !chart.destroyed)).toBe(true);
        const quantitativeCharts = [...app.quantCharts];
        await app.renderDividendeTab();
        expect(firstCharts.every(chart => chart.destroyed)).toBe(true);
        expect(app.dividendCharts).toHaveLength(3);
        expect(quantitativeCharts.every(chart => !chart.destroyed)).toBe(true);
    });

    it('places current valuation today and terminal price exactly ten years later in both views', () => {
        const now = Date.parse('2026-10-01T10:00:00Z');
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const calc = { currency: 'USD', baseMetric: 10, price: 100, metricLabel: 'FCF/action', histPoints: [] };
        const params = { baseMetric: 10, growthRate: 0.04, multiple: 15, targetReturn: 0.1, currentPrice: 100 };
        const result = metrics.fairPriceModel(params);
        for (const id of ['valuation-tab-chart', 'kpi-modal-chart']) {
            const canvas = document.getElementById(id);
            app.renderValuationChart(canvas, calc, { params, result });
            const data = charts.get(canvas).config.data.datasets;
            expect(data.find(d => d.label.startsWith('Prix juste')).data).toEqual([{ x: now, y: result.fairPrice }]);
            expect(data.find(d => d.label.startsWith('Prix terminal')).data).toEqual([{ x: Date.parse('2036-10-01T10:00:00Z'), y: result.terminalPrice }]);
            expect(charts.get(canvas).config.options.scales.metric.position).toBe('right');
        }
    });

    it('shows invalid hypotheses instead of generating a future projection', () => {
        const calc = { currency: 'USD', baseMetric: 10, price: 100, metricLabel: 'FCF/action', histPoints: [] };
        const growth = document.getElementById('val-tab-growth');
        growth._userSet = true; growth.value = '-200';
        const multiple = document.getElementById('val-tab-multiple');
        multiple._userSet = true; multiple.value = '15';
        const state = app.readCalculator('val-tab', calc);
        expect(state.result).toBeNull();
        expect(state.missing).toContain('Hypothèses invalides');
        expect(growth.getAttribute('aria-invalid')).toBe('true');
        app.renderValuationChart(document.getElementById('valuation-tab-chart'), calc, state);
        expect(app.valuationTabChart.config.data.datasets.find(d => d.label.endsWith('projeté')).data).toEqual([]);
    });

    it('ignores dividend checkbox for a price-index comparison and aligns common daily sessions', async () => {
        document.getElementById('kpi-show-dividends').checked = true;
        app.currentModalPeriod = '1mo';
        const point = (date, hour, c, a) => ({ t: Date.parse(`${date}T${hour}:00:00Z`), session: date, c, a });
        app.fetchPriceHistory = vi.fn(async symbol => symbol === 'AAPL'
            ? [point('2026-09-01', '07', 100, 50), point('2026-09-02', '07', 110, 80)]
            : [point('2026-09-01', '13', 200, 200), point('2026-09-02', '13', 202, 202)]);
        const canvas = document.getElementById('kpi-modal-chart');
        const stats = document.getElementById('kpi-modal-stats');
        await app.renderComparisonModal(canvas, stats);
        const config = charts.get(canvas).config;
        expect(config.data.datasets[0].data[1]).toBeCloseTo(110);
        expect(config.data.datasets[1].data[1]).toBeCloseTo(101);
        expect(config.options.scales.y.ticks.callback(100)).toBe('100');
        expect(stats.textContent).toContain('hors dividendes');
        expect(app.fetchPriceHistory.mock.calls.every(call => call[2].daily)).toBe(true);
    });

    it('loads daily fiscal-close data and preserves local sessions across time zones', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-01T10:00:00Z'));
        app.currentData.priceHistoryLong = null;
        app.safeFetchJson = vi.fn(async () => ({ chart: { result: [{
            meta: { exchangeTimezoneName: 'Asia/Tokyo', currentTradingPeriod: { regular: { end: Date.parse('2026-10-01T06:30:00Z') / 1000 } } },
            timestamp: [Date.parse('2025-09-25T23:00:00Z') / 1000, Date.parse('2025-09-28T23:00:00Z') / 1000],
            indicators: { quote: [{ close: [100, 120] }] },
        }] } }));
        const series = await app.getLongHistory();
        expect(app.safeFetchJson.mock.calls[0][0]).toContain('interval=1d');
        expect(series[0].session).toBe('2025-09-26');
        expect(metrics.dailyCloseAt(series, Date.parse('2025-09-27'))).toBe(100);
    });

    it('does not let late suggestions replace a newer query', async () => {
        const older = pending(), newer = pending();
        app.safeFetchJson = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
        const p1 = app.fetchSuggestions('Apple');
        const p2 = app.fetchSuggestions('Air Liquide');
        newer.resolve({ quotes: [{ symbol: 'AI.PA', shortname: 'Air Liquide', quoteType: 'EQUITY' }] });
        await p2;
        older.resolve({ quotes: [{ symbol: 'AAPL', shortname: 'Apple', quoteType: 'EQUITY' }] });
        await p1;
        expect(document.getElementById('screener-suggestions').textContent).toContain('Air Liquide');
        expect(document.getElementById('screener-suggestions').textContent).not.toContain('Apple');
    });

    it('selects a textual search result with the keyboard instead of requesting its name as a ticker', async () => {
        app.setupSearch();
        app.loadStock = vi.fn();
        app.safeFetchJson = vi.fn(async () => ({ quotes: [
            { symbol: 'AI.PA', shortname: 'Air Liquide', quoteType: 'EQUITY' },
            { symbol: 'AIR.PA', shortname: 'Airbus', quoteType: 'EQUITY' },
        ] }));
        const input = document.getElementById('screener-search-input');
        input.value = 'Air Liquide';
        await app.fetchSuggestions(input.value);
        input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown' }));
        input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
        expect(app.loadStock).toHaveBeenCalledWith('AI.PA');
    });
});

describe('Screener EUR quote', () => {
    const renderQuote = ({ currency, price, rate, marketRate = rate, quoteType = 'EQUITY', stale = false }) => {
        app.currentData.eurFx = rate == null ? null : {
            latest: rate,
            marketRate,
            latestAt: Date.parse('2026-09-30T16:00:00Z'),
            stale,
            fromIso: metrics.normalizeCurrency(currency).iso,
            toIso: 'EUR',
        };
        app.renderHeader({}, {}, {}, {}, {
            currency,
            quoteType,
            regularMarketPrice: { raw: price },
            regularMarketChange: { raw: 1 },
            regularMarketChangePercent: { raw: 0.01 },
        });
        app.renderEurCountervalue(
            document.getElementById('kpi-modal-price-eur'),
            document.getElementById('kpi-modal-fx-meta'),
            price,
            currency,
            quoteType,
        );
    };

    it.each([
        ['USD', 100, 0.9, 0.9, '90,00 €'],
        ['CHF', 100, 1.04, 1.04, '104,00 €'],
        ['JPY', 100, 0.0058, 0.0058, '0,5800 €'],
        // One GBp is 0.01 GBP: the effective quote-unit rate is 0.0117 EUR.
        ['GBp', 100, 0.0117, 1.17, '1,17 €'],
        ['USD', 0.000012, 0.9, 0.9, '0,00001080 €'],
    ])('shows %s quote in EUR in both shared headers', (currency, price, rate, marketRate, expected) => {
        renderQuote({ currency, price, rate, marketRate });
        expect(document.getElementById('stock-price-eur').textContent).toContain(expected);
        expect(document.getElementById('kpi-modal-price-eur').textContent).toContain(expected);
        expect(document.getElementById('stock-fx-meta').textContent).toContain(`1 ${metrics.normalizeCurrency(currency).iso}`);
        expect(document.getElementById('stock-fx-meta').textContent).toContain('change du 30/09/2026');
    });

    it('keeps EUR quotes single-line and labels an index conversion as indicative', () => {
        renderQuote({ currency: 'EUR', price: 123.45, rate: 1, marketRate: 1 });
        expect(document.getElementById('stock-price').textContent).toBe('123,45 EUR');
        expect(document.getElementById('stock-price-eur').hidden).toBe(true);

        renderQuote({ currency: 'USD', price: 5000, rate: 0.9, quoteType: 'INDEX' });
        expect(document.getElementById('stock-price').textContent).toBe('5 000,00 points');
        expect(document.getElementById('stock-price-eur').textContent).toContain('indicatif');
    });

    it('shows unavailable and stale FX states without inventing a rate', () => {
        renderQuote({ currency: 'CAD', price: 20, rate: null });
        const eur = document.getElementById('stock-price-eur');
        expect(eur.textContent).toBe('Conversion EUR indisponible');
        expect(eur.classList.contains('is-unavailable')).toBe(true);
        expect(document.getElementById('stock-fx-meta').hidden).toBe(true);

        renderQuote({ currency: 'USD', price: 20, rate: 0.9, stale: true });
        const meta = document.getElementById('stock-fx-meta');
        expect(meta.textContent).toContain('taux ancien');
        expect(meta.classList.contains('is-stale')).toBe(true);
    });

    it('expires FX cache entries and retries immediately after a failed request', async () => {
        const now = Date.parse('2026-10-01T12:00:00Z');
        vi.spyOn(Date, 'now').mockReturnValue(now);
        app.fetchPriceHistory = vi.fn()
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValue([{ t: now - 3600_000, c: 0.9, session: '2026-10-01', closed: true }]);

        await expect(app.fetchFxSeries('USD', 'EUR', '1mo')).resolves.toBeNull();
        const fx = await app.fetchFxSeries('USD', 'EUR', '1mo');
        await app.fetchFxSeries('USD', 'EUR', '1mo');
        expect(fx.latest).toBeCloseTo(0.9);
        expect(fx.latestAt).toBe(now - 3600_000);
        expect(fx.stale).toBe(false);
        expect(app.fetchPriceHistory).toHaveBeenCalledTimes(2);
        expect(app.fetchPriceHistory).toHaveBeenLastCalledWith('USDEUR=X', '1mo', { daily: true });
    });
});
