// @vitest-environment jsdom
//
// BUG FOUND (rapport utilisateur) : les 4 cartes KPI du haut (Total Value/
// Total Return/Var Today/Invested) restaient figées sur le dernier snapshot
// PORTEFEUILLE affiché quand l'utilisateur passait en mode "actif unique"
// (drill-down sur une ligne du tableau, ex. Soitec) — parce que
// historicalChart.js::renderChart() ne publiait pas le PortfolioSnapshot
// QUE `if (!isSingleAssetMode && !isIndexMode)`. kpiData (Total Value/Return/
// VarToday) était pourtant DÉJÀ calculé correctement pour l'actif seul par
// _computeAggregateKPIs, mode-agnostique — le bug était purement un verrou de
// contexte d'affichage, jamais un calcul financier erroné.
//
// Fix : élargir la condition à `if (!isIndexMode)` (le mode index n'a pas de
// notion de "Total Return portefeuille" à publier) + capturer
// `snapshotStartedAt` dans la branche 'asset' de update() (absent avant, ce
// qui aurait laissé la garde anti-race de portfolioKPIs inopérante pour ce
// mode — un refresh portefeuille plus ancien aurait pu écraser les KPI d'un
// actif fraîchement sélectionné).
//
// Utilise le VRAI DataManager (pas de réimplémentation du calcul financier) —
// seuls storage/api sont des doubles déterministes, sans réseau ni DOM réels
// au-delà du strict nécessaire pour que HistoricalChart.update()/renderChart()
// s'exécutent (jsdom, un <canvas> et un Chart.js factice qui ne dessine rien).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HistoricalChart } from '../src/historicalChart.js';
import { DataManager } from '../src/dataManager.js';
import { portfolioKPIs } from '../src/portfolioKPIs.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

class FakeChartJs {
    constructor(ctx, config) { this.ctx = ctx; this.config = config; }
    destroy() {}
}

// Reproduit exactement le scénario Soitec de la capture : 3 achats (174,62€×1,
// 130€×2, 131€×2 = 696,62€ investis, 5 titres, PRU 139,324€), clôture hier
// 154,85€, prix courant 152,05€ → Value=760,25€, Day P&L=-14,00€ (-1,81%).
// Un second ticker + du cash rendent le total PORTEFEUILLE nettement différent
// du total de l'actif seul, pour que les tests puissent distinguer sans
// ambiguïté "KPI portefeuille" de "KPI de l'actif".
function buildScenario() {
    const storage = createFakeStorage({
        prices: {
            SOI: { price: 152.05, currency: 'EUR', previousClose: 154.85, lastUpdate: Date.now() },
            OTHER: { price: 1200, currency: 'EUR', previousClose: 1180, lastUpdate: Date.now() }
        },
        conversionRate: 0.9
    });
    const purchases = [
        purchase({ ticker: 'SOI', name: 'Soitec', assetType: 'Stock', price: 174.62, quantity: 1, date: '2026-05-25', broker: 'Boursobank PEA' }),
        purchase({ ticker: 'SOI', name: 'Soitec', assetType: 'Stock', price: 130.00, quantity: 2, date: '2026-06-12', broker: 'Boursobank PEA' }),
        purchase({ ticker: 'SOI', name: 'Soitec', assetType: 'Stock', price: 131.00, quantity: 2, date: '2026-06-22', broker: 'Boursobank PEA' }),
        purchase({ ticker: 'OTHER', name: 'Other Co', assetType: 'Stock', price: 1000, quantity: 1, date: '2024-01-01', broker: 'Boursobank PEA' }),
        purchase({ ticker: 'EUR', name: 'Cash', assetType: 'Cash', price: 50, quantity: 1, date: '2024-01-01', broker: 'Boursobank PEA' })
    ];
    storage.getPurchases = () => purchases;

    const api = createFakeApi();
    const dataManager = new DataManager(storage, api);

    const investmentsPage = {
        filterManager: { getSelectedTickers: () => new Set() },
        getChartTitleConfig: () => ({ mode: 'global', label: 'Portfolio Global', icon: 'x' }),
        getFilteredPurchasesFromPage: () => purchases,
        renderData: () => {}
    };

    document.body.innerHTML = '<canvas id="historical-portfolio-chart"></canvas>';
    global.Chart = FakeChartJs;

    const chart = new HistoricalChart(storage, dataManager, null, investmentsPage);
    return { chart, storage, dataManager, purchases };
}

describe('KPI top cards — synchronisation avec le mode affiché (portefeuille/actif/index)', () => {
    beforeEach(() => { portfolioKPIs.reset(); });
    afterEach(() => { vi.restoreAllMocks(); delete global.Chart; });

    it('TEST 1 — mode portefeuille : KPI top = snapshot portefeuille', async () => {
        const { chart } = buildScenario();
        await chart.update(false, false);

        const kpis = portfolioKPIs.getKPIs();
        // 760,25 (SOI) + 1200 (OTHER) + 50 (cash) = 2010,25
        expect(kpis.totalValue).toBeCloseTo(2010.25, 2);
        expect(kpis.invested).toBeCloseTo(1696.62, 2); // 696,62 + 1000
        expect(kpis.source).toBe('snapshot');
    });

    it('TEST 2 — mode actif (Soitec) : KPI top = KPI de l\'actif, pas du portefeuille', async () => {
        const { chart } = buildScenario();
        await chart.showAssetChart('SOI');

        const kpis = portfolioKPIs.getKPIs();
        expect(kpis.totalValue).toBeCloseTo(760.25, 2);
        expect(kpis.invested).toBeCloseTo(696.62, 2);
        expect(kpis.totalReturn).toBeCloseTo(63.63, 2);
        expect(kpis.totalReturnPct).toBeCloseTo(9.13, 1);
        expect(kpis.varToday).toBeCloseTo(-14.00, 2);
        expect(kpis.varTodayPct).toBeCloseTo(-1.81, 1);
    });

    it('TEST 3 — changement portefeuille → actif : les KPI changent réellement de contexte', async () => {
        const { chart } = buildScenario();
        await chart.update(false, false);
        const portfolioTotal = portfolioKPIs.getKPIs().totalValue;
        expect(portfolioTotal).toBeCloseTo(2010.25, 2);

        await chart.showAssetChart('SOI');
        const assetTotal = portfolioKPIs.getKPIs().totalValue;
        expect(assetTotal).toBeCloseTo(760.25, 2);
        expect(assetTotal).not.toBeCloseTo(portfolioTotal, 2);
    });

    it('TEST 4 — actif → portefeuille : les KPI reviennent exactement aux valeurs portefeuille', async () => {
        const { chart } = buildScenario();
        await chart.showAssetChart('SOI');
        expect(portfolioKPIs.getKPIs().totalValue).toBeCloseTo(760.25, 2);

        await chart.showPortfolioChart();
        const kpis = portfolioKPIs.getKPIs();
        expect(kpis.totalValue).toBeCloseTo(2010.25, 2);
        expect(kpis.invested).toBeCloseTo(1696.62, 2);
    });

    it('TEST 5 — le cash global du portefeuille n\'est jamais ajouté à Total Value de l\'actif', async () => {
        const { chart } = buildScenario();
        await chart.showAssetChart('SOI');

        const kpis = portfolioKPIs.getKPIs();
        // 760,25 + 50 (cash portefeuille) donnerait 810,25 — la présence de ce
        // montant précis prouverait une fuite du cash global dans l'actif.
        expect(kpis.totalValue).not.toBeCloseTo(810.25, 2);
        expect(kpis.totalValue).toBeCloseTo(760.25, 2);
    });

    it('TEST 5b — Var Today = somme exacte du Day P&L du tableau, même avec un cash-flow (portefeuille réel de production)', () => {
        // Cas réel remonté en production (compte réel, mêmes ordres de grandeur
        // que le rapport "297,18€" : ~37k€ de valeur totale, ~8.4k€ de retour).
        // Réécrit pour l'interface SSOT actuelle : _computeAggregateKPIs ne lit
        // plus targetSummary/targetCashReserve/todayGraphData directement, il
        // lit exclusivement un PortfolioSnapshot déjà canonique — voir
        // dataManager.buildPortfolioSnapshot. Le dailyTwr fourni ici (1.003281)
        // impliquerait, avec l'ancien code, un Var Today TRÈS différent de
        // 362,08€ s'il était encore utilisé — précisément ce que ce test
        // continue de garantir impossible.
        const { chart, dataManager } = buildScenario();

        const portfolioSnapshot = dataManager.buildPortfolioSnapshot({
            holdings: [],
            summary: {
                totalCurrentEUR: 36575.56,
                totalInvestedEUR: 28179.89,
                gainTotal: 8395.67,
                totalDayChangeEUR: 362.08,
                dayChangePct: 1.00
            },
            cashReserve: { total: 461.67 },
            snapshotStartedAt: 1000
        });

        const kpiData = chart._computeAggregateKPIs({ portfolioSnapshot, snapshotStartedAt: 1000 });

        expect(kpiData.totalValue).toBeCloseTo(37037.23, 2);
        expect(kpiData.varTodayAbs).toBeCloseTo(362.08, 2);
        expect(kpiData.varTodayPct).toBeCloseTo(1.00, 2);
        // Preuve que ce n'est PAS le ratio TWR (1.003281) reconverti en euros
        // sur le total : totalValue*(1-1/dTwr) ≈ 121€, très différent de 362,08€.
        expect(kpiData.varTodayAbs).not.toBeCloseTo(37037.23 * (1 - 1 / 1.003281), 0);
    });

    it('TEST 6 — anti-race : un refresh portefeuille plus ancien ne réécrit jamais les KPI d\'un actif plus récent', async () => {
        const { chart, dataManager } = buildScenario();

        // Simule le refresh PORTEFEUILLE démarré AVANT (snapshotStartedAt=1000)
        // mais dont la réponse arrive APRÈS la sélection de l'actif (2000) —
        // exactement le scénario que ce ticket doit empêcher. PortfolioSnapshot
        // construit via le même producteur canonique que le moteur réel
        // (dataManager.buildPortfolioSnapshot) — _computeAggregateKPIs ne lit
        // plus targetSummary/todayGraphData directement (voir SSOT).
        const portfolioSnapshotOld = dataManager.buildPortfolioSnapshot({
            holdings: [], summary: { totalCurrentEUR: 1960.25, totalInvestedEUR: 1696.62, gainTotal: 263.63, totalDayChangeEUR: 260.25, dayChangePct: 15.3 },
            cashReserve: { total: 50 }, snapshotStartedAt: 1000
        });
        const portfolioKpiData = chart._computeAggregateKPIs({ portfolioSnapshot: portfolioSnapshotOld, snapshotStartedAt: 1000 });

        const portfolioSnapshotAsset = dataManager.buildPortfolioSnapshot({
            holdings: [], summary: { totalCurrentEUR: 760.25, totalInvestedEUR: 696.62, gainTotal: 63.63, totalDayChangeEUR: -14.00, dayChangePct: -1.81 },
            cashReserve: { total: 0 }, snapshotStartedAt: 2000
        });
        const assetKpiData = chart._computeAggregateKPIs({ portfolioSnapshot: portfolioSnapshotAsset, snapshotStartedAt: 2000 });

        // L'actif (plus récent) répond EN PREMIER...
        chart.renderChart(document.getElementById('historical-portfolio-chart'),
            { values: [760.25], twr: [1, 0.9819], labels: ['00:00'] },
            { totalCurrentEUR: 760.25, totalInvestedEUR: 696.62 },
            { mode: 'asset' }, null, 'SOI', 154.85, assetKpiData);
        expect(portfolioKPIs.getKPIs().totalValue).toBeCloseTo(760.25, 2);

        // ...puis le portefeuille (plus ancien) répond APRÈS.
        chart.renderChart(document.getElementById('historical-portfolio-chart'),
            { values: [1960.25], twr: [1, 1.15], labels: ['00:00'] },
            { totalCurrentEUR: 1960.25, totalInvestedEUR: 1696.62 },
            { mode: 'global' }, null, null, 1900, portfolioKpiData);

        // Le résultat doit rester intégralement celui de l'actif — jamais écrasé.
        const finalKpis = portfolioKPIs.getKPIs();
        expect(finalKpis.totalValue).toBeCloseTo(760.25, 2);
        expect(finalKpis.totalValue).not.toBeCloseTo(1960.25, 2);
    });

    // RÉVISÉ (validation architecture 2026-09-24, Phase 4 — "Financial Truth
    // over KPI Reconciliation") : topKpi.totalValue (valorisation LIVE) n'est
    // plus censé égaler lastGraphValue (dernière OBSERVATION historique du
    // graphique) — voir dataManager.js, ex-alignLastPointToLiveSnapshot,
    // supprimée. Dans ce scénario (aucune bougie fournie par le fake api),
    // le graphique retombe sur la valorisation de clôture veille
    // (previousClose=154.85€ × 5 titres = 774.25€), tandis que le KPI reste
    // sur le prix live (152.05€ × 5 = 760.25€, voir TEST 2) — un écart
    // attendu et correct, pas une incohérence.
    it('TEST 7 — KPI (live) et graphique (observation historique) restent deux valorisations distinctes en mode actif ; table/KPI restent, eux, cohérents entre eux', async () => {
        const { chart } = buildScenario();

        let capturedGraphData = null, capturedSummary = null;
        const originalRenderChart = chart.renderChart.bind(chart);
        vi.spyOn(chart, 'renderChart').mockImplementation((canvas, graphData, summary, ...rest) => {
            capturedGraphData = graphData;
            capturedSummary = summary;
            return originalRenderChart(canvas, graphData, summary, ...rest);
        });

        await chart.showAssetChart('SOI');

        const topKpi = portfolioKPIs.getKPIs();
        const lastGraphValue = capturedGraphData.values[capturedGraphData.values.length - 1];

        // KPI (live) : inchangé, voir TEST 2.
        expect(topKpi.totalValue).toBeCloseTo(760.25, 2);
        // Graphique : sa propre observation historique (previousClose, faute
        // de bougie) — plus jamais alignée sur le KPI live.
        expect(lastGraphValue).toBeCloseTo(774.25, 2);
        expect(lastGraphValue).not.toBeCloseTo(topKpi.totalValue, 2);

        // La table (summary) et le KPI, eux, restent cohérents entre eux —
        // ce sont les deux qui partagent la même résolution live.
        expect(topKpi.invested).toBeCloseTo(capturedSummary.totalInvestedEUR, 2);
        expect(topKpi.totalReturn).toBeCloseTo(capturedSummary.gainTotal, 2);
        expect(topKpi.varToday).toBeCloseTo(-14.00, 2); // day P&L de l'actif, voir TEST 2
    });
});
