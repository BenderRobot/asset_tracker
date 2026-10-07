// dividendAnalytics.js - Calculs du modal "Détail des Dividendes" (Analytics).
//
// Module PUR (aucun accès DOM/réseau) : il reçoit les transactions dividende,
// une fonction de conversion EUR et les positions actuelles, et renvoie toutes
// les agrégations affichées (KPI, séries par période, par actif, saisonnalité,
// projection). La conversion USD->EUR reste celle de DataManager (taux
// historique du jour du versement) : un dividende non convertible est exclu
// des totaux et compté dans `excludedCount`, jamais converti au taux courant.

const DAY_MS = 24 * 60 * 60 * 1000;
// Deux versements d'un même actif à moins de 10 jours d'écart sont un seul
// évènement (ex: même dividende réparti sur deux courtiers).
const SAME_EVENT_DAYS = 10;
const MONTH_LABELS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

export { MONTH_LABELS };

function toDate(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function monthKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function periodKey(d, granularity) {
    if (granularity === 'year') return String(d.getFullYear());
    if (granularity === 'quarter') return `${d.getFullYear()}-T${Math.floor(d.getMonth() / 3) + 1}`;
    return monthKey(d);
}

// Liste continue des clés de période entre deux dates (les mois sans
// versement apparaissent à 0 au lieu d'être silencieusement sautés).
export function periodRange(start, end, granularity) {
    const keys = [];
    const step = granularity === 'year' ? 12 : (granularity === 'quarter' ? 3 : 1);
    const cursor = new Date(start.getFullYear(), granularity === 'year' ? 0 : (granularity === 'quarter' ? Math.floor(start.getMonth() / 3) * 3 : start.getMonth()), 1);
    const last = periodKey(end, granularity);
    for (let guard = 0; guard < 1200; guard++) {
        const key = periodKey(cursor, granularity);
        keys.push(key);
        if (key === last) break;
        cursor.setMonth(cursor.getMonth() + step);
    }
    return keys;
}

function frequencyFromInterval(days) {
    if (!Number.isFinite(days)) return { label: 'Indéterminée', perYear: null };
    if (days < 45) return { label: 'Mensuel', perYear: 12 };
    if (days < 120) return { label: 'Trimestriel', perYear: 4 };
    if (days < 240) return { label: 'Semestriel', perYear: 2 };
    return { label: 'Annuel', perYear: 1 };
}

function median(values) {
    if (!values.length) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function growthPct(current, previous) {
    return previous > 0 ? ((current - previous) / previous) * 100 : null;
}

// Regroupe les versements d'un actif en évènements (date + montant cumulé).
function groupEvents(payments) {
    const events = [];
    payments.forEach(p => {
        const last = events[events.length - 1];
        if (last && (p.date - last.date) / DAY_MS <= SAME_EVENT_DAYS) {
            last.amount += p.amount;
        } else {
            events.push({ date: p.date, amount: p.amount });
        }
    });
    return events;
}

/**
 * @param {Array} dividends transactions `type === 'dividend'`
 * @param {Object} options
 * @param {(div) => number|null} options.toEUR montant EUR du versement, null si non convertible
 * @param {Array} [options.holdings] positions actuelles ({ ticker, name, quantity, invested, currentValue })
 * @param {(code) => string} [options.brokerLabel]
 * @param {number} [options.portfolioValue] valeur totale du portefeuille (EUR)
 * @param {Date} [options.now]
 */
export function buildDividendAnalytics(dividends, options = {}) {
    const {
        toEUR = d => Number(d?.price ?? d?.amount) * Number(d?.quantity ?? 1),
        holdings = [],
        brokerLabel = code => code,
        portfolioValue = null,
        now = new Date()
    } = options;

    const payments = [];
    let excludedCount = 0;
    (Array.isArray(dividends) ? dividends : []).forEach(div => {
        const date = toDate(div?.date);
        const amount = toEUR(div);
        if (!date || !Number.isFinite(amount)) { excludedCount++; return; }
        if (amount <= 0) return;
        const ticker = String(div.ticker || '—').trim() || '—';
        payments.push({
            date,
            ticker,
            name: div.name && div.name !== 'Dividend' && div.name !== 'Dividend Manual' ? div.name : ticker,
            broker: brokerLabel(div.broker || 'Inconnu') || div.broker || 'Inconnu',
            amount
        });
    });
    payments.sort((a, b) => a.date - b.date);

    const holdingByTicker = new Map();
    holdings.forEach(h => {
        if (!h?.ticker || !((h.quantity || 0) > 0.0001)) return;
        holdingByTicker.set(String(h.ticker).toUpperCase(), h);
    });

    const ttmStart = new Date(now.getTime() - 365 * DAY_MS);
    const prevTtmStart = new Date(now.getTime() - 730 * DAY_MS);
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const prevYearStart = new Date(now.getFullYear() - 1, 0, 1);
    const prevYearSameDay = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), 23, 59, 59);

    // --- Totaux globaux -------------------------------------------------
    let total = 0, ttm = 0, prevTtm = 0, ytd = 0, prevYtd = 0;
    const byMonth = new Map();
    const byBroker = new Map();
    payments.forEach(p => {
        total += p.amount;
        if (p.date > ttmStart && p.date <= now) ttm += p.amount;
        else if (p.date > prevTtmStart && p.date <= ttmStart) prevTtm += p.amount;
        if (p.date >= yearStart && p.date <= now) ytd += p.amount;
        if (p.date >= prevYearStart && p.date <= prevYearSameDay) prevYtd += p.amount;
        const mk = monthKey(p.date);
        byMonth.set(mk, (byMonth.get(mk) || 0) + p.amount);
        byBroker.set(p.broker, (byBroker.get(p.broker) || 0) + p.amount);
    });

    const firstDate = payments[0]?.date || null;
    const lastDate = payments[payments.length - 1]?.date || null;
    const activeMonths = firstDate
        ? Math.max(1, (now.getFullYear() - firstDate.getFullYear()) * 12 + (now.getMonth() - firstDate.getMonth()) + 1)
        : 0;
    let bestMonth = null;
    byMonth.forEach((amount, key) => { if (!bestMonth || amount > bestMonth.amount) bestMonth = { key, amount }; });

    // --- Par actif ------------------------------------------------------
    const assetMap = new Map();
    payments.forEach(p => {
        const key = p.ticker.toUpperCase();
        if (!assetMap.has(key)) assetMap.set(key, { ticker: p.ticker, name: p.name, payments: [] });
        const a = assetMap.get(key);
        if (a.name === a.ticker && p.name !== p.ticker) a.name = p.name;
        a.payments.push(p);
    });

    const assets = [...assetMap.entries()].map(([key, a]) => {
        const holding = holdingByTicker.get(key) || null;
        const events = groupEvents(a.payments);
        const intervals = events.slice(1).map((e, i) => (e.date - events[i].date) / DAY_MS);
        const medianInterval = median(intervals);
        const frequency = frequencyFromInterval(medianInterval);
        const assetTotal = a.payments.reduce((s, p) => s + p.amount, 0);
        const assetTtm = a.payments.filter(p => p.date > ttmStart && p.date <= now).reduce((s, p) => s + p.amount, 0);
        const assetPrevTtm = a.payments.filter(p => p.date > prevTtmStart && p.date <= ttmStart).reduce((s, p) => s + p.amount, 0);
        const first = a.payments[0].date;
        const last = a.payments[a.payments.length - 1].date;
        const lastEvent = events[events.length - 1];
        const held = !!holding;

        // Revenu annuel projeté : moyenne des `perYear` derniers évènements ×
        // fréquence. Un simple TTM sous-estime dès qu'un versement glisse de
        // quelques jours hors de la fenêtre de 365 jours (ex: trimestriel payé
        // le 1er octobre, consulté le 7). Sans fréquence connue (un seul
        // versement) : le TTM.
        let projectedAnnual = 0;
        if (held) {
            if (frequency.perYear) {
                const recent = events.slice(-frequency.perYear);
                projectedAnnual = (recent.reduce((s, e) => s + e.amount, 0) / recent.length) * frequency.perYear;
            } else {
                projectedAnnual = assetTtm;
            }
        }

        let nextExpected = null;
        if (held && Number.isFinite(medianInterval)) {
            nextExpected = new Date(lastEvent.date.getTime() + medianInterval * DAY_MS);
            // Versement en retard : on le projette sur la prochaine échéance future.
            while (nextExpected < new Date(now.getTime() - 30 * DAY_MS)) {
                nextExpected = new Date(nextExpected.getTime() + medianInterval * DAY_MS);
            }
        }

        const byYear = {};
        a.payments.forEach(p => { byYear[p.date.getFullYear()] = (byYear[p.date.getFullYear()] || 0) + p.amount; });
        const byMonthOfYear = Array(12).fill(0);
        a.payments.forEach(p => { byMonthOfYear[p.date.getMonth()] += p.amount; });

        const invested = held && Number.isFinite(holding.invested) ? holding.invested : null;
        const currentValue = held && Number.isFinite(holding.currentValue) ? holding.currentValue : null;

        return {
            ticker: a.ticker,
            name: holding?.name || a.name,
            total: assetTotal,
            count: a.payments.length,
            eventCount: events.length,
            first,
            last,
            ttm: assetTtm,
            prevTtm: assetPrevTtm,
            growthPct: growthPct(assetTtm, assetPrevTtm),
            frequency: frequency.label,
            frequencyPerYear: frequency.perYear,
            medianIntervalDays: Number.isFinite(medianInterval) ? medianInterval : null,
            lastAmount: lastEvent.amount,
            avgAmount: assetTotal / events.length,
            nextExpected,
            held,
            invested,
            currentValue,
            projectedAnnual,
            yieldOnCost: invested > 0 ? (projectedAnnual / invested) * 100 : null,
            currentYield: currentValue > 0 ? (projectedAnnual / currentValue) * 100 : null,
            sharePct: total > 0 ? (assetTotal / total) * 100 : 0,
            byYear,
            byMonthOfYear,
            payments: a.payments
        };
    }).sort((x, y) => y.total - x.total);

    // --- Projection & rendements ---------------------------------------
    const heldAssets = assets.filter(a => a.held);
    const projectedAnnual = heldAssets.reduce((s, a) => s + a.projectedAnnual, 0);
    const heldInvested = heldAssets.reduce((s, a) => s + (a.invested || 0), 0);
    const heldValue = heldAssets.reduce((s, a) => s + (a.currentValue || 0), 0);

    // --- Saisonnalité (année × mois) ------------------------------------
    const years = [...new Set(payments.map(p => p.date.getFullYear()))].sort();
    const seasonality = years.map(year => {
        const months = Array(12).fill(0);
        payments.forEach(p => { if (p.date.getFullYear() === year) months[p.date.getMonth()] += p.amount; });
        return { year, months, total: months.reduce((s, v) => s + v, 0) };
    });

    // --- Calendrier prévisionnel (12 prochains mois) --------------------
    const horizonEnd = new Date(now.getFullYear(), now.getMonth() + 12, 0, 23, 59, 59);
    const upcoming = [];
    heldAssets.forEach(a => {
        if (!a.nextExpected || !a.medianIntervalDays) return;
        let d = a.nextExpected;
        const estimate = a.frequencyPerYear ? a.projectedAnnual / a.frequencyPerYear : a.lastAmount;
        for (let guard = 0; d <= horizonEnd && guard < 24; guard++) {
            upcoming.push({ date: d, ticker: a.ticker, name: a.name, amount: estimate, frequency: a.frequency });
            d = new Date(d.getTime() + a.medianIntervalDays * DAY_MS);
        }
    });
    upcoming.sort((x, y) => x.date - y.date);
    const forecastMonths = periodRange(now, horizonEnd, 'month').map(key => ({
        key,
        amount: upcoming.filter(u => monthKey(u.date) === key).reduce((s, u) => s + u.amount, 0)
    }));

    return {
        payments,
        excludedCount,
        assets,
        brokers: [...byBroker.entries()].map(([broker, amount]) => ({ broker, amount })).sort((a, b) => b.amount - a.amount),
        seasonality,
        upcoming,
        forecastMonths,
        kpis: {
            total,
            count: payments.length,
            firstDate,
            lastDate,
            monthlyAvg: activeMonths ? total / activeMonths : 0,
            ttm,
            prevTtm,
            ttmGrowthPct: growthPct(ttm, prevTtm),
            ytd,
            prevYtd,
            ytdGrowthPct: growthPct(ytd, prevYtd),
            bestMonth,
            payerCount: assets.length,
            heldPayerCount: heldAssets.length,
            projectedAnnual,
            projectedMonthly: projectedAnnual / 12,
            yieldOnCost: heldInvested > 0 ? (projectedAnnual / heldInvested) * 100 : null,
            currentYield: heldValue > 0 ? (projectedAnnual / heldValue) * 100 : null,
            portfolioYield: portfolioValue > 0 ? (projectedAnnual / portfolioValue) * 100 : null
        }
    };
}

// Série agrégée par période. `byAsset` renvoie une série par actif (pour un
// empilement), sinon une seule série totale. Les périodes vides valent 0.
export function aggregateByPeriod(payments, granularity, { now = new Date(), tickers = null } = {}) {
    if (!payments.length) return { labels: [], total: [], byAsset: new Map() };
    const labels = periodRange(payments[0].date, now > payments[payments.length - 1].date ? now : payments[payments.length - 1].date, granularity);
    const index = new Map(labels.map((k, i) => [k, i]));
    const total = Array(labels.length).fill(0);
    const byAsset = new Map();
    payments.forEach(p => {
        const i = index.get(periodKey(p.date, granularity));
        if (i === undefined) return;
        total[i] += p.amount;
        if (tickers) {
            const key = tickers.has(p.ticker.toUpperCase()) ? p.ticker.toUpperCase() : '__other__';
            if (!byAsset.has(key)) byAsset.set(key, Array(labels.length).fill(0));
            byAsset.get(key)[i] += p.amount;
        }
    });
    return { labels, total, byAsset };
}
