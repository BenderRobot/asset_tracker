import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatTicker as formatMarketTicker } from '../src/MarketUtils.js';
import { isHistoricalFetchFailure, PriceAPI } from '../src/api.js';
import { DataManager } from '../src/dataManager.js';
import { createFakeApi, createFakeStorage, purchase } from './helpers.js';

describe('Yahoo ticker mapping', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('routes ASML to its Amsterdam EUR listing', () => {
        const storage = createFakeStorage({ assetTypes: { ASML: 'Stock' } });
        const api = new PriceAPI(storage);

        expect(formatMarketTicker('ASML')).toBe('ASML.AS');
        expect(api.formatTicker('ASML')).toBe('ASML.AS');
    });

    it('keeps GOLD-ETFP as the storage key while fetching GOLD.PA for long history', async () => {
        const storage = createFakeStorage({
            assetTypes: { 'GOLD-ETFP': 'Stock' },
            prices: { 'GOLD-ETFP': { price: 150, currency: 'EUR', lastUpdate: Date.now() } }
        });
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
                chart: {
                    result: [{
                        meta: { currency: 'EUR' },
                        timestamp: [1_790_000_000, 1_790_086_400],
                        indicators: { quote: [{ close: [140, 145] }] }
                    }],
                    error: null
                }
            })
        }));
        vi.stubGlobal('fetch', fetchMock);
        const api = new PriceAPI(storage);

        const history = await api.getHistoricalPricesWithRetry('GOLD-ETFP', 1_789_900_000, 1_790_100_000, '1d', 1);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toContain('symbol=GOLD.PA');
        expect(isHistoricalFetchFailure(history)).toBe(false);
        expect(history[1_790_086_400_000]).toBeCloseTo(150, 8);
    });

    it('does not pre-format GOLD-ETFP before handing it to PriceAPI', async () => {
        const requestedTickers = [];
        const now = Date.now();
        const storage = createFakeStorage({
            prices: { 'GOLD-ETFP': { price: 150, previousClose: 149, currency: 'EUR', lastUpdate: now } },
            assetTypes: { 'GOLD-ETFP': 'Stock' }
        });
        const api = createFakeApi({
            async getHistoricalPricesWithRetry(ticker) {
                requestedTickers.push(ticker);
                return { [now - 86400000]: 149, [now]: 150 };
            }
        });

        await new DataManager(storage, api).calculateHistory([
            purchase({ ticker: 'GOLD-ETFP', price: 100, date: '2024-01-01' })
        ], 90);

        expect(requestedTickers).toEqual(['GOLD-ETFP']);
    });
});
