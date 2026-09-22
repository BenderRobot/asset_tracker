// Verifies dataManager.debugDividendPhantomGap() itself (the temporary
// diagnostic the user runs against their REAL account data — see
// dataManager.js's own doc comment) produces correct numbers, using the exact
// same constructed scenario as realWorldGapReproduction.test.js. This is a
// meta-test: it doesn't re-prove the bug, it proves the DIAGNOSTIC TOOL is
// trustworthy before asking the user to rely on its output for their real
// portfolio.
import { describe, it, expect, vi } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

describe('debugDividendPhantomGap — l\'outil de diagnostic lui-même est correct', () => {
    it('rapproche exactement Σphantom - Σdividendes == graphBefore - holdingsTotal, sur un compte réel simulé', async () => {
        const purchases = [
            purchase({ ticker: 'MEGA', assetType: 'Stock', price: 15000, quantity: 1, date: '2024-01-01' }),
            purchase({ ticker: 'OTHER', assetType: 'Stock', price: 15000, quantity: 1, date: '2024-01-01' }),
            purchase({ ticker: 'MEGA', assetType: 'Dividend', type: 'dividend', price: 654.00, quantity: 1, date: '2024-06-01' })
        ];
        const storage = createFakeStorage({
            prices: {
                MEGA: { price: 17000, currency: 'EUR', previousClose: 16800, lastUpdate: Date.now() },
                OTHER: { price: 19226.78, currency: 'EUR', previousClose: 19000, lastUpdate: Date.now() }
            },
            conversionRate: 0.9
        });
        storage.getPurchases = () => purchases; // seule méthode manquante du double pour ce test

        const dm = new DataManager(storage, createFakeApi());
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
        let result;
        try {
            result = await dm.debugDividendPhantomGap();
        } finally {
            logSpy.mockRestore();
            tableSpy.mockRestore();
        }

        expect(result.rows.length).toBe(1);
        expect(result.rows[0].Ticker).toBe('MEGA');
        expect(result.totalPhantomValue).toBeCloseTo(17000, 2);
        expect(result.totalDividendAmount).toBeCloseTo(654, 2);
        expect(result.predicted).toBeCloseTo(16346.00, 2);
        expect(result.graphBefore).toBeCloseTo(53226.78, 2);
        expect(result.holdingsTotal).toBeCloseTo(36880.78, 2);
        expect(result.observed).toBeCloseTo(16346.00, 2);
        expect(result.residual).toBeCloseTo(0, 6); // les dividendes expliquent 100% de l'écart sur ce scénario
    });
});
