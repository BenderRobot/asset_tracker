// Tests 5 & 6 du rapport "Total Value change entre deux reloads" — complète
// immutableSnapshotRace.test.js (qui prouve qu'AUCUNE lecture concurrente ne
// peut fuiter DANS un seul calcul) en couvrant deux angles supplémentaires :
//   - un reload EST censé refléter un nouveau prix de marché (ce n'est pas un
//     bug en soi) — mais chaque calcul, pris séparément, doit rester
//     parfaitement cohérent en interne (graph == holdings), et l'écart entre
//     les deux calculs doit être EXACTEMENT le mouvement de prix, jamais un
//     artefact de calcul ;
//   - plusieurs tickers à la fois, certains avec un live différent de leur
//     bougie, doivent TOUS utiliser le même snapshot figé, pas seulement le
//     premier de la liste.
import { describe, it, expect } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

describe('TEST 5 — reload : deux calculs successifs restent chacun cohérents, l\'écart == mouvement réel', () => {
    it('un changement de prix entre deux calculs se répercute exactement, sans incohérence artificielle', async () => {
        const storage = createFakeStorage({
            prices: { AMAT: { price: 405.30, currency: 'EUR', previousClose: 398.60, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'AMAT', assetType: 'Stock', price: 290.77, quantity: 2, date: '2024-01-01' })];

        // "Premier chargement"
        const snapshotA = await dm.buildTodaySnapshot(assetPurchases, []);
        const totalA = snapshotA.summary.totalCurrentEUR;
        expect(totalA).toBeCloseTo(2 * 405.30, 6);
        // RÉVISÉ (validation architecture 2026-09-24, Phase 4) : le
        // graphique n'est plus censé égaler le Total Value live — sans
        // aucune bougie fournie ici, il retombe sur previousClose (398.60€,
        // figé), stable et cohérent AVEC LUI-MÊME d'un calcul à l'autre (voir
        // ci-dessous), mais plus avec le KPI live.
        const graphLastA = snapshotA.todayGraphData.values[snapshotA.todayGraphData.values.length - 1];
        expect(graphLastA).toBeCloseTo(2 * 398.60, 6);

        // "Reload" 18 minutes plus tard : le marché a réellement bougé (nouveau
        // prix live, nouveau lastUpdate) — un scénario légitime, pas une course.
        storage.setCurrentPrice('AMAT', { price: 411.95, currency: 'EUR', previousClose: 398.60, lastUpdate: Date.now() });
        const snapshotB = await dm.buildTodaySnapshot(assetPurchases, []);
        const totalB = snapshotB.summary.totalCurrentEUR;
        expect(totalB).toBeCloseTo(2 * 411.95, 6);
        const graphLastB = snapshotB.todayGraphData.values[snapshotB.todayGraphData.values.length - 1];
        // previousClose n'a pas changé entre les deux "reloads" (seul le
        // prix live a bougé) : le graphique reste donc IDENTIQUE d'un calcul
        // à l'autre, exactement comme on l'attend d'une observation
        // historique qui n'a pas changé.
        expect(graphLastB).toBeCloseTo(graphLastA, 6);

        // L'écart entre les deux calculs LIVE (KPI) est EXACTEMENT le
        // mouvement de prix (2 actions × 6,65€), ni plus ni moins — aucun
        // résidu de course.
        expect(totalB - totalA).toBeCloseTo(2 * (411.95 - 405.30), 6);
    });
});

describe('TEST 6 — plusieurs tickers : tous utilisent le même snapshot figé, pas seulement le premier', () => {
    it('deux tickers avec un live différent de leur bougie restent chacun cohérents graph/holdings', async () => {
        let callsAMAT = 0, callsTSLA = 0;
        const storage = createFakeStorage({
            prices: {
                // Chacun "bouge" à chaque lecture — simule deux flux concurrents
                // indépendants réécrivant chacun leur ticker pendant le calcul.
                AMAT: () => { callsAMAT++; return { price: 400 + callsAMAT, currency: 'EUR', previousClose: 395, lastUpdate: Date.now() }; },
                TSLA: () => { callsTSLA++; return { price: 320 + callsTSLA, currency: 'EUR', previousClose: 315, lastUpdate: Date.now() }; }
            },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [
            purchase({ ticker: 'AMAT', assetType: 'Stock', price: 290.77, quantity: 2, date: '2024-01-01' }),
            purchase({ ticker: 'TSLA', assetType: 'Stock', price: 255.18, quantity: 4, date: '2024-01-01' })
        ];

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        const amatResolved = snapshot.todayGraphData.resolvedPrices.get('AMAT').price;
        const tslaResolved = snapshot.todayGraphData.resolvedPrices.get('TSLA').price;

        // Chaque ticker garde SA PROPRE première valeur captée (401 et 321),
        // pas mélangée avec l'autre ni avec un appel ultérieur.
        expect(amatResolved).toBeCloseTo(401, 6);
        expect(tslaResolved).toBeCloseTo(321, 6);

        const graphLast = snapshot.todayGraphData.values[snapshot.todayGraphData.values.length - 1];
        const holdingsTotal = snapshot.summary.totalCurrentEUR;
        const expectedTotal = 2 * amatResolved + 4 * tslaResolved;

        expect(holdingsTotal).toBeCloseTo(expectedTotal, 6);

        // RÉVISÉ (validation architecture 2026-09-24, Phase 4) : le
        // graphique n'utilise plus resolvedPrices (live) du tout — sans
        // aucune bougie, il retombe sur previousClose pour CHAQUE ticker
        // (395 et 315, tous deux figés, jamais le compteur qui "bouge").
        const expectedGraphFromPreviousClose = 2 * 395 + 4 * 315;
        expect(graphLast).toBeCloseTo(expectedGraphFromPreviousClose, 6);
        expect(graphLast).not.toBeCloseTo(holdingsTotal, 6);

        // Chaque ticker par ligne du tableau (holdings) utilise aussi EXACTEMENT
        // son prix résolu — pas celui de l'autre ticker, pas un prix "moyenné".
        const amatHolding = snapshot.holdings.find(h => h.ticker === 'AMAT');
        const tslaHolding = snapshot.holdings.find(h => h.ticker === 'TSLA');
        expect(amatHolding.currentValue).toBeCloseTo(2 * amatResolved, 6);
        expect(tslaHolding.currentValue).toBeCloseTo(4 * tslaResolved, 6);
    });
});
