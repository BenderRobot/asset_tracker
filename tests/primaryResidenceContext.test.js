import { describe, expect, it } from 'vitest';
import { buildPrimaryResidenceContext } from '../src/primaryResidenceContext.js';

describe('buildPrimaryResidenceContext', () => {
    it('transmet le capital restant dû plutôt que le capital initial', () => {
        const context = buildPrimaryResidenceContext({
            name: 'Maison',
            purchasePrice: 200000,
            currentValue: 250000,
            purchaseDate: '2020-01-01',
            credits: [{
                name: 'PTZ', initialAmount: 120000, rate: 0,
                duration: 120, startDate: '2020-01-01'
            }]
        }, new Date('2025-01-01T12:00:00Z'));

        expect(context.totalDebt).toBe(60000);
        expect(context.totalDebt).not.toBe(120000);
        expect(context.equity).toBe(190000);
        expect(context.totalMonthlyPayment).toBe(1000);
        expect(context.credits[0]).toMatchObject({
            remainingCapital: 60000,
            status: 'active',
            endDate: '2030-01-01'
        });
    });

    it('ne compte plus la mensualité d’un crédit déjà remboursé', () => {
        const context = buildPrimaryResidenceContext({
            currentValue: 150000,
            credits: [{
                name: 'Ancien prêt', initialAmount: 60000, rate: 0,
                duration: 60, startDate: '2015-01-01'
            }]
        }, new Date('2025-01-01T12:00:00Z'));

        expect(context.totalDebt).toBe(0);
        expect(context.totalMonthlyPayment).toBe(0);
        expect(context.equity).toBe(150000);
        expect(context.credits[0].status).toBe('repaid');
    });

    it('échoue explicitement si un crédit ne permet pas un calcul fiable', () => {
        const context = buildPrimaryResidenceContext({
            currentValue: 250000,
            credits: [{ name: 'Crédit incomplet', initialAmount: 100000 }]
        }, new Date('2025-01-01T12:00:00Z'));

        expect(context.debtStatus).toBe('unavailable');
        expect(context.totalDebt).toBeNull();
        expect(context.totalMonthlyPayment).toBeNull();
        expect(context.equity).toBeNull();
    });
});
