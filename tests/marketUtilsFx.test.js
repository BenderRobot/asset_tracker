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

    it('retombe sur la cotation la plus proche dans une fenêtre de ±7 jours (weekend/jour férié)', () => {
        const map = new Map([['2024-03-15', 1 / 0.91]]); // vendredi
        // Dimanche : pas de cotation FX ce jour précis -> doit retomber sur vendredi.
        const rate = resolveHistoricalUsdToEurRate('2024-03-17', map, 0.5);
        expect(rate).toBeCloseTo(0.91, 6);
    });

    it('replie explicitement sur le taux courant (et le LOG) si aucune cotation dans la fenêtre', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const map = new Map([['2024-01-01', 1 / 0.90]]); // bien en dehors de ±7j
        const rate = resolveHistoricalUsdToEurRate('2024-06-15', map, 0.777, { ticker: 'TSLA', broker: 'B' });

        expect(rate).toBe(0.777);
        expect(warnSpy).toHaveBeenCalled();
        expect(warnSpy.mock.calls[0][0]).toContain('TSLA');
        warnSpy.mockRestore();
    });

    it("replie sur le taux courant (log) si aucune map n'est fournie du tout", () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(resolveHistoricalUsdToEurRate('2024-03-15', null, 0.85)).toBe(0.85);
        expect(resolveHistoricalUsdToEurRate('2024-03-15', new Map(), 0.85)).toBe(0.85);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it("ne fabrique jamais un taux différent du taux de repli fourni", () => {
        // Le fallback doit être EXACTEMENT fallbackRate, jamais une valeur dérivée
        // silencieusement (ex: 1, ou une moyenne) — invariant 9 : pas de taux inventé.
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fallback = 0.913;
        expect(resolveHistoricalUsdToEurRate('1999-01-01', new Map([['2024-01-01', 1]]), fallback)).toBe(fallback);
        warnSpy.mockRestore();
    });
});
