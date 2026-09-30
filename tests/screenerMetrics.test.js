import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    YEAR_MS, normalizeCurrency, currencyContext, valueAt, alignSeriesByTime, normalizePair,
    annualSeriesStats, median, averageCost, fundamentalRows, historicalMultiples, forwardEstimates,
    hasFundamentalProfile, radarDimensions, quantScore, fairPriceModel, simpleDcf,
} from '../src/screenerMetrics.js';

const r = raw => ({ raw });
const day = iso => Date.parse(`${iso}T00:00:00Z`);

// Values taken from the real Yahoo responses of 2026-09-30 (TSM ADR, NYSE).
const TSM = {
    price: { currency: 'USD', quoteType: 'EQUITY', regularMarketPrice: r(458.04) },
    financialData: { financialCurrency: 'TWD', freeCashflow: r(730826014720) },
    defaultKeyStatistics: { sharesOutstanding: r(5186474013), trailingEps: r(13.43) },
    earningsTrend: {
        trend: [
            { period: '0y', endDate: '2026-12-31', earningsEstimate: { avg: r(16.93389), earningsCurrency: 'USD' } },
            { period: '+1y', endDate: '2027-12-31', earningsEstimate: { avg: r(21.9251), earningsCurrency: 'USD' } },
        ],
    },
};

describe('currencies', () => {
    it('normalises minor units (London pence)', () => {
        expect(normalizeCurrency('GBp')).toEqual({ iso: 'GBP', factor: 0.01 });
        expect(normalizeCurrency('EUR')).toEqual({ iso: 'EUR', factor: 1 });
    });

    it('flags statements reported in another currency than the quote (ADR)', () => {
        const ctx = currencyContext(TSM);
        expect(ctx).toMatchObject({ quote: 'USD', priceIso: 'USD', finIso: 'TWD', needsFx: true });
    });

    it('prefers the currency published with the annual statements', () => {
        const ctx = currencyContext({ price: { currency: 'GBp' }, financialData: { financialCurrency: 'USD' } }, [{ year: '2025', currency: 'EUR' }]);
        expect(ctx).toMatchObject({ priceIso: 'GBP', priceFactor: 0.01, finIso: 'EUR', needsFx: true });
    });
});

describe('time series', () => {
    const series = [{ t: 10, c: 1 }, { t: 20, c: 2 }, { t: 30, c: 3 }];

    it('reads the last value at or before a date, never a future one', () => {
        expect(valueAt(series, 5)).toBeNull();
        expect(valueAt(series, 20)).toBe(2);
        expect(valueAt(series, 29)).toBe(2);
        expect(valueAt(series, 99)).toBe(3);
    });

    it('aligns a benchmark on the stock dates and normalises from the first common date', () => {
        const stock = [{ t: 5, c: 50 }, { t: 15, c: 55 }, { t: 30, c: 60 }];
        const aligned = alignSeriesByTime(stock, series);
        expect(aligned).toEqual([null, 1, 3]);
        const pair = normalizePair(stock.map(d => d.c), aligned);
        expect(pair.start).toBe(1);
        expect(pair.base).toEqual([null, 100, (60 / 55) * 100]);
        expect(pair.other).toEqual([null, 100, 300]);
    });

    it('does not compute a growth footer from a zero or missing start', () => {
        expect(annualSeriesStats([0, 10, 20])).toBeNull();
        expect(annualSeriesStats([null, 10, 20])).toMatchObject({ perf: 100 });
        expect(annualSeriesStats([5])).toBeNull();
    });

    it('computes the median of real values only', () => {
        expect(median([3, null, 1, 2])).toBe(2);
        expect(median([])).toBeNull();
    });
});

describe('average cost (PRU)', () => {
    it('keeps the average cost of the remaining shares after a partial sale', () => {
        const rows = [
            { ticker: 'AAPL', date: '2024-01-02', price: 100, quantity: 10, currency: 'USD', assetType: 'Stock' },
            { ticker: 'AAPL', date: '2024-06-01', price: 150, quantity: -5, currency: 'USD', assetType: 'Stock' },
            { ticker: 'AAPL', date: '2024-07-01', price: 12, quantity: 1, currency: 'USD', assetType: 'Dividend' },
        ];
        expect(averageCost(rows, 'aapl')).toEqual({ quantity: 5, avgPrice: 100, currency: 'USD' });
    });

    it('returns nothing for a fully sold position or mixed-currency lots', () => {
        expect(averageCost([
            { ticker: 'X', date: '2024-01-01', price: 10, quantity: 2, currency: 'EUR' },
            { ticker: 'X', date: '2024-02-01', price: 12, quantity: -2, currency: 'EUR' },
        ], 'X')).toBeNull();
        expect(averageCost([
            { ticker: 'X', date: '2024-01-01', price: 10, quantity: 2, currency: 'EUR' },
            { ticker: 'X', date: '2024-02-01', price: 12, quantity: 2, currency: 'USD' },
        ], 'X')).toBeNull();
    });
});

describe('fundamentals', () => {
    const fundamentals = [
        { year: '2024', endDate: '2024-12-31', annualFreeCashFlow: 870e9, annualNetIncome: 1173e9, annualTotalRevenue: 2894e9, annualStockholdersEquity: 3600e9, annualDilutedAverageShares: 25.93e9 },
        { year: '2025', endDate: '2025-12-31', annualFreeCashFlow: 730.8e9, annualNetIncome: 1718e9, annualTotalRevenue: 3800e9, annualStockholdersEquity: 4500e9, annualDilutedAverageShares: 25.93e9 },
    ];

    it('expresses per-share values per quoted ADR, not per ordinary share', () => {
        const rows = fundamentalRows(fundamentals, 5.186e9);
        expect(rows[1].shares).toBeCloseTo(5.186e9, -3);
        expect(rows[1].fcfPerShare).toBeCloseTo(730.8e9 / 5.186e9, 6);
    });

    it('converts the reporting currency before comparing with the price (TSM: P/FCF ≈ 100, not 3)', () => {
        const rows = fundamentalRows(fundamentals, 5.186e9);
        const twdUsd = 0.0315;
        const hist = historicalMultiples(rows, () => 458.04, () => twdUsd);
        expect(hist[1].pfcf).toBeCloseTo(458.04 / ((730.8e9 / 5.186e9) * twdUsd), 6);
        expect(hist[1].pfcf).toBeGreaterThan(90);
        expect(hist[1].fcfPerShare).toBeCloseTo(4.44, 2);
    });

    it('leaves multiples empty when the FX rate or the price is unknown', () => {
        const rows = fundamentalRows(fundamentals, 5.186e9);
        expect(historicalMultiples(rows, () => 458, () => null)[0].pe).toBeNull();
        expect(historicalMultiples(rows, () => null, () => 1)[0].pe).toBeNull();
    });

    it('uses analyst EPS estimates converted from their own currency', () => {
        const estimates = forwardEstimates(TSM, 458.04, code => (code === 'USD' ? 1 : null));
        expect(estimates.map(e => e.label)).toEqual(['Exercice 2026', 'Exercice 2027']);
        expect(estimates[1].pe).toBeCloseTo(458.04 / 21.9251, 6);
        expect(forwardEstimates(TSM, 458.04, () => null)).toEqual([]);
    });
});

describe('quantitative profile', () => {
    it('is not available for ETFs, indices or crypto', () => {
        expect(hasFundamentalProfile({ price: { quoteType: 'ETF' }, summaryDetail: {} })).toBe(false);
        expect(hasFundamentalProfile({ price: { quoteType: 'CRYPTOCURRENCY' } })).toBe(false);
        expect(hasFundamentalProfile(TSM)).toBe(true);
    });

    it('never scores missing fields as zero', () => {
        const dims = radarDimensions({}, {});
        expect(dims['Retours']).toBeNull();
        expect(dims['Santé']).toBeNull();
        expect(quantScore(dims)).toBeNull();
    });

    it('reads the five-year average yield as a percentage (Yahoo already sends 0.5 for 0.5 %)', () => {
        const low = radarDimensions({}, { dividendYield: r(0.0033), fiveYearAvgDividendYield: r(0.5) });
        // 0.33 % yield → 0.253 + 1.2 (pays) + 0.2 (5-year 0.5 %) = 1.653
        expect(low['Dividende']).toBeCloseTo(0.253 + 1.2 + 0.2, 3);
    });

    it('rescales an axis when only part of its inputs is published', () => {
        const dims = radarDimensions({ grossMargins: r(0.6), operatingMargins: r(0.3) }, {});
        // (60 + 30) × 3/2 = 135 → capped at 5
        expect(dims['Marges']).toBe(5);
    });

    it('scores on computable axes only', () => {
        const full = {
            returnOnEquity: r(0.2), returnOnAssets: r(0.1), grossMargins: r(0.4), operatingMargins: r(0.2),
            profitMargins: r(0.15), revenueGrowth: r(0.1), earningsGrowth: r(0.1), currentRatio: r(1.5), debtToEquity: r(50),
        };
        const score = quantScore(radarDimensions(full, {}));
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThanOrEqual(20);
    });
});

describe('valuation models', () => {
    it('refuses to compute a fair price from missing inputs', () => {
        expect(fairPriceModel({ baseMetric: null, growthRate: 0.1, multiple: 20, targetReturn: 0.12 })).toBeNull();
        expect(fairPriceModel({ baseMetric: 5, growthRate: null, multiple: 20, targetReturn: 0.12 })).toBeNull();
        expect(fairPriceModel({ baseMetric: -1, growthRate: 0.1, multiple: 20, targetReturn: 0.12 })).toBeNull();
    });

    it('discounts the terminal value and the dividends at the target return', () => {
        const res = fairPriceModel({ baseMetric: 10, growthRate: 0, multiple: 15, targetReturn: 0.1, dividendRate: 0, currentPrice: 100, years: 1 });
        expect(res.fairPrice).toBeCloseTo(150 / 1.1, 9);
        expect(res.safetyMargin).toBeCloseTo(((150 / 1.1) - 100) / (150 / 1.1) * 100, 9);
    });

    it('needs a real growth rate for the simplified DCF', () => {
        expect(simpleDcf(5, null)).toBeNull();
        expect(simpleDcf(-2, 0.1)).toBeNull();
        expect(simpleDcf(5, 0.5).growth).toBe(0.2);
    });
});

describe('screener page contains no fabricated data', () => {
    const source = readFileSync(new URL('../src/screenerApp.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../screener.html', import.meta.url), 'utf8');

    it.each([
        ['random values', /Math\.random/],
        ['community ratings', /évaluations|Communaut/i],
        ['hard-coded exchange prefix', /XNGS/],
        ['dummy series', /Dummy|Simulated/i],
        ['hard-coded P/E median', /25\.4/],
        ['exchange-based PEA guess', /PEA/],
    ])('has no %s', (_, pattern) => {
        expect(source).not.toMatch(pattern);
        expect(html).not.toMatch(pattern);
    });

    it('keeps the 3-year window at three years', () => {
        expect(source).toMatch(/'3y': \{ years: 3/);
        expect(3 * YEAR_MS).toBeGreaterThan(2 * YEAR_MS);
    });
});
