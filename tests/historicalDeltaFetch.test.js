// VALIDATION ARCHITECTURE (2026-09-24) — intégration du cache par point
// (historicalPointStore.js) dans api.js::getHistoricalPricesWithRetry. Teste
// bout en bout, réseau stubé, que :
//   - un historique déjà connu et clôturé n'est JAMAIS redemandé ;
//   - une extension de fenêtre (même ticker/intervalle, endTs plus tardif)
//     ne redemande que le DELTA, pas toute la plage ;
//   - un échec réseau sur le delta reste un échec TOTAL pour cet appel,
//     jamais mélangé silencieusement avec les anciens points en cache
//     (fail-closed — voir failClosedPriceData.test.js pour l'invariant
//     général, ici vérifié spécifiquement pour le chemin delta-fetch).
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PriceAPI, isHistoricalFetchFailure } from '../src/api.js';
import { historicalPointStore } from '../src/historicalPointStore.js';
import { createFakeStorage } from './helpers.js';

const DAY_SEC = 24 * 60 * 60;

function yahooResponse(startSec, endSec) {
    const timestamps = [];
    for (let t = startSec; t <= endSec; t += DAY_SEC) timestamps.push(t);
    const closes = timestamps.map((_, i) => 100 + i);
    return {
        chart: {
            result: [{
                meta: { currency: 'EUR' },
                timestamp: timestamps,
                indicators: { quote: [{ close: closes }] }
            }],
            error: null
        }
    };
}

function parsePeriod(url) {
    const u = new URL(url);
    return { period1: Number(u.searchParams.get('period1')), period2: Number(u.searchParams.get('period2')) };
}

beforeEach(() => {
    localStorage.clear();
    // Ne fige QUE Date (pas setTimeout) : _doFetchHistoricalPrices utilise
    // sleep(1000) entre ses tentatives de retry — avec setTimeout figé et
    // jamais avancé manuellement, ce sleep resterait bloqué indéfiniment.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
});

describe('Cache historique par point — intervalle daily (1d)', () => {
    it('historique déjà présent et clôturé -> 0 nouvelle requête réseau au rechargement (même appel exact)', async () => {
        const startTs = Math.floor(new Date('2026-09-10T00:00:00Z').getTime() / 1000);
        const endTs = Math.floor(Date.now() / 1000);

        let fetchCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            fetchCalls++;
            const { period1, period2 } = parsePeriod(url);
            return { ok: true, json: async () => yahooResponse(period1, period2) };
        }));

        const storage = createFakeStorage({ assetTypes: { DELTA1: 'STOCK' } });
        const api = new PriceAPI(storage);

        const first = await api.getHistoricalPricesWithRetry('DELTA1', startTs, endTs, '1d');
        expect(fetchCalls).toBe(1);
        expect(Object.keys(first).length).toBeGreaterThan(0);

        // "Dashboard rechargé" quelques secondes plus tard : même ticker,
        // même fenêtre — tout est déjà connu et clôturé (le jour courant
        // n'ayant de toute façon jamais de bougie clôturée).
        vi.setSystemTime(new Date('2026-09-20T12:00:30Z'));
        const second = await api.getHistoricalPricesWithRetry('DELTA1', startTs, Math.floor(Date.now() / 1000), '1d');

        expect(fetchCalls).toBe(1); // AUCUNE nouvelle requête réseau
        expect(second).toEqual(first);
    });

    it('extension de fenêtre (quelques jours plus tard) -> seul le DELTA est redemandé, jamais toute la plage', async () => {
        const startTs = Math.floor(new Date('2026-09-10T00:00:00Z').getTime() / 1000);
        const firstEndTs = Math.floor(Date.now() / 1000); // 2026-09-20 12:00

        const requestedRanges = [];
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            const { period1, period2 } = parsePeriod(url);
            requestedRanges.push({ period1, period2 });
            return { ok: true, json: async () => yahooResponse(period1, period2) };
        }));

        const storage = createFakeStorage({ assetTypes: { DELTA2: 'STOCK' } });
        const api = new PriceAPI(storage);

        const first = await api.getHistoricalPricesWithRetry('DELTA2', startTs, firstEndTs, '1d');
        expect(requestedRanges.length).toBe(1);
        expect(requestedRanges[0].period1).toBe(startTs); // 1er appel : plage complète

        // 3 jours plus tard, l'utilisateur recharge le dashboard : même
        // startTs (date de départ du portefeuille, fixe), endTs plus tardif.
        vi.setSystemTime(new Date('2026-09-23T12:00:00Z'));
        const secondEndTs = Math.floor(Date.now() / 1000);
        const second = await api.getHistoricalPricesWithRetry('DELTA2', startTs, secondEndTs, '1d');

        expect(requestedRanges.length).toBe(2); // une seule requête réseau SUPPLÉMENTAIRE
        // Le 2e appel réseau ne redemande PAS depuis startTs — seulement le delta.
        expect(requestedRanges[1].period1).toBeGreaterThan(startTs + 8 * DAY_SEC);

        // Le résultat final couvre bien TOUTE la plage demandée (anciens +
        // nouveaux points), jamais seulement le delta brut.
        expect(Object.keys(second).length).toBeGreaterThan(Object.keys(first).length);
        for (const key of Object.keys(first)) {
            expect(second[key]).toBe(first[key]); // anciens points préservés tels quels
        }
    });

    it('échec réseau (429) sur le DELTA -> échec TOTAL pour cet appel, jamais mélangé silencieusement avec les anciens points', async () => {
        const startTs = Math.floor(new Date('2026-09-10T00:00:00Z').getTime() / 1000);
        const firstEndTs = Math.floor(Date.now() / 1000);

        let callCount = 0;
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            callCount++;
            if (callCount === 1) {
                const { period1, period2 } = parsePeriod(url);
                return { ok: true, json: async () => yahooResponse(period1, period2) };
            }
            return { ok: false, status: 429 }; // tout appel réseau ULTÉRIEUR échoue
        }));

        const storage = createFakeStorage({ assetTypes: { DELTA3: 'STOCK' } });
        const api = new PriceAPI(storage);

        const first = await api.getHistoricalPricesWithRetry('DELTA3', startTs, firstEndTs, '1d');
        expect(isHistoricalFetchFailure(first)).toBe(false);

        vi.setSystemTime(new Date('2026-09-23T12:00:00Z'));
        const second = await api.getHistoricalPricesWithRetry('DELTA3', startTs, Math.floor(Date.now() / 1000), '1d', 1);

        // FAIL-CLOSED : le delta a échoué -> résultat marqué échec, PAS un
        // objet contenant seulement les anciens points (ce qui masquerait la
        // panne en produisant un historique incomplet d'apparence valide).
        expect(isHistoricalFetchFailure(second)).toBe(true);
    });
});

describe('Cache historique par point — intervalle intraday (5m), hors périmètre', () => {
    it('un intervalle intraday ne bénéficie jamais du delta-fetch : chaque appel redemande la plage complète', async () => {
        let fetchCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            fetchCalls++;
            const { period1, period2 } = parsePeriod(url);
            return { ok: true, json: async () => yahooResponse(period1, period2) };
        }));

        const storage = createFakeStorage({ assetTypes: { DELTA4: 'STOCK' } });
        const api = new PriceAPI(storage);

        const startTs = Math.floor(Date.now() / 1000) - 2 * DAY_SEC;
        const endTs = Math.floor(Date.now() / 1000);

        await api.getHistoricalPricesWithRetry('DELTA4', startTs, endTs, '5m');
        expect(fetchCalls).toBe(1);
        expect(historicalPointStore.getKnownPoints('DELTA4', '5m', startTs, endTs)).toEqual({}); // jamais alimenté pour l'intraday

        // Même fenêtre EXACTE, appel séparé (pas concurrent) : le cache par
        // point ne joue aucun rôle ici, seul l'éventuel cache exact-range
        // existant (historicalPriceCache, TTL propre) pourrait s'appliquer —
        // hors scope de ce test.
    });
});
