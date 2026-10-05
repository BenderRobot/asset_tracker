import { describe, expect, it } from 'vitest';
import { buildNetWorthContext } from '../src/netWorthContext.js';

function portfolio(overrides = {}) {
    return {
        summary: { totalValue: 1000, cash: 200, status: 'valid' },
        holdings: [{ ticker: 'AAPL', name: 'Apple', type: 'Stock' }],
        primaryResidence: {
            name: 'Maison familiale', equity: 100000, totalDebt: 50000,
            debtStatus: 'complete'
        },
        ...overrides
    };
}

function expenses(overrides = {}) {
    return {
        bankAccounts: [{ name: 'Compte courant', currency: 'EUR', balance: 500 }],
        totalBankBalanceEUR: 500,
        ...overrides
    };
}

describe('buildNetWorthContext', () => {
    it('additionne chaque composante enregistrée une seule fois', () => {
        const context = buildNetWorthContext(portfolio(), expenses());

        expect(context.status).toBe('complete');
        expect(context.components).toEqual({
            investedAssetsAndProjects: 800,
            brokerCash: 200,
            bankBalanceEUR: 500,
            primaryResidenceEquity: 100000,
            primaryResidenceDebt: 50000
        });
        expect(context.totalNetWorthEUR).toBe(101500);
        expect(context.knownSubtotalEUR).toBe(101500);
    });

    it('ne fabrique pas de total si un solde bancaire non-EUR ne peut pas être converti', () => {
        const context = buildNetWorthContext(portfolio(), expenses({
            bankAccounts: [{ name: 'Compte USD', currency: 'USD', balance: 500 }],
            totalBankBalanceEUR: null
        }));

        expect(context.status).toBe('partial');
        expect(context.totalNetWorthEUR).toBeNull();
        expect(context.knownSubtotalEUR).toBe(101000);
        expect(context.unavailable).toContain('Solde bancaire USD non converti');
    });

    it('bloque le total lorsqu’une résidence semble aussi présente dans les actifs', () => {
        const context = buildNetWorthContext(portfolio({
            holdings: [{ ticker: 'HOME', name: 'Maison familiale', type: 'Real Estate' }]
        }), expenses());

        expect(context.totalNetWorthEUR).toBeNull();
        expect(context.duplicateResidenceAssets).toEqual(['HOME']);
        expect(context.unavailable).toContain('Doublon immobilier potentiel: HOME');
    });
});
