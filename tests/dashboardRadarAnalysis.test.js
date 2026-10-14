import { describe, expect, it, vi } from 'vitest';
import { buildRadarAnalysisPayload, fetchPortfolioRadarAnalysis, morningRadarTrigger, parisRadarDay, radarAutoTrigger, radarPreviewText, radarReleaseTrigger, selectRadarMacroArticles } from '../src/dashboardRadarAnalysis.js';
import { verifiedPortfolioReleases } from '../src/dashboardEarningsReleases.js';

vi.mock('../src/authFetchHeaders.js', () => ({ getAuthHeader: async () => ({ Authorization: 'Bearer test' }) }));

const now = Date.parse('2026-10-13T18:00:00Z');
const snapshot = {
    status: 'valid', sourceStale: false, dayPnl: -95, dayPnlPct: -1.2, totalValue: 1000,
    positions: [
        { ticker: 'AMAT', name: 'Applied Materials', quantity: 1, dayPnl: -70, dayPnlPct: -8, currentValue: 500 },
        { ticker: 'AAPL', name: 'Apple', quantity: 1, dayPnl: -25, dayPnlPct: -2, currentValue: 500 }
    ]
};

describe('Dashboard AI radar', () => {
    it('starts a Paris morning briefing at 08:30 across summer and winter time, once per day', () => {
        const base = { snapshot: { ...snapshot, sourceStale: true, dayPnl: null }, newsReady: true };
        const summer = Date.parse('2026-10-14T06:30:00Z');
        const winter = Date.parse('2026-11-02T07:30:00Z');
        expect(parisRadarDay(summer)).toEqual({ day: '2026-10-14', minutes: 510 });
        expect(parisRadarDay(winter)).toEqual({ day: '2026-11-02', minutes: 510 });
        expect(morningRadarTrigger({ ...base, now: summer - 60_000 })).toBeNull();
        expect(morningRadarTrigger({ ...base, now: summer })).toBe('briefing de 8 h 30');
        expect(morningRadarTrigger({ ...base, now: summer, lastMorningDay: '2026-10-14' })).toBeNull();
        expect(morningRadarTrigger({ ...base, now: summer, visible: false })).toBeNull();
    });

    it('requests a fresh reading when a verified report appears after the morning briefing', () => {
        const releases = [{ id: 'asml-q3-2026' }];
        const base = { releases, snapshot, newsReady: true, visible: true, now };
        expect(radarReleaseTrigger(base)).toEqual({ reason: 'nouveau résultat publié', pendingId: 'asml-q3-2026' });
        expect(radarReleaseTrigger({ ...base, analysisReleaseIds: ['asml-q3-2026'] })).toBeNull();
        expect(radarReleaseTrigger({ ...base, lastAttemptId: 'asml-q3-2026', lastAttemptAt: now - 60_000 })).toBeNull();
        expect(radarReleaseTrigger({ ...base, lastAttemptId: 'asml-q3-2026', lastAttemptAt: now - 16 * 60_000 }))
            .not.toBeNull();
    });

    it('keeps yesterday’s performance out of the morning prompt and includes verified ASML results', () => {
        const morning = Date.parse('2026-10-14T06:30:00Z');
        const releases = verifiedPortfolioReleases([{ ticker: 'ASML', providerSymbol: 'ASML.AS', quantity: 1 }], morning);
        const payload = buildRadarAnalysisPayload({ ...snapshot, sourceStale: true,
            pricesTimestamp: morning - 15 * 3600_000, positions: [...snapshot.positions,
                { ticker: 'ASML', name: 'ASML Holding', quantity: 1, currentValue: 1500, dayPnl: -999 }] },
        [], [], morning, { morning: true, releases });
        expect(payload.mode).toBe('morning');
        expect(payload.portfolio).not.toHaveProperty('dayPnlEUR');
        expect(payload.portfolio.positions[0]).not.toHaveProperty('dayImpactEUR');
        expect(payload.earningsReleases[0].period).toBe('T3 2026');
        expect(payload.earningsReleases[0].highlights[0]).toContain('11,7 Md€');
        expect(JSON.stringify(payload)).not.toContain('-999');
        expect(releases[0].isNew).toBe(true);
        expect(verifiedPortfolioReleases([{ ticker: 'ASML', quantity: 1 }], morning - 2 * 3600_000)).toEqual([]);
        expect(verifiedPortfolioReleases([{ ticker: 'ASML.AS', quantity: 1 }], morning)).toHaveLength(1);
        expect(verifiedPortfolioReleases([{ ticker: 'AAPL', quantity: 1 }], morning)).toEqual([]);
    });

    it('asks Gemini for a morning report, with the issuer release linked even without search grounding', async () => {
        const morning = Date.parse('2026-10-14T06:30:00Z');
        const releases = verifiedPortfolioReleases([{ ticker: 'ASML', quantity: 1 }], morning);
        const payload = buildRadarAnalysisPayload(snapshot, [], [], morning, { morning: true, releases });
        vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
            const request = JSON.parse(options.body);
            expect(request.message).toContain('briefing de 8 h 30');
            expect(request.message).toContain('11,7 Md€');
            expect(request.message).not.toContain('dayPnlEUR');
            return { ok: true, json: async () => ({ text: 'ASML : résultats publiés.', groundingMetadata: {} }) };
        }));
        try {
            const result = await fetchPortfolioRadarAnalysis(payload, 'briefing de 8 h 30');
            expect(result.sources[0].url).toBe(releases[0].sourceUrl);
        } finally { vi.unstubAllGlobals(); }
    });
    it('scans after news is ready, reacts to a meaningful move, and throttles repeats', () => {
        const base = { snapshot, newsReady: true, visible: true, now };
        expect(radarAutoTrigger(base)).toBe('baisse marquée');
        expect(radarAutoTrigger({ ...base, previousPct: -0.1, lastAttemptAt: now - 16 * 60_000,
            lastSuccessAt: now - 16 * 60_000 })).toBe('baisse brusque');
        expect(radarAutoTrigger({ ...base, previousPct: -1.1, lastAttemptAt: now - 16 * 60_000,
            lastSuccessAt: now - 16 * 60_000 })).toBeNull();
        expect(radarAutoTrigger({ ...base, previousPct: -0.1, lastAttemptAt: now - 60_000,
            lastSuccessAt: now - 60_000 })).toBeNull();
        expect(radarAutoTrigger({ ...base, previousPct: -1.1, lastSuccessAt: now - 61 * 60_000 })).toBe('baisse marquée');
    });

    it('never scans a stale or previous-session snapshot, or while hidden', () => {
        const base = { snapshot, newsReady: true, visible: true, now };
        expect(radarAutoTrigger({ ...base, snapshot: { ...snapshot, sourceStale: true } })).toBeNull();
        expect(radarAutoTrigger({ ...base, previousSession: true })).toBeNull();
        expect(radarAutoTrigger({ ...base, visible: false })).toBeNull();
        expect(radarAutoTrigger({ ...base, newsReady: false })).toBeNull();
    });

    it('sends current contributions and dated news, without broker or expired articles', () => {
        const recent = { title: 'Applied Materials publie ses résultats', assetName: 'Applied Materials',
            datetime: (now - 3600_000) / 1000, source: 'Journal', url: 'https://example.org/amat' };
        const expired = { title: 'Ancien article Apple', assetName: 'Apple',
            datetime: (now - 3 * 86400_000) / 1000, url: 'https://example.org/old' };
        const payload = buildRadarAnalysisPayload({ ...snapshot, positions: snapshot.positions.map(p => ({ ...p, broker: 'SECRET' })) },
            [expired, recent], [], now);
        expect(payload.portfolio.positions.map(p => p.dayImpactEUR)).toEqual([-70, -25]);
        expect(payload.articles).toHaveLength(1);
        expect(payload.articles[0].title).toBe(recent.title);
        expect(JSON.stringify(payload)).not.toContain('SECRET');
    });

    it('keeps only matched company news, includes recent macro context, and makes a readable preview', () => {
        const matched = { title: 'Applied Materials publie ses résultats', assetName: 'Applied Materials',
            datetime: (now - 3600_000) / 1000, url: 'https://example.org/company' };
        const unrelated = { title: 'SpaceX prépare un lancement', assetName: 'SpaceX',
            datetime: (now - 1800_000) / 1000, url: 'https://example.org/unrelated' };
        const macro = { title: 'La Fed précise sa trajectoire de taux',
            datetime: (now - 900_000) / 1000, url: 'https://example.org/macro' };
        const oldMacro = { title: 'Ancienne dépêche', datetime: (now - 3 * 86400_000) / 1000 };
        const payload = buildRadarAnalysisPayload(snapshot, [unrelated, matched], [oldMacro, macro], now);
        expect(payload.articles.map(article => article.title)).toEqual([matched.title]);
        expect(payload.macroArticles.map(article => article.title)).toEqual([macro.title]);
        expect(selectRadarMacroArticles([oldMacro, macro], now)).toEqual([macro]);
        expect(radarPreviewText('### Ce qui est observé\n\n**Applied Materials** baisse.\n\n### Contexte'))
            .toBe('Applied Materials baisse.');
    });

    it('lists only sources returned by Google Search grounding, not article leads', async () => {
        const payload = buildRadarAnalysisPayload(snapshot, [{ title: 'Article non consulté',
            datetime: (now - 3600_000) / 1000, url: 'https://example.org/lead' }], [], now);
        vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
            expect(JSON.parse(options.body).purpose).toBe('portfolio_radar');
            return { ok: true, json: async () => ({ text: 'Analyse vérifiée', groundingMetadata: {
                groundingChunks: [{ web: { title: 'Journal consulté', uri: 'https://example.org/source' } },
                    { web: { title: 'Lien dangereux', uri: 'javascript:alert(1)' } }]
            } }) };
        }));
        try {
            const result = await fetchPortfolioRadarAnalysis(payload, 'point régulier');
            expect(result.sources).toEqual([{ title: 'Journal consulté', url: 'https://example.org/source' }]);
        } finally { vi.unstubAllGlobals(); }
    });
});
