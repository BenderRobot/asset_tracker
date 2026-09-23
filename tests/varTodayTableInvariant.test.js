// @vitest-environment jsdom
//
// AUDIT (cohérence KPI "Var Today" / colonne "DAY P&L" du tableau) :
//
// Le rapport initial constatait KPI="121,41€" vs Σ table="362,08€". Un
// premier correctif avait ajouté, dans historicalChart::_computeAggregateKPIs,
// un repli `targetSummary.totalDayChangeEUR` — mais UNIQUEMENT quand aucune
// donnée de graphique (todayGraphData/dailyTwr) n'était disponible. Dans le
// mode réellement utilisé au quotidien (portefeuille global, 1D), todayGraphData
// EST toujours disponible, donc le chemin réellement emprunté restait le ratio
// `dailyTwr` appliqué au total du portefeuille (`totalValue - totalValue/dTwr`)
// — une définition mathématiquement différente de Σ asset.dayChange, qui peut
// diverger dès qu'un achat/vente a lieu dans la journée (le scénario même du
// rapport). Le "fix déjà appliqué" ne protégeait donc RIEN dans le cas normal.
//
// Ces tests verrouillent l'invariant requis : Var Today (KPI ET tooltip au
// point "maintenant") = targetSummary.totalDayChangeEUR, TOUJOURS — jamais un
// second calcul indépendant (TWR ou autre) qui pourrait numériquement diverger.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HistoricalChart } from '../src/historicalChart.js';
import { DataManager } from '../src/dataManager.js';
import { portfolioKPIs } from '../src/portfolioKPIs.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

class FakeChartJs {
    constructor(ctx, config) { this.ctx = ctx; this.config = config; }
    destroy() {}
}

describe('Invariant — KPI Var Today = Σ DAY P&L du tableau (jamais un ratio TWR indépendant)', () => {
    beforeEach(() => { portfolioKPIs.reset(); });
    afterEach(() => { delete global.Chart; });

    it("_computeAggregateKPIs retourne EXACTEMENT totalDayChangeEUR même quand un ratio dailyTwr très différent est présent", () => {
        const storage = createFakeStorage({});
        const dataManager = new DataManager(storage, createFakeApi());
        const investmentsPage = { filterManager: { getSelectedTickers: () => new Set() }, getChartTitleConfig: () => ({ mode: 'global' }), getFilteredPurchasesFromPage: () => [], renderData: () => {} };
        const chart = new HistoricalChart(storage, dataManager, null, investmentsPage);

        // Reproduit le rapport initial : totalValue ~2010,25€ — un ancien
        // dailyTwr aurait impliqué ~121,41€ de Var Today, alors que la vraie
        // somme des DAY P&L du tableau (summary.totalDayChangeEUR) est de
        // 362,08€. _computeAggregateKPIs ne lit PLUS AUCUNE donnée de
        // graphique (dTwr n'existe même plus dans son interface) — on
        // construit donc directement le PortfolioSnapshot canonique via le
        // même producteur que le moteur réel (dataManager.buildPortfolioSnapshot),
        // jamais une reconstruction manuelle d'un objet ad hoc.
        const targetSummary = { totalCurrentEUR: 1960.25, totalInvestedEUR: 1696.62, gainTotal: 263.63, totalDayChangeEUR: 362.08, dayChangePct: 18.47 };
        const targetCashReserve = { total: 50 };
        const portfolioSnapshot = dataManager.buildPortfolioSnapshot({
            holdings: [], summary: targetSummary, cashReserve: targetCashReserve, snapshotStartedAt: Date.now()
        });

        const kpiData = chart._computeAggregateKPIs({ portfolioSnapshot });

        expect(kpiData.varTodayAbs).toBeCloseTo(362.08, 2);
        expect(kpiData.varTodayPct).toBeCloseTo(18.47, 2);
        // Preuve que ce n'est PAS (même approximativement) l'ancien résultat TWR.
        expect(kpiData.varTodayAbs).not.toBeCloseTo(121.41, 1);
    });

    it('scénario bout-en-bout (portefeuille global, achat le jour même) : KPI Var Today == Σ table.dayChange', async () => {
        const today = new Date().toISOString().slice(0, 10);
        const storage = createFakeStorage({
            prices: {
                AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() },
                MSFT: { price: 300, currency: 'EUR', previousClose: 305, lastUpdate: Date.now() }
            },
            conversionRate: 0.9
        });
        const purchases = [
            purchase({ ticker: 'AAPL', name: 'Apple', assetType: 'Stock', price: 150, quantity: 5, date: '2024-01-01' }),
            // Achat AUJOURD'HUI (cash-flow intra-journée) — ne doit jamais se
            // transformer en gain/perte apparent dans Var Today.
            purchase({ ticker: 'AAPL', name: 'Apple', assetType: 'Stock', price: 200, quantity: 3, date: today }),
            purchase({ ticker: 'MSFT', name: 'Microsoft', assetType: 'Stock', price: 250, quantity: 2, date: '2024-01-01' }),
            purchase({ ticker: 'EUR', name: 'Cash', assetType: 'Cash', price: 500, quantity: 1, date: '2024-01-01' })
        ];
        storage.getPurchases = () => purchases;

        const investmentsPage = {
            filterManager: { getSelectedTickers: () => new Set() },
            getChartTitleConfig: () => ({ mode: 'global', label: 'Portfolio Global', icon: 'x' }),
            getFilteredPurchasesFromPage: () => purchases,
            renderData: () => {}
        };

        document.body.innerHTML = '<canvas id="historical-portfolio-chart"></canvas>';
        global.Chart = FakeChartJs;

        const dataManager = new DataManager(storage, createFakeApi());
        const chart = new HistoricalChart(storage, dataManager, null, investmentsPage);

        let capturedSummary = null;
        const originalRenderChart = chart.renderChart.bind(chart);
        chart.renderChart = (canvas, graphData, summary, ...rest) => {
            capturedSummary = summary;
            return originalRenderChart(canvas, graphData, summary, ...rest);
        };

        await chart.update(false, false);

        expect(capturedSummary).not.toBeNull();
        const kpiVarToday = portfolioKPIs.getKPIs().varToday;

        // L'INVARIANT : la KPI doit égaler EXACTEMENT la somme des DAY P&L des
        // lignes du tableau (targetSummary.totalDayChangeEUR), jamais une
        // approximation.
        expect(kpiVarToday).toBeCloseTo(capturedSummary.totalDayChangeEUR, 6);

        // Le cash-flow (achat du jour) ne doit jamais apparaître comme du P&L :
        // Σ dayChange ne doit dépendre que du mouvement de PRIX (AAPL 190->200,
        // MSFT 305->300 sur les quantités détenues HIER), jamais de la quantité
        // achetée aujourd'hui.
        const expectedDayChange = (200 - 190) * 5 /* AAPL détenu hier */ + (300 - 305) * 2 /* MSFT détenu hier */;
        expect(kpiVarToday).toBeCloseTo(expectedDayChange, 2);
    });

    it('le tooltip au point "maintenant" (lastIndex) réutilise kpiData.varTodayAbs, jamais un second calcul TWR', () => {
        const storage = createFakeStorage({});
        const dataManager = new DataManager(storage, createFakeApi());
        const investmentsPage = { filterManager: { getSelectedTickers: () => new Set() }, getChartTitleConfig: () => ({ mode: 'global' }), getFilteredPurchasesFromPage: () => [], renderData: () => {} };
        const chart = new HistoricalChart(storage, dataManager, null, investmentsPage);
        chart.currentPeriod = 1;

        // Le PortfolioSnapshot LIVE (dayPnl=362.08€) et une série "brute" dont le
        // dernier point représenterait, SANS alignement, un dailyTwr impliquant
        // ~121.41€ — reproduit exactement la forme du bug initial. On passe par
        // le VRAI pipeline (dataManager.alignLastPointToLiveSnapshot), jamais un
        // objet `kpiData` fabriqué à la main : _buildKpiRows ne connaît plus ce
        // concept, il ne lit QUE graphData.
        const portfolioSnapshot = dataManager.buildPortfolioSnapshot({
            holdings: [], summary: { totalCurrentEUR: 1960.25, totalInvestedEUR: 1696.62, gainTotal: 263.63, totalDayChangeEUR: 362.08, dayChangePct: 18.47 },
            cashReserve: { total: 50 }, snapshotStartedAt: Date.now()
        });
        const rawGraphData = {
            values: [2000, 2010.25],
            dailyTwr: [1.0, 2010.25 / (2010.25 - 121.41)],
            investedAssetOnly: [1696.62, 1696.62]
        };
        const graphData = dataManager.alignLastPointToLiveSnapshot(rawGraphData, portfolioSnapshot);
        const opts = {
            graphData, pctSeries: [0, 0.5], eurFmt: v => v, pctFmt: v => v,
            isIndexMode: false, isUnitView: false, isPerformanceMode: false,
            displayValues: graphData.values
        };

        const rows = chart._buildKpiRows(1, opts);
        const varTodayRow = rows.find(r => r.label === 'Var Today');

        expect(varTodayRow).toBeDefined();
        expect(varTodayRow.eur).toBeCloseTo(362.08, 2);
        expect(varTodayRow.eur).not.toBeCloseTo(121.41, 1);
    });

    it('point intermédiaire (hover sur un instant passé, pas "maintenant") : plus aucune ligne "Var Today" affichée (règle absolue TWR ≠ FinancialSnapshot)', () => {
        const storage = createFakeStorage({});
        const dataManager = new DataManager(storage, createFakeApi());
        const investmentsPage = { filterManager: { getSelectedTickers: () => new Set() }, getChartTitleConfig: () => ({ mode: 'global' }), getFilteredPurchasesFromPage: () => [], renderData: () => {} };
        const chart = new HistoricalChart(storage, dataManager, null, investmentsPage);
        chart.currentPeriod = 1;

        const portfolioSnapshot = dataManager.buildPortfolioSnapshot({
            holdings: [], summary: { totalCurrentEUR: 1960.25, totalInvestedEUR: 1696.62, gainTotal: 263.63, totalDayChangeEUR: 362.08, dayChangePct: 18.47 },
            cashReserve: { total: 50 }, snapshotStartedAt: Date.now()
        });
        const rawGraphData = {
            values: [2000, 2010.25],
            dailyTwr: [1.0, 2010.25 / (2010.25 - 121.41)],
            investedAssetOnly: [1696.62, 1696.62]
        };
        // alignLastPointToLiveSnapshot ne renseigne dayPnl QU'AU DERNIER index
        // (index 1 ici) — l'index 0 (point passé) reste donc `null` par
        // construction, jamais par un test explicite de l'index dans la vue.
        const graphData = dataManager.alignLastPointToLiveSnapshot(rawGraphData, portfolioSnapshot);
        const opts = {
            graphData, pctSeries: [0, 0.5], eurFmt: v => v, pctFmt: v => v,
            isIndexMode: false, isUnitView: false, isPerformanceMode: false,
            displayValues: graphData.values
        };

        const rows = chart._buildKpiRows(0, opts); // hover sur le PREMIER point, pas le dernier
        const varTodayRow = rows.find(r => r.label === 'Var Today');
        expect(varTodayRow).toBeUndefined();
    });

    it('Invariants D/E/F bout-en-bout : KPI, tableau et graphique lisent le MÊME PortfolioSnapshot (même snapshotId)', async () => {
        const today = new Date().toISOString().slice(0, 10);
        const storage = createFakeStorage({
            prices: {
                AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() },
                MSFT: { price: 300, currency: 'EUR', previousClose: 305, lastUpdate: Date.now() }
            },
            conversionRate: 0.9
        });
        const purchases = [
            purchase({ ticker: 'AAPL', name: 'Apple', assetType: 'Stock', price: 150, quantity: 5, date: '2024-01-01' }),
            purchase({ ticker: 'AAPL', name: 'Apple', assetType: 'Stock', price: 200, quantity: 3, date: today }),
            purchase({ ticker: 'MSFT', name: 'Microsoft', assetType: 'Stock', price: 250, quantity: 2, date: '2024-01-01' })
        ];
        storage.getPurchases = () => purchases;

        const investmentsPage = {
            filterManager: { getSelectedTickers: () => new Set() },
            getChartTitleConfig: () => ({ mode: 'global', label: 'Portfolio Global', icon: 'x' }),
            getFilteredPurchasesFromPage: () => purchases,
            renderData: () => {}
        };

        document.body.innerHTML = '<canvas id="historical-portfolio-chart"></canvas>';
        global.Chart = FakeChartJs;

        const dataManager = new DataManager(storage, createFakeApi());
        const chart = new HistoricalChart(storage, dataManager, null, investmentsPage);

        let capturedTableHoldings = null;
        investmentsPage.renderData = (holdings) => { capturedTableHoldings = holdings; };

        await chart.update(false, false);

        const kpis = portfolioKPIs.getKPIs();
        // Invariant H : un snapshotId non nul a bien été transmis jusqu'à portfolioKPIs.
        expect(kpis.snapshotId).toBeTruthy();

        // Invariant D : KPI Var Today == snapshot.dayPnl (== Σ table.dayChange, invariant E).
        const sumTableDayChange = capturedTableHoldings.reduce((s, h) => s + (h.dayChange || 0), 0);
        expect(kpis.varToday).toBeCloseTo(sumTableDayChange, 6);

        // Invariant F : la valeur de la KPI (donc celle que le tooltip du point
        // "maintenant" réutilise EXACTEMENT — voir le test précédent) est bien la
        // vraie variation de marché sur les quantités détenues HIER, jamais
        // gonflée par l'achat AAPL du jour même (voir Invariant G) :
        // (200-190)×5 (AAPL détenu hier) + (300-305)×2 (MSFT détenu hier) = 40€.
        expect(kpis.varToday).toBeCloseTo(40, 2);
    });

    it('Total Return au point "maintenant" du tooltip lit graphData.totalReturn (aligné sur le snapshot live), jamais une reconstruction locale (val - cash - investedAO)', () => {
        const storage = createFakeStorage({});
        const dataManager = new DataManager(storage, createFakeApi());
        const investmentsPage = { filterManager: { getSelectedTickers: () => new Set() }, getChartTitleConfig: () => ({ mode: 'global' }), getFilteredPurchasesFromPage: () => [], renderData: () => {} };
        const chart = new HistoricalChart(storage, dataManager, null, investmentsPage);
        chart.currentPeriod = 1;

        // totalReturn LIVE (500€) volontairement DIFFÉRENT de ce que (val - cash -
        // investedAO) donnerait sur la série brute (2010.25 - 50 - 1696.62 =
        // 263.63€) pour prouver que c'est bien le PortfolioSnapshot live —
        // via alignLastPointToLiveSnapshot — qui est lu, jamais une
        // reconstruction locale par soustraction dans la vue.
        const portfolioSnapshot = dataManager.buildPortfolioSnapshot({
            holdings: [], summary: { totalCurrentEUR: 2060.25, totalInvestedEUR: 1560.25, gainTotal: 500, totalDayChangeEUR: 40, dayChangePct: 2 },
            cashReserve: { total: 50 }, snapshotStartedAt: Date.now()
        });
        // Série "brute" telle que HistoryCalculator la produirait réellement
        // (cash/totalReturn/totalReturnPct sont TOUJOURS des tableaux, même
        // avant alignement — voir _buildSeries) : la valeur au dernier index
        // AVANT alignement (263.63) donnerait un résultat FAUX si jamais lue
        // directement, ce que ce test vérifie justement ne jamais arriver.
        const rawGraphData = {
            values: [2000, 2010.25],
            investedAssetOnly: [1696.62, 1696.62],
            cash: [50, 50],
            totalReturn: [250, 263.63],
            totalReturnPct: [14.7, 15.5]
        };
        const graphData = dataManager.alignLastPointToLiveSnapshot(rawGraphData, portfolioSnapshot);
        const opts = {
            graphData, pctSeries: [0, 0.5], eurFmt: v => v, pctFmt: v => v,
            isIndexMode: false, isUnitView: false, isPerformanceMode: false,
            displayValues: graphData.values
        };

        const rows = chart._buildKpiRows(1, opts);
        const totalReturnRow = rows.find(r => r.label === 'Total Return');

        expect(totalReturnRow.eur).toBe(500);
        expect(totalReturnRow.eur).not.toBeCloseTo(263.63, 2);
    });

    it("BUG des 297,18€ (audit) : le dernier point d'un graphique multi-jours (1W) ne peut plus diverger du PortfolioSnapshot live pour Total Value ET Total Return", async () => {
        const today = new Date().toISOString().slice(0, 10);
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const purchases = [purchase({ ticker: 'AAPL', name: 'Apple', assetType: 'Stock', price: 150, quantity: 10, date: '2024-01-01' })];
        storage.getPurchases = () => purchases;

        const investmentsPage = {
            filterManager: { getSelectedTickers: () => new Set() },
            getChartTitleConfig: () => ({ mode: 'global', label: 'Portfolio Global', icon: 'x' }),
            getFilteredPurchasesFromPage: () => purchases,
            renderData: () => {}
        };

        document.body.innerHTML = '<canvas id="historical-portfolio-chart"></canvas>';
        global.Chart = FakeChartJs;

        const dataManager = new DataManager(storage, createFakeApi());
        const chart = new HistoricalChart(storage, dataManager, null, investmentsPage);
        chart.currentPeriod = 7; // vue 1W — exactement le scénario du rapport

        // Le dernier point du graphique DOIT être exactement le snapshot live —
        // structurellement, via dataManager.alignLastPointToLiveSnapshot, pas
        // par coïncidence entre deux moteurs de résolution de prix séparés.
        let capturedGraphData = null;
        const originalRenderChart = chart.renderChart.bind(chart);
        chart.renderChart = (canvas, graphData, ...rest) => { capturedGraphData = graphData; return originalRenderChart(canvas, graphData, ...rest); };

        await chart.update(false, false);
        const liveKpis = portfolioKPIs.getKPIs();

        const lastIdx = capturedGraphData.values.length - 1;
        expect(capturedGraphData.values[lastIdx]).toBeCloseTo(liveKpis.totalValue, 6);
        expect(capturedGraphData.totalReturn[lastIdx]).toBeCloseTo(liveKpis.totalReturn, 6);
    });
});
