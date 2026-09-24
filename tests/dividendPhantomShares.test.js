// BUG FOUND (root cause of the production report: chart's "Fin"/tooltip/Total
// Value showing 53 226,78€ while the KPI cards/table showed 36 880,78€ for the
// SAME instant — a ~16 346€ gap on a real portfolio with years of dividends).
//
// A confirmed dividend is stored as a purchase-shaped row carrying the
// UNDERLYING STOCK'S OWN TICKER (see achatsPage.js::handleConfirmDividends/
// handleManualDividend): { ticker: 'AAPL', assetType: 'Dividend',
// type: 'dividend', price: <net amount>, quantity: 1 }. dataManager.js
// classifies this as CASH everywhere (calculateCashReserve's isCashOrDiv check)
// — it must never be treated as a real purchase of the ticker. But
// HistoryCalculator._buildLedger's `isCash` test only recognized
// `assetType === 'cash'` (or ticker CASH/EUR), NOT `dividend` — so every
// dividend fell into the "real buy" branch and became a PHANTOM +1 SHARE of
// the underlying ticker, bought at a cost equal to the dividend amount, then
// valorized at that ticker's CURRENT price for every point of the graph
// (HistoryCalculator._buildSeries's `quantities` map). Each dividend ever
// received leaves a permanent, ever-accumulating phantom share behind (never
// "sold"), inflating exactly the graph engine's own totalValue — never
// calculateHoldings's (which already excludes dividend rows) — hence a
// growing, silent divergence between the chart and the KPI cards/table that
// gets worse the longer the portfolio has been receiving dividends.
import { describe, it, expect } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

describe('TEST — un dividende ne doit jamais créer une action fantôme dans le graphique', () => {
    it('graphique et holdings restent réconciliés (Total Value = graph.lastValue) en présence de dividendes', async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 195, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());

        const assetPurchases = [
            purchase({ ticker: 'AAPL', assetType: 'Stock', price: 150, quantity: 10, date: '2024-01-01' })
        ];
        // Un dividende historique reçu sur CE MÊME ticker — la forme exacte
        // produite par achatsPage.js::handleConfirmDividends.
        const cashPurchases = [
            purchase({
                ticker: 'AAPL', name: 'Apple', assetType: 'Dividend', type: 'dividend',
                price: 50, amount: 50, quantity: 1, currency: 'EUR', date: '2024-06-01'
            })
        ];

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, cashPurchases);
        const values = snapshot.todayGraphData.values;
        const lastGraphValue = values[values.length - 1];

        // RÉVISÉ (validation architecture 2026-09-24, Phase 4) : le graphique
        // et le Total Value (KPI/holdings, prix LIVE) ne sont plus censés
        // coïncider par construction — voir financialSnapshot.test.js. Ce
        // test vérifie désormais l'absence de action fantôme DIRECTEMENT sur
        // la série du graphique elle-même (aucune bougie fournie par le fake
        // api ici -> le graphique retombe sur previousClose=195€, jamais le
        // prix live 200€) : la valeur hors-cash doit correspondre à
        // EXACTEMENT 10 actions AAPL à 195€, jamais 11.
        const cash = snapshot.cashReserve.total;
        expect(cash).toBeCloseTo(50, 6); // le dividende reste un mouvement de cash
        expect(lastGraphValue - cash).toBeCloseTo(10 * 195, 6);

        // Et le coût de revient (Total Return) du graphique ne doit pas non plus
        // inclure le montant du dividende comme un faux "investi" sur AAPL.
        const investedAssetOnly = snapshot.summary.totalInvestedEUR;
        expect(investedAssetOnly).toBeCloseTo(10 * 150, 6);
    });

    it('plusieurs dividendes successifs sur le même ticker n\'accumulent aucune quantité fantôme', async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 195, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());

        const assetPurchases = [
            purchase({ ticker: 'AAPL', assetType: 'Stock', price: 150, quantity: 10, date: '2024-01-01' })
        ];
        // Quatre dividendes trimestriels reçus sur plusieurs années — avant le
        // fix, chacun ajoutait une action fantôme supplémentaire (4 actions en
        // trop, soit 800€ d'écart avec ce seul portefeuille).
        const cashPurchases = ['2024-03-01', '2024-06-01', '2024-09-01', '2024-12-01'].map(date =>
            purchase({ ticker: 'AAPL', assetType: 'Dividend', type: 'dividend', price: 20, quantity: 1, currency: 'EUR', date })
        );

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, cashPurchases);
        const values = snapshot.todayGraphData.values;
        const lastGraphValue = values[values.length - 1];
        const cash = snapshot.cashReserve.total;

        expect(cash).toBeCloseTo(80, 6);
        expect(lastGraphValue - cash).toBeCloseTo(10 * 195, 6); // toujours 10 actions, jamais 14 (previousClose, faute de bougie — voir Phase 4)
    });
});
