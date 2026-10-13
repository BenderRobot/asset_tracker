import { selectDailyContributions } from './dashboardContributions.js';
import { selectPortfolioNewsSignals } from './dashboardPortfolioRadar.js';
import { GEMINI_PROXY_URL } from './config.js';
import { getAuthHeader } from './authFetchHeaders.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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

export function buildRadarAnalysisPayload(snapshot, articles = [], macroArticles = [], now = Date.now()) {
    if (snapshot?.status !== 'valid' || !Number.isFinite(snapshot.dayPnl)) return null;
    const contributions = selectDailyContributions(snapshot);
    const positions = contributions.rows.filter(row => Number.isFinite(row.impact))
        .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)).slice(0, 8)
        .map(row => ({ ticker: String(row.ticker || '').slice(0, 30), name: String(row.name || '').slice(0, 80), type: row.assetType,
            weightPct: row.weight, dayPct: row.pct, dayImpactEUR: row.impact }));
    const articleRows = (items, limit) => items.filter(item => {
        const publishedAt = Number(item?.datetime) * 1000;
        return Number.isFinite(publishedAt) && publishedAt <= now && now - publishedAt <= 2 * DAY_MS;
    }).slice(0, limit)
        .map(item => ({ asset: item.assetName || null, title: String(item.title || '').slice(0, 180),
            source: String(item.source || '').slice(0, 80), publishedAt: new Date(item.datetime * 1000).toISOString(),
            url: /^https?:\/\//i.test(item.url || '') ? String(item.url).slice(0, 400) : null }));
    const relevant = selectPortfolioNewsSignals(snapshot, articles, now).rows.map(row => row.article).filter(Boolean);
    const prioritized = [...relevant, ...articles].filter((item, index, list) =>
        item && list.findIndex(candidate => candidate?.title === item.title) === index);
    return {
        observedAt: new Date(now).toISOString(),
        pricesAsOf: Number.isFinite(snapshot.pricesTimestamp) ? new Date(snapshot.pricesTimestamp).toISOString() : null,
        portfolio: { dayPnlEUR: snapshot.dayPnl, dayPnlPct: snapshot.dayPnlPct,
            totalValueEUR: Number.isFinite(snapshot.totalValue) ? snapshot.totalValue : null,
            positions, quality: contributions.status },
        articles: articleRows(prioritized, 6),
        macroArticles: articleRows(macroArticles, 2)
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
    const messageFor = data => `Déclencheur : ${reason}. Explique en 3 à 5 phrases ce qui est observé, puis les actualités vérifiées qui pourraient l'éclairer. Sépare ce qui est inconnu. N'attribue jamais une baisse à un article sans preuve. Données : ${JSON.stringify(data)}`;
    while (messageFor(bounded).length > 6500 && (bounded.macroArticles.length || bounded.articles.length)) {
        if (bounded.macroArticles.length) bounded.macroArticles.pop();
        else bounded.articles.pop();
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
    return { text: data.text.trim(), sources: sourceLinks(data.groundingMetadata),
        modelVersion: data.modelVersion || null };
}
