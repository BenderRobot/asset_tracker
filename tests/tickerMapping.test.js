import { describe, expect, it } from 'vitest';
import { formatTicker as formatMarketTicker } from '../src/MarketUtils.js';
import { PriceAPI } from '../src/api.js';
import { createFakeStorage } from './helpers.js';

describe('Yahoo ticker mapping', () => {
    it('routes ASML to its Amsterdam EUR listing', () => {
        const storage = createFakeStorage({ assetTypes: { ASML: 'Stock' } });
        const api = new PriceAPI(storage);

        expect(formatMarketTicker('ASML')).toBe('ASML.AS');
        expect(api.formatTicker('ASML')).toBe('ASML.AS');
    });
});
