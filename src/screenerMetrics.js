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
    const statementCurrencies = [...new Set((fundamentals || []).flatMap(period => {
        const published = period?.currencies?.length ? period.currencies : [period?.currency];
        return published.map(code => normalizeCurrency(code).iso).filter(Boolean);
    }))];
    const finCurrencyMixed = statementCurrencies.length > 1;
    const financial = statementCurrencies.length === 1 ? statementCurrencies[0]
        : statementCurrencies.length > 1 ? null
        : quoteSummary?.financialData?.financialCurrency
            || quoteSummary?.earnings?.financialCurrency
            || priceIso;
    const finIso = normalizeCurrency(financial).iso;
    return {
        quote, priceIso, priceFactor, finIso,
        finCurrencies: statementCurrencies,
        finCurrencyMixed,
        needsFx: !!(finIso && priceIso && finIso !== priceIso),
    };
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

// Compare completed daily sessions by their local exchange date. Never carry a
// benchmark across a missing session (holidays, crypto weekends, open markets).
export function commonSessions(base, other, key = 'c') {
    const date = p => p.session || new Date(p.t).toISOString().slice(0, 10);
    const right = new Map((other || []).filter(p => p.closed !== false).map(p => [date(p), p]));
    return (base || []).filter(p => p.closed !== false).flatMap(p => {
        const match = right.get(date(p));
        const a = p[key], b = match?.[key];
        return isNum(a) && a > 0 && isNum(b) && b > 0
            ? [{ t: p.t, session: date(p), base: a, other: b }] : [];
    });
}

export function dailyCloseAt(series, t) {
    const date = new Date(t).toISOString().slice(0, 10);
    for (let i = (series?.length || 0) - 1; i >= 0; i--) {
        const p = series[i];
        if (p.closed !== false && p.session <= date && isNum(p.c)) return p.c;
    }
    return null;
}

export function monthlyCloses(series) {
    const months = new Map();
    for (const p of series || []) {
        if (p.closed !== false) months.set((p.session || new Date(p.t).toISOString()).slice(0, 7), p);
    }
    return [...months.values()];
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
    if (!isNum(first) || !isNum(last) || !isNum(years) || first <= 0 || last <= 0 || !(years > 0)) return null;
    return (Math.pow(last / first, 1 / years) - 1) * 100;
}

// Perf/CAGR footer of the annual charts: only defined on positive endpoints.
export function annualSeriesStats(series, years = null) {
    const position = (value, fallback) => {
        if (isNum(value)) return value;
        if (/^\d{4}$/.test(String(value || ''))) return Number(value);
        const timestamp = Date.parse(String(value || ''));
        return Number.isFinite(timestamp) ? timestamp / YEAR_MS : fallback;
    };
    const points = (series || [])
        .map((v, i) => ({ v, year: years ? position(years[i], i) : i }))
        .filter(p => isNum(p.v));
    if (points.length < 2) return null;
    const start = points[0].v, end = points[points.length - 1].v;
    if (start === 0) return null;
    return {
        perf: ((end - start) / Math.abs(start)) * 100,
        cagr: cagr(start, end, points[points.length - 1].year - points[0].year),
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
// Without instrument-level depositary metadata, cross-currency/foreign US
// listings have an unconfirmed share basis. Do not infer an ADR ratio from
// today's shares outstanding (buybacks/dilution change that count as well).
export function historicalShareBasis(quoteSummary, context = currencyContext(quoteSummary)) {
    const price = quoteSummary?.price || {};
    const country = quoteSummary?.assetProfile?.country;
    const foreignUS = country && country !== 'United States'
        && /Nasdaq|NYSE|New York|NMS|NYQ|NGM|NCM|ASE/i.test(price.exchangeName || '');
    const depositary = /\bADR\b|\bADS\b|depositary/i.test(`${price.longName || ''} ${price.shortName || ''}`);
    return context.needsFx || foreignUS || depositary ? null : 1;
}

// One dated, confirmed ordinary-shares-per-quoted-share factor per fiscal year
// may be supplied. Otherwise retain published ordinary per-share values, or
// return null for unconfirmed instruments. Never rescale with current shares.
export function fundamentalRows(fundamentals, { ordinaryPerQuoted = 1 } = {}) {
    const years = (fundamentals || []).filter(y => y && y.year);
    if (!years.length) return [];
    const sharesOf = y => y.annualDilutedAverageShares ?? y.annualBasicAverageShares ?? null;
    const perShare = (value, shares) => (isNum(value) && isNum(shares) && shares > 0 ? value / shares : null);

    return years.map(y => {
        const factor = typeof ordinaryPerQuoted === 'function' ? ordinaryPerQuoted(y.endDate) : ordinaryPerQuoted;
        const confirmed = isNum(factor) && factor > 0;
        const shares = confirmed && isNum(sharesOf(y)) ? sharesOf(y) / factor : null;
        const publishedEps = num(y.annualDilutedEPS) ?? num(y.annualBasicEPS);
        return {
            fiscalId: y.fiscalId || `${y.periodType || '12M'}:${y.endDate || y.year}`,
            year: y.year,
            endDate: y.endDate || null,
            periodType: y.periodType || '12M',
            currency: y.currency || null,
            currencies: y.currencies || (y.currency ? [y.currency] : []),
            currencyByMetric: y.currencyByMetric || {},
            currencyConflict: !!y.currencyConflict,
            metricConflicts: y.metricConflicts || [],
            endTs: y.endDate ? Date.parse(`${y.endDate}T23:59:59Z`) : null,
            revenue: y.annualTotalRevenue ?? null,
            netIncome: y.annualNetIncome ?? null,
            fcf: y.annualFreeCashFlow ?? null,
            ocf: y.annualOperatingCashFlow ?? null,
            equity: y.annualStockholdersEquity ?? null,
            shares,
            eps: confirmed ? (publishedEps != null ? publishedEps * factor : perShare(y.annualNetIncome, shares)) : null,
            fcfPerShare: perShare(y.annualFreeCashFlow, shares),
            ocfPerShare: perShare(y.annualOperatingCashFlow, shares),
            salesPerShare: perShare(y.annualTotalRevenue, shares),
            bookPerShare: perShare(y.annualStockholdersEquity, shares),
            dividendPerShare: isNum(y.annualCommonStockDividendPaid) && isNum(shares) && shares > 0
                ? Math.abs(y.annualCommonStockDividendPaid) / shares : null,
        };
    });
}

// Statement availability is independent from quoteSummary.financialData.
// Yahoo may omit that real-time module while still returning valid annual
// statements from fundamentals-timeseries.
export function hasFinancialStatements(fundamentals) {
    return (fundamentals || []).some(period => period && (period.endDate || period.year)
        && Object.entries(period).some(([key, value]) => key.startsWith('annual') && isNum(value)));
}

export function fiscalPeriodLabel(period, { short = false } = {}) {
    const endDate = period?.endDate;
    let close = period?.year || 'date inconnue';
    if (endDate && Number.isFinite(Date.parse(`${endDate}T00:00:00Z`))) {
        close = new Intl.DateTimeFormat('fr-FR', {
            day: 'numeric', month: short ? 'short' : 'long', year: 'numeric', timeZone: 'UTC',
        }).format(new Date(`${endDate}T00:00:00Z`));
    }
    const periodType = period?.periodType;
    const suffix = periodType && !['12M', 'ANNUAL', 'FY'].includes(String(periodType).toUpperCase())
        ? ` · ${periodType}` : '';
    return `${short ? '' : 'Exercice clos le '}${close}${suffix}`;
}

function statementMetricCurrency(period, key) {
    return normalizeCurrency(period?.currencyByMetric?.[key] || period?.currency).iso;
}

function consecutiveAnnualPeriods(current, previous) {
    if (!current || !previous) return false;
    const currentType = String(current.periodType || '12M').toUpperCase();
    const previousType = String(previous.periodType || '12M').toUpperCase();
    if (currentType !== previousType) return false;
    if (current.endDate && previous.endDate) {
        const gapDays = (Date.parse(`${current.endDate}T00:00:00Z`) - Date.parse(`${previous.endDate}T00:00:00Z`)) / 86400000;
        return Number.isFinite(gapDays) && gapDays >= 300 && gapDays <= 430;
    }
    const gapYears = Number(current.year) - Number(previous.year);
    return Number.isFinite(gapYears) && gapYears === 1;
}

// `periods` must be ordered newest first, as displayed by the Finances table.
// Missing/zero denominators, incomparable currencies and fiscal gaps stay null.
export function financialStatementViewValue(periods, index, row, statementKey, mode = 'amount') {
    const period = periods?.[index];
    const value = period?.[row?.key];
    if (!isNum(value)) return null;
    if (mode === 'amount') return value;

    if (mode === 'change') {
        const previous = periods[index + 1];
        const previousValue = previous?.[row.key];
        if (!isNum(previousValue) || previousValue === 0 || !consecutiveAnnualPeriods(period, previous)) return null;
        const currentCurrency = statementMetricCurrency(period, row.key);
        const previousCurrency = statementMetricCurrency(previous, row.key);
        if ((currentCurrency || previousCurrency) && currentCurrency !== previousCurrency) return null;
        return ((value - previousValue) / Math.abs(previousValue)) * 100;
    }

    if (mode === 'common') {
        if (row.perShare) return null;
        const denominatorKey = statementKey === 'balance' ? 'annualTotalAssets' : 'annualTotalRevenue';
        const denominator = period[denominatorKey];
        if (!isNum(denominator) || denominator === 0) return null;
        const valueCurrency = statementMetricCurrency(period, row.key);
        const denominatorCurrency = statementMetricCurrency(period, denominatorKey);
        if ((valueCurrency || denominatorCurrency) && valueCurrency !== denominatorCurrency) return null;
        return (value / Math.abs(denominator)) * 100;
    }

    return null;
}

function marketDateParts(timestamp, timeZone) {
    if (!isNum(timestamp) || timestamp <= 0) return null;
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timeZone || 'UTC',
        }).formatToParts(new Date(timestamp * 1000));
        const value = type => parts.find(part => part.type === type)?.value;
        const year = Number(value('year'));
        const month = value('month');
        const day = value('day');
        return Number.isFinite(year) && month && day ? { year, iso: `${year}-${month}-${day}` } : null;
    } catch {
        return marketDateParts(timestamp, 'UTC');
    }
}

// Aggregates provider dividend events by civil year in the exchange timezone.
// Absence is interpreted only inside calendar years fully covered by the
// provider response; an incomplete current/start year never becomes a claimed
// suspension.
export function dividendEventSummary(events, coverage = {}) {
    const timeZone = coverage.exchangeTimezoneName || 'UTC';
    const clean = (events || [])
        .map(event => ({ timestamp: Number(event?.timestamp), amount: Number(event?.amount) }))
        .filter(event => isNum(event.timestamp) && event.timestamp > 0 && isNum(event.amount) && event.amount >= 0)
        .sort((a, b) => a.timestamp - b.timestamp);
    const start = marketDateParts(Number(coverage.startTimestamp), timeZone);
    const end = marketDateParts(Number(coverage.endTimestamp), timeZone);
    if (!clean.length) {
        return { annual: [], latestComplete: null, lastChange: null, continuityYears: null,
            missingCompleteYears: [], lastEvent: null, eventCount: 0, coverageKnown: !!(start && end),
            coverageStart: start?.iso || null, coverageEnd: end?.iso || null, timeZone };
    }

    const grouped = new Map();
    clean.forEach(event => {
        const date = marketDateParts(event.timestamp, timeZone);
        if (!date) return;
        const row = grouped.get(date.year) || { year: date.year, total: 0, count: 0, events: [] };
        row.total += event.amount;
        row.count += 1;
        row.events.push(event);
        grouped.set(date.year, row);
    });
    const firstYear = Math.min(...grouped.keys());
    const lastYear = end?.year ?? Math.max(...grouped.keys());
    const annual = [];
    for (let year = firstYear; year <= lastYear; year++) {
        const row = grouped.get(year) || { year, total: 0, count: 0, events: [] };
        const complete = !!(start && end && start.iso <= `${year}-01-01` && end.iso >= `${year}-12-31`);
        annual.push({ ...row, complete });
    }

    const completed = annual.filter(row => row.complete);
    const latestComplete = completed.at(-1) || null;
    const previousComplete = completed.length >= 2 ? completed.at(-2) : null;
    let lastChange = null;
    if (latestComplete && previousComplete && latestComplete.year === previousComplete.year + 1) {
        if (previousComplete.total > 0) {
            const percent = ((latestComplete.total - previousComplete.total) / previousComplete.total) * 100;
            lastChange = {
                fromYear: previousComplete.year, toYear: latestComplete.year, percent,
                direction: percent > 0.05 ? 'increase' : percent < -0.05 ? 'decrease' : 'stable',
            };
        } else if (latestComplete.total > 0) {
            lastChange = { fromYear: previousComplete.year, toYear: latestComplete.year, percent: null, direction: 'resumed' };
        }
    }
    let continuityYears = completed.length ? 0 : null;
    for (let index = completed.length - 1; index >= 0 && completed[index].count > 0; index--) continuityYears += 1;
    const missingCompleteYears = completed.filter(row => row.count === 0).map(row => row.year);

    return {
        annual, latestComplete, lastChange, continuityYears, missingCompleteYears,
        lastEvent: clean.at(-1) || null, eventCount: clean.length,
        coverageKnown: !!(start && end), coverageStart: start?.iso || null, coverageEnd: end?.iso || null, timeZone,
    };
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
            fiscalId: r.fiscalId,
            year: r.year,
            endDate: r.endDate,
            periodType: r.periodType,
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
const clamp = (v, min, max) => (v == null ? null : Math.min(Math.max(v, min), max));

export const RADAR_AXES = ['Retours', 'Marges', 'Croissance', 'Trésorerie', 'Dividende', 'Santé'];
export const QUANT_MIN_COVERAGE = 0.6;

const higherScore = (value, target) => isNum(value) ? clamp((value / target) * 5, 0, 5) : null;
const rangeScore = (value, low, high) => isNum(value) ? clamp(((value - low) / (high - low)) * 5, 0, 5) : null;
const metric = (key, label, value, unit, score, reference) => ({ key, label, value, unit, score, reference });

function buildAxis(metrics) {
    const available = metrics.filter(item => isNum(item.value) && isNum(item.score));
    return {
        score: available.length
            ? available.reduce((sum, item) => sum + item.score, 0) / available.length
            : null,
        available: available.length,
        total: metrics.length,
        metrics,
    };
}

// Rich score contract used by both the compact card and the methodology
// modal. Each Yahoo field belongs to one axis only. Missing fields remain
// unavailable: they are never converted to zero or extrapolated.
export function quantProfile(financial = {}, detail = {}) {
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
    const revenue = num(financial.totalRevenue);
    const freeCashflow = num(financial.freeCashflow);
    const operatingCashflow = num(financial.operatingCashflow);
    const fcfMargin = isNum(freeCashflow) && isNum(revenue) && revenue > 0 ? (freeCashflow / revenue) * 100 : null;
    const operatingCashflowMargin = isNum(operatingCashflow) && isNum(revenue) && revenue > 0
        ? (operatingCashflow / revenue) * 100
        : null;

    // An omitted Yahoo field is not proof that the company pays no dividend.
    // An explicit numeric zero, however, remains a real zero and is scored.
    const dividendYield = pct(detail.dividendYield) ?? pct(detail.trailingAnnualDividendYield);
    const fiveYearAvgYield = num(detail.fiveYearAvgDividendYield); // already in %
    const payout = num(detail.payoutRatio);
    const payoutScore = !isNum(payout) ? null
        : payout < 0 ? 0
            : payout <= 0.7 ? 4.5
                : payout <= 1 ? 3
                    : 1;

    const axes = {
        'Retours': buildAxis([
            metric('roe', 'ROE', roe, '%', higherScore(roe, 25), 'cible 25 %'),
            metric('roa', 'ROA', roa, '%', higherScore(roa, 12), 'cible 12 %'),
        ]),
        'Marges': buildAxis([
            metric('grossMargin', 'Marge brute', gross, '%', higherScore(gross, 60), 'cible 60 %'),
            metric('operatingMargin', 'Marge opérationnelle', operating, '%', higherScore(operating, 30), 'cible 30 %'),
            metric('netMargin', 'Marge nette', net, '%', higherScore(net, 20), 'cible 20 %'),
        ]),
        'Croissance': buildAxis([
            metric('revenueGrowth', 'CA sur 1 an', revenueGrowth, '%', rangeScore(revenueGrowth, -15, 25), 'plage -15 à 25 %'),
            metric('earningsGrowth', 'Bénéfices sur 1 an', earningsGrowth, '%', rangeScore(earningsGrowth, -15, 25), 'plage -15 à 25 %'),
        ]),
        'Trésorerie': buildAxis([
            metric('operatingCashflowMargin', 'Marge de flux d\'exploitation', operatingCashflowMargin, '%', higherScore(operatingCashflowMargin, 30), 'cible 30 %'),
            metric('freeCashflowMargin', 'Marge de free cash-flow', fcfMargin, '%', higherScore(fcfMargin, 25), 'cible 25 %'),
        ]),
        'Dividende': buildAxis([
            metric('dividendYield', 'Rendement', dividendYield, '%', higherScore(dividendYield, 4), 'cible 4 %'),
            metric('payoutRatio', 'Taux de distribution', isNum(payout) ? payout * 100 : null, '%', payoutScore, 'zone cible 0–70 %'),
            metric('fiveYearYield', 'Rendement moyen sur 5 ans', fiveYearAvgYield, '%', higherScore(fiveYearAvgYield, 4), 'cible 4 %'),
        ]),
        'Santé': buildAxis([
            metric('currentRatio', 'Ratio courant', currentRatio, 'x', higherScore(currentRatio, 2), 'cible 2,0x'),
            metric('debtToEquity', 'Dette / capitaux propres', debtToEquity, '%', isNum(debtToEquity) ? clamp(5 - (debtToEquity / 250) * 5, 0, 5) : null, 'meilleur sous 80 %'),
        ]),
    };

    const dimensions = Object.fromEntries(RADAR_AXES.map(axis => [axis, axes[axis].score]));
    const metricsAvailable = Object.values(axes).reduce((sum, axis) => sum + axis.available, 0);
    const metricsTotal = Object.values(axes).reduce((sum, axis) => sum + axis.total, 0);
    const axesAvailable = Object.values(axes).filter(axis => isNum(axis.score)).length;

    return {
        dimensions,
        axes,
        coverage: {
            metricsAvailable,
            metricsTotal,
            percent: metricsTotal ? (metricsAvailable / metricsTotal) * 100 : 0,
            axesAvailable,
            axesTotal: RADAR_AXES.length,
        },
    };
}

export function radarDimensions(financial = {}, detail = {}) {
    return quantProfile(financial, detail).dimensions;
}

// Score /20 over equally weighted available axes. Rich profiles additionally
// require at least 60% of the underlying metrics, so a sparse payload cannot
// look as authoritative as a complete one.
export function quantScore(input) {
    const dimensions = input?.dimensions || input;
    if (input?.coverage) {
        if (input.coverage.axesAvailable < 4 || input.coverage.percent < QUANT_MIN_COVERAGE * 100) return null;
    }
    const values = Object.values(dimensions || {}).filter(isNum);
    if (values.length < 4) return null;
    return (values.reduce((s, v) => s + v, 0) / (values.length * 5)) * 20;
}

// ─── Valuation ──────────────────────────────────────────────────────────────
// Discounted terminal multiple + discounted dividends over `years`.
export function fairPriceModel({ baseMetric, growthRate, multiple, targetReturn, dividendRate = 0, includeDividends = true, currentPrice, years = 10 }) {
    if (![baseMetric, growthRate, multiple, targetReturn, years].every(isNum)
        || baseMetric <= 0 || multiple <= 0 || targetReturn <= -1 || growthRate <= -1
        || !Number.isInteger(years) || years < 1 || years > 100) return null;
    let pvDividends = 0;
    const dividends = Array(years).fill(0);
    if (includeDividends && isNum(dividendRate) && dividendRate > 0) {
        for (let y = 1; y <= years; y++) {
            dividends[y - 1] = dividendRate * Math.pow(1 + growthRate, y);
            pvDividends += dividends[y - 1] / Math.pow(1 + targetReturn, y);
        }
    }
    const terminal = baseMetric * Math.pow(1 + growthRate, years) * multiple;
    const fairPrice = terminal / Math.pow(1 + targetReturn, years) + pvDividends;
    if (!isNum(terminal) || terminal <= 0 || !isNum(fairPrice) || fairPrice <= 0 || !dividends.every(isNum)) return null;
    const flows = dividends.slice();
    flows[years - 1] += terminal;
    if (!flows.every(isNum)) return null;
    // Positive future cash flows give one IRR. Solve in log(1+r), keeping the
    // domain r > -1 and supporting negative returns without arbitrary defaults.
    let estReturn = null;
    if (isNum(currentPrice) && currentPrice > 0) {
        const pv = logRate => flows.reduce((sum, cash, i) => cash > 0 ? sum + cash * Math.exp(-logRate * (i + 1)) : sum, 0);
        let lo = -700, hi = 700;
        for (let i = 0; i < 180; i++) {
            const mid = (lo + hi) / 2;
            if (pv(mid) > currentPrice) lo = mid; else hi = mid;
        }
        const solved = Math.expm1((lo + hi) / 2) * 100;
        if (isNum(solved)) estReturn = solved;
    }
    return {
        fairPrice,
        terminalPrice: terminal,
        safetyMargin: fairPrice > 0 && isNum(currentPrice) ? ((fairPrice - currentPrice) / fairPrice) * 100 : null,
        estReturn,
    };
}

// Simplified 10-year DCF on FCF per share + Gordon terminal value.
export function simpleDcf(fcfPerShare, growthRate, { discountRate = 0.10, terminalGrowth = 0.025, years = 10, maxGrowth = 0.20 } = {}) {
    if (!isNum(fcfPerShare) || fcfPerShare <= 0 || !isNum(growthRate) || growthRate <= -1) return null;
    const g = Math.min(growthRate, maxGrowth);
    let value = 0, fcf = fcfPerShare;
    for (let y = 1; y <= years; y++) {
        fcf *= 1 + g;
        value += fcf / Math.pow(1 + discountRate, y);
    }
    value += (fcf * (1 + terminalGrowth)) / (discountRate - terminalGrowth) / Math.pow(1 + discountRate, years);
    return isNum(value) && value > 0 ? { value, growth: g, discountRate, terminalGrowth } : null;
}
