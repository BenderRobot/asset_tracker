import { describe, it, expect } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { HistoryCalculator } from '../src/HistoryCalculator.js';
import * as MarketUtils from '../src/MarketUtils.js';

describe('smoke', () => {
    it('imports DataManager from the real source', () => {
        const dm = new DataManager({ getConversionRate: () => null }, null);
        expect(typeof dm.calculateHoldings).toBe('function');
        expect(typeof dm.validatePortfolioConsistency).toBe('function');
        expect(typeof dm.getHistoricalFxMap).toBe('function');
    });

    it('imports HistoryCalculator from the real source', () => {
        const hc = new HistoryCalculator({ getConversionRate: () => null }, null);
        expect(typeof hc.calculateGenericHistory).toBe('function');
    });

    it('exports resolveHistoricalUsdToEurRate from MarketUtils', () => {
        expect(typeof MarketUtils.resolveHistoricalUsdToEurRate).toBe('function');
    });
});
