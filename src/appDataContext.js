import { buildDataQuality, normalizeTimestamp } from './dataQualityContext.js';
import { getIndexFuture } from './indexFutures.js';

export const SCREENER_CONTEXT_KEY = 'assistant_screener_context_v1';
export const NOTIFICATION_CONTEXT_KEY = 'assistant_notification_context_v1';
export const INDICES_STORAGE_KEY = 'dashboard_indices_v1';

const CDN = 'https://cdn.jsdelivr.net/npm/openmoji@14.0.0/color/svg/';
export const DEFAULT_DASHBOARD_INDICES = Object.freeze([
    { ticker: '^GSPC', name: 'S&P 500', icon: `${CDN}1F1FA-1F1F8.svg`, format: 'index' },
    { ticker: '^IXIC', name: 'NASDAQ 100', icon: `${CDN}1F4BB.svg`, format: 'index' },
    { ticker: '^FCHI', name: 'CAC 40', icon: `${CDN}1F1EB-1F1F7.svg`, format: 'index' },
    { ticker: '^STOXX50E', name: 'EURO STOXX 50', icon: `${CDN}1F1EA-1F1FA.svg`, format: 'index' },
    { ticker: 'BTC-EUR', name: 'BITCOIN', icon: '₿', format: 'crypto' },
    { ticker: 'GC=F', name: 'OR (GOLD)', icon: `${CDN}1FA99.svg`, format: 'commodity' },
    { ticker: 'EURUSD=X', name: 'EUR / USD', icon: `${CDN}1F4B1.svg`, format: 'forex' }
]);

function safeParse(storage, key) {
    try {
        const raw = storage?.getItem?.(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value?.raw ?? value);
    return Number.isFinite(number) ? number : null;
}

export function persistScreenerContext(context, storage = globalThis.localStorage) {
    storage?.setItem?.(SCREENER_CONTEXT_KEY, JSON.stringify(context));
}

export function persistNotificationContext(userId, rules, settings, storage = globalThis.localStorage) {
    storage?.setItem?.(NOTIFICATION_CONTEXT_KEY, JSON.stringify({
        userId: userId || null,
        rules: (Array.isArray(rules) ? rules : []).map(rule => ({
            asset: rule?.asset || null,
            metric: rule?.metric || null,
            condition: rule?.condition || null,
            value: finite(rule?.value),
            enabled: rule?.enabled !== false
        })),
        settings: settings || {},
        updatedAt: Date.now()
    }));
}

export function buildTrackedIndicesContext(indices, currentData = {}, { now = Date.now() } = {}) {
    return (indices || []).map(index => {
        const quote = currentData?.[index.ticker] || null;
        const future = getIndexFuture(index.ticker);
        const futureQuote = future ? currentData?.[future.ticker] || null : null;
        const asOf = quote?.lastUpdate ?? quote?.lastUpdated ?? quote?.timestamp ?? null;
        const unavailable = quote ? [] : ['quote'];
        return {
            ticker: index.ticker,
            name: index.name,
            format: index.format || null,
            price: finite(quote?.price ?? quote?.regularMarketPrice),
            changePercent: finite(quote?.changePercent ?? quote?.regularMarketChangePercent),
            future: future ? {
                ticker: future.ticker,
                code: future.code,
                name: future.name,
                label: 'FUTURE',
                price: finite(futureQuote?.price ?? futureQuote?.regularMarketPrice),
                changePercent: finite(futureQuote?.changePercent ?? futureQuote?.regularMarketChangePercent),
                quality: buildDataQuality({
                    asOf: futureQuote?.lastUpdate ?? futureQuote?.lastUpdated ?? futureQuote?.timestamp ?? null,
                    source: 'market_cache_future',
                    unavailable: futureQuote ? [] : ['quote'],
                    now
                })
            } : null,
            quality: buildDataQuality({ asOf, source: 'market_cache', unavailable, now })
        };
    });
}

export function buildAppDataContext({
    storage = globalThis.localStorage,
    currentData = {},
    userId = null,
    now = Date.now()
} = {}) {
    const savedIndices = safeParse(storage, INDICES_STORAGE_KEY);
    const indices = Array.isArray(savedIndices) ? savedIndices : DEFAULT_DASHBOARD_INDICES;
    const screener = safeParse(storage, SCREENER_CONTEXT_KEY);
    const notificationsRaw = safeParse(storage, NOTIFICATION_CONTEXT_KEY);
    const notifications = notificationsRaw && (!userId || !notificationsRaw.userId || notificationsRaw.userId === userId)
        ? notificationsRaw
        : null;

    return {
        screener: screener ? {
            ...screener,
            quality: buildDataQuality({
                asOf: screener.updatedAt,
                source: 'screener_selection',
                unavailable: screener.ticker ? [] : ['ticker'],
                staleAfterMs: 24 * 60 * 60 * 1000,
                now
            })
        } : null,
        trackedIndices: buildTrackedIndicesContext(indices, currentData, { now }),
        notifications: notifications ? {
            settings: notifications.settings || {},
            rules: (notifications.rules || []).map(rule => ({
                asset: rule.asset || null,
                metric: rule.metric || null,
                condition: rule.condition || null,
                value: finite(rule.value),
                enabled: rule.enabled !== false
            })),
            quality: buildDataQuality({
                asOf: notifications.updatedAt,
                source: 'firestore_notifications_cache',
                staleAfterMs: 24 * 60 * 60 * 1000,
                now
            })
        } : null,
        quality: buildDataQuality({
            asOf: Math.max(
                normalizeTimestamp(screener?.updatedAt) || 0,
                normalizeTimestamp(notifications?.updatedAt) || 0,
                ...Object.values(currentData || {}).map(row => normalizeTimestamp(row?.lastUpdate ?? row?.lastUpdated) || 0)
            ) || null,
            source: 'application_modules',
            unavailable: [!screener && 'screener', !notifications && 'notifications'].filter(Boolean),
            now
        })
    };
}
