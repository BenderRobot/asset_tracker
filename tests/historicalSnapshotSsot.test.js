// HistoricalPortfolioSnapshot — invariants obligatoires (audit architecture
// SSOT, bug des 297,18€ : le tooltip 1W/1M combinait une valeur HISTORIQUE
// (graphData.values[idx]) avec du cash/invested COURANTS (kpiData.cash) pour
// fabriquer un "Total Return" hybride qui n'appartenait à aucun instant réel.
//
// Root cause tracée (voir rapport) :
//   - graphData.values[idx] EST déjà auto-cohérent par construction
//     (HistoryCalculator._buildSeries résout prix/quantités POUR CE point) —
//     mais rien n'exposait le cash ET le totalReturn DE CE MÊME point : la
//     vue devait forcément aller chercher `kpiData.cash` (l'état COURANT)
//     pour combler le trou, mélangeant deux instants différents.
//   - Le dernier point d'un graphique multi-jours (1W/1M/...) est bâti par
//     une passe de résolution de prix ENTIÈREMENT SÉPARÉE de celle du
//     PortfolioSnapshot live (buildTodaySnapshot) — sans garantie qu'elles
//     retombent sur le même prix pour chaque ticker (HistoryCalculator
//     borne son `liveOverride` à `days === 1`, jamais appliqué au dernier
//     point d'une série 1W/1M).
//
// Fix : HistoryCalculator expose désormais cash[]/totalReturn[]/totalReturnPct[]
// par point (même formule que le snapshot live, calculée une fois — voir
// _buildSeries), ET dataManager.alignLastPointToLiveSnapshot() garantit que le
// DERNIER point de N'IMPORTE QUELLE série affichée est structurellement
// remplacé par le PortfolioSnapshot live — jamais laissé à la merci d'une
// résolution de prix indépendante.
import { describe, it, expect } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

describe('TEST A/B/C — auto-cohérence de chaque point historique (totalReturn = (totalValue - cash) - investedAssetOnly, partout)', () => {
    it('tient pour CHAQUE point non-null d\'une série réelle multi-jours (1M)', async () => {
        const storage = createFakeStorage({
            prices: {
                AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() },
                'BTC-EUR': { price: 60000, currency: 'EUR', previousClose: 58000, lastUpdate: Date.now() }
            },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
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

describe('TEST D/E/F/12 — régression EXACTE du bug rapporté (297,18€, LIVE vs HISTORICAL)', () => {
    it('reproduit les valeurs exactes du rapport : jamais un hybride entre un point historique et le snapshot live', async () => {
        const storage = createFakeStorage({});
        const dm = new DataManager(storage, createFakeApi());

        // LIVE (tel que rapporté) :
        const liveSnapshot = dm.buildPortfolioSnapshot({
            holdings: [],
            summary: { totalCurrentEUR: 36951.61, totalInvestedEUR: 28179.89, gainTotal: 8360.04, totalDayChangeEUR: 85.64, dayChangePct: 0.23 },
            cashReserve: { total: 50 }, // 37001.61 - 36951.61
            snapshotStartedAt: Date.now()
        });
        expect(liveSnapshot.totalValue).toBeCloseTo(37001.61, 2);
        expect(liveSnapshot.totalReturn).toBeCloseTo(8360.04, 2);

        // Série "brute" (telle que produite par HistoryCalculator pour la vue
        // 1W, AVANT alignement) : un point antérieur réellement historique
        // (36704.43/8062.86 — les valeurs vues dans le tooltip du rapport), et
        // un dernier point dont la résolution de prix indépendante donnerait,
        // sans le fix, un résultat différent du live (peu importe lequel —
        // c'est justement ce que l'alignement rend impossible à observer).
        const rawGraphData = {
            values: [36704.43, 36850.00],
            investedAssetOnly: [28179.89, 28179.89],
            cash: [50, 50],
            totalReturn: [8062.86, 8200.00],
            totalReturnPct: [28.61, 29.10]
        };

        const graphData = dm.alignLastPointToLiveSnapshot(rawGraphData, liveSnapshot);

        // Point HISTORIQUE (index 0, jamais "maintenant") : INCHANGÉ, tel quel.
        expect(graphData.values[0]).toBeCloseTo(36704.43, 2);
        expect(graphData.totalReturn[0]).toBeCloseTo(8062.86, 2);

        // Dernier point ("maintenant") : EXACTEMENT le snapshot live, jamais
        // un hybride (ni 36850/8200, ni un mélange genre 36951.61/8062.86).
        const lastIdx = graphData.values.length - 1;
        expect(graphData.values[lastIdx]).toBeCloseTo(37001.61, 2);
        expect(graphData.totalReturn[lastIdx]).toBeCloseTo(8360.04, 2);
        // La différence 297,18€ (37001.61-36704.43 et 8360.04-8062.86) ne peut
        // plus se produire ENTRE deux valeurs affichées comme représentant le
        // MÊME point — l'index 0 et l'index lastIdx sont maintenant deux
        // instants explicitement différents, jamais confondus.
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

    it('alignLastPointToLiveSnapshot ne mute jamais le graphData brut passé en entrée', () => {
        const storage = createFakeStorage({});
        const dm = new DataManager(storage, createFakeApi());
        const liveSnapshot = dm.buildPortfolioSnapshot({
            holdings: [], summary: { totalCurrentEUR: 1000, totalInvestedEUR: 800, gainTotal: 200, totalDayChangeEUR: 10, dayChangePct: 1 },
            cashReserve: { total: 0 }, snapshotStartedAt: Date.now()
        });
        const rawGraphData = { values: [900, 950], investedAssetOnly: [800, 800], cash: [0, 0], totalReturn: [100, 150], totalReturnPct: [12.5, 18.75] };
        const rawValuesRef = rawGraphData.values;

        const aligned = dm.alignLastPointToLiveSnapshot(rawGraphData, liveSnapshot);

        expect(aligned).not.toBe(rawGraphData); // nouvel objet
        expect(aligned.values).not.toBe(rawValuesRef); // nouveau tableau
        expect(rawGraphData.values[1]).toBe(950); // l'original reste intact
        expect(aligned.values[1]).toBeCloseTo(1000, 2); // l'aligné, lui, est bien remplacé
    });
});

describe('TEST I — deux snapshots consécutifs peuvent différer sans que le dernier soit automatiquement traité comme "live"', () => {
    it("alignLastPointToLiveSnapshot ne touche QUE son propre dernier index, jamais un autre", () => {
        const storage = createFakeStorage({});
        const dm = new DataManager(storage, createFakeApi());
        const liveSnapshot = dm.buildPortfolioSnapshot({
            holdings: [], summary: { totalCurrentEUR: 500, totalInvestedEUR: 400, gainTotal: 100, totalDayChangeEUR: 5, dayChangePct: 1 },
            cashReserve: { total: 0 }, snapshotStartedAt: Date.now()
        });
        const rawGraphData = {
            values: [100, 200, 300, 400],
            investedAssetOnly: [400, 400, 400, 400],
            cash: [0, 0, 0, 0],
            totalReturn: [-300, -200, -100, 0],
            totalReturnPct: [-75, -50, -25, 0]
        };

        const aligned = dm.alignLastPointToLiveSnapshot(rawGraphData, liveSnapshot);

        // Seul l'index 3 (dernier) change — les 3 précédents restent leurs
        // propres valeurs historiques, jamais "rapprochées" du live.
        expect(aligned.values.slice(0, 3)).toEqual([100, 200, 300]);
        expect(aligned.totalReturn.slice(0, 3)).toEqual([-300, -200, -100]);
        expect(aligned.values[3]).toBeCloseTo(500, 2);
        expect(aligned.totalReturn[3]).toBeCloseTo(100, 2);
    });
});
