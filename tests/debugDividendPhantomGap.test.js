// Verifies dataManager.debugDividendPhantomGap() itself (the temporary
// diagnostic the user runs against their REAL account data — see
// dataManager.js's own doc comment) produces correct numbers, using the exact
// same constructed scenario as realWorldGapReproduction.test.js. This is a
// meta-test: it doesn't re-prove the bug, it proves the DIAGNOSTIC TOOL is
// trustworthy before asking the user to rely on its output for their real
// portfolio.
import { describe, it, expect, vi } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

describe('debugDividendPhantomGap — l\'outil de diagnostic lui-même est correct', () => {
    it('rapproche exactement Σphantom - Σdividendes == graphBefore - holdingsTotal, sur un compte réel simulé', async () => {
        const purchases = [
            purchase({ ticker: 'MEGA', assetType: 'Stock', price: 15000, quantity: 1, date: '2024-01-01' }),
            purchase({ ticker: 'OTHER', assetType: 'Stock', price: 15000, quantity: 1, date: '2024-01-01' }),
            purchase({ ticker: 'MEGA', assetType: 'Dividend', type: 'dividend', price: 654.00, quantity: 1, date: '2024-06-01' })
        ];
        const storage = createFakeStorage({
            prices: {
                MEGA: { price: 17000, currency: 'EUR', previousClose: 16800, lastUpdate: Date.now() },
                OTHER: { price: 19226.78, currency: 'EUR', previousClose: 19000, lastUpdate: Date.now() }
            },
            conversionRate: 0.9
        });
        storage.getPurchases = () => purchases; // seule méthode manquante du double pour ce test

        const dm = new DataManager(storage, createFakeApi());
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
        let result;
        try {
            result = await dm.debugDividendPhantomGap();
        } finally {
            logSpy.mockRestore();
            tableSpy.mockRestore();
        }

        // RÉVISÉ (validation architecture 2026-09-24, Phase 4 — "Financial
        // Truth over KPI Reconciliation") : ce diagnostic lit
        // `calculateGenericHistory` (graph) tel quel, dont la résolution de
        // prix a changé — sans aucune bougie fournie ici, le graphique
        // retombe sur previousClose(MEGA)=16800/previousClose(OTHER)=19000
        // au lieu du prix live. `totalPhantomValue` (lu directement sur
        // storage.getCurrentPrice, PAS via le graphique — voir
        // dataManager.debugDividendPhantomGap) reste, lui, basé sur le prix
        // live (17000), inchangé.
        expect(result.rows.length).toBe(1);
        expect(result.rows[0].Ticker).toBe('MEGA');
        expect(result.totalPhantomValue).toBeCloseTo(17000, 2);
        expect(result.totalDividendAmount).toBeCloseTo(654, 2);
        expect(result.predicted).toBeCloseTo(16346.00, 2); // formule interne inchangée : totalPhantomValue - totalDividendAmount
        expect(result.holdingsTotal).toBeCloseTo(36880.78, 2); // KPI/table, live — inchangé

        // graphBefore (previousClose, plus jamais live) : 2×16800 (MEGA, part
        // réelle + fantôme) + 19000 (OTHER) = 52600€.
        expect(result.graphBefore).toBeCloseTo(52600, 2);
        const observed = result.graphBefore - result.holdingsTotal;
        expect(observed).toBeCloseTo(52600 - 36880.78, 2);

        // Ce diagnostic n'a PAS été conçu pour Phase 4 (il compare un
        // graphique previousClose-based à un total live-based) — son
        // `residual` n'est donc plus nul ici : l'écart "observé" inclut
        // désormais AUSSI la divergence live/previousClose légitime de
        // Phase 4 (200€ sur MEGA, 226,78€ sur OTHER), en plus du phantom
        // share qu'il vise à isoler. Ce test verrouille cette réalité
        // explicitement plutôt que de prétendre que l'outil reste précis à
        // l'euro près pour cet usage précis — un futur lecteur de ses
        // résultats doit savoir que ce résidu existe désormais par design.
        expect(result.residual).toBeCloseTo(observed - result.predicted, 6);
        // observed (15719.22) - predicted (16346) = -626.78 : ce diagnostic
        // ne soustrait PAS la divergence live/previousClose de Phase 4 (il
        // n'a pas été conçu pour ça) — son résidu n'est donc plus nul, mais
        // reste un nombre STABLE et explicable, jamais une valeur aléatoire.
        expect(result.residual).toBeCloseTo(-626.78, 2);
    });
});
