import { describe, it, expect } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

describe('buildTodaySnapshot smoke', () => {
    it('runs end to end on a simple crypto-only portfolio', async () => {
        const storage = createFakeStorage({
            prices: { 'BTC-EUR': { price: 50000, currency: 'EUR', previousClose: 49000, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const api = createFakeApi();
        const dm = new DataManager(storage, api);

        const assetPurchases = [purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', currency: 'EUR', price: 40000, quantity: 0.1, date: '2024-01-01' })];
        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);

        console.log(JSON.stringify({
            values: snapshot.todayGraphData.values,
            resolvedPrices: [...(snapshot.todayGraphData.resolvedPrices || [])],
            summaryTotal: snapshot.summary.totalCurrentEUR,
            holdingsCount: snapshot.holdings.length
        }, null, 2));

        expect(snapshot.holdings.length).toBeGreaterThan(0);
    });
});
