// VALIDATION ARCHITECTURE (2026-09-24, décision #11) — instrumentation.
// Vérifie que les compteurs reflètent fidèlement ce qui se passe réellement
// dans api.js : un cache hit historique ne déclenche aucun fetch(), une
// dédup coalescée ne compte qu'1 requête réseau pour N appelants, et les
// codes HTTP 429/5xx renvoyés par le Worker sont comptés dans les bons seaux.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PriceAPI } from '../src/api.js';
import { marketDataMetrics } from '../src/marketDataMetrics.js';
import { createFakeStorage } from './helpers.js';

function yahooResponse(closes, startSec = 1_790_000_000) {
    const timestamp = closes.map((_, i) => startSec + i * 86400);
    return {
        chart: {
            result: [{
                meta: { currency: 'EUR' },
                timestamp,
                indicators: { quote: [{ close: closes }] }
            }],
            error: null
        }
    };
}

beforeEach(() => marketDataMetrics.reset());
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('marketDataMetrics — cache hit vs cache miss (historique)', () => {
    it('1er appel = cache miss + 1 requête réseau, 2e appel identique = cache hit + 0 requête réseau supplémentaire', async () => {
        // 4 points couvrant EXACTEMENT les 3 jours de la plage testée
        // (1790000000 -> 1790259200 = 259200s = 3 jours) : le cache par point
        // (voir historicalPointStore.js) ne considère la plage comme
        // entièrement connue que si elle est couverte SANS trou jusqu'à la
        // fin demandée — un mock ne couvrant que 2 jours sur 3 déclencherait
        // à raison un delta-fetch légitime pour le jour manquant.
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => yahooResponse([1, 2, 3, 4]) })));
        const storage = createFakeStorage({ assetTypes: { M1: 'STOCK' } });
        const api = new PriceAPI(storage);

        await api.getHistoricalPricesWithRetry('M1', 1790000000, 1790259200, '1d');
        let s = marketDataMetrics.snapshot();
        expect(s.browserRequests).toBe(1);
        expect(s.cacheMisses).toBe(1);
        expect(s.cacheHits).toBe(0);

        await api.getHistoricalPricesWithRetry('M1', 1790000000, 1790259200, '1d');
        s = marketDataMetrics.snapshot();
        expect(s.browserRequests).toBe(1); // aucun 2e fetch()
        expect(s.cacheHits).toBe(1);
    });
});

describe('marketDataMetrics — déduplication (requêtes concurrentes)', () => {
    it('3 appels concurrents identiques -> 1 requête réseau comptée, 2 déduplications', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => yahooResponse([1, 2]) })));
        const storage = createFakeStorage({ assetTypes: { M2: 'STOCK' } });
        const api = new PriceAPI(storage);

        await Promise.all([
            api.getHistoricalPricesWithRetry('M2', 1790000000, 1790259200, '1d'),
            api.getHistoricalPricesWithRetry('M2', 1790000000, 1790259200, '1d'),
            api.getHistoricalPricesWithRetry('M2', 1790000000, 1790259200, '1d'),
        ]);

        const s = marketDataMetrics.snapshot();
        expect(s.browserRequests).toBe(1);
        expect(s.deduplicatedRequests).toBe(2);
        expect(s.cacheMisses).toBe(1);
    });
});

describe('marketDataMetrics — codes HTTP', () => {
    it('counts 429 once and stops immediate retries', async () => {
        let call = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            call++;
            return call === 1 ? { ok: false, status: 429 } : { ok: false, status: 500 };
        }));
        const storage = createFakeStorage({ assetTypes: { M3: 'STOCK' } });
        const api = new PriceAPI(storage);

        await api.getHistoricalPricesWithRetry('M3', 1790000000, 1790259200, '1d', 2);

        const s = marketDataMetrics.snapshot();
        expect(s.worker429).toBe(1);
        expect(s.worker5xx).toBe(0);
        expect(s.browserRequests).toBe(1);
    });

    it('un timeout (AbortError) est compté dans timeouts, pas dans worker5xx', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
        }));
        const storage = createFakeStorage({ assetTypes: { M4: 'STOCK' } });
        const api = new PriceAPI(storage);

        await api.getHistoricalPricesWithRetry('M4', 1790000000, 1790259200, '1d', 1);

        const s = marketDataMetrics.snapshot();
        expect(s.timeouts).toBe(1);
        expect(s.worker5xx).toBe(0);
    });
});
