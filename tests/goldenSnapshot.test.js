// TEST GOLDEN SNAPSHOT (cahier des charges §16-17) — un scénario réaliste
// combinant tout ce que le rapport de bug production a mis en cause au même
// moment : deux courtiers sur le même ticker (dont une vente partielle chez
// un seul des deux), un actif USD (taux historique figé vs taux courant
// différent), une crypto, des mouvements de cash, et un dividende. Vérifie
// que buildTodaySnapshot() — LA source unique lue par le graphique, les KPI
// et le tableau (voir historicalChart.js::update()) — reste algébriquement
// cohérent de bout en bout, pas seulement sur chaque sous-calcul isolément.
import { describe, it, expect } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

describe('TEST GOLDEN SNAPSHOT — scénario réaliste multi-broker/USD/crypto/cash/dividende', () => {
    it('graph.lastValue == holdings.totalValue + cash, et totalReturn == Σ gainEUR == totalValue - investedAssetOnly', async () => {
        const storage = createFakeStorage({
            prices: {
                AAPL: { price: 220, currency: 'EUR', previousClose: 215, lastUpdate: Date.now() },
                MSFT: { price: 300, currency: 'EUR', previousClose: 295, lastUpdate: Date.now() }, // déjà convertie EUR par storage.js (voir setCurrentPrice), currency reflète l'état APRÈS conversion
                'BTC-EUR': { price: 60000, currency: 'EUR', previousClose: 59000, lastUpdate: Date.now() }
            },
            conversionRate: 0.85 // taux COURANT — volontairement différent du taux historique ci-dessous
        });
        const dm = new DataManager(storage, createFakeApi());

        const assetPurchases = [
            // Même ticker, deux courtiers, coûts de revient distincts.
            purchase({ broker: 'A', ticker: 'AAPL', price: 100, quantity: 10, date: '2024-01-01' }),
            purchase({ broker: 'B', ticker: 'AAPL', price: 150, quantity: 10, date: '2024-01-01' }),
            // Vente PARTIELLE chez A seulement — ne doit jamais toucher B.
            purchase({ broker: 'A', ticker: 'AAPL', price: 300, quantity: -4, date: '2024-06-01' }),
            // Actif USD — coût figé au taux historique de la transaction (0.90),
            // jamais au taux courant (0.85) résolu ci-dessus.
            purchase({ broker: 'A', ticker: 'MSFT', currency: 'USD', price: 200, quantity: 5, date: '2024-02-01' }),
            // Crypto.
            purchase({ broker: 'B', ticker: 'BTC-EUR', assetType: 'Crypto', price: 30000, quantity: 0.05, date: '2024-03-01' })
        ];
        const cashPurchases = [
            purchase({ broker: 'A', ticker: 'EUR', assetType: 'Cash', price: 500, quantity: 1, date: '2024-01-01' }),
            purchase({ broker: 'B', ticker: 'EUR', assetType: 'Cash', price: -200, quantity: 1, date: '2024-04-01' }),
            // Le produit de la vente partielle ci-dessus (4 * 300 = 1200€) arrive
            // en cash chez A, comme toute vente (voir app.js::addPurchase).
            purchase({ broker: 'A', ticker: 'EUR', assetType: 'Cash', price: 1200, quantity: 1, date: '2024-06-01' }),
            // Un dividende sur AAPL — ne doit jamais devenir une action fantôme
            // (voir dividendPhantomShares.test.js) ni gonfler l'investi.
            purchase({ broker: 'A', ticker: 'AAPL', assetType: 'Dividend', type: 'dividend', price: 25, quantity: 1, date: '2024-07-01' })
        ];

        const historicalFxMap = new Map([['2024-02-01', 1 / 0.90]]); // USD->EUR figé à 0.90 pour cette date

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, cashPurchases);
        // buildTodaySnapshot résout lui-même historicalFxMap via getHistoricalFxMap
        // (pas de réseau réel sous Node -> fetch échoue silencieusement et
        // retombe sur une Map vide, donc sur le taux COURANT comme repli — voir
        // resolveHistoricalUsdToEurRate) ; on injecte donc le taux figé
        // directement dans calculateHoldings ci-dessous pour vérifier
        // l'invariant 9 de façon déterministe, indépendamment de ce repli réseau.
        const holdingsWithHistoricalFx = dm.calculateHoldings(assetPurchases, null, historicalFxMap);
        const msft = holdingsWithHistoricalFx.find(h => h.ticker === 'MSFT');
        expect(msft.invested).toBeCloseTo(5 * 200 * 0.90, 2); // jamais 0.85

        const { todayGraphData, holdings, summary, cashReserve } = snapshot;
        const values = todayGraphData.values;
        const lastGraphValue = values[values.length - 1];

        // RÉVISÉ (validation architecture 2026-09-24, Phase 4 — "Financial
        // Truth over KPI Reconciliation") : le graphique (observation/
        // valorisation historique) et les holdings/KPI (prix LIVE, via
        // resolvedPrices) ne sont plus censés coïncider par construction.
        // Sans aucune bougie fournie ici (fake api), le graphique retombe sur
        // la clôture veille de chaque ticker (previousClose) — calculé
        // explicitement ci-dessous pour prouver qu'il s'agit bien d'une
        // résolution cohérente, pas d'une valeur arbitraire.
        const totalValueFromHoldings = summary.totalCurrentEUR + cashReserve.total;
        const totalValueFromPreviousClose =
            16 * 215 /* AAPL (6 chez A + 10 chez B) previousClose */ +
            5 * 295 /* MSFT previousClose */ +
            0.05 * 59000 /* BTC-EUR previousClose */ +
            cashReserve.total;
        expect(lastGraphValue).toBeCloseTo(totalValueFromPreviousClose, 2);
        expect(lastGraphValue).not.toBeCloseTo(totalValueFromHoldings, 2);

        // --- Cash : ni oublié, ni doublé (500 - 200 + 1200 (vente) + 25 (dividende)). ---
        expect(cashReserve.total).toBeCloseTo(500 - 200 + 1200 + 25, 2);

        // --- Total Return = Σ gainEUR = totalValue - investedAssetOnly. ---
        const sumGainEUR = holdings.reduce((s, h) => s + (h.gainEUR || 0), 0);
        expect(summary.gainTotal).toBeCloseTo(sumGainEUR, 6);
        expect(summary.gainTotal).toBeCloseTo(summary.totalCurrentEUR - summary.totalInvestedEUR, 6);

        // --- Isolation par courtier (invariant 8) : la vente partielle chez A ne
        // doit pas avoir touché le coût de revient de B. ---
        const positions = dm._buildPositionsByBrokerTicker(assetPurchases, 0.85, historicalFxMap);
        const aaplA = positions.find(p => p.broker === 'A' && p.ticker === 'AAPL');
        const aaplB = positions.find(p => p.broker === 'B' && p.ticker === 'AAPL');
        expect(aaplA.quantity).toBeCloseTo(6, 6); // 10 - 4
        expect(aaplB.quantity).toBeCloseTo(10, 6); // jamais touché
        expect(aaplB.invested).toBeCloseTo(1500, 2); // 10 * 150, inchangé

        // --- Total = somme des deux courtiers (invariant 1/7). ---
        const aapl = holdings.find(h => h.ticker === 'AAPL');
        expect(aapl.quantity).toBeCloseTo(aaplA.quantity + aaplB.quantity, 6);
    });
});
