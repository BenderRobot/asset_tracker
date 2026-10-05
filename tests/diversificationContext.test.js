import { describe, expect, it } from 'vitest';
import { buildDiversificationContext } from '../src/diversificationContext.js';
import { buildGeminiDiversificationPrompt } from '../src/geminiService.js';

function report(overrides = {}) {
    return {
        assets: [
            { ticker: 'ETF', name: 'ETF Monde', assetType: 'ETF', quantity: 1, currentValue: 1000, gainPct: 10, weight: 66.67 },
            { ticker: 'STOCK', name: 'Action', assetType: 'Stock', quantity: 1, currentValue: 500, gainPct: -5, weight: 33.33 }
        ],
        diversification: { diversityScore: '90.0', herfindahl: '0.5556', effectiveAssets: '1.80', totalAssets: 2 },
        summary: { cashReserve: 500 },
        portfolioSnapshot: {
            cash: 500, status: 'valid', sourceStale: false,
            pricesTimestamp: '2026-10-04T12:00:00Z'
        },
        ...overrides
    };
}

describe('Gemini diversification context', () => {
    it('utilise valeur de marché + cash comme unique dénominateur des poids courants', () => {
        const context = buildDiversificationContext(report());

        expect(context.allocationValid).toBe(true);
        expect(context.allocationTotal).toBe(2000);
        expect(context.cashWeight).toBe(25);
        expect(context.positions.find(position => position.ticker === 'ETF').weight).toBe(50);
        expect(context.positions.find(position => position.ticker === 'STOCK').weight).toBe(25);
        expect(context.top3Weight).toBe(75);
        expect(context.allocationRows.find(row => row.type === 'Cash')).toMatchObject({ value: 500, weight: 25 });
    });

    it('explique dans le prompt que le score existant reste hors cash', () => {
        const prompt = buildGeminiDiversificationPrompt(buildDiversificationContext(report()));

        expect(prompt).toContain('valeur de marché actuelle des positions + cash');
        expect(prompt).toContain('calculés sur les positions uniquement, hors cash');
        expect(prompt).toContain('Cash: 500.00€ (25.0%)');
        expect(prompt).toContain('ETF Monde (50.0%)');
        expect(prompt).toContain('poids cash inclus 50.0%');
    });

    it('refuse tous les poids si une valeur de position est indisponible', () => {
        const invalid = report({
            assets: [
                { ticker: 'KNOWN', name: 'Connu', assetType: 'ETF', quantity: 1, currentValue: 1000 },
                { ticker: 'MISSING', name: 'Inconnu', assetType: 'Stock', quantity: 1, currentValue: null }
            ]
        });
        const context = buildDiversificationContext(invalid);
        const prompt = buildGeminiDiversificationPrompt(context);

        expect(context.allocationValid).toBe(false);
        expect(context.allocationTotal).toBeNull();
        expect(context.top3Weight).toBeNull();
        expect(context.positions.every(position => position.weight === null)).toBe(true);
        expect(context.allocationRows.every(row => row.weight === null)).toBe(true);
        expect(context.allocationUnavailable).toEqual(['MISSING']);
        expect(prompt).toContain('Statut allocation: indisponible');
        expect(prompt).toContain('Données manquantes: MISSING');
        expect(prompt).toContain('Poids des 3 plus grandes positions: indisponible');
    });
});
