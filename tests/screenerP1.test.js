import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import * as metrics from '../src/screenerMetrics.js';

// Exercise the actual class and real page markup, replacing Firebase and the
// canvas renderer only. Network payloads stay deterministic and credential-free.
const source = readFileSync(new URL('../src/screenerApp.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../screener.html', import.meta.url), 'utf8');
let app, document, dom, charts, context;
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
    context = vm.createContext({
        ...metrics, document, window: dom.window, Chart, Date, Intl, console,
        setTimeout, clearTimeout, AbortController, DOMException, URL, fetch: vi.fn(),
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
        app.safeFetchJson = vi.fn(async () => ({ events: [{ timestamp: 1700000000, amount: 1 }] }));
        await expect(app.renderDividendeTab()).resolves.toBe(true);
        expect(app.safeFetchJson).toHaveBeenCalledWith('https://example.invalid?symbol=AAPL&type=DIVIDENDS');
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

    it('shows the fitted trend over short periods instead of annualising it', () => {
        const points = dates => dates.map((date, index) => ({
            t: Date.parse(`${date}T16:00:00Z`),
            session: date,
            closed: true,
            c: 100 * Math.pow(1.02, index),
        }));
        app.currentData.quoteSummary.price = { currency: 'USD' };
        app.currentPeriod = '1mo';
        app.currentData.priceHistory = points(['2026-09-01', '2026-09-10', '2026-09-20', '2026-09-30']);

        app.renderRegressionChart();

        expect(document.getElementById('regression-card-title').textContent).toBe('Tendance semi-log');
        expect(document.getElementById('reg-slope-label').textContent).toBe('Tendance 1M');
        expect(document.getElementById('reg-slope').textContent).toMatch(/^\+?6\.1%$/);
        expect(document.getElementById('reg-slope').textContent).not.toContain('/an');

        app.currentPeriod = '5y';
        app.currentData.priceHistory = points(['2023-01-01', '2024-01-01', '2025-01-01', '2026-01-01']);
        app.renderRegressionChart();
        expect(document.getElementById('reg-slope-label').textContent).toBe('Pente /an');
        expect(document.getElementById('reg-slope').textContent).toContain('/an');
    });

    it('uses the compact regression layout and removes sigma bands from the legend', async () => {
        app.modalHistory = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'].map((date, index) => ({
            t: Date.parse(`${date}T16:00:00Z`),
            c: 100 * Math.pow(1.03, index),
            a: 100 * Math.pow(1.03, index),
        }));
        app.currentModalPeriod = '3mo';

        await app.renderKpiModalContent('regression');

        const content = document.querySelector('.kpi-modal-content');
        const modalChart = charts.get(document.getElementById('kpi-modal-chart'));
        expect(content.classList.contains('regression-mode-layout')).toBe(true);
        expect(document.querySelector('.kpi-modal-sidebar-header h3').textContent).toBe('Réglages de tendance');
        expect(document.querySelector('.regression-stats-grid')).not.toBeNull();
        expect(document.querySelectorAll('.regression-stat-card')).toHaveLength(6);
        expect(document.getElementById('kpi-modal-stats').textContent).toContain('sur période');
        expect(modalChart.config.data.datasets.filter(dataset => dataset.isBand)
            .every(dataset => dataset.label == null)).toBe(true);
        const bandIndex = modalChart.config.data.datasets.findIndex(dataset => dataset.isBand);
        expect(modalChart.config.options.plugins.legend.labels.filter(
            { text: 'Band', datasetIndex: bandIndex }, modalChart.config.data,
        )).toBe(false);
        expect(modalChart.config.options.scales.y.ticks.maxTicksLimit).toBe(8);
        expect(modalChart.config.options.plugins.tooltip.callbacks.label({
            parsed: { y: 120 }, dataset: { isBand: true },
        })).toBeNull();

        await app.renderKpiModalContent('price');
        expect(content.classList.contains('regression-mode-layout')).toBe(false);
        expect(document.querySelector('.kpi-modal-sidebar-header h3').textContent).toBe('Paramètres');
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

    it('adds the same EUR countervalue to valuation estimates and dividends', async () => {
        app.currentData = {
            ...app.currentData,
            currency: { quote: 'USD', priceIso: 'USD', priceFactor: 1, finIso: 'USD', needsFx: false },
            eurFx: { latest: 0.9, marketRate: 0.9, fromIso: 'USD', toIso: 'EUR' },
            finFx: { latest: 1, at: () => 1 },
            quoteSummary: {
                price: { currency: 'USD', regularMarketPrice: { raw: 100 } },
                defaultKeyStatistics: { sharesOutstanding: { raw: 100 }, trailingEps: { raw: 5 } },
                financialData: { freeCashflow: { raw: 500 }, totalRevenue: { raw: 2000 }, revenueGrowth: { raw: 0.05 } },
                summaryDetail: { trailingPE: { raw: 20 }, dividendYield: { raw: 0.02 }, dividendRate: { raw: 2 } },
            },
        };
        app.renderValuation();
        expect(document.getElementById('valuation-list').textContent).toContain('90,00 €');
        expect(app.calculatorHeaderHtml({ result: { fairPrice: 120, estReturn: 4, safetyMargin: 10 } }, 'USD')).toContain('108,00 €');

        app.safeFetchJson = vi.fn(async () => ({ events: [] }));
        await app.renderDividendeTab();
        const dividendEur = document.getElementById('div-kpi-rate-eur');
        expect(dividendEur.hidden).toBe(false);
        expect(dividendEur.textContent).toContain('1,80 € au taux du jour');
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

    it('converts modal history with the FX rate from each date', async () => {
        const first = Date.parse('2026-09-01T16:00:00Z');
        const second = Date.parse('2026-09-30T16:00:00Z');
        app.currentData.currency.quote = 'USD';
        app.fetchFxSeries = vi.fn(async () => ({
            latest: 0.9,
            at: t => t === first ? 0.8 : 0.9,
        }));
        const rates = await app.getConversionArray('EUR', [
            { t: first, c: 100 },
            { t: second, c: 100 },
        ]);
        expect(rates).toEqual([0.8, 0.9]);
        expect(rates[0]).not.toBe(0.9);
    });

    it('switches the main price charts to dated EUR rates and back to native values', async () => {
        const first = { t: Date.parse('2026-09-01T16:00:00Z'), session: '2026-09-01', closed: true, c: 100 };
        const second = { t: Date.parse('2026-09-30T16:00:00Z'), session: '2026-09-30', closed: true, c: 100 };
        const stock = [first, second, { ...second, t: second.t + 1000, session: '2026-10-01', c: 100 }, { ...second, t: second.t + 2000, session: '2026-10-02', c: 100 }];
        const benchmark = stock.map((point, index) => ({ ...point, c: 200 + index * 2 }));
        app.currentData = {
            ...app.currentData,
            priceHistory: stock,
            sp500History: benchmark,
            pru: { value: 75 },
            eurFx: { latest: 0.9, marketRate: 0.9 },
            currency: { quote: 'USD', priceIso: 'USD', priceFactor: 1, finIso: 'USD' },
            quoteSummary: { price: {
                currency: 'USD', regularMarketPrice: { raw: 100 }, regularMarketChangePercent: { raw: 0.01 },
            } },
        };
        app.getConversionArray = vi.fn(async (_target, data, source) => {
            expect(source).toBe('USD');
            return data === stock ? [0.8, 0.85, 0.88, 0.9] : [0.8, 0.85, 0.88, 0.9];
        });
        app.setupChartCurrencyToggle();

        document.querySelector('.chart-currency-btn[data-currency="EUR"]').click();
        await vi.waitFor(() => expect(app.chartCurrency).toBe('EUR'));
        expect(charts.get(document.getElementById('price-chart')).config.data.datasets[0].data).toEqual([80, 85, 88, 90]);
        expect(document.getElementById('price-chart-label').textContent).toContain('90,00 EUR');
        expect(document.getElementById('sp500-currency-note').textContent).toContain('taux historiques');
        expect(document.querySelector('.chart-currency-btn[data-currency="EUR"]').getAttribute('aria-pressed')).toBe('true');

        document.querySelector('.chart-currency-btn[data-currency="NATIVE"]').click();
        expect(app.chartCurrency).toBe('NATIVE');
        expect(charts.get(document.getElementById('price-chart')).config.data.datasets[0].data).toEqual([100, 100, 100, 100]);
        expect(document.getElementById('price-chart-label').textContent).toContain('USD');
    });

    it('keeps native charts selected when historical FX is unavailable', async () => {
        app.currentData.priceHistory = [{ t: Date.now(), session: '2026-10-01', closed: true, c: 100 }];
        app.currentData.sp500History = [];
        app.getConversionArray = vi.fn(async () => null);
        app.setupChartCurrencyToggle();
        document.querySelector('.chart-currency-btn[data-currency="EUR"]').click();
        await vi.waitFor(() => expect(document.getElementById('screener-temp-msg')).not.toBeNull());
        expect(app.chartCurrency).toBe('NATIVE');
        expect(document.querySelector('.chart-currency-btn[data-currency="NATIVE"]').getAttribute('aria-pressed')).toBe('true');
        expect(document.getElementById('screener-temp-msg').textContent).toContain('indisponible');
    });

    it('carries the global EUR choice into a price detail modal', async () => {
        app.chartCurrency = 'EUR';
        app.currentData = {
            ...app.currentData,
            hasFundamentals: true,
            quoteSummary: { price: {
                currency: 'USD', quoteType: 'EQUITY', regularMarketPrice: { raw: 100 },
                regularMarketChangePercent: { raw: 0.01 }, shortName: 'Test',
            }, assetProfile: {} },
        };
        app.fetchPriceHistory = vi.fn(async () => []);
        app.renderKpiModalContent = vi.fn(async () => {});
        await app.openKpiModal('price');
        expect(document.getElementById('kpi-currency-select').value).toBe('EUR');
        expect(document.getElementById('kpi-currency-label').textContent).toBe('EUR');
        expect(document.querySelector('#kpi-currency-options [data-value="EUR"]').classList.contains('selected')).toBe(true);
    });
});

describe('Screener P2 robustness', () => {
    const history = () => Array.from({ length: 4 }, (_, index) => ({
        t: Date.parse(`2026-09-${String(index + 1).padStart(2, '0')}T16:00:00Z`),
        session: `2026-09-${String(index + 1).padStart(2, '0')}`,
        closed: true,
        c: 100 + index,
    }));

    it('keeps the previous summary period after failure and retries from the message', async () => {
        app.currentData.priceHistory = history();
        app.currentData.sp500History = history();
        app.currentData.quoteSummary.price = { currency: 'USD', regularMarketPrice: { raw: 103 } };
        app.fetchPriceHistory = vi.fn().mockRejectedValue(new Error('502'));
        app.setupPeriodButtons();

        const previous = document.querySelector('.period-btn[data-period="1y"]');
        const requested = document.querySelector('.period-btn[data-period="3mo"]');
        requested.click();
        await vi.waitFor(() => expect(document.querySelector('.screener-retry-btn')).not.toBeNull());
        expect(app.currentPeriod).toBe('1y');
        expect(previous.classList.contains('active')).toBe(true);
        expect(requested.classList.contains('active')).toBe(false);
        expect(document.getElementById('price-chart-state').textContent).toContain('Période indisponible');
        expect(document.getElementById('price-chart-state').hidden).toBe(false);

        app.fetchPriceHistory.mockResolvedValue(history());
        document.querySelector('.screener-retry-btn').click();
        await vi.waitFor(() => expect(app.currentPeriod).toBe('3mo'));
        expect(requested.classList.contains('active')).toBe(true);
        expect(requested.hasAttribute('aria-busy')).toBe(false);
        expect(document.getElementById('price-chart-state').hidden).toBe(true);
    });

    it('keeps the previous modal period on failure, then accepts a successful retry', async () => {
        app.currentModalPeriod = '10y';
        app.currentModalKpi = 'price';
        app.modalHistory = history();
        app.fetchPriceHistory = vi.fn().mockResolvedValue(null);
        app.renderKpiModalContent = vi.fn(async () => {});
        app.setupModalPeriodButtons();

        const previous = document.querySelector('.kpi-period-btn[data-period="10y"]');
        const requested = document.querySelector('.kpi-period-btn[data-period="1mo"]');
        requested.click();
        await vi.waitFor(() => expect(document.querySelector('.screener-retry-btn')).not.toBeNull());
        expect(app.currentModalPeriod).toBe('10y');
        expect(previous.classList.contains('active')).toBe(true);
        expect(document.getElementById('kpi-modal-chart-state').textContent).toContain('Période indisponible');

        app.fetchPriceHistory.mockResolvedValue(history());
        document.querySelector('.screener-retry-btn').click();
        await vi.waitFor(() => expect(app.currentModalPeriod).toBe('1mo'));
        expect(requested.classList.contains('active')).toBe(true);
        expect(app.renderKpiModalContent).toHaveBeenCalledWith('price');
    });

    it('fetches each comparison series only once when its modal period changes', async () => {
        app.currentModalPeriod = '10y';
        app.currentModalKpi = 'sp500';
        app.fetchPriceHistory = vi.fn(async () => history());
        app.setupModalPeriodButtons();

        const requested = document.querySelector('.kpi-period-btn[data-period="1mo"]');
        requested.click();

        await vi.waitFor(() => expect(charts.get(document.getElementById('kpi-modal-chart'))).toBeDefined());
        expect(app.currentModalPeriod).toBe('1mo');
        expect(app.fetchPriceHistory).toHaveBeenCalledTimes(2);
        expect(app.fetchPriceHistory.mock.calls.map(call => call[0])).toEqual(['AAPL', '^GSPC']);
        expect(app.fetchPriceHistory.mock.calls.every(call => call[1] === '1mo' && call[2]?.daily === true)).toBe(true);
        expect(requested.classList.contains('active')).toBe(true);
    });

    it('keeps the previous comparison chart on failure and replaces it after retry', async () => {
        app.currentModalPeriod = '10y';
        app.currentModalKpi = 'sp500';
        const previousChart = { destroy: vi.fn() };
        app.modalChart = previousChart;
        app.fetchPriceHistory = vi.fn(async () => null);
        app.setupModalPeriodButtons();

        const previous = document.querySelector('.kpi-period-btn[data-period="10y"]');
        const requested = document.querySelector('.kpi-period-btn[data-period="1mo"]');
        requested.click();

        await vi.waitFor(() => expect(document.getElementById('kpi-modal-chart-state').textContent)
            .toContain('Comparaison indisponible'));
        expect(app.currentModalPeriod).toBe('10y');
        expect(previous.classList.contains('active')).toBe(true);
        expect(requested.classList.contains('active')).toBe(false);
        expect(previousChart.destroy).not.toHaveBeenCalled();

        app.fetchPriceHistory.mockResolvedValue(history());
        document.querySelector('#kpi-modal-chart-state .chart-inline-retry').click();
        await vi.waitFor(() => expect(charts.get(document.getElementById('kpi-modal-chart'))).toBeDefined());
        expect(app.currentModalPeriod).toBe('1mo');
        expect(requested.classList.contains('active')).toBe(true);
        expect(previousChart.destroy).toHaveBeenCalledTimes(1);
    });

    it('commits only the latest comparison period when requests overlap', async () => {
        const firstRequest = pending();
        app.currentModalPeriod = '10y';
        app.currentModalKpi = 'sp500';
        app.fetchPriceHistory = vi.fn((symbol, period) => {
            if (symbol === 'AAPL' && period === '1mo') return firstRequest.promise;
            return Promise.resolve(history());
        });
        app.setupModalPeriodButtons();

        const first = document.querySelector('.kpi-period-btn[data-period="1mo"]');
        const latest = document.querySelector('.kpi-period-btn[data-period="3mo"]');
        first.click();
        await vi.waitFor(() => expect(app.fetchPriceHistory).toHaveBeenCalledTimes(1));
        latest.click();

        await vi.waitFor(() => expect(app.currentModalPeriod).toBe('3mo'));
        firstRequest.resolve(history());
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(app.currentModalPeriod).toBe('3mo');
        expect(first.classList.contains('active')).toBe(false);
        expect(latest.classList.contains('active')).toBe(true);
        expect(app.fetchPriceHistory.mock.calls.map(call => [call[0], call[1]])).toEqual([
            ['AAPL', '1mo'],
            ['AAPL', '3mo'],
            ['^GSPC', '3mo'],
        ]);
    });

    it('invalidates an in-flight modal period request when the modal closes', async () => {
        const request = pending();
        app.currentModalPeriod = '10y';
        app.currentModalKpi = 'price';
        app.modalHistory = history();
        app.fetchPriceHistory = vi.fn(() => request.promise);
        app.renderKpiModalContent = vi.fn(async () => {});
        app.setupModalPeriodButtons();

        document.querySelector('.kpi-period-btn[data-period="1mo"]').click();
        await vi.waitFor(() => expect(app.fetchPriceHistory).toHaveBeenCalled());
        app.closeKpiModal();
        request.resolve(history());
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(app.currentModalPeriod).toBe('10y');
        expect(app.modalHistory).toBeNull();
        expect(app.renderKpiModalContent).not.toHaveBeenCalled();
    });

    it('aborts a stalled fetch at the configured timeout', async () => {
        app.requestTimeoutMs = 5;
        context.fetch.mockImplementation((_url, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        }));
        await expect(app.safeFetchJson('https://example.invalid/stalled')).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(context.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failed long history and retries the Valuation tab', async () => {
        app.currentData = {
            ...app.currentData,
            priceHistoryLong: null,
            currency: { quote: 'USD', priceIso: 'USD', priceFactor: 1, finIso: 'USD', needsFx: false },
            finFx: { latest: 1, at: () => 1 },
            quoteSummary: {
                price: { currency: 'USD', quoteType: 'EQUITY', regularMarketPrice: { raw: 103 } },
                defaultKeyStatistics: { sharesOutstanding: { raw: 100 }, trailingEps: { raw: 5 } },
                financialData: { financialCurrency: 'USD', freeCashflow: { raw: 500 }, operatingCashflow: { raw: 600 }, totalRevenue: { raw: 2000 } },
                summaryDetail: { trailingPE: { raw: 20 }, dividendRate: { raw: 2 } },
            },
        };
        app.fetchPriceHistory = vi.fn()
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValueOnce(history());

        await expect(app.renderValuationTab()).resolves.toBe(false);
        expect(app.currentData.priceHistoryLong).toBeNull();
        const state = document.getElementById('valuation-tab-chart-state');
        expect(state.hidden).toBe(false);
        expect(state.textContent).toContain('Historique long indisponible');
        expect(charts.get(document.getElementById('valuation-tab-chart'))).toBeUndefined();

        state.querySelector('.chart-inline-retry').click();
        await vi.waitFor(() => expect(charts.get(document.getElementById('valuation-tab-chart'))).toBeDefined());
        expect(app.fetchPriceHistory).toHaveBeenCalledTimes(2);
        expect(app.currentData.priceHistoryLong).toEqual(history());
        expect(state.hidden).toBe(true);
    });

    it('keeps the last payment chart when dividend events fail, then replaces it on retry', async () => {
        app.safeFetchJson = vi.fn(async () => ({ events: [{ timestamp: 1700000000, amount: 1 }] }));
        await app.renderDividendeTab();
        const canvas = document.getElementById('chart-dividend-payments');
        const previousChart = charts.get(canvas);

        app.safeFetchJson.mockRejectedValueOnce(new Error('502'));
        await expect(app.renderDividendeTab()).resolves.toBe(false);
        const state = document.getElementById('dividend-payments-state');
        expect(state.textContent).toContain('Historique des versements indisponible');
        expect(charts.get(canvas)).toBe(previousChart);
        expect(previousChart.destroyed).toBe(false);

        app.safeFetchJson.mockResolvedValueOnce({ events: [{ timestamp: 1710000000, amount: 1.1 }] });
        state.querySelector('.chart-inline-retry').click();
        await vi.waitFor(() => expect(charts.get(canvas)).not.toBe(previousChart));
        expect(previousChart.destroyed).toBe(true);
        expect(state.hidden).toBe(true);
        expect(app.dividendCharts).toHaveLength(3);
    });

    it('checks dividend events even when summary fields do not indicate a dividend', async () => {
        app.currentData.quoteSummary.summaryDetail = {};
        app.currentData.rows = app.currentData.rows.map(row => ({ ...row, dividendPerShare: 0 }));
        app.safeFetchJson = vi.fn(async () => ({ events: [{ timestamp: 1700000000, amount: 0.5 }] }));

        await expect(app.renderDividendeTab()).resolves.toBe(true);

        expect(app.safeFetchJson).toHaveBeenCalledWith('https://example.invalid?symbol=AAPL&type=DIVIDENDS');
        expect(document.getElementById('dividende-empty').style.display).toBe('none');
        expect(document.getElementById('dividende-content').style.display).toBe('');
        expect(charts.get(document.getElementById('chart-dividend-payments'))).toBeDefined();
    });

    it('retries missing fundamentals from the Quantitative tab', async () => {
        app.currentData = {
            ...app.currentData,
            fundamentals: [],
            rows: [],
            hasFundamentals: true,
            quoteSummary: {
                price: { currency: 'USD', quoteType: 'EQUITY' },
                financialData: { financialCurrency: 'USD' },
                summaryDetail: {},
            },
        };
        const fundamentals = ['2024', '2025'].map((year, index) => ({
            year,
            endDate: `${year}-12-31`,
            currency: 'USD',
            annualTotalRevenue: 1000 + index * 100,
            annualGrossProfit: 500 + index * 50,
            annualOperatingIncome: 200 + index * 20,
            annualNetIncome: 100 + index * 10,
            annualOperatingCashFlow: 150 + index * 10,
            annualFreeCashFlow: 120 + index * 10,
            annualStockholdersEquity: 500,
            annualTotalAssets: 1000,
            annualCashAndCashEquivalents: 200,
            annualTotalDebt: 100,
            annualBasicAverageShares: 100,
            annualDilutedAverageShares: 102,
            annualCommonStockDividendPaid: -20,
            annualCapitalExpenditure: -30,
        }));
        app.fetchFundamentals = vi.fn(async () => fundamentals);
        app.fetchFxSeries = vi.fn(async () => ({ latest: 1, at: () => 1 }));

        await expect(app.renderQuantitativeTab()).resolves.toBe(false);
        const state = document.getElementById('quant-tab-state');
        expect(state.textContent).toContain('Historique financier indisponible');
        expect(document.getElementById('quant-grid').style.display).toBe('none');

        state.querySelector('.chart-inline-retry').click();
        await vi.waitFor(() => expect(state.hidden).toBe(true));
        expect(app.fetchFundamentals).toHaveBeenCalledWith('AAPL');
        expect(app.currentData.fundamentals).toEqual(fundamentals);
        expect(document.getElementById('quant-grid').style.display).toBe('');
        expect(app.quantCharts.length).toBeGreaterThan(0);
    });

    it('renders the quote before optional fundamentals, benchmark and FX finish', async () => {
        const fundamentals = pending();
        const benchmark = pending();
        const points = history();
        app.render = vi.fn();
        app.showState = vi.fn();
        app.fetchQuoteSummary = vi.fn(async () => ({
            price: { currency: 'USD', quoteType: 'EQUITY', regularMarketPrice: { raw: 100 } },
            financialData: { financialCurrency: 'USD' },
        }));
        app.fetchPriceHistory = vi.fn(symbol => symbol === '^GSPC' ? benchmark.promise : Promise.resolve(points));
        app.fetchFundamentals = vi.fn(() => fundamentals.promise);
        app.fetchFxSeries = vi.fn(async () => ({ latest: 0.9, marketRate: 0.9, at: () => 0.9 }));
        app.computePru = vi.fn(async () => null);

        const loading = app.loadStock('AAPL');
        await vi.waitFor(() => expect(app.render).toHaveBeenCalledTimes(1));
        expect(app.currentData.fundamentals).toEqual([]);
        expect(app.currentData.eurFxPending).toBe(true);
        expect(app.showState).toHaveBeenCalledWith('panel');

        benchmark.resolve(points);
        fundamentals.resolve([{ year: '2025', currency: 'USD', annualNetIncome: 100 }]);
        await loading;
        expect(context.logger.error.mock.calls).toEqual([]);
        expect(app.render).toHaveBeenCalledTimes(2);
        expect(app.render).toHaveBeenLastCalledWith({ resetTab: false });
        expect(app.currentData.fundamentals).toHaveLength(1);
        expect(app.currentData.eurFxPending).toBe(false);
    });

    it('prefetches three histories only for price-based modals', async () => {
        app.currentData.hasFundamentals = true;
        app.currentData.quoteSummary = { price: { currency: 'USD', regularMarketPrice: { raw: 100 } }, assetProfile: {} };
        app.fetchPriceHistory = vi.fn(async () => []);
        app.renderKpiModalContent = vi.fn(async () => {});

        await app.openKpiModal('price');
        expect(app.fetchPriceHistory).toHaveBeenCalledTimes(3);
        app.closeKpiModal();

        for (const type of ['sp500', 'radar', 'valuation']) {
            app.fetchPriceHistory.mockClear();
            await app.openKpiModal(type);
            expect(app.fetchPriceHistory, type).not.toHaveBeenCalled();
            app.closeKpiModal();
        }
    });
});
