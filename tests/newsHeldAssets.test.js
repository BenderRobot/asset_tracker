import { describe, expect, it } from 'vitest';
import { getHeldAssetNames } from '../src/newsHoldingMatcher.js';

describe('getHeldAssetNames', () => {
    it('exclut les actifs vendus en totalité et le cash', () => {
        const purchases = [
            { ticker: 'TKE', name: 'Take-Two', assetType: 'Stock', quantity: 0.526038 },
            { ticker: 'TKE', name: 'Take-Two', assetType: 'Stock', quantity: -0.526038 },
            { ticker: 'SOI', name: 'Soitec', assetType: 'Stock', quantity: 2 },
            { ticker: 'SOI', name: 'Soitec', assetType: 'Stock', quantity: 2 },
            { ticker: 'EUR', name: 'Cash', assetType: 'Cash', quantity: 1 }
        ];
        expect(getHeldAssetNames(purchases)).toEqual(['Soitec']);
    });

    it('garde un actif partiellement vendu', () => {
        const purchases = [
            { ticker: 'BTC', name: 'Bitcoin', assetType: 'Crypto', quantity: 0.001 },
            { ticker: 'BTC', name: 'Bitcoin', assetType: 'Crypto', quantity: -0.0005 }
        ];
        expect(getHeldAssetNames(purchases)).toEqual(['Bitcoin']);
    });
});
