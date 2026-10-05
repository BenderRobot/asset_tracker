import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRiskContext } from '../src/riskContext.js';
import { fetchGeminiRiskAdvice } from '../src/geminiService.js';

afterEach(() => vi.unstubAllGlobals());

function report(overrides = {}) {
    return {
        assets: [
            { ticker: 'ETF', name: 'ETF Monde', assetType: 'ETF', quantity: 1, currentValue: 1000, gainPct: 10, weight: 50 },
            { ticker: 'STOCK', name: 'Action', assetType: 'Stock', quantity: 1, currentValue: 500, gainPct: -5, weight: 25 },
            { ticker: 'HOME', name: 'SCPI', assetType: 'Real Estate', quantity: 1, currentValue: 2000, gainPct: 2, weight: 25 }
        ],
        risk: { status: 'available', periodDays: 365, assetRisks: [] },
        summary: { cashReserve: 500 },
        portfolioSnapshot: {
            cash: 500, totalValue: 4000, status: 'valid', sourceStale: false,
            pricesTimestamp: '2026-10-04T12:00:00Z'
        },
        ...overrides
    };
}

describe('Gemini risk context', () => {
    it('calcule les poids sur actifs de marché + cash et exclut l’immobilier', () => {
        const context = buildRiskContext(report());

        expect(context.totalValue).toBe(2000);
        expect(context.totalValue).not.toBe(4000);
        expect(context.cashWeight).toBe(25);
        expect(context.positions.find(position => position.ticker === 'ETF').weight).toBe(50);
        expect(context.positions.find(position => position.ticker === 'STOCK').weight).toBe(25);
        expect(context.positions.some(position => position.ticker === 'HOME')).toBe(false);
        expect(context.excludedRealEstate).toEqual([
            { ticker: 'HOME', name: 'SCPI', currentValue: 2000 }
        ]);
        expect(context.excludedRealEstateValue).toBe(2000);
    });

    it('rend tous les poids indisponibles si le cash ou une cotation manque', () => {
        const missingCash = report({
            portfolioSnapshot: { cash: null, status: 'invalid' },
            summary: { cashReserve: null }
        });
        const context = buildRiskContext(missingCash);

        expect(context.allocationValid).toBe(false);
        expect(context.totalValue).toBeNull();
        expect(context.cashWeight).toBeNull();
        expect(context.positions.every(position => position.weight === null)).toBe(true);
        expect(context.allocationUnavailable).toEqual(['Cash']);
    });

    it('envoie à Gemini le périmètre cash inclus sans ajouter la valeur immobilière', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({ text: 'Analyse' })
        }));
        vi.stubGlobal('fetch', fetchMock);

        await fetchGeminiRiskAdvice(buildRiskContext(report()));

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.prompt).toContain('Valeur totale du périmètre risque (marché + cash): 2000.00€');
        expect(body.prompt).toContain('Cash: 500.00€ (25.0%)');
        expect(body.prompt).toContain('ETF Monde), ETF: poids dans le périmètre risque cash inclus 50.0%');
        expect(body.prompt).toContain('Immobilier explicitement exclu (1 actif(s), valeur 2000.00€)');
        expect(body.prompt).toContain('HOME (SCPI): 2000.00€');
        expect(body.prompt).not.toContain('Valeur totale du périmètre risque (marché + cash): 4000.00€');
    });
});
