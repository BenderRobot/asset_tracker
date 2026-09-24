// VALIDATION ARCHITECTURE (2026-09-24, décision #1) — Purchase fallback.
//
// api.js::fetchPricesViaProxy substituait auparavant, sur un échec réseau/HTTP
// confirmé (429/500/502/timeout) sans prix en cache, le prix d'achat comme
// nouveau prix courant ET nouveau previousClose (day change à 0% fabriqué,
// indiscernable en aval d'une vraie cotation à variation nulle — même défaut
// que le bug previousClose=currentPrice déjà corrigé, voir
// financialFallbackIntegrity.test.js). Ce comportement est supprimé :
//   - échec + aucun prix précédent en cache -> storage reste vide pour ce
//     ticker (priceDataUnavailable en aval, jamais une valeur fabriquée) ;
//   - échec + un prix précédent VALIDE existe déjà -> il reste affiché tel
//     quel (storage.currentData n'est pas touché sur échec), avec son
//     lastUpdate figé -> c'est la base de l'état stale/degraded porté par le
//     futur MarketDataRepository.
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PriceAPI } from '../src/api.js';
import { createFakeStorage } from './helpers.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('fetchPricesViaProxy — aucun fallback "prix d\'achat" sur échec réseau confirmé', () => {
    it.each([
        ['HTTP 429', () => ({ ok: false, status: 429 })],
        ['HTTP 500', () => ({ ok: false, status: 500 })],
        ['HTTP 502', () => ({ ok: false, status: 502 })],
    ])('%s sans prix précédent en cache -> aucun prix fabriqué, ticker reste indisponible', async (_label, makeResponse) => {
        vi.stubGlobal('fetch', vi.fn(async () => makeResponse()));

        const storage = createFakeStorage({ assetTypes: { AAPL: 'Stock' } });
        const api = new PriceAPI(storage);

        await api.fetchPricesViaProxy(['AAPL']);

        expect(storage.getCurrentPrice('AAPL')).toBeNull();
    });

    it('timeout (AbortError) sans prix précédent en cache -> aucun prix fabriqué', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
        }));

        const storage = createFakeStorage({ assetTypes: { AAPL: 'Stock' } });
        const api = new PriceAPI(storage);

        await api.fetchPricesViaProxy(['AAPL']);

        expect(storage.getCurrentPrice('AAPL')).toBeNull();
    });

    it('échec réseau (500) avec un snapshot précédent VALIDE en cache -> le snapshot précédent est conservé tel quel', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));

        const storage = createFakeStorage({
            assetTypes: { AAPL: 'Stock' },
            prices: {
                AAPL: { price: 200, previousClose: 190, currency: 'EUR', source: 'Yahoo Proxy', lastUpdate: 123456 }
            }
        });
        const api = new PriceAPI(storage);

        await api.fetchPricesViaProxy(['AAPL']);

        const after = storage.getCurrentPrice('AAPL');
        expect(after.price).toBe(200);
        expect(after.previousClose).toBe(190);
        expect(after.source).toBe('Yahoo Proxy');
        // lastUpdate non réécrit : c'est ce qui permettra à l'UI de détecter
        // et d'afficher un état "stale" plutôt qu'un nouveau prix frais.
        expect(after.lastUpdate).toBe(123456);
    });

    it("aucune trace de source: 'Purchase fallback' n'est plus produite, quelle que soit l'erreur", async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429 })));

        const storage = createFakeStorage({ assetTypes: { ZZZZ: 'Stock' } });
        const api = new PriceAPI(storage);

        await api.fetchPricesViaProxy(['ZZZZ']);

        const after = storage.getCurrentPrice('ZZZZ');
        expect(after).toBeNull();
    });
});
