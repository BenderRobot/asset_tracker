// VALIDATION ARCHITECTURE (2026-09-24, MarketDataRepository) — coalescing des
// prix LIVE. Même défaut confirmé par l'audit que le cache-stampede déjà
// corrigé pour l'historique (voir historicalFetchDeduplication.test.js) :
// loadPortfolioData() et HistoricalChart.update() (mode portefeuille)
// appellent chacun leur propre api.fetchBatchPrices(tickers) pour EXACTEMENT
// le même jeu de tickers, sans s'attendre l'un l'autre (voir dashboardApp.js
// init(), commentaire ANTI-RACE). Avant ce fix, chaque appel refaisait sa
// propre rafale réseau ; api.js::fetchBatchPrices coalesce désormais un appel
// concurrent pour le même jeu de tickers sur la MÊME promesse en vol — aucun
// changement requis côté dashboardApp.js/historicalChart.js.
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PriceAPI } from '../src/api.js';
import { marketDataMetrics } from '../src/marketDataMetrics.js';
import { createFakeStorage } from './helpers.js';

function yahooChartResponse(price, previousClose) {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
        chart: {
            result: [{
                meta: { currency: 'EUR', regularMarketPrice: price, chartPreviousClose: previousClose, marketState: 'REGULAR' },
                timestamp: [nowSec - 86400, nowSec],
                indicators: { quote: [{ close: [previousClose, price] }] }
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

describe('fetchBatchPrices — coalescing des requêtes concurrentes pour le même jeu de tickers', () => {
    it('3 appels concurrents pour le MÊME jeu de tickers -> 1 seule rafale réseau, tous reçoivent le même résultat', async () => {
        let fetchCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            fetchCalls++;
            return { ok: true, json: async () => yahooChartResponse(100, 98) };
        }));

        const storage = createFakeStorage({ assetTypes: { AAPL: 'Stock', MSFT: 'Stock' } });
        const api = new PriceAPI(storage);

        await Promise.all([
            api.fetchBatchPrices(['AAPL', 'MSFT']),
            api.fetchBatchPrices(['AAPL', 'MSFT']),
            api.fetchBatchPrices(['AAPL', 'MSFT']),
        ]);

        // 2 tickers -> 2 requêtes réseau pour la SEULE exécution coalescée,
        // jamais 6 (2 tickers x 3 appelants).
        expect(fetchCalls).toBe(2);
        expect(storage.getCurrentPrice('AAPL').price).toBe(100);
        expect(storage.getCurrentPrice('MSFT').price).toBe(100);
    });

    it('overlapping batches share each instrument request', async () => {
        let fetchCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            fetchCalls++;
            return { ok: true, json: async () => yahooChartResponse(50, 49) };
        }));

        const storage = createFakeStorage({ assetTypes: { AAPL: 'Stock', MSFT: 'Stock', NVDA: 'Stock' } });
        const api = new PriceAPI(storage);

        await Promise.all([
            api.fetchBatchPrices(['AAPL', 'MSFT']),
            api.fetchBatchPrices(['AAPL', 'MSFT', 'NVDA']),
        ]);

        expect(fetchCalls).toBe(3); // three distinct instruments, not five downloads
    });

    it("l'ordre des tickers dans le tableau n'affecte pas la coalescence (même jeu, ordre différent)", async () => {
        let fetchCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            fetchCalls++;
            return { ok: true, json: async () => yahooChartResponse(10, 9) };
        }));

        const storage = createFakeStorage({ assetTypes: { AAPL: 'Stock', MSFT: 'Stock' } });
        const api = new PriceAPI(storage);

        await Promise.all([
            api.fetchBatchPrices(['AAPL', 'MSFT']),
            api.fetchBatchPrices(['MSFT', 'AAPL']),
        ]);

        expect(fetchCalls).toBe(2); // toujours coalescé malgré l'ordre différent
    });

    it('subsequent calls reuse the fresh provider cache', async () => {
        let fetchCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            fetchCalls++;
            return { ok: true, json: async () => yahooChartResponse(20, 19) };
        }));

        // isCacheValid=false pour forcer un refetch même après un 1er succès
        // (sinon le 2e appel serait légitimement skippé par le cache TTL, ce
        // qui ne testerait pas la coalescence mais le TTL).
        const storage = createFakeStorage({ assetTypes: { AAPL: 'Stock' }, isCacheValid: false });
        const api = new PriceAPI(storage);

        await api.fetchBatchPrices(['AAPL']);
        expect(fetchCalls).toBe(1);

        await api.fetchBatchPrices(['AAPL']);
        expect(fetchCalls).toBe(1); // provider cache is still fresh
    });
});
