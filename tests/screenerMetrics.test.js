import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    YEAR_MS, normalizeCurrency, currencyContext, valueAt, alignSeriesByTime, commonSessions, dailyCloseAt, normalizePair,
    annualSeriesStats, median, averageCost, fundamentalRows, historicalMultiples, forwardEstimates,
    hasFundamentalProfile, hasFinancialStatements, fiscalPeriodLabel, historicalShareBasis,
    quantProfile, radarDimensions, quantScore, fairPriceModel, simpleDcf,
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
        const rows = fundamentalRows(fundamentals, { ordinaryPerQuoted: () => 5 });
        expect(rows[1].shares).toBeCloseTo(5.186e9, -3);
        expect(rows[1].fcfPerShare).toBeCloseTo(730.8e9 / 5.186e9, 6);
    });

    it('converts the reporting currency before comparing with the price (TSM: P/FCF ≈ 100, not 3)', () => {
        const rows = fundamentalRows(fundamentals, { ordinaryPerQuoted: () => 5 });
        const twdUsd = 0.0315;
        const hist = historicalMultiples(rows, () => 458.04, () => twdUsd);
        expect(hist[1].pfcf).toBeCloseTo(458.04 / ((730.8e9 / 5.186e9) * twdUsd), 6);
        expect(hist[1].pfcf).toBeGreaterThan(90);
        expect(hist[1].fcfPerShare).toBeCloseTo(4.44, 2);
    });

    it('leaves multiples empty when the FX rate or the price is unknown', () => {
        const rows = fundamentalRows(fundamentals, { ordinaryPerQuoted: () => 5 });
        expect(historicalMultiples(rows, () => 458, () => null)[0].pe).toBeNull();
        expect(historicalMultiples(rows, () => null, () => 1)[0].pe).toBeNull();
    });

    it('uses analyst EPS estimates converted from their own currency', () => {
        const estimates = forwardEstimates(TSM, 458.04, code => (code === 'USD' ? 1 : null));
        expect(estimates.map(e => e.label)).toEqual(['Exercice 2026', 'Exercice 2027']);
        expect(estimates[1].pe).toBeCloseTo(458.04 / 21.9251, 6);
        expect(forwardEstimates(TSM, 458.04, () => null)).toEqual([]);
    });

    it('detects annual statements independently from quoteSummary.financialData', () => {
        expect(hasFinancialStatements([{ year: '2025', endDate: '2025-09-30', annualNetIncome: 10 }])).toBe(true);
        expect(hasFinancialStatements([{ year: '2025', endDate: '2025-09-30', annualNetIncome: null }])).toBe(false);
        expect(hasFinancialStatements([])).toBe(false);
    });

    it('preserves fiscal identity metadata and formats the full close date', () => {
        const [row] = fundamentalRows([{
            fiscalId: '12M:2025-09-30', year: '2025', endDate: '2025-09-30', periodType: '12M',
            currency: 'USD', currencies: ['USD'], currencyByMetric: { annualNetIncome: 'USD' },
            annualNetIncome: 10,
        }]);
        expect(row).toMatchObject({
            fiscalId: '12M:2025-09-30', endDate: '2025-09-30', periodType: '12M',
            currency: 'USD', currencies: ['USD'],
        });
        expect(fiscalPeriodLabel(row)).toBe('Exercice clos le 30 septembre 2025');
    });
});

describe('quantitative profile', () => {
    it('is not available for ETFs, indices or crypto', () => {
        expect(hasFundamentalProfile({ price: { quoteType: 'ETF' }, summaryDetail: {} })).toBe(false);
        expect(hasFundamentalProfile({ price: { quoteType: 'CRYPTOCURRENCY' } })).toBe(false);
        expect(hasFundamentalProfile(TSM)).toBe(true);
    });

    it('never scores missing fields as zero', () => {
        const profile = quantProfile({}, {});
        const dims = profile.dimensions;
        expect(dims['Retours']).toBeNull();
        expect(dims['Santé']).toBeNull();
        expect(dims['Dividende']).toBeNull();
        expect(profile.coverage.metricsAvailable).toBe(0);
        expect(quantScore(profile)).toBeNull();
    });

    it('reads the five-year average yield as a percentage (Yahoo already sends 0.5 for 0.5 %)', () => {
        const low = radarDimensions({}, { dividendYield: r(0.0033), fiveYearAvgDividendYield: r(0.5) });
        // Average of the two available metric scores: 0.33/4×5 and 0.5/4×5.
        expect(low['Dividende']).toBeCloseTo((0.33 / 4 * 5 + 0.5 / 4 * 5) / 2, 6);
    });

    it('averages published metrics without extrapolating a missing input', () => {
        const profile = quantProfile({ grossMargins: r(0.3), operatingMargins: r(0.3) }, {});
        expect(profile.dimensions['Marges']).toBeCloseTo(3.75, 6);
        expect(profile.axes['Marges'].available).toBe(2);
        expect(profile.axes['Marges'].total).toBe(3);
    });

    it('distinguishes an unavailable dividend from an explicit zero yield', () => {
        expect(quantProfile({}, {}).dimensions['Dividende']).toBeNull();
        const noDividend = quantProfile({}, { dividendYield: r(0) });
        expect(noDividend.dimensions['Dividende']).toBe(0);
        expect(noDividend.axes['Dividende'].available).toBe(1);
    });

    it('uses every source metric in one axis only and reports coverage', () => {
        const full = quantProfile({
            returnOnEquity: r(0.2), returnOnAssets: r(0.1),
            grossMargins: r(0.4), operatingMargins: r(0.2), profitMargins: r(0.15),
            revenueGrowth: r(0.1), earningsGrowth: r(0.1),
            totalRevenue: r(1000), operatingCashflow: r(250), freeCashflow: r(180),
            currentRatio: r(1.5), debtToEquity: r(50),
        }, { dividendYield: r(0.02), payoutRatio: r(0.4), fiveYearAvgDividendYield: r(1.8) });
        const keys = Object.values(full.axes).flatMap(axis => axis.metrics.map(item => item.key));
        expect(new Set(keys).size).toBe(keys.length);
        expect(full.coverage).toMatchObject({ metricsAvailable: 14, metricsTotal: 14, percent: 100, axesAvailable: 6, axesTotal: 6 });
        expect(quantScore(full)).toBeGreaterThan(0);
    });

    it('withholds the global score below 60% metric coverage even with four axes', () => {
        const sparse = quantProfile({
            returnOnEquity: r(0.2), grossMargins: r(0.4), revenueGrowth: r(0.1), currentRatio: r(1.5),
        }, {});
        expect(sparse.coverage.axesAvailable).toBe(4);
        expect(sparse.coverage.percent).toBeLessThan(60);
        expect(quantScore(sparse)).toBeNull();
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
    it('returns the target IRR when bought at model value, with and without dividends', () => {
        for (const dividendRate of [0, 2]) {
            const input = { baseMetric: 10, growthRate: 0.04, multiple: 15, targetReturn: 0.1, dividendRate, years: 10 };
            const value = fairPriceModel(input).fairPrice;
            const result = fairPriceModel({ ...input, currentPrice: value });
            expect(result.estReturn).toBeCloseTo(10, 8);
            expect(result.terminalPrice).toBeCloseTo(10 * 1.04 ** 10 * 15, 8);
        }
    });

    it('computes negative returns and the one-year reproduction without discounting twice', () => {
        const base = { baseMetric: 10, growthRate: 0, multiple: 15, targetReturn: 0.1, years: 1, includeDividends: false };
        expect(fairPriceModel({ ...base, currentPrice: 150 / 1.1 }).estReturn).toBeCloseTo(10, 8);
        expect(fairPriceModel({ ...base, currentPrice: 200 }).estReturn).toBeCloseTo(-25, 8);
    });

    it.each([
        { growthRate: -2 }, { growthRate: -1 }, { growthRate: Infinity },
        { years: 0 }, { years: -1 }, { years: 0.5 }, { years: Infinity },
        { multiple: -1 }, { targetReturn: -1 }, { growthRate: 1e100 },
    ])('rejects invalid or overflowing hypotheses: %j', bad => {
        expect(fairPriceModel({ baseMetric: 10, growthRate: 0.1, multiple: 15, targetReturn: 0.1, years: 10, ...bad })).toBeNull();
    });
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

describe('P1 historical data regressions', () => {
    it('keeps missing and skipped fiscal years in CAGR duration', () => {
        expect(annualSeriesStats([100, null, 121]).cagr).toBeCloseTo(10, 9);
        expect(annualSeriesStats([100, 121], ['2023', '2025']).cagr).toBeCloseTo(10, 9);
        expect(annualSeriesStats([null, 100, null, 121], ['2022', '2023', '2024', '2025']).cagr).toBeCloseTo(10, 9);
        expect(annualSeriesStats([100, 121], ['2023-09-30', '2025-09-30']).cagr).toBeCloseTo(10, 2);
    });

    it('preserves published ordinary EPS instead of replacing the average with current shares', () => {
        const data = [{ year: '2025', endDate: '2025-09-30', annualNetIncome: 112010000000,
            annualDilutedAverageShares: 15004697000, annualDilutedEPS: 7.46 }];
        const result = fundamentalRows(data);
        expect(result[0].eps).toBe(7.46);
        expect(result[0].shares).toBe(15004697000);
    });

    it('does not guess ADR factors and supports independently confirmed factors by date', () => {
        expect(historicalShareBasis(TSM)).toBeNull();
        expect(historicalShareBasis({ price: { currency: 'USD', exchangeName: 'NYSE' }, assetProfile: { country: 'United Kingdom' } })).toBeNull();
        expect(historicalShareBasis({ price: { currency: 'USD', exchangeName: 'NasdaqGS' }, assetProfile: { country: 'United States' } })).toBe(1);
        const data = [{ year: '2024', endDate: '2024-12-31', annualDilutedEPS: 2, annualNetIncome: 1000, annualDilutedAverageShares: 500 }];
        expect(fundamentalRows(data, { ordinaryPerQuoted: null })[0]).toMatchObject({ eps: null, shares: null, netIncome: 1000 });
        expect(fundamentalRows(data, { ordinaryPerQuoted: date => date === '2024-12-31' ? 5 : null })[0].eps).toBe(10);
    });

    it('compares local session dates without forward filling holidays or open sessions', () => {
        const left = [
            { t: day('2026-09-02') + 7 * 3600000, session: '2026-09-02', c: 100 },
            { t: day('2026-09-03'), session: '2026-09-03', c: 110 },
            { t: day('2026-09-04'), session: '2026-09-04', c: 120, closed: false },
        ];
        const right = [
            { t: day('2026-09-01'), session: '2026-09-01', c: 90 },
            { t: day('2026-09-02') + 13.5 * 3600000, session: '2026-09-02', c: 105 },
            { t: day('2026-09-04'), session: '2026-09-04', c: 115 },
        ];
        expect(commonSessions(left, right)).toHaveLength(1);
        expect(commonSessions(left, right)[0]).toMatchObject({ base: 100, other: 105, session: '2026-09-02' });
    });

    it('uses a daily close no later than fiscal end, including weekends and intraday exclusions', () => {
        const series = [
            { session: '2025-09-26', c: 100 },
            { session: '2025-09-29', c: 120 },
            { session: '2025-09-30', c: 125, closed: false },
        ];
        expect(dailyCloseAt(series, day('2025-09-27'))).toBe(100);
        expect(dailyCloseAt(series, day('2025-09-30'))).toBe(120);
        expect(dailyCloseAt(series, day('2025-09-20'))).toBeNull();
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
