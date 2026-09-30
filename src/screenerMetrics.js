// ============================================================
// screenerMetrics.js — pure computations for the Screener page
// ============================================================
// No DOM, no network: every function takes Yahoo payloads (or series already
// fetched by screenerApp.js) and returns numbers or null. `null` always means
// "not computable from real data" and must be rendered as "—", never replaced
// by a default value.
import { transactionKind } from './financialTransactions.js';

export const YEAR_MS = 365.25 * 24 * 3600 * 1000;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const raw = v => (v && typeof v === 'object' ? v.raw : v);
const num = v => (isNum(raw(v)) ? raw(v) : null);

// ─── Currencies ──────────────────────────────────────────────────────────────
// Yahoo quotes some lines in minor units (London in pence: GBp/GBX). EPS,
// dividends and statements are always in major units, so every cross ratio is
// computed in the ISO major currency.
const MINOR_UNITS = { GBp: 'GBP', GBX: 'GBP', ZAc: 'ZAR', ZAC: 'ZAR', ILA: 'ILS' };

export function normalizeCurrency(code) {
    if (!code) return { iso: null, factor: 1 };
    if (MINOR_UNITS[code]) return { iso: MINOR_UNITS[code], factor: 0.01 };
    return { iso: String(code).toUpperCase(), factor: 1 };
}

// Yahoo FX symbol quoting units of `toIso` for one `fromIso`.
export function fxSymbol(fromIso, toIso) {
    return `${fromIso}${toIso}=X`;
}

// Everything the page needs to know about the currencies of one quote.
export function currencyContext(quoteSummary, fundamentals = []) {
    const quote = quoteSummary?.price?.currency || quoteSummary?.summaryDetail?.currency || null;
    const { iso: priceIso, factor: priceFactor } = normalizeCurrency(quote);
    const financial = fundamentals.find(y => y.currency)?.currency
        || quoteSummary?.financialData?.financialCurrency
        || quoteSummary?.earnings?.financialCurrency
        || priceIso;
    const finIso = normalizeCurrency(financial).iso;
    return { quote, priceIso, priceFactor, finIso, needsFx: !!(finIso && priceIso && finIso !== priceIso) };
}

// ─── Series helpers ─────────────────────────────────────────────────────────
// Last observation at or before `t` (causal). null when the series starts after t.
export function valueAt(series, t, key = 'c') {
    if (!series?.length || t < series[0].t) return null;
    let lo = 0, hi = series.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (series[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    const v = series[lo][key] ?? series[lo].c;
    return isNum(v) ? v : null;
}

// Re-expresses `other` on the timestamps of `base`, causally.
export function alignSeriesByTime(base, other, key = 'c') {
    return (base || []).map(d => valueAt(other, d.t, key));
}

// Normalises two aligned series to 100 from the first date where both exist.
export function normalizePair(baseValues, otherValues) {
    const start = baseValues.findIndex((v, i) => isNum(v) && v > 0 && isNum(otherValues[i]) && otherValues[i] > 0);
    if (start < 0) return null;
    const b0 = baseValues[start], o0 = otherValues[start];
    return {
        start,
        base: baseValues.map((v, i) => (i < start || !isNum(v) ? null : (v / b0) * 100)),
        other: otherValues.map((v, i) => (i < start || !isNum(v) ? null : (v / o0) * 100)),
    };
}

export function cagr(first, last, years) {
    if (!isNum(first) || !isNum(last) || first <= 0 || last <= 0 || !(years > 0)) return null;
    return (Math.pow(last / first, 1 / years) - 1) * 100;
}

// Perf/CAGR footer of the annual charts: only defined on positive endpoints.
export function annualSeriesStats(series) {
    const points = (series || []).filter(isNum);
    if (points.length < 2) return null;
    const start = points[0], end = points[points.length - 1];
    if (start === 0) return null;
    return {
        perf: ((end - start) / Math.abs(start)) * 100,
        cagr: cagr(start, end, points.length - 1),
    };
}

export function median(values) {
    const s = (values || []).filter(isNum).sort((a, b) => a - b);
    if (!s.length) return null;
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ─── Position (PRU) ─────────────────────────────────────────────────────────
// Weighted average cost of the shares still held, replaying buys and sells in
// date order. Dividends and cash rows are ignored. Returns null when nothing
// is held or when the lots mix currencies (no silent cross-currency average).
export function averageCost(transactions, ticker) {
    const upper = String(ticker || '').toUpperCase();
    const rows = (transactions || [])
        .filter(p => String(p.ticker || '').toUpperCase() === upper && transactionKind(p) === 'asset')
        .filter(p => isNum(p.quantity) && isNum(p.price))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (!rows.length) return null;

    const currencies = new Set(rows.map(p => p.currency || 'EUR'));
    if (currencies.size > 1) return null;

    let quantity = 0, cost = 0;
    for (const p of rows) {
        if (p.quantity > 0) {
            quantity += p.quantity;
            cost += p.quantity * p.price;
        } else if (quantity > 0) {
            const sold = Math.min(-p.quantity, quantity);
            cost -= (cost / quantity) * sold;
            quantity -= sold;
        }
    }
    if (quantity <= 1e-9) return null;
    return { quantity, avgPrice: cost / quantity, currency: [...currencies][0] };
}

// ─── Fundamentals ───────────────────────────────────────────────────────────
// Per-share values of each fiscal year, in the financial currency, expressed
// per QUOTED share. For ADRs, Yahoo's sharesOutstanding counts ADR equivalents
// while statements count ordinary shares; the ratio of the latest year rescales
// every year consistently (1 for ordinary listings).
export function fundamentalRows(fundamentals, sharesOutstanding) {
    const years = (fundamentals || []).filter(y => y && y.year);
    if (!years.length) return [];
    const sharesOf = y => y.annualDilutedAverageShares ?? y.annualBasicAverageShares ?? null;
    const lastShares = [...years].reverse().map(sharesOf).find(isNum);
    const scale = isNum(sharesOutstanding) && isNum(lastShares) && lastShares > 0 ? sharesOutstanding / lastShares : 1;
    const perShare = (value, shares) => (isNum(value) && isNum(shares) && shares > 0 ? value / shares : null);

    return years.map(y => {
        const shares = isNum(sharesOf(y)) ? sharesOf(y) * scale : null;
        return {
            year: y.year,
            endTs: y.endDate ? Date.parse(`${y.endDate}T23:59:59Z`) : null,
            revenue: y.annualTotalRevenue ?? null,
            netIncome: y.annualNetIncome ?? null,
            fcf: y.annualFreeCashFlow ?? null,
            ocf: y.annualOperatingCashFlow ?? null,
            equity: y.annualStockholdersEquity ?? null,
            shares,
            eps: perShare(y.annualNetIncome, shares),
            fcfPerShare: perShare(y.annualFreeCashFlow, shares),
            ocfPerShare: perShare(y.annualOperatingCashFlow, shares),
            salesPerShare: perShare(y.annualTotalRevenue, shares),
            bookPerShare: perShare(y.annualStockholdersEquity, shares),
            dividendPerShare: isNum(y.annualCommonStockDividendPaid) && isNum(shares) && shares > 0
                ? Math.abs(y.annualCommonStockDividendPaid) / shares : null,
        };
    });
}

// Year-end multiples from real statements and the real closing price.
// priceAt(t) → price in priceIso major units; fxAt(t) → finIso→priceIso rate.
export function historicalMultiples(rows, priceAt, fxAt) {
    const ratio = (price, perShare, rate) =>
        isNum(price) && isNum(perShare) && perShare > 0 && isNum(rate) ? price / (perShare * rate) : null;
    return rows.map(r => {
        const price = r.endTs ? priceAt(r.endTs) : null;
        const rate = r.endTs ? fxAt(r.endTs) : null;
        return {
            year: r.year,
            endTs: r.endTs,
            price,
            fcfPerShare: isNum(r.fcfPerShare) && isNum(rate) ? r.fcfPerShare * rate : null,
            epsPerShare: isNum(r.eps) && isNum(rate) ? r.eps * rate : null,
            pe: ratio(price, r.eps, rate),
            pfcf: ratio(price, r.fcfPerShare, rate),
            pocf: ratio(price, r.ocfPerShare, rate),
            ps: ratio(price, r.salesPerShare, rate),
        };
    });
}

// Forward P/E from analyst EPS estimates (earningsTrend 0y / +1y).
export function forwardEstimates(quoteSummary, priceMajor, fxToPrice) {
    const trend = quoteSummary?.earningsTrend?.trend || [];
    return trend
        .filter(t => t.period === '0y' || t.period === '+1y')
        .map(t => {
            const eps = num(t.earningsEstimate?.avg);
            const rate = fxToPrice(t.earningsEstimate?.earningsCurrency);
            const epsPrice = isNum(eps) && isNum(rate) ? eps * rate : null;
            return {
                label: t.endDate ? `Exercice ${String(t.endDate).slice(0, 4)}` : t.period,
                eps: epsPrice,
                pe: isNum(epsPrice) && epsPrice > 0 && isNum(priceMajor) ? priceMajor / epsPrice : null,
            };
        })
        .filter(e => e.eps != null);
}

// ─── Instrument type ────────────────────────────────────────────────────────
// Fundamental analysis (score, radar, valuation, statements) only exists for
// operating companies. ETFs, indices, crypto and futures have no statements.
export function hasFundamentalProfile(quoteSummary) {
    const type = quoteSummary?.price?.quoteType;
    return type === 'EQUITY' && !!quoteSummary?.financialData;
}

// ─── Quantitative profile ───────────────────────────────────────────────────
// Sum of the present inputs, rescaled to the full input count. null when none
// of the inputs exists, so a missing field is never scored as zero.
function partial(values) {
    const present = values.filter(isNum);
    if (!present.length) return null;
    return present.reduce((s, v) => s + v, 0) * (values.length / present.length);
}
const clamp = (v, min, max) => (v == null ? null : Math.min(Math.max(v, min), max));

export const RADAR_AXES = ['Retours', 'Marges', 'Croissance', 'Rentabilité', 'Dividende', 'Santé'];

export function radarDimensions(financial = {}, detail = {}) {
    const pct = v => (num(v) == null ? null : num(v) * 100);
    const roe = pct(financial.returnOnEquity);
    const roa = pct(financial.returnOnAssets);
    const gross = pct(financial.grossMargins);
    const operating = pct(financial.operatingMargins);
    const net = pct(financial.profitMargins);
    const revenueGrowth = pct(financial.revenueGrowth);
    const earningsGrowth = pct(financial.earningsGrowth);
    const currentRatio = num(financial.currentRatio);
    const debtToEquity = num(financial.debtToEquity);

    // For an operating company Yahoo omits dividend fields when none is paid:
    // absence means 0 here, which is a real value.
    const dividendYield = (pct(detail.dividendYield) ?? pct(detail.trailingAnnualDividendYield)) ?? 0;
    const fiveYearAvgYield = num(detail.fiveYearAvgDividendYield) ?? 0; // already in %
    const payout = num(detail.payoutRatio);
    const paysDividend = dividendYield > 0;

    const returns = partial([roe, isNum(roa) ? roa * 1.4 : null]);
    const margins = partial([gross, operating, net]);
    const growth = partial([revenueGrowth, earningsGrowth]);
    const profitability = partial([net, operating, roe]);

    let health = null;
    if (isNum(currentRatio)) {
        const base = clamp((currentRatio / 3) * 3.5, 0, 3.5);
        health = isNum(debtToEquity)
            ? base + (debtToEquity <= 80 ? 1.5 : debtToEquity <= 150 ? 1 : 0.4)
            : base * (5 / 3.5);
    }

    const dividend = paysDividend
        ? clamp((dividendYield / 3) * 2.3, 0, 2.3) + 1.2 + clamp((fiveYearAvgYield / 2) * 0.8, 0, 0.8)
            + (isNum(payout) ? (payout >= 0 && payout <= 0.7 ? 0.7 : payout <= 1 ? 0.5 : 0.2) : 0)
        : 0;

    return {
        'Retours': clamp(returns == null ? null : (returns / 30) * 5, 0, 5),
        'Marges': clamp(margins == null ? null : (margins / 90) * 5, 0, 5),
        'Croissance': clamp(growth == null ? null : ((growth + 15) / 55) * 5, 0, 5),
        'Rentabilité': clamp(profitability == null ? null : (profitability / 75) * 5, 0, 5),
        'Dividende': clamp(dividend, 0, 5),
        'Santé': clamp(health, 0, 5),
    };
}

// Score /20 over the axes that could be computed; null below 4 axes.
export function quantScore(dimensions) {
    const values = Object.values(dimensions || {}).filter(isNum);
    if (values.length < 4) return null;
    return (values.reduce((s, v) => s + v, 0) / (values.length * 5)) * 20;
}

// ─── Valuation ──────────────────────────────────────────────────────────────
// Discounted terminal multiple + discounted dividends over `years`.
export function fairPriceModel({ baseMetric, growthRate, multiple, targetReturn, dividendRate = 0, includeDividends = true, currentPrice, years = 10 }) {
    if (![baseMetric, growthRate, multiple, targetReturn].every(isNum) || baseMetric <= 0 || multiple <= 0 || targetReturn <= -1) return null;
    let pvDividends = 0;
    if (includeDividends && isNum(dividendRate) && dividendRate > 0) {
        for (let y = 1; y <= years; y++) {
            pvDividends += (dividendRate * Math.pow(1 + growthRate, y)) / Math.pow(1 + targetReturn, y);
        }
    }
    const terminal = baseMetric * Math.pow(1 + growthRate, years) * multiple;
    const fairPrice = terminal / Math.pow(1 + targetReturn, years) + pvDividends;
    return {
        fairPrice,
        safetyMargin: fairPrice > 0 && isNum(currentPrice) ? ((fairPrice - currentPrice) / fairPrice) * 100 : null,
        estReturn: fairPrice > 0 && isNum(currentPrice) && currentPrice > 0 ? (Math.pow(fairPrice / currentPrice, 1 / years) - 1) * 100 : null,
    };
}

// Simplified 10-year DCF on FCF per share + Gordon terminal value.
export function simpleDcf(fcfPerShare, growthRate, { discountRate = 0.10, terminalGrowth = 0.025, years = 10, maxGrowth = 0.20 } = {}) {
    if (!isNum(fcfPerShare) || fcfPerShare <= 0 || !isNum(growthRate)) return null;
    const g = Math.min(growthRate, maxGrowth);
    let value = 0, fcf = fcfPerShare;
    for (let y = 1; y <= years; y++) {
        fcf *= 1 + g;
        value += fcf / Math.pow(1 + discountRate, y);
    }
    value += (fcf * (1 + terminalGrowth)) / (discountRate - terminalGrowth) / Math.pow(1 + discountRate, years);
    return { value, growth: g, discountRate, terminalGrowth };
}
