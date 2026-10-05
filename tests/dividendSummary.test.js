import { describe, expect, it, vi } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeApi, createFakeStorage } from './helpers.js';

function manager() {
    return new DataManager(createFakeStorage({ conversionRate: 0.42 }), createFakeApi());
}

describe('DataManager.calculateDividendSummary', () => {
    it('additionne EUR et USD avec le taux historique du versement, jamais le taux courant', () => {
        const dm = manager();
        const fx = new Map([['2026-01-15', 1 / 0.90]]);
        const summary = dm.calculateDividendSummary([
            { type: 'dividend', ticker: 'ETF', date: '2026-01-10', price: 25, quantity: 1, currency: 'EUR' },
            { type: 'dividend', ticker: 'AAPL', date: '2026-01-15', price: 100, quantity: 1, currency: 'USD' }
        ], fx);

        expect(summary.totalEUR).toBeCloseTo(115);
        expect(summary.knownTotalEUR).toBeCloseTo(115);
        expect(summary.conversionStatus).toBe('complete');
        expect(summary.unavailableCount).toBe(0);
        expect(summary.byCurrency).toEqual([
            { currency: 'EUR', count: 1, amount: 25, invalidCount: 0 },
            { currency: 'USD', count: 1, amount: 100, invalidCount: 0 }
        ]);
    });

    it('refuse de présenter un sous-total comme total quand le taux USD manque', () => {
        const dm = manager();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const summary = dm.calculateDividendSummary([
            { type: 'dividend', date: '2026-01-10', price: 25, currency: 'EUR' },
            { type: 'dividend', ticker: 'AAPL', date: '2026-01-15', price: 100, currency: 'USD' }
        ], new Map());

        expect(summary.totalEUR).toBeNull();
        expect(summary.knownTotalEUR).toBe(25);
        expect(summary.conversionStatus).toBe('partial');
        expect(summary.unavailableCount).toBe(1);
    });

    it('ne reconvertit pas un dividende déjà enregistré en EUR', () => {
        const dm = manager();
        const summary = dm.calculateDividendSummary([{
            type: 'dividend', date: '2026-01-15', price: 72, quantity: 1,
            currency: 'EUR', originalAmount: 100, originalCurrency: 'USD'
        }], new Map([['2026-01-15', 1 / 0.90]]));

        expect(summary.totalEUR).toBe(72);
        expect(summary.byCurrency).toEqual([
            { currency: 'EUR', count: 1, amount: 72, invalidCount: 0 }
        ]);
    });

    it('marque les montants invalides et les devises non prises en charge comme indisponibles', () => {
        const dm = manager();
        const summary = dm.calculateDividendSummary([
            { type: 'dividend', date: '2026-01-15', price: 'invalide', currency: 'EUR' },
            { type: 'dividend', date: '2026-01-15', price: 10, currency: 'GBP' }
        ], new Map());

        expect(summary.totalEUR).toBeNull();
        expect(summary.knownTotalEUR).toBe(0);
        expect(summary.conversionStatus).toBe('unavailable');
        expect(summary.unavailableCount).toBe(2);
        expect(summary.byCurrency[0].invalidCount).toBe(1);
    });
});
