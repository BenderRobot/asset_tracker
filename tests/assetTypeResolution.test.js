// BUG (EUEA — iShares Core EURO STOXX 50, distributing ETF): a dividend
// record stored under the same ticker made storage.getAssetType() answer
// 'Dividend', so PriceAPI skipped the price history as "legitimately empty"
// and the chart collapsed to the first-purchase point.
import { describe, it, expect, vi } from 'vitest';
import { Storage } from '../src/storage.js';
import { PriceAPI } from '../src/api.js';

const getAssetType = (purchases, ticker) => Storage.prototype.getAssetType.call({ purchases }, ticker);

const dividend = { ticker: 'EUEA', type: 'dividend', assetType: 'Dividend', price: 12.3, quantity: 1, date: '2024-06-20' };
const buy = { ticker: 'EUEA', type: 'buy', assetType: 'ETF', price: 51.4, quantity: 10, date: '2024-04-29' };

describe('storage.getAssetType', () => {
    it('returns the instrument type even when a dividend record comes first', () => {
        expect(getAssetType([dividend, buy], 'EUEA')).toBe('ETF');
        expect(getAssetType([buy, dividend], 'euea')).toBe('ETF');
    });

    it('keeps Dividend for a ticker that only has dividend records', () => {
        expect(getAssetType([dividend], 'EUEA')).toBe('Dividend');
    });

    it('defaults to Stock for an unknown ticker', () => {
        expect(getAssetType([buy], 'AAPL')).toBe('Stock');
    });
});

describe('PriceAPI history for a distributing asset', () => {
    it('fetches the price history instead of skipping it as a dividend', async () => {
        const purchases = [dividend, buy];
        const storage = {
            getAssetType: (t) => getAssetType(purchases, t),
            getCurrentPrice: () => null,
            getPurchases: () => purchases
        };
        const api = Object.create(PriceAPI.prototype);
        api.storage = storage;
        api.historicalPriceCache = {};
        api.historicalFetchedAt = {};
        api._inFlightHistoricalRequests = new Map();
        api.formatTicker = (t) => `${t}.AS`;
        api._doFetchHistoricalPrices = vi.fn(async () => ({ 1714374000000: 51.02, 1790000000000: 64.18 }));

        const history = await api.getHistoricalPricesWithRetry('EUEA', 1713916800, 1790100000, '1wk');

        expect(api._doFetchHistoricalPrices).toHaveBeenCalledTimes(1);
        expect(Object.keys(history)).toHaveLength(2);
    });
});
