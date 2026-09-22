// TEST 28 (section 36) — audits the ONE real unit boundary in this codebase:
// Yahoo's chart API returns `timestamp` in Unix SECONDS; every internal
// consumer (HistoryCalculator's historicalDataMap, MarketCalendarEngine's
// regularSession, TimeRangeEngine) works in MILLISECONDS. A missed ×1000 (or
// a stray ×1000 applied twice) here would silently shift the whole chart by
// a factor of 1000 — this test pins that exact conversion against the real
// shape of a Yahoo chart response (see tests/marketMetadata.test.js for the
// literal payload this is modeled on), not a guess at the schema.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PriceAPI } from '../src/api.js';
import { createFakeStorage } from './helpers.js';

describe('TEST 28 — conversion Unix seconds (Yahoo) -> ms (interne) à la frontière API', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('getHistoricalPricesWithRetry multiplie bien les timestamps Yahoo (secondes) par 1000', async () => {
        const YAHOO_SECONDS_1 = 1790083800; // valeur réelle observée (voir marketMetadata.test.js)
        const YAHOO_SECONDS_2 = 1790107200;

        const fakeYahooResponse = {
            chart: {
                result: [{
                    meta: { currency: 'EUR', exchangeTimezoneName: 'Europe/Paris' },
                    timestamp: [YAHOO_SECONDS_1, YAHOO_SECONDS_2],
                    indicators: { quote: [{ close: [180.5, 181.2] }] }
                }],
                error: null
            }
        };

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => fakeYahooResponse
        })));

        const storage = createFakeStorage({ assetTypes: { AAPL: 'STOCK' } });
        const api = new PriceAPI(storage);

        const prices = await api.getHistoricalPricesWithRetry('AAPL', YAHOO_SECONDS_1, YAHOO_SECONDS_2, '1d');
        const keys = Object.keys(prices).map(Number).sort((a, b) => a - b);

        expect(keys).toEqual([YAHOO_SECONDS_1 * 1000, YAHOO_SECONDS_2 * 1000]);
        // Contrôle négatif explicite : si le ×1000 manquait, la clé serait en
        // secondes (~1.79e9) au lieu de ms (~1.79e12) — un facteur 1000 exact,
        // pas une différence d'arrondi.
        expect(keys[0]).toBe(YAHOO_SECONDS_1 * 1000);
        expect(keys[0]).not.toBe(YAHOO_SECONDS_1);
    });

    it('ingestProviderMetadata (MarketCalendarEngine) applique la même conversion à currentTradingPeriod', async () => {
        const REGULAR_START_SECONDS = 1790083800;
        const REGULAR_END_SECONDS = 1790107200;
        // Ticker et bornes distincts du test précédent : PriceAPI met en cache par
        // (ticker, startTs, endTs, interval) dans le localStorage partagé entre tests
        // de ce fichier — réutiliser exactement les mêmes valeurs ferait retomber sur
        // le cache et sauterait l'appel réseau (donc ingestProviderMetadata) qu'on
        // veut justement observer ici.
        const TICKER = 'MSFT';

        const fakeYahooResponse = {
            chart: {
                result: [{
                    meta: {
                        currency: 'USD', exchangeTimezoneName: 'America/New_York', instrumentType: 'EQUITY',
                        currentTradingPeriod: { regular: { start: REGULAR_START_SECONDS, end: REGULAR_END_SECONDS } }
                    },
                    timestamp: [REGULAR_START_SECONDS],
                    indicators: { quote: [{ close: [341] }] }
                }],
                error: null
            }
        };

        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => fakeYahooResponse })));

        const storage = createFakeStorage({ assetTypes: { [TICKER]: 'STOCK' } });
        const api = new PriceAPI(storage);
        await api.getHistoricalPricesWithRetry(TICKER, REGULAR_START_SECONDS, REGULAR_END_SECONDS, '1d');

        const { marketCalendarEngine } = await import('../src/MarketCalendarEngine.js');
        const meta = marketCalendarEngine.getProviderMetadata(TICKER);
        expect(meta.regularSession.startMs).toBe(REGULAR_START_SECONDS * 1000);
        expect(meta.regularSession.endMs).toBe(REGULAR_END_SECONDS * 1000);
    });
});
