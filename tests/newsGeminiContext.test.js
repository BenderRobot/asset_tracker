import { describe, expect, it } from 'vitest';
import { buildGeminiNewsContextPrompt } from '../src/geminiService.js';
import { findHoldingForNews } from '../src/newsHoldingMatcher.js';

describe('News holding matching', () => {
    const holdings = [
        { ticker: 'AI', name: 'C3.ai', quantity: 2 },
        { ticker: 'MC.PA', name: 'LVMH', quantity: 1 },
        { ticker: 'SOLD', name: 'Ancienne position', quantity: 0 }
    ];

    it('matches an exact ticker token but not the same letters inside another word', () => {
        expect(findHoldingForNews({ title: 'AI : nouveaux résultats trimestriels' }, holdings)?.ticker).toBe('AI');
        expect(findHoldingForNews({ title: 'La société said avoir progressé' }, holdings)).toBeNull();
    });

    it('matches normalized company names and excludes fully sold positions', () => {
        expect(findHoldingForNews({ title: 'LVMH dévoile sa nouvelle stratégie' }, holdings)?.ticker).toBe('MC.PA');
        expect(findHoldingForNews({ title: 'Ancienne position annonce ses résultats' }, holdings)).toBeNull();
    });
});

describe('Gemini news portfolio context', () => {
    it('includes canonical exposure, performance, cash and freshness metadata', () => {
        const prompt = buildGeminiNewsContextPrompt('Apple publie', 'Résultats supérieurs', {
            ticker: 'AAPL', name: 'Apple', assetType: 'Stock', quantity: 2,
            avgPrice: 100, currentPrice: 125, invested: 200, currentValue: 250,
            weight: 12.5, gainEUR: 50, gainPct: 25, dayChange: 5, dayPct: 2,
            portfolioTotalValue: 2000, cashReserve: 300, portfolioStatus: 'valid',
            pricesTimestamp: '2026-10-04T12:00:00Z', sourceStale: false,
            purchases: [{ broker: 'Trade Republic' }]
        });

        expect(prompt).toContain('Montant investi restant: 200.00 €');
        expect(prompt).toContain('Poids dans le portefeuille, cash inclus: 12.50%');
        expect(prompt).toContain('Variation du jour: 5.00 € (2.00%)');
        expect(prompt).toContain('Cash: 300.00 €');
        expect(prompt).toContain('Courtiers: Trade Republic');
        expect(prompt).toContain('Prix potentiellement périmés: non');
    });

    it('states explicitly when no matching position exists and sanitizes data fields', () => {
        const withoutHolding = buildGeminiNewsContextPrompt('Actualité macro', 'Résumé', null);
        const injected = buildGeminiNewsContextPrompt('Titre', 'Résumé', {
            ticker: 'AAPL', name: '<script>instruction</script>Apple', quantity: 1, purchases: []
        });

        expect(withoutHolding).toContain('Aucune position actuellement détenue');
        expect(injected).not.toContain('<script>');
        expect(injected).toContain('instruction Apple');
        expect(injected).toContain('indisponible');
    });
});
