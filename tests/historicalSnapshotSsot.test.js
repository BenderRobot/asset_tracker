// HistoricalPortfolioSnapshot — invariants obligatoires (audit architecture
// SSOT, bug des 297,18€ : le tooltip 1W/1M combinait une valeur HISTORIQUE
// (graphData.values[idx]) avec du cash/invested COURANTS (kpiData.cash) pour
// fabriquer un "Total Return" hybride qui n'appartenait à aucun instant réel.
//
// Root cause tracée (voir rapport) : graphData.values[idx] EST déjà
// auto-cohérent par construction (HistoryCalculator._buildSeries résout
// prix/quantités POUR CE point) — mais rien n'exposait le cash ET le
// totalReturn DE CE MÊME point : la vue devait forcément aller chercher
// `kpiData.cash` (l'état COURANT) pour combler le trou, mélangeant deux
// instants différents.
//
// Fix (partie encore valide, TEST A/B/C ci-dessous) : HistoryCalculator
// expose cash[]/totalReturn[]/totalReturnPct[] par point (même formule que
// le snapshot live, calculée une fois — voir _buildSeries).
//
// RÉVISION (validation architecture 2026-09-24, Phase 4 — "Financial Truth
// over KPI Reconciliation") : le second volet du fix original,
// dataManager.alignLastPointToLiveSnapshot(), forçait le DERNIER point de
// N'IMPORTE QUELLE série affichée à être remplacé par le PortfolioSnapshot
// live. Cette méthode est supprimée — le graphique représente désormais
// uniquement la vérité des observations disponibles ; le KPI (portfolioKPIs)
// reste une valorisation live séparée, qui n'a jamais dépendu de graphData
// (voir historicalChart::_computeAggregateKPIs, qui lit portfolioSnapshot
// directement). Les deux peuvent légitimement différer — voir TEST D/E/F/12
// ci-dessous, réécrit pour verrouiller l'absence d'alignement forcé.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('TEST A/B/C — auto-cohérence de chaque point historique (totalReturn = (totalValue - cash) - investedAssetOnly, partout)', () => {
    it('tient pour CHAQUE point non-null d\'une série réelle multi-jours (1M)', async () => {
        const storage = createFakeStorage({
            prices: {
                AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() },
                'BTC-EUR': { price: 60000, currency: 'EUR', previousClose: 58000, lastUpdate: Date.now() }
            },
            conversionRate: 0.9
        });
        const candleTs = Date.now() - 86400000;
        const dm = new DataManager(storage, createFakeApi({
            async getHistoricalPricesWithRetry(ticker) {
                return { [candleTs]: ticker === 'AAPL' ? 200 : 60000 };
            }
        }));
        const assetPurchases = [
            purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' }),
            purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', price: 40000, quantity: 0.05, date: '2024-01-01' })
        ];
        const cashPurchases = [purchase({ ticker: 'EUR', assetType: 'Cash', price: 500, quantity: 1, date: '2024-01-01' })];

        const graphData = await dm.calculateHistory([...assetPurchases, ...cashPurchases], 30);

        expect(graphData.cash).toBeDefined();
        expect(graphData.totalReturn).toBeDefined();
        expect(graphData.totalReturnPct).toBeDefined();

        let checkedAtLeastOne = false;
        for (let i = 0; i < graphData.values.length; i++) {
            if (graphData.values[i] == null) continue;
            const expected = (graphData.values[i] - graphData.cash[i]) - graphData.investedAssetOnly[i];
            expect(graphData.totalReturn[i], `point ${i} incohérent`).toBeCloseTo(expected, 6);
            checkedAtLeastOne = true;
        }
        expect(checkedAtLeastOne).toBe(true);
    });
});

describe('TEST D/E/F/12 — le graphique ne force plus son dernier point à égaler le PortfolioSnapshot live (bug des 297,18€, RÉVISÉ)', () => {
    it("le dernier point du graphique reste la dernière bougie RÉELLE, même quand un prix live frais et très différent est disponible", async () => {
        const storage = createFakeStorage({
            // Prix live volontairement très différent de la bougie — c'est
            // exactement le cas que l'ancien alignLastPointToLiveSnapshot
            // aurait forcé sur le graphique.
            prices: { AAPL: { price: 999, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const candleTs = Date.now() - 2 * 3600000; // une vraie bougie, il y a 2h
        const fakeApi = createFakeApi({
            async getHistoricalPricesWithRetry() { return { [candleTs]: 200 }; }
        });
        const dm = new DataManager(storage, fakeApi);
        const assetPurchases = [purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' })];

        const graphData = await dm.calculateGenericHistory(assetPurchases, 1, false);
        const lastIdx = graphData.values.length - 1;

        // Le dernier point affiché reflète la bougie réelle (200×5=1000€),
        // JAMAIS le prix live (999×5=4995€) — même frais, même disponible.
        expect(graphData.values[lastIdx]).toBeCloseTo(1000, 2);
        expect(graphData.values[lastIdx]).not.toBeCloseTo(4995, 2);
    });

    it("le PortfolioSnapshot live (KPI/tableau) PEUT légitimement différer du dernier point du graphique — ce n'est plus un bug à corriger", async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 999, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const candleTs = Date.now() - 2 * 3600000;
        const fakeApi = createFakeApi({
            async getHistoricalPricesWithRetry() { return { [candleTs]: 200 }; }
        });
        const dm = new DataManager(storage, fakeApi);
        const assetPurchases = [purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' })];

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        const lastIdx = snapshot.todayGraphData.values.length - 1;

        // KPI/tableau (portfolioSnapshot, via resolvedPrices) : valorisation
        // LIVE — 999×5 = 4995€.
        expect(snapshot.portfolioSnapshot.totalValue).toBeCloseTo(4995, 2);
        // Graphique (todayGraphData.values) : dernière observation historique
        // — 200×5 = 1000€. Les deux nombres sont sciemment différents dans ce
        // scénario, et c'est le comportement CORRECT désormais.
        expect(snapshot.todayGraphData.values[lastIdx]).toBeCloseTo(1000, 2);
        expect(snapshot.todayGraphData.values[lastIdx]).not.toBeCloseTo(snapshot.portfolioSnapshot.totalValue, 2);
    });
});

describe('TEST G/H — un changement d\'état COURANT (cash, portefeuille) n\'altère jamais un historique déjà produit', () => {
    it("modifier le cash/portefeuille après coup ne mute pas un graphData déjà construit", async () => {
        const storage = createFakeStorage({ prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } }, conversionRate: 0.9 });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' })];

        const graphData = await dm.calculateHistory(assetPurchases, 7);
        const snapshotBefore = { values: [...graphData.values], totalReturn: [...graphData.totalReturn], cash: [...graphData.cash] };

        // "Modifier le portefeuille courant" : nouvel achat, nouveau prix, cash
        // ajouté. Ne doit RIEN changer à l'objet déjà retourné.
        storage.setCurrentPrice('AAPL', { price: 999, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() });
        assetPurchases.push(purchase({ ticker: 'AAPL', price: 999, quantity: 100, date: new Date().toISOString().slice(0, 10) }));

        expect(graphData.values).toEqual(snapshotBefore.values);
        expect(graphData.totalReturn).toEqual(snapshotBefore.totalReturn);
        expect(graphData.cash).toEqual(snapshotBefore.cash);
    });
});
