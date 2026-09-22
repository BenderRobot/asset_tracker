// Verifies dataManager.debugLastPointDivergence() (the temporary instrumented
// diagnostic for the "-42,16€ entre 22:00 et le dernier point" report) is
// itself correct, on a controlled scenario that reproduces the EXACT mechanism
// named in the user's Objectif 3: the last-point-only live-price override
// (HistoryCalculator._buildSeries, `days === 1 && i === last`) picks up a
// fresher live price than the 22:00 candle used, and nothing else changes.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, purchase } from './helpers.js';

describe('debugLastPointDivergence — le diagnostic instrumenté est correct', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('isole le ticker et le delta EUR exacts causés par le live-override du dernier point', async () => {
        // "Maintenant" fixé à 23:30 Paris (CEST, UTC+2) un lundi de juin — un
        // point QUI N'EST PAS une bougie réelle (voir _buildTimestampGrid, qui
        // injecte explicitement `now` pour days===1).
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-06-17T21:30:00Z'));

        const candleNoon = Date.UTC(2024, 5, 17, 10, 0, 0);   // 12:00 Paris — 50 000€
        const candle2200Paris = Date.UTC(2024, 5, 17, 20, 0, 0); // 22:00 Paris — 50 500€ (notre point de référence)

        const storage = createFakeStorage({
            prices: {
                'BTC-EUR': { price: 51200, currency: 'EUR', previousClose: 49000, lastUpdate: Date.now() } // live FRAIS, différent des bougies
            },
            conversionRate: 0.9
        });
        storage.getPurchases = () => [
            purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', price: 40000, quantity: 0.1, date: '2024-01-01', currency: 'EUR' })
        ];

        const fakeApi = {
            async getHistoricalPricesWithRetry() {
                return { [candleNoon]: 50000, [candle2200Paris]: 50500 };
            },
            async fetchCryptoKlinesFromBinance() { return {}; },
            async fetchBatchPrices() { return {}; }
        };

        const dm = new DataManager(storage, fakeApi);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
        let result;
        try {
            result = await dm.debugLastPointDivergence(22, 0);
        } finally {
            logSpy.mockRestore(); warnSpy.mockRestore(); tableSpy.mockRestore();
        }

        expect(result).not.toBeNull();
        const btc = result.rows.find(r => r.ticker === 'BTC-EUR');
        expect(btc).toBeTruthy();

        // Le point "22:00" doit avoir résolu la bougie réelle (50 500€, source
        // 'candle'), jamais le live.
        expect(btc.sourceAt2200).toBe('candle');
        expect(btc.priceAt2200).toBeCloseTo(50500, 6);

        // Le DERNIER point doit avoir déclenché le live-override (51 200€, frais
        // <10min) — jamais une bougie ou un simple carry-forward.
        expect(btc.sourceAtLast).toBe('liveOverride');
        expect(btc.priceAtLast).toBeCloseTo(51200, 6);

        // Delta exact = 0.1 BTC * (51200 - 50500) = 70,00€.
        expect(btc.deltaEUR).toBeCloseTo(70, 2);

        // Le delta global du graphique doit être ENTIÈREMENT expliqué par ce
        // seul ticker — résidu nul, pas une histoire de cash ou d'un autre actif.
        expect(result.reportedDelta).toBeCloseTo(70, 2);
        expect(result.residual).toBeCloseTo(0, 2);

        // Aucun mouvement de cash entre les deux points dans ce scénario — le
        // diagnostic doit le confirmer explicitement (pas de faux positif).
        expect(result.cashChanged).toBe(false);
    });
});
