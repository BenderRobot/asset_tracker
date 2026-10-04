import { describe, expect, it, vi } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeApi, createFakeStorage, purchase } from './helpers.js';

function validGraph(overrides = {}) {
    return {
        twr: [1, 1.10, 0.99],
        twrWithDividends: [1, 1.10, 0.99],
        values: [100, 110, 99],
        assetValues: [100, 110, 99],
        historicalDataMap: new Map(),
        dataQuality: { valid: true, estimated: false },
        ...overrides
    };
}

describe('Historical portfolio risk', () => {
    it('uses successive TWR returns for annualized volatility and peak-to-trough drawdown', () => {
        const dm = new DataManager(createFakeStorage(), createFakeApi());
        const risk = dm.calculateHistoricalRisk(validGraph(), {
            minObservations: 2,
            annualizationPeriods: 252
        });

        // Returns are +10% then -10%. The former cross-sectional implementation
        // could not reconstruct this actual 10% peak-to-trough loss.
        expect(risk.status).toBe('available');
        expect(risk.observations).toBe(2);
        expect(risk.volatility).toBeCloseTo(Math.sqrt(0.02) * Math.sqrt(252) * 100, 2);
        expect(risk.maxDrawdown).toBeCloseTo(-10, 8);
        expect(risk.sharpeRatio).toBeCloseTo(0, 8);
    });

    it('includes dividends and dilutes market risk with the cash weight', () => {
        const dm = new DataManager(createFakeStorage(), createFakeApi());
        const risk = dm.calculateHistoricalRisk(validGraph({
            twr: [1, 1, 1],
            twrWithDividends: [1, 1.10, 0.99],
            values: [200, 210, 199],
            assetValues: [100, 110, 99]
        }), { minObservations: 2, annualizationPeriods: 252 });

        // +10%/-10% on the security sleeve becomes +5% then about -5.24%
        // for the total portfolio because roughly half of it is cash.
        expect(risk.volatility).toBeGreaterThan(0);
        expect(risk.volatility).toBeLessThan(120);
        expect(risk.maxDrawdown).toBeCloseTo(-(11 / 210) * 100, 2);
        expect(risk.includesDividends).toBe(true);
        expect(risk.cashIncluded).toBe(true);
    });

    it('fails closed when market history is invalid or too short', () => {
        const dm = new DataManager(createFakeStorage(), createFakeApi());
        const invalid = dm.calculateHistoricalRisk(validGraph({
            dataQuality: { valid: false, reason: 'PRICE_DATA_UNAVAILABLE', failedInstruments: ['AAPL'] }
        }));
        const short = dm.calculateHistoricalRisk(validGraph(), { minObservations: 20 });

        expect(invalid).toMatchObject({
            status: 'unavailable', reason: 'PRICE_DATA_UNAVAILABLE',
            volatility: null, maxDrawdown: null, failedInstruments: ['AAPL']
        });
        expect(short).toMatchObject({
            status: 'unavailable', reason: 'INSUFFICIENT_OBSERVATIONS', observations: 2
        });
    });

    it('calculates individual volatility from historical prices, not total position performance', () => {
        const dm = new DataManager(createFakeStorage(), createFakeApi());
        const dailyPrices = [100, 102, 101, 105, 103, 106];
        const historicalDataMap = new Map([['AAPL', Object.fromEntries(
            dailyPrices.map((price, index) => [Date.UTC(2026, 0, index + 1), price])
        )]]);
        const risk = dm.calculateHistoricalRisk(validGraph({ historicalDataMap }), {
            minObservations: 2,
            assetTickers: ['AAPL'],
            cryptoTickers: new Set()
        });

        expect(risk.assetRisks).toHaveLength(1);
        expect(risk.assetRisks[0]).toMatchObject({ ticker: 'AAPL', observations: 5 });
        expect(risk.assetRisks[0].volatility).toBeGreaterThan(0);
    });

    it('only requests active market assets and reports excluded real estate', async () => {
        const dm = new DataManager(createFakeStorage(), createFakeApi());
        vi.spyOn(dm, 'calculateGenericHistory').mockResolvedValue(validGraph({
            twr: Array.from({ length: 21 }, (_, index) => 1 + index / 1000),
            twrWithDividends: Array.from({ length: 21 }, (_, index) => 1 + index / 1000),
            values: Array.from({ length: 21 }, () => 100),
            assetValues: Array.from({ length: 21 }, () => 100)
        }));
        const purchases = [
            purchase({ ticker: 'AAPL', quantity: 2 }),
            purchase({ ticker: 'SOLD', quantity: 1 }),
            purchase({ ticker: 'SOLD', quantity: -1 }),
            purchase({ ticker: 'HOME', assetType: 'Real Estate', quantity: 1 })
        ];

        const risk = await dm.calculatePortfolioRisk(purchases, 365);

        expect(dm.calculateGenericHistory).toHaveBeenCalledWith(expect.arrayContaining(purchases.slice(0, 3)), 365, false);
        expect(risk.status).toBe('available');
        expect(risk.excludedRealEstate).toBe(1);
    });

    it('never derives risk from a cross-section of current holdings', () => {
        const dm = new DataManager(createFakeStorage(), createFakeApi());
        expect(dm.calculateRisk([{ gainPct: 100 }, { gainPct: -50 }])).toMatchObject({
            status: 'unavailable',
            reason: 'HISTORICAL_SERIES_REQUIRED',
            volatility: null,
            maxDrawdown: null
        });
    });
});
