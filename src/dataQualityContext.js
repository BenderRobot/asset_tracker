const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;

export function normalizeTimestamp(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}

/** Contrat commun de fraicheur utilise par tous les contextes envoyes a Gemini. */
export function buildDataQuality({
    asOf = null,
    generatedAt = Date.now(),
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    status = null,
    source = null,
    unavailable = [],
    now = Date.now()
} = {}) {
    const asOfMs = normalizeTimestamp(asOf);
    const generatedAtMs = normalizeTimestamp(generatedAt) ?? now;
    const missing = [...new Set((unavailable || []).filter(Boolean).map(String))];
    let resolvedStatus = status;
    if (!resolvedStatus) {
        if (asOfMs === null) resolvedStatus = 'unavailable';
        else if (missing.length) resolvedStatus = 'partial';
        else resolvedStatus = Math.max(0, now - asOfMs) > staleAfterMs ? 'stale' : 'fresh';
    }

    return {
        status: resolvedStatus,
        asOf: asOfMs === null ? null : new Date(asOfMs).toISOString(),
        generatedAt: new Date(generatedAtMs).toISOString(),
        ageMs: asOfMs === null ? null : Math.max(0, now - asOfMs),
        staleAfterMs,
        source,
        unavailable: missing
    };
}

export function formatDataQuality(quality) {
    if (!quality) return 'statut=indisponible';
    return `statut=${quality.status || 'indisponible'}, source=${quality.source || 'indisponible'}, date=${quality.asOf || 'indisponible'}, donnees manquantes=${(quality.unavailable || []).join(', ') || 'aucune'}`;
}
