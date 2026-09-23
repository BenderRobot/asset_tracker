// Preuve de l'Option C : la capture de `livePriceSnapshot` doit se produire
// IMMÉDIATEMENT après fetchBatchPrices() (sans await entre les deux, voir
// historicalChart.js::update()), puis être transmise telle quelle jusqu'à
// HistoryCalculator — plutôt que capturée plus tard, à l'intérieur de
// buildTodaySnapshot()/calculateGenericHistory(), après l'await
// getHistoricalFxMap() (un vrai aller-retour réseau possible pour un
// portefeuille avec des actifs USD).
//
// Ce test rejoue exactement la séquence demandée :
//   fetchBatchPrices()
//       ↓
//   capture snapshot                    (AVANT tout await, comme dans update())
//       ↓
//   await simulé / retard FX            (getHistoricalFxMap, mocké avec un délai)
//       ↓
//   deuxième fetch concurrent modifie storage   (loadPortfolioData qui "gagne" la course)
//       ↓
//   HistoryCalculator                   (doit voir le prix CAPTURÉ, pas le prix muté)
//
// Avant l'Option C, `livePriceSnapshotOverride` n'existait pas : buildTodaySnapshot()
// laissait calculateGenericHistory() capturer son propre snapshot APRÈS l'await
// getHistoricalFxMap() — donc APRÈS la mutation concurrente simulée ci-dessous.
// Ce test échoue avec ce comportement (le calcul verrait 999€, le prix muté) et
// passe avec le nouveau (405,30€, le prix capturé avant la mutation).
import { describe, it, expect, vi } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

describe('Option C — ordre capture/retard FX/mutation concurrente', () => {
    it('le calcul utilise le prix capturé AVANT le retard FX, jamais celui écrit par un fetch concurrent pendant ce retard', async () => {
        const storage = createFakeStorage({
            prices: { AMAT: { price: 405.30, currency: 'EUR', previousClose: 398.60, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'AMAT', assetType: 'Stock', price: 290.77, quantity: 2, date: '2024-01-01' })];

        // Étape 1 : fetchBatchPrices() a déjà résolu (simulé par le prix déjà en
        // storage ci-dessus, exactement comme historicalChart.js::update() après
        // son propre `await this.api.fetchBatchPrices(tickers)`).

        // Étape 2 : capture du snapshot, SANS AUCUN AWAIT entre les deux lignes —
        // reproduit exactement historicalChart.js::update().
        const tickers = ['AMAT'];
        const livePriceSnapshot = new Map(tickers.map(t => [t, storage.getCurrentPrice(t)]));
        expect(livePriceSnapshot.get('AMAT').price).toBeCloseTo(405.30, 6);

        // Étape 3 : "retard FX" simulé — getHistoricalFxMap() est mocké avec un
        // délai, pour pouvoir injecter la mutation concurrente PENDANT cette
        // fenêtre précise (celle identifiée comme le résidu de course).
        const realGetHistoricalFxMap = dm.getHistoricalFxMap.bind(dm);
        const fxSpy = vi.spyOn(dm, 'getHistoricalFxMap').mockImplementation(async (purchases) => {
            await new Promise(resolve => setTimeout(resolve, 5));
            // Étape 4 : deuxième fetch CONCURRENT (ex: dashboardApp.loadPortfolioData,
            // qui appelle lui aussi fetchBatchPrices indépendamment) — écrit un
            // prix différent PENDANT que buildTodaySnapshot() est encore en cours.
            storage.setCurrentPrice('AMAT', { price: 999, currency: 'EUR', previousClose: 398.60, lastUpdate: Date.now() });
            return realGetHistoricalFxMap(purchases);
        });

        try {
            // Étape 5 : HistoryCalculator — buildTodaySnapshot reçoit le snapshot
            // capturé à l'étape 2, PAS un nouveau à capturer lui-même.
            const snapshot = await dm.buildTodaySnapshot(assetPurchases, [], livePriceSnapshot);

            const resolvedPrice = snapshot.todayGraphData.resolvedPrices.get('AMAT').price;
            const totalValue = snapshot.summary.totalCurrentEUR;

            // Le calcul doit refléter le prix CAPTURÉ (405,30€), jamais celui
            // écrit par le fetch concurrent pendant le retard FX (999€).
            expect(resolvedPrice).toBeCloseTo(405.30, 6);
            expect(totalValue).toBeCloseTo(2 * 405.30, 6);
            expect(resolvedPrice).not.toBeCloseTo(999, 0);

            // Preuve que la mutation concurrente a bien eu lieu (le test ne serait
            // pas probant sinon) — storage lui-même reflète désormais 999€.
            expect(storage.getCurrentPrice('AMAT').price).toBe(999);
        } finally {
            fxSpy.mockRestore();
        }
    });
});
