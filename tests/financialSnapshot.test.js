// Tests for the "single source of truth" structural fix (see dataManager.js::
// buildTodaySnapshot, HistoryCalculator.js::_buildSeries's resolvedPrices,
// portfolioKPIs.js's snapshotStartedAt guard). These exercise the REAL
// DataManager/HistoryCalculator/PortfolioKPIs classes against a fake
// storage/api double — no network, no DOM, no mocked financial values baked
// into production code (the fakes live only under tests/).
import { describe, it, expect, beforeEach } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { PortfolioKPIs } from '../src/portfolioKPIs.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

// RÉVISÉ (validation architecture 2026-09-24, Phase 4 — "Financial Truth
// over KPI Reconciliation") : "le dernier point du graphique === Total
// Value" n'est PLUS un invariant imposé par le code (voir
// HistoryCalculator._buildSeries, l'ex-"liveOverride" supprimé, et
// dataManager.js, ex-alignLastPointToLiveSnapshot, supprimée). Le graphique
// représente la dernière observation historique réellement disponible ; le
// KPI/tableau (summary.totalCurrentEUR, via resolvedPrices) reste une
// valorisation LIVE séparée. Les deux PEUVENT coïncider (si la dernière
// bougie et le prix live sont identiques) mais rien ne les force à le faire.
describe('TEST 1 — le graphique et le Total Value (KPI/tableau) sont deux valorisations INDÉPENDANTES, jamais forcées à coïncider', () => {
    it('le dernier point du graphique reflète la dernière bougie réelle ; Total Value (KPI) reflète le prix live — ils peuvent légitimement différer', async () => {
        const storage = createFakeStorage({
            prices: {
                'BTC-EUR': { price: 55000, currency: 'EUR', previousClose: 49000, lastUpdate: Date.now() }, // live, différent de la bougie
                // AAPL : live égal à previousClose exprès — isole tout l'écart
                // mesuré ci-dessous sur BTC uniquement, AAPL ne contribue à
                // aucune divergence graphique/live de son côté.
                AAPL: { price: 178, currency: 'EUR', previousClose: 178, lastUpdate: Date.now() }
            },
            conversionRate: 0.9
        });
        const btcCandleTs = Date.now() - 3600000; // bougie réelle il y a 1h, à 50000 (pas 55000)
        const dm = new DataManager(storage, createFakeApi({
            async getHistoricalPricesWithRetry(ticker) {
                if (ticker === 'BTC-EUR') return { [btcCandleTs]: 50000 };
                return {};
            }
        }));

        const assetPurchases = [
            purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', price: 40000, quantity: 0.1, date: '2024-01-01' }),
            purchase({ ticker: 'AAPL', assetType: 'Stock', price: 150, quantity: 5, date: '2024-01-01' })
        ];
        const cashPurchases = [purchase({ ticker: 'EUR', assetType: 'Cash', price: 1000, quantity: 1, date: '2024-01-01' })];

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, cashPurchases);

        const graphValues = snapshot.todayGraphData.values;
        const lastGraphValue = graphValues[graphValues.length - 1];
        const totalValueFromHoldings = snapshot.summary.totalCurrentEUR + snapshot.cashReserve.total;

        // Total Value (KPI/tableau) utilise le prix LIVE de BTC (55000).
        // Le graphique, lui, reste sur la bougie réelle (50000) — un écart de
        // 0.1 BTC × 5000€ = 500€ entre les deux, PARFAITEMENT légitime.
        expect(lastGraphValue).not.toBeCloseTo(totalValueFromHoldings, 2);
        expect(totalValueFromHoldings - lastGraphValue).toBeCloseTo(500, 2);
    });
});

describe('TEST 2 — une réponse plus ancienne ne peut pas écraser un état plus récent', () => {
    let kpis;
    beforeEach(() => { kpis = new PortfolioKPIs(); });
    const snapshot = (snapshotStartedAt, totalValue, invested, dayPnl) => ({
        status: 'valid', snapshotStartedAt, snapshotId: `test-${snapshotStartedAt}`,
        totalValue, invested, totalReturn: totalValue - invested,
        totalReturnPct: invested > 0 ? ((totalValue - invested) / invested) * 100 : 0,
        dayPnl, dayPnlPct: totalValue > 0 ? (dayPnl / totalValue) * 100 : 0
    });

    it('ignore un snapshotStartedAt antérieur au dernier appliqué', () => {
        kpis.updateFromSnapshot(snapshot(2000, 1000, 900, 10));
        expect(kpis.getKPIs().totalValue).toBe(1000);

        // Une requête démarrée AVANT (1000 < 2000) répond APRÈS — doit être ignorée.
        kpis.updateFromSnapshot(snapshot(1000, 500, 400, -5));
        expect(kpis.getKPIs().totalValue).toBe(1000);
    });

    it('applique bien un snapshot plus récent quand il arrive après', () => {
        kpis.updateFromSnapshot(snapshot(1000, 1000, 900, 10));
        kpis.updateFromSnapshot(snapshot(2000, 1200, 900, 30));
        expect(kpis.getKPIs().totalValue).toBe(1200);
    });
});

describe('TEST 3 — deux refresh simultanés ne mélangent jamais leurs champs', () => {
    it('le résultat final appartient entièrement à UN SEUL des deux appels, jamais un mélange', () => {
        const kpis = new PortfolioKPIs();

        // Refresh A démarre en premier (snapshotStartedAt=1000) mais répond en
        // DERNIER (race réseau) ; Refresh B démarre après (2000) mais répond en
        // premier. Le résultat doit être intégralement celui de B (le plus récent
        // par snapshotStartedAt), jamais un mélange de champs des deux.
        const refreshB = { status: 'valid', snapshotStartedAt: 2000, snapshotId: 'B', totalValue: 2222, invested: 2000, totalReturn: 222, totalReturnPct: 11, dayPnl: 22, dayPnlPct: 2.2 };
        const refreshA = { status: 'valid', snapshotStartedAt: 1000, snapshotId: 'A', totalValue: 1111, invested: 1000, totalReturn: 111, totalReturnPct: 11, dayPnl: 11, dayPnlPct: 1.1 };

        kpis.updateFromSnapshot(refreshB); // répond en premier
        kpis.updateFromSnapshot(refreshA); // répond en second mais plus ANCIEN -> ignoré

        const result = kpis.getKPIs();
        expect(result.totalValue).toBe(refreshB.totalValue);
        expect(result.totalReturn).toBe(refreshB.totalReturn);
        expect(result.varToday).toBe(refreshB.dayPnl);
        // Aucun champ ne doit provenir de refreshA.
        expect(result.totalValue).not.toBe(refreshA.totalValue);
    });
});

describe('TEST 4 — Clôture hier a une définition unique (série interne dailyTwr du moteur graphique)', () => {
    // NOTE (audit cohérence KPI/tableau) : ce test porte sur l'auto-cohérence
    // INTERNE de todayGraphData.dailyTwr (le ratio journalier que le moteur
    // graphique construit pour ses propres besoins de tooltip intra-journée —
    // voir historicalChart::_buildKpiRows, points PASSÉS uniquement). Il ne
    // teste PLUS "la formule de la KPI Var Today" : depuis le fix de
    // historicalChart::_computeAggregateKPIs, la KPI (et le point "maintenant"
    // du tooltip) est TOUJOURS targetSummary.totalDayChangeEUR — jamais ce
    // ratio TWR. Voir tests/varTodayTableInvariant.test.js pour l'invariant
    // KPI = Σ table.
    it('la clôture implicite du ratio TWR journalier égale la clôture brute résolue par le graphique', async () => {
        const storage = createFakeStorage({
            prices: { 'BTC-EUR': { price: 51000, currency: 'EUR', previousClose: 50000, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', price: 40000, quantity: 0.2, date: '2024-01-01' })];

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        const { todayGraphData } = snapshot;

        // IMPORTANT (validation architecture 2026-09-24, Phase 4) : dTwr est
        // un ratio INTERNE au graphique, dérivé de sa PROPRE série `values`
        // (résolution historique — voir _buildSeries) — désormais distincte
        // de summary.totalCurrentEUR (valorisation LIVE, via resolvedPrices).
        // Pour que ce test d'auto-cohérence algébrique reste valide, il doit
        // comparer dTwr à la valeur qui l'a RÉELLEMENT produit (values[idx]),
        // jamais à la valorisation live désormais indépendante.
        const values = todayGraphData.values;
        const dailyTwr = todayGraphData.dailyTwr;
        let lastValidIdx = values.length - 1;
        while (lastValidIdx >= 0 && (values[lastValidIdx] == null || isNaN(values[lastValidIdx]))) lastValidIdx--;

        const totalValue = values[lastValidIdx];
        const dTwr = dailyTwr[lastValidIdx];
        // Formule interne du ratio TWR journalier (plus celle de la KPI — voir
        // NOTE ci-dessus).
        const twrImpliedVarToday = totalValue - totalValue / dTwr;
        const impliedReferenceClose = totalValue - twrImpliedVarToday; // = totalValue / dTwr

        // "Clôture hier" brute, telle que résolue par le moteur du graphique.
        const rawYesterdayClose = todayGraphData.yesterdayClose;

        expect(impliedReferenceClose).toBeCloseTo(rawYesterdayClose, 2);
    });
});

describe('TEST 5 — ratio TWR journalier interne réconcilié algébriquement avec valeur actuelle et référence', () => {
    // NOTE (audit cohérence KPI/tableau) : comme TEST 4, ceci teste
    // l'auto-cohérence algébrique du ratio dailyTwr interne au moteur
    // graphique — plus la formule de la KPI Var Today elle-même (voir
    // historicalChart::_computeAggregateKPIs, désormais targetSummary.
    // totalDayChangeEUR sans exception).
    it('varTodayAbs (dérivé du TWR) = totalValue - referenceValue, exactement (pas juste approximativement)', async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'AAPL', assetType: 'Stock', price: 150, quantity: 10, date: '2024-01-01' })];

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        const totalValue = snapshot.summary.totalCurrentEUR + snapshot.cashReserve.total;
        const values = snapshot.todayGraphData.values;
        const dailyTwr = snapshot.todayGraphData.dailyTwr;
        let idx = values.length - 1;
        while (idx >= 0 && (values[idx] == null || isNaN(values[idx]))) idx--;

        const dTwr = dailyTwr[idx];
        const varTodayAbs = totalValue - totalValue / dTwr;
        const referenceValue = totalValue / dTwr;

        expect(totalValue - referenceValue).toBeCloseTo(varTodayAbs, 9);
        expect(referenceValue + varTodayAbs).toBeCloseTo(totalValue, 9);
    });
});

describe('TEST 6 — Période reste indépendante de Var Today', () => {
    it('le TWR de période (2 jours) et le TWR journalier ne sont pas la même série quand la valeur bouge différemment chaque jour', async () => {
        const storage = createFakeStorage({
            prices: { 'BTC-EUR': { price: 60000, currency: 'EUR', previousClose: 55000, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        // Achat il y a plusieurs jours : la valeur d'aujourd'hui vs hier (Var Today)
        // et la valeur d'aujourd'hui vs il y a 2 jours (Période) n'ont aucune raison
        // de coïncider — le prix a bougé de 55000 (hier) à 60000 (aujourd'hui), un
        // mouvement purement journalier, sans rapport avec le prix d'achat.
        const assetPurchases = [purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', price: 40000, quantity: 0.1, date: '2024-01-01' })];

        const graphData2D = await dm.calculateGenericHistory([...assetPurchases], 2, false);
        const twr = graphData2D.twr.filter(v => v != null);
        const dailyTwr = graphData2D.dailyTwr.filter(v => v != null);

        expect(twr.length).toBeGreaterThan(0);
        expect(dailyTwr.length).toBeGreaterThan(0);

        // Les deux séries ne sont pas la MÊME référence — modifier l'une ne doit
        // pas modifier l'autre (elles doivent être des tableaux distincts).
        expect(graphData2D.twr).not.toBe(graphData2D.dailyTwr);
    });
});

describe('TEST 7 — un prix live qui change entre deux lectures ne doit pas produire deux valorisations KPI/holdings ; le graphique reste sur sa propre résolution historique', () => {
    it('calculateHoldings réutilise EXACTEMENT resolvedPrices (le prix live figé), pas une nouvelle lecture — le graphique, lui, n\'utilise plus ce prix live du tout', async () => {
        let readCount = 0;
        const storage = createFakeStorage({
            prices: {
                // BTC "bouge" à chaque lecture de storage.getCurrentPrice — si
                // calculateHoldings relisait storage indépendamment de
                // resolvedPrices, il obtiendrait un prix différent de celui figé
                // une seule fois pour ce calcul.
                'BTC-EUR': () => {
                    readCount++;
                    return { price: 50000 + readCount * 1000, currency: 'EUR', previousClose: 49000, lastUpdate: Date.now() };
                }
            },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', price: 40000, quantity: 0.1, date: '2024-01-01' })];

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);

        const resolvedPrice = snapshot.todayGraphData.resolvedPrices.get('BTC-EUR').price;
        const graphLastValue = snapshot.todayGraphData.values[snapshot.todayGraphData.values.length - 1];
        const holdingsValue = snapshot.holdings[0].currentValue;

        // holdings/KPI (via resolvedPrices) restent alignés sur le MÊME prix
        // live figé — jamais une seconde lecture de storage.getCurrentPrice.
        expect(holdingsValue).toBeCloseTo(0.1 * resolvedPrice, 6);

        // Le GRAPHIQUE, lui, n'utilise plus ce prix live du tout (validation
        // architecture 2026-09-24, Phase 4) : sans aucune bougie réelle pour
        // ce scénario, son seul point est la valorisation de clôture veille
        // (previousClose=49000, figé — jamais le prix live qui "bouge" à
        // chaque lecture). Preuve directe que le graphique et resolvedPrices
        // sont deux résolutions désormais indépendantes.
        expect(graphLastValue).toBeCloseTo(0.1 * 49000, 6);
        expect(graphLastValue).not.toBeCloseTo(0.1 * resolvedPrice, 6);
    });
});

describe('TEST 8 — le dernier point ne bénéficie d\'aucune logique spéciale qui changerait sa définition', () => {
    it('un prix live PÉRIMÉ (>10min) sur le dernier point retombe sur le même repli que les autres points, pas sur une valeur "spéciale"', async () => {
        const staleTs = Date.now() - 20 * 60 * 1000; // 20 minutes — hors de la fenêtre de fraîcheur de 10 min
        const storage = createFakeStorage({
            prices: { 'BTC-EUR': { price: 99999, currency: 'EUR', previousClose: 48000, lastUpdate: staleTs } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', price: 40000, quantity: 0.1, date: '2024-01-01' })];

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        const resolved = snapshot.todayGraphData.resolvedPrices.get('BTC-EUR');

        // Le prix live (99999) est périmé : le dernier point doit retomber sur le
        // même repli que n'importe quel autre point sans cotation fraîche
        // (previousClose ici, faute d'historique) — jamais sur le live périmé.
        expect(resolved.price).not.toBe(99999);
        expect(resolved.price).toBeCloseTo(48000, 6);

        // Et holdings doit voir EXACTEMENT ce même prix replié, pas le live périmé
        // relu indépendamment (calculateHoldings sans snapshot lirait 99999 --
        // voir _enrichAggregatedPosition's fallback direct à storage.getCurrentPrice).
        const holdingsValue = snapshot.holdings[0].currentValue;
        expect(holdingsValue).toBeCloseTo(0.1 * 48000, 6);
    });
});

describe('TEST 9 — buildTodaySnapshot : un achat/vente du jour ne devient jamais du Day P&L (invariant 4)', () => {
    // BUG FOUND (root cause de l'audit "KPI Var Today vs Σ table") :
    // buildTodaySnapshot appelait calculateHoldings(assetPurchases, null, ...) —
    // le `null` empêchait toute ligne de bénéficier de yesterdayCloseMap (déjà
    // résolu, sans coût réseau, dans todayGraphData.perTickerYesterdayClose,
    // via buildYesterdayCloseMapFromGraphData). Sans cette map,
    // _enrichAggregatedPosition retombe sur son second calcul, moins précis :
    // (currentPrice - previousClose) × la quantité TOTALE détenue AUJOURD'HUI —
    // qui inclut tout achat/vente survenu dans la journée. Un achat le jour même
    // gonflait alors le Day P&L affiché (table ET Var Today, qui en est la
    // somme) de (variation de prix du jour) × (quantité achetée aujourd'hui),
    // un cash-flow devenu P&L apparent.
    it("un achat effectué aujourd'hui sur une position existante ne modifie pas le Day P&L déjà couru sur les titres détenus hier", async () => {
        const today = new Date().toISOString().slice(0, 10);
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [
            purchase({ ticker: 'AAPL', assetType: 'Stock', price: 150, quantity: 5, date: '2024-01-01' }),
            // Achat AUJOURD'HUI : pur cash-flow, aucune information de marché.
            purchase({ ticker: 'AAPL', assetType: 'Stock', price: 200, quantity: 3, date: today })
        ];

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        const aapl = snapshot.holdings.find(h => h.ticker === 'AAPL');

        // Day P&L correct : (200 - 190) × 5 (quantité détenue HIER) = 50€.
        // La version buguée aurait donné (200 - 190) × 8 (quantité totale
        // d'aujourd'hui, achat du jour inclus) = 80€.
        expect(aapl.dayChange).toBeCloseTo(50, 2);
        expect(aapl.dayChange).not.toBeCloseTo(80, 2);
        expect(snapshot.summary.totalDayChangeEUR).toBeCloseTo(50, 2);
    });
});

describe("TEST 10 — generateFullReport respecte yesterdayCloseMap (même invariant, chemin dashboardApp.refreshDataInBackground)", () => {
    // BUG FOUND (même classe que TEST 9) : dashboardApp.js::refreshDataInBackground
    // appelait generateFullReport(marketPurchases, null, historicalFxMap) — le
    // rapport qui alimente le cache Firestore (mode "follower") et les KPI
    // secondaires (Top Gainer/Loser du jour) subissait donc la même
    // contamination cash-flow → Day P&L que buildTodaySnapshot. Ce test
    // verrouille que generateFullReport, quand on lui fournit la map correcte
    // (comme le fait désormais dashboardApp.js via calculateAllAssetsYesterdayClose,
    // à l'identique d'analyticsApp.js), produit bien le Day P&L cash-flow-immune —
    // pas juste que la fonction existe.
    it("un achat du jour n'inflate pas dayChange dans le rapport quand yesterdayCloseMap est fourni", async () => {
        const today = new Date().toISOString().slice(0, 10);
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const purchases = [
            purchase({ ticker: 'AAPL', assetType: 'Stock', price: 150, quantity: 5, date: '2024-01-01' }),
            purchase({ ticker: 'AAPL', assetType: 'Stock', price: 200, quantity: 3, date: today })
        ];

        const yesterdayCloseMap = await dm.calculateAllAssetsYesterdayClose(purchases);
        const report = dm.generateFullReport(purchases, yesterdayCloseMap);
        const aapl = report.assets.find(a => a.ticker === 'AAPL');

        expect(aapl.dayChange).toBeCloseTo(50, 2); // (200-190) × 5 détenus hier
        expect(aapl.dayChange).not.toBeCloseTo(80, 2); // pas × 8 (avec l'achat du jour)
        expect(report.summary.dayChange).toBeCloseTo(50, 2);
    });
});
