import { describe, expect, it } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, purchase } from './helpers.js';

describe('positions totalement vendues', () => {
    it("les exclut des positions courantes et des KPI sans effacer leur historique", () => {
        const storage = createFakeStorage({
            prices: {
                TKE: { price: 214.40, currency: 'EUR' },
                AAPL: { price: 180, currency: 'EUR' }
            }
        });
        const dm = new DataManager(storage, null);
        const transactions = [
            purchase({ ticker: 'TKE', name: 'Take-Two', price: 180, quantity: 2, date: '2026-01-10' }),
            purchase({ ticker: 'TKE', name: 'Take-Two', price: 214.40, quantity: -2, date: '2026-10-02' }),
            purchase({ ticker: 'AAPL', name: 'Apple', price: 150, quantity: 3, date: '2026-02-01' })
        ];

        const holdings = dm.calculateHoldings(transactions);
        const summary = dm.calculateSummary(holdings);
        const snapshot = dm.buildPortfolioSnapshot({
            holdings,
            summary,
            cashReserve: { total: 0, byBroker: {} }
        });

        expect(holdings.map(position => position.ticker)).toEqual(['AAPL']);
        expect(summary.assetsCount).toBe(1);
        expect(summary.topPerformers.map(position => position.ticker)).toEqual(['AAPL']);
        expect(summary.worstPerformers.map(position => position.ticker)).toEqual(['AAPL']);
        expect(snapshot.positions.map(position => position.ticker)).toEqual(['AAPL']);

        // Le registre source et l'historique de l'actif vendu restent complets.
        expect(transactions).toHaveLength(3);
        expect(dm.getAssetHistoryPurchases(transactions, 'TKE')).toHaveLength(2);
    });

    it('conserve une position partiellement vendue avec sa quantité restante exacte', () => {
        const storage = createFakeStorage({ prices: { TKE: { price: 214.40, currency: 'EUR' } } });
        const dm = new DataManager(storage, null);
        const transactions = [
            purchase({ ticker: 'TKE', name: 'Take-Two', price: 180, quantity: 2, date: '2026-01-10' }),
            purchase({ ticker: 'TKE', name: 'Take-Two', price: 214.40, quantity: -1, date: '2026-10-02' })
        ];

        const holdings = dm.calculateHoldings(transactions);

        expect(holdings).toHaveLength(1);
        expect(holdings[0].ticker).toBe('TKE');
        expect(holdings[0].quantity).toBeCloseTo(1, 8);
    });
});
