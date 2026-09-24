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

    // RÉVISÉ (validation architecture 2026-09-24, Phase 4 — "Financial Truth
    // over KPI Reconciliation") : dataManager.alignLastPointToLiveSnapshot()
    // est supprimée — elle seule fabriquait dayPnl/dayPnlPct comme séries du
    // graphique (null partout sauf au dernier index). Sans elle, ces deux
    // champs n'existent structurellement plus DU TOUT sur graphData : "Var
    // Today" ne peut donc plus jamais apparaître dans le tooltip du
    // graphique, à AUCUN index, pas même le dernier — la KPI "Var Today" en
    // haut de page reste disponible séparément via portfolioKPIs (alimentée
    // par portfolioSnapshot.dayPnl, jamais par graphData). C'est exactement
    // la règle de la section K de l'audit : "Ne pas afficher Var Today sur un
    // point historique qui ne possède pas un dayPnl explicitement calculé
    // pour ce point" — et aucun point du graphique n'en a un.
    it('le tooltip du graphique n\'affiche plus JAMAIS "Var Today", même au dernier index ("maintenant") — cette KPI reste exclusive à portfolioKPIs', () => {
        const storage = createFakeStorage({});
        const dataManager = new DataManager(storage, createFakeApi());
        const investmentsPage = { filterManager: { getSelectedTickers: () => new Set() }, getChartTitleConfig: () => ({ mode: 'global' }), getFilteredPurchasesFromPage: () => [], renderData: () => {} };
        const chart = new HistoricalChart(storage, dataManager, null, investmentsPage);
        chart.currentPeriod = 1;

        // Série "brute" telle que HistoryCalculator la produit réellement —
        // aucun champ dayPnl/dayPnlPct (voir _buildSeries : ces séries
        // n'existent plus du tout, à aucun index).
        const graphData = {
            values: [2000, 2010.25],
            totalReturn: [250, 263.63],
            totalReturnPct: [14.7, 15.5]
        };
        const opts = {
            graphData, pctSeries: [0, 0.5], eurFmt: v => v, pctFmt: v => v,
            isIndexMode: false, isUnitView: false, isPerformanceMode: false,
            displayValues: graphData.values
        };

        const rowsAtLast = chart._buildKpiRows(1, opts);
        expect(rowsAtLast.find(r => r.label === 'Var Today')).toBeUndefined();

        const rowsAtFirst = chart._buildKpiRows(0, opts);
        expect(rowsAtFirst.find(r => r.label === 'Var Today')).toBeUndefined();
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

    // RÉVISÉ (validation architecture 2026-09-24, Phase 4) : le tooltip du
    // graphique lit désormais TOUJOURS graphData.totalReturn tel que résolu
    // par HistoryCalculator — jamais une valeur substituée depuis le snapshot
    // live (alignLastPointToLiveSnapshot supprimée). C'est l'inverse exact de
    // l'ancien invariant : ce test verrouille qu'AUCUNE substitution n'a lieu.
    it('Total Return au point "maintenant" du tooltip lit la valeur RÉSOLUE PAR LE GRAPHIQUE lui-même, jamais une valeur substituée depuis le snapshot live', () => {
        const storage = createFakeStorage({});
        const dataManager = new DataManager(storage, createFakeApi());
        const investmentsPage = { filterManager: { getSelectedTickers: () => new Set() }, getChartTitleConfig: () => ({ mode: 'global' }), getFilteredPurchasesFromPage: () => [], renderData: () => {} };
        const chart = new HistoricalChart(storage, dataManager, null, investmentsPage);
        chart.currentPeriod = 1;

        // Série "brute" telle que HistoryCalculator la produit réellement —
        // ce tableau n'est plus jamais retouché avant d'atteindre le tooltip.
        const graphData = {
            values: [2000, 2010.25],
            investedAssetOnly: [1696.62, 1696.62],
            cash: [50, 50],
            totalReturn: [250, 263.63],
            totalReturnPct: [14.7, 15.5]
        };
        const opts = {
            graphData, pctSeries: [0, 0.5], eurFmt: v => v, pctFmt: v => v,
            isIndexMode: false, isUnitView: false, isPerformanceMode: false,
            displayValues: graphData.values
        };

        const rows = chart._buildKpiRows(1, opts);
        const totalReturnRow = rows.find(r => r.label === 'Total Return');

        // La valeur du graphique (263.63), pas une valeur live hypothétique
        // (500€ dans l'ancien test) qui n'a plus aucun moyen d'atteindre ce
        // tableau.
        expect(totalReturnRow.eur).toBe(263.63);
    });

    // RÉVISÉ (validation architecture 2026-09-24, Phase 4) : "bug des
    // 297,18€" — le fix original forçait le dernier point d'un graphique
    // multi-jours (1W/1M/...) à égaler le PortfolioSnapshot live. Ce test
    // vérifiait cette égalité forcée ; il vérifie désormais l'inverse — le
    // graphique reste sur sa PROPRE observation historique même quand le
    // snapshot live (KPI) diverge nettement, ce qui est désormais un
    // comportement correct, pas un bug.
    it("le dernier point d'un graphique multi-jours (1W) reste sa propre observation historique, MÊME quand le PortfolioSnapshot live diverge nettement", async () => {
        const storage = createFakeStorage({
            // Prix live très différent de la bougie historique unique fournie
            // ci-dessous — reproduit exactement la forme du rapport original.
            prices: { AAPL: { price: 999, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
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

        // Une seule bougie réelle sur toute la fenêtre 1W, à 100€ — bien
        // distincte des 999€ du prix live.
        const fakeApi = createFakeApi({
            async getHistoricalPricesWithRetry() {
                return { [Date.now() - 3 * 24 * 3600000]: 100 };
            }
        });
        const dataManager = new DataManager(storage, fakeApi);
        const chart = new HistoricalChart(storage, dataManager, null, investmentsPage);
        chart.currentPeriod = 7; // vue 1W — exactement le scénario du rapport

        let capturedGraphData = null;
        const originalRenderChart = chart.renderChart.bind(chart);
        chart.renderChart = (canvas, graphData, ...rest) => { capturedGraphData = graphData; return originalRenderChart(canvas, graphData, ...rest); };

        await chart.update(false, false);
        const liveKpis = portfolioKPIs.getKPIs();

        // KPI live : valorisation "maintenant" au prix live (999×10=9990€).
        expect(liveKpis.totalValue).toBeCloseTo(9990, 0);

        const lastIdx = capturedGraphData.values.length - 1;
        // Le graphique NE SUIT PLUS le live : son dernier point reste ancré
        // sur la bougie réelle (100×10=1000€), jamais rapproché des 9990€ du
        // KPI. C'est la preuve directe qu'aucun code ne force plus cette
        // égalité.
        expect(capturedGraphData.values[lastIdx]).toBeCloseTo(1000, 0);
        expect(capturedGraphData.values[lastIdx]).not.toBeCloseTo(liveKpis.totalValue, 0);
    });
});
