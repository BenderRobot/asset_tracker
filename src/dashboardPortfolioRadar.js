import { selectDailyContributions } from './dashboardContributions.js';
import { findHoldingForNews } from './newsHoldingMatcher.js';
import { YAHOO_MAP } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function eventTime(value) {
    const raw = value?.raw ?? value?.fmt ?? value;
    if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
}

export function selectPortfolioNewsSignals(snapshot, articles = [], now = Date.now(), { previousSession = false } = {}) {
    const contributions = selectDailyContributions(snapshot, { previousSession });
    if (contributions.status === 'unavailable' || contributions.status === 'previous-session') {
        return { status: contributions.status, rows: [] };
    }
    const positions = (snapshot.positions || []).filter(position => position.quantity > 0);
    const recent = articles.filter(article => {
        const publishedAt = Number(article?.datetime) * 1000;
        return Number.isFinite(publishedAt) && publishedAt <= now && now - publishedAt <= 2 * DAY_MS;
    }).sort((a, b) => b.datetime - a.datetime);
    const matched = new Map();
    for (const article of recent) {
        const holding = findHoldingForNews(article, positions);
        if (holding && !matched.has(holding.ticker)) matched.set(holding.ticker, article);
    }
    const rows = contributions.rows.filter(row => row.impact < 0)
        .sort((a, b) => a.impact - b.impact)
        .slice(0, 3)
        .map(row => ({ ...row, article: matched.get(row.ticker) || null }));
    return { status: contributions.status, rows };
}

export function companyCalendarCandidates(holdings = []) {
    const excluded = /^(ETF|ETC|CRYPTO|CASH|REAL ESTATE|IMMOBILIER)$/i;
    const seen = new Set();
    return holdings.filter(holding => {
        const ticker = String(holding?.ticker || '').trim().toUpperCase();
        if (!(Number(holding?.quantity) > 0) || !ticker || excluded.test(String(holding.assetType || ''))) return false;
        if (seen.has(ticker)) return false;
        seen.add(ticker);
        return true;
    }).map(holding => ({
        ticker: String(holding.ticker).trim().toUpperCase(),
        providerSymbol: YAHOO_MAP[String(holding.ticker).trim().toUpperCase()] || String(holding.ticker).trim().toUpperCase(),
        name: holding.name || holding.ticker
    }));
}

export function parseUpcomingEarnings(holding, quoteSummary, now = Date.now()) {
    const event = quoteSummary?.calendarEvents?.earnings;
    const dates = (event?.earningsDate || []).map(eventTime).filter(time => Number.isFinite(time) && time >= now - DAY_MS && time <= now + 180 * DAY_MS)
        .sort((a, b) => a - b);
    if (!dates.length) return null;
    return {
        ticker: holding.ticker,
        name: holding.name,
        providerSymbol: holding.providerSymbol,
        date: dates[0],
        endDate: dates.length > 1 ? dates[dates.length - 1] : null,
        estimated: event.isEarningsDateEstimate === true
    };
}
