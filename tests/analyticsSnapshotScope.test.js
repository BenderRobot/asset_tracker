import { describe, it, expect, vi } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

describe('Analytics snapshot scope', () => {
    it('excludes Real Estate from the market snapshot and adds it only to Analytics', async () => {
        const dm = new DataManager(createFakeStorage(), createFakeApi());
        const stock = purchase({ ticker: 'AAPL', assetType: 'Stock', price: 100, quantity: 1 });
        const realEstate = purchase({ ticker: 'IMMO-1', assetType: 'Real Estate', price: 500, quantity: 1 });
        const cash = purchase({ ticker: 'EUR', assetType: 'Cash', price: 50, quantity: 1 });
        const purchases = [stock, realEstate, cash];

        dm.repository.getSnapshot = vi.fn(async (assets, cashRows) => ({ assets, cashRows }));
        await dm.getCanonicalMarketSnapshot(purchases);
        expect(dm.repository.getSnapshot).toHaveBeenCalledWith([stock], [cash], {});

        const marketHolding = {
            ticker: 'AAPL', name: 'Apple', assetType: 'Stock', quantity: 1,
            avgPrice: 100, currentPrice: 120, previousClose: 115,
            currentValue: 120, invested: 100, gainEUR: 20, gainPct: 20,
            dayChange: 5, dayPct: 4.35, purchases: [stock]
        };
        const marketSummary = dm.calculateSummary([marketHolding]);
        const marketCash = { total: 50 };
        const marketPortfolioSnapshot = dm.buildPortfolioSnapshot({
            holdings: [marketHolding], summary: marketSummary, cashReserve: marketCash,
            snapshotStartedAt: 1234, pricesTimestamp: 1234
        });
        const marketResult = {
            snapshot: {
                snapshotId: marketPortfolioSnapshot.snapshotId,
                portfolioSnapshot: marketPortfolioSnapshot,
                _engine: { holdings: [marketHolding], summary: marketSummary, cashReserve: marketCash }
            }
        };
        const realEstateHolding = {
            ticker: 'IMMO-1', name: 'Projet immo', assetType: 'Real Estate', quantity: 1,
            avgPrice: 500, currentPrice: 550, previousClose: 550,
            currentValue: 550, invested: 500, gainEUR: 50, gainPct: 10,
            dayChange: 0, dayPct: 0, purchases: [realEstate]
        };
        vi.spyOn(dm, 'getHistoricalFxMap').mockResolvedValue(new Map());
        vi.spyOn(dm, 'calculateHoldings').mockReturnValue([realEstateHolding]);

        const analytics = await dm.buildAnalyticsSnapshot(purchases, marketResult);

        expect(marketPortfolioSnapshot.positions.map(p => p.ticker)).toEqual(['AAPL']);
        expect(analytics.portfolioSnapshot.positions.map(p => p.ticker)).toEqual(['AAPL', 'IMMO-1']);
        expect(analytics.portfolioSnapshot.totalValue).toBe(720);
        expect(analytics.portfolioSnapshot.totalReturn).toBe(70);
        expect(analytics.portfolioSnapshot.meta).toMatchObject({ mode: 'analytics', includesRealEstate: true });
    });

    it('does not mutate cached holdings while building the Analytics report', () => {
        const dm = new DataManager(createFakeStorage(), createFakeApi());
        const cachedHolding = Object.freeze({
            ticker: 'AAPL', currentValue: 120, invested: 100, gainEUR: 20,
            gainPct: 20, dayChange: 5, dayPct: 4.35, quantity: 1
        });
        const report = dm.generateReportFromResolvedState(
            [cachedHolding],
            { totalCurrentEUR: 120, totalInvestedEUR: 100, gainTotal: 20, gainPct: 20, totalDayChangeEUR: 5, dayChangePct: 4.35 },
            { total: 0 }
        );

        expect(cachedHolding).not.toHaveProperty('weight');
        expect(report.assets[0]).not.toBe(cachedHolding);
        expect(report.assets[0].weight).toBe(100);
    });
});
