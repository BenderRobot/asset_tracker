import { describe, it, expect, vi } from 'vitest';
import { resolveHistoricalUsdToEurRate } from '../src/MarketUtils.js';

// This is the SINGLE implementation shared by dataManager.js
// (_buildPositionsByBrokerTicker, calculateEnrichedPurchases) and
// HistoryCalculator.js (applyCostBasisEntry, _buildPurchasePoints) — tested here
// once, directly, rather than only indirectly through each of those call sites.
describe('resolveHistoricalUsdToEurRate', () => {
    it('utilise le taux exact du jour quand il existe (inverse de EUR->USD)', () => {
        const map = new Map([['2024-03-15', 1 / 0.92]]);
        const rate = resolveHistoricalUsdToEurRate('2024-03-15', map, 0.5, { ticker: 'AAPL', broker: 'A' });
        expect(rate).toBeCloseTo(0.92, 6);
    });

    it('retombe sur une cotation antérieure dans une fenêtre de 7 jours (weekend/jour férié)', () => {
        const map = new Map([['2024-03-15', 1 / 0.91]]); // vendredi
        // Dimanche : pas de cotation FX ce jour précis -> doit retomber sur vendredi.
        const rate = resolveHistoricalUsdToEurRate('2024-03-17', map, 0.5);
        expect(rate).toBeCloseTo(0.91, 6);
    });

    it('refuse la conversion si aucune cotation antérieure n existe dans la fenêtre', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const map = new Map([['2024-01-01', 1 / 0.90]]); // bien en dehors de ±7j
        const rate = resolveHistoricalUsdToEurRate('2024-06-15', map, 0.777, { ticker: 'TSLA', broker: 'B' });

        expect(rate).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
        expect(warnSpy.mock.calls[0][0]).toContain('TSLA');
        warnSpy.mockRestore();
    });

    it("refuse la conversion si aucune map n'est fournie", () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(resolveHistoricalUsdToEurRate('2024-03-15', null, 0.85)).toBeNull();
        expect(resolveHistoricalUsdToEurRate('2024-03-15', new Map(), 0.85)).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it("n'utilise jamais une cotation future ni le taux courant", () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const futureOnly = new Map([['2024-03-18', 1 / 0.91]]);
        expect(resolveHistoricalUsdToEurRate('2024-03-17', futureOnly, 0.913)).toBeNull();
        warnSpy.mockRestore();
    });
});
