// BUG FOUND (rapport utilisateur : Total Value/Var Today changeant entre deux
// reloads, ex. 11 921,90€ → 11 967,60€, sans que le graphique/le tableau ne se
// contredisent chacun pris isolément). Cause racine : storage.getCurrentPrice()
// était relu EN DIRECT, ticker par ticker, à PLUSIEURS endroits distincts du
// pipeline (_seedLastKnownPrices, _resolveMidnightValuationSeed,
// _valueTodaysHoldingsAtYesterdaysQuantities, le liveOverride du dernier point
// et la capture de resolvedPrices dans _buildSeries) — un pipeline qui prend un
// temps réel non négligeable (fetch historique, résolution de la clôture
// veille). Pendant cette fenêtre, dashboardApp.js lance en parallèle, SANS
// attendre, sa propre loadPortfolioData() qui appelle aussi
// api.fetchBatchPrices() et réécrit storage.currentData pour les mêmes tickers
// — deux flux réseau non coordonnés en course pour la même donnée. Le fix
// capture `livePriceSnapshot` UNE SEULE FOIS, tout en haut de
// calculateGenericHistory, avant le moindre await, et le réutilise partout —
// exactement le même principe déjà appliqué à `dynamicRate`.
//
// Ce test simule la course directement : storage.getCurrentPrice() renvoie un
// prix DIFFÉRENT à chaque appel (comme le ferait un flux concurrent qui
// réécrit le cache pendant que ce calcul est en cours). Avant le fix, chaque
// site de lecture aurait capté une valeur différente ; après le fix, une seule
// valeur (celle capturée en tout premier) doit être utilisée partout.
import { describe, it, expect } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

describe('Snapshot immuable — un flux concurrent qui réécrit storage pendant le calcul ne doit jamais être vu', () => {
    it('resolvedPrices, Total Value et holdings restent tous alignés sur le TOUT PREMIER prix lu', async () => {
        let callCount = 0;
        const storage = createFakeStorage({
            prices: {
                // Simule un autre flux (dashboardApp.loadPortfolioData) qui
                // réécrit storage.currentData à chaque tick pendant que CE calcul
                // est en cours — le prix "vu" dépend de QUAND on regarde.
                AMAT: () => { callCount++; return { price: 400 + callCount, currency: 'EUR', previousClose: 395, lastUpdate: Date.now() }; }
            },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'AMAT', assetType: 'Stock', price: 300, quantity: 2, date: '2024-01-01' })];

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        const resolvedPrice = snapshot.todayGraphData.resolvedPrices.get('AMAT').price;
        const values = snapshot.todayGraphData.values;
        const graphLastValue = values[values.length - 1];
        const holdingsValue = snapshot.holdings[0].currentValue;

        // Storage EST bien interrogé plusieurs fois en interne (currency lookups
        // notamment) — sinon ce test ne prouverait rien.
        expect(callCount).toBeGreaterThan(1);

        // Mais la VALEUR utilisée pour la valorisation reste celle du tout
        // premier appel (401), jamais une valeur ultérieure du compteur.
        expect(resolvedPrice).toBeCloseTo(401, 6);
        expect(graphLastValue).toBeCloseTo(2 * 401, 6);
        expect(holdingsValue).toBeCloseTo(2 * 401, 6);

        // Et surtout : graphique et holdings restent identiques ENTRE EUX (pas
        // seulement chacun "plausible" isolément) — c'est ça, l'invariant qui
        // se serait brisé sans le fix.
        expect(graphLastValue).toBeCloseTo(holdingsValue, 6);
    });
});
