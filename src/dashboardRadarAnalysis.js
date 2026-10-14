import { selectDailyContributions } from './dashboardContributions.js';
import { selectPortfolioNewsSignals } from './dashboardPortfolioRadar.js';
import { GEMINI_PROXY_URL } from './config.js';
import { getAuthHeader } from './authFetchHeaders.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function parisRadarDay(now = Date.now()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(now)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function morningRadarTrigger({ snapshot, newsReady = false, visible = true,
    lastMorningDay = null, lastAttemptAt = 0, now = Date.now() } = {}) {
    const paris = parisRadarDay(now);
    if (!visible || !newsReady || snapshot?.status !== 'valid' || lastMorningDay === paris.day
        || paris.minutes < 8 * 60 + 30 || paris.minutes >= 12 * 60
        || (lastAttemptAt && now - lastAttemptAt < 15 * 60_000)) return null;
    return 'briefing de 8 h 30';
}

export function radarReleaseTrigger({ releases = [], analysisReleaseIds = [], snapshot, newsReady = false,
    visible = true, lastAttemptId = '', lastAttemptAt = 0, now = Date.now() } = {}) {
    if (!visible || !newsReady || snapshot?.status !== 'valid' || !releases.length) return null;
    const pending = releases.filter(release => !analysisReleaseIds.includes(release.id));
    if (!pending.length) return null;
    const pendingId = pending.map(release => release.id).sort().join('|');
    if (lastAttemptId === pendingId && now - lastAttemptAt < 15 * 60_000) return null;
    return { reason: 'nouveau résultat publié', pendingId };
}

export function selectRadarMacroArticles(articles = [], now = Date.now(), limit = 4) {
    return articles.filter(article => {
        const publishedAt = Number(article?.datetime) * 1000;
        return Number.isFinite(publishedAt) && publishedAt <= now && now - publishedAt <= 2 * DAY_MS
            && typeof article.title === 'string' && article.title.trim();
    }).sort((a, b) => b.datetime - a.datetime).slice(0, limit);
}

export function radarPreviewText(value) {
    const lines = String(value || '').split(/\r?\n/).map(line => line.trim())
        .filter(line => line && !/^#{1,6}\s|^[-*_]{3,}$/.test(line));
    const first = lines.find(line => !/^[*+-]\s/.test(line)) || lines[0] || '';
    return first.replace(/\*\*/g, '').replace(/^[*+-]\s*/, '').slice(0, 320);
}

export function radarAutoTrigger({ snapshot, previousSession = false, newsReady = false, visible = true,
    previousPct = null, lastAttemptAt = 0, lastSuccessAt = 0, now = Date.now() } = {}) {
    if (!visible || !newsReady || previousSession || snapshot?.status !== 'valid' || snapshot.sourceStale
        || !Number.isFinite(snapshot.dayPnlPct) || !Number.isFinite(snapshot.dayPnl)) return null;
    if (lastAttemptAt && now - lastAttemptAt < 15 * 60 * 1000) return null;
    const delta = Number.isFinite(previousPct) ? snapshot.dayPnlPct - previousPct : null;
    if (delta !== null && Math.abs(delta) >= 0.75 && (!lastSuccessAt || now - lastSuccessAt >= 15 * 60 * 1000)) {
        return delta < 0 ? 'baisse brusque' : 'pic de variation';
    }
    if (!lastSuccessAt || now - lastSuccessAt >= HOUR_MS) {
        return snapshot.dayPnlPct <= -1 ? 'baisse marquée' : 'point régulier';
    }
    return null;
}

export function buildRadarAnalysisPayload(snapshot, articles = [], macroArticles = [], now = Date.now(),
    { morning = false, releases = [] } = {}) {
    if (snapshot?.status !== 'valid' || (!morning && !Number.isFinite(snapshot.dayPnl))) return null;
    const contributions = selectDailyContributions(snapshot);
    const ranked = morning ? (snapshot.positions || []).filter(row => Number(row.quantity) > 0 && !row.ticker?.startsWith('CASH-'))
        .sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0))
        : contributions.rows.filter(row => Number.isFinite(row.impact))
            .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
    const positions = ranked.slice(0, 8).map(row => morning
        ? ({ ticker: String(row.ticker || '').slice(0, 30), name: String(row.name || '').slice(0, 80),
            type: row.assetType, lastKnownValueEUR: Number.isFinite(row.currentValue) ? row.currentValue : null })
        : ({ ticker: String(row.ticker || '').slice(0, 30), name: String(row.name || '').slice(0, 80), type: row.assetType,
            weightPct: row.weight, dayPct: row.pct, dayImpactEUR: row.impact }));
    const articleRows = (items, limit) => items.filter(item => {
        const publishedAt = Number(item?.datetime) * 1000;
        return Number.isFinite(publishedAt) && publishedAt <= now && now - publishedAt <= 2 * DAY_MS;
    }).slice(0, limit)
        .map(item => ({ asset: item.assetName || null, title: String(item.title || '').slice(0, 180),
            source: String(item.source || '').slice(0, 80), publishedAt: new Date(item.datetime * 1000).toISOString(),
            url: /^https?:\/\//i.test(item.url || '') ? String(item.url).slice(0, 400) : null }));
    const relevant = morning ? articles.filter(item => Number(item?.datetime) * 1000 >= now - DAY_MS)
        .slice(0, 3) : selectPortfolioNewsSignals(snapshot, articles, now).rows.map(row => row.article).filter(Boolean);
    const prioritized = relevant.filter((item, index, list) =>
        item && list.findIndex(candidate => candidate?.title === item.title) === index);
    return {
        observedAt: new Date(now).toISOString(),
        mode: morning ? 'morning' : 'intraday',
        pricesAsOf: Number.isFinite(snapshot.pricesTimestamp) ? new Date(snapshot.pricesTimestamp).toISOString() : null,
        portfolio: morning ? { totalValueLastKnownEUR: Number.isFinite(snapshot.totalValue) ? snapshot.totalValue : null,
            positions, quality: 'last-known-prices; current-day performance unavailable' }
            : { dayPnlEUR: snapshot.dayPnl, dayPnlPct: snapshot.dayPnlPct,
                totalValueEUR: Number.isFinite(snapshot.totalValue) ? snapshot.totalValue : null,
                positions, quality: contributions.status },
        articles: articleRows(prioritized, 3),
        macroArticles: articleRows(selectRadarMacroArticles(macroArticles, now), 4),
        earningsReleases: releases.slice(0, 2).map(release => ({ ticker: release.ticker, period: release.period,
            publishedAt: new Date(release.publishedAt).toISOString(), source: release.source,
            sourceUrl: release.sourceUrl, highlights: release.highlights.slice(0, 3) }))
    };
}

function sourceLinks(groundingMetadata) {
    // Only Google Search grounding links were consulted by the model. Articles
    // supplied as context are leads, not evidence that their pages were read.
    const candidates = (groundingMetadata?.groundingChunks || [])
        .map(chunk => ({ title: chunk.web?.title, url: chunk.web?.uri }));
    const seen = new Set();
    return candidates.filter(source => {
        try {
            const url = new URL(source.url);
            if (!['http:', 'https:'].includes(url.protocol) || seen.has(url.href)) return false;
            seen.add(url.href);
            source.url = url.href;
            return true;
        } catch { return false; }
    }).slice(0, 6);
}

export async function fetchPortfolioRadarAnalysis(payload, reason, { signal } = {}) {
    const bounded = { ...payload, articles: [...(payload.articles || [])], macroArticles: [...(payload.macroArticles || [])] };
    const messageFor = data => data.mode === 'morning'
        ? `Déclencheur : ${reason}. Prépare un point de marché daté de observedAt (briefing matinal si le déclencheur l'indique). Les cours du portefeuille sont les derniers connus : ne présente aucune variation de la veille comme une variation d'aujourd'hui. Résume d'abord en 2-3 points les résultats publiés dans earningsReleases, avec chiffres, période, date et source ; distingue résultats constatés et prévisions. Puis explique les nouvelles macroéconomiques récentes et la tendance possible de la journée, sans prédire avec certitude. Vérifie les faits via la recherche. Distingue fait sourcé, hypothèse et inconnu. Réponds en français, 250 mots maximum. Données : ${JSON.stringify(data)}`
        : `Déclencheur : ${reason}. Résume d'abord toute publication vérifiée dans earningsReleases, puis explique brièvement les contributions observées et cherche les nouvelles macroéconomiques ou sectorielles récentes susceptibles d'éclairer la direction du marché. Les titres d'actifs fournis ne sont que des pistes : si aucun événement propre à une société n'est pertinent et vérifié, dis-le sans en inventer. Distingue fait sourcé, hypothèse et inconnu ; ne déduis jamais une cause de la seule simultanéité. Réponds en français, en trois sections courtes avec titres, 250 mots maximum, dates et sources. Données : ${JSON.stringify(data)}`;
    while (messageFor(bounded).length > 6500 && (bounded.macroArticles.length || bounded.articles.length)) {
        if (bounded.articles.length) bounded.articles.pop();
        else bounded.macroArticles.pop();
    }
    const message = messageFor(bounded);
    if (message.length > 7000) throw new Error('Contexte trop volumineux pour l’analyse.');
    const response = await fetch(GEMINI_PROXY_URL, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', ...(await getAuthHeader()) },
        body: JSON.stringify({ purpose: 'portfolio_radar',
            system: 'Le JSON suivant contient seulement des mesures du portefeuille courant et des articles à vérifier. Ne révèle pas de données de compte ou de courtier.',
            message })
    });
    if (!response.ok) {
        const error = new Error(response.status === 429 ? 'Quota d’analyses atteint pour aujourd’hui.' : 'Analyse IA momentanément indisponible.');
        error.status = response.status;
        throw error;
    }
    const data = await response.json();
    if (typeof data?.text !== 'string' || !data.text.trim()) throw new Error('Analyse IA vide.');
    const sources = sourceLinks(data.groundingMetadata);
    for (const release of bounded.earningsReleases || []) {
        if (release.sourceUrl && !sources.some(source => source.url === release.sourceUrl))
            sources.unshift({ title: release.source, url: release.sourceUrl });
    }
    return { text: data.text.trim(), sources: sources.slice(0, 8),
        modelVersion: data.modelVersion || null };
}
