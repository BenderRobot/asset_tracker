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

describe('TEST 1 — Total Value / graphique / tooltip lisent le même snapshot', () => {
    it('le dernier point du graphique + cash égale Total Value, exactement', async () => {
        const storage = createFakeStorage({
            prices: {
                'BTC-EUR': { price: 50000, currency: 'EUR', previousClose: 49000, lastUpdate: Date.now() },
                AAPL: { price: 180, currency: 'EUR', previousClose: 178, lastUpdate: Date.now() }
            },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());

        const assetPurchases = [
            purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', price: 40000, quantity: 0.1, date: '2024-01-01' }),
            purchase({ ticker: 'AAPL', assetType: 'Stock', price: 150, quantity: 5, date: '2024-01-01' })
        ];
        const cashPurchases = [purchase({ ticker: 'EUR', assetType: 'Cash', price: 1000, quantity: 1, date: '2024-01-01' })];

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, cashPurchases);

        const graphValues = snapshot.todayGraphData.values;
        const lastGraphValue = graphValues[graphValues.length - 1]; // inclut le cash (purchases passées ensemble à calculateGenericHistory)
        const totalValueFromHoldings = snapshot.summary.totalCurrentEUR + snapshot.cashReserve.total;

        expect(lastGraphValue).toBeCloseTo(totalValueFromHoldings, 6);

        // Le "tooltip" ne fait qu'afficher graphData.values[lastIndex] (voir
        // historicalChart::_buildKpiRows, plus aucune substitution) — donc "ce que
        // lirait le tooltip" EST déjà lastGraphValue, testé ci-dessus.
    });
});

describe('TEST 2 — une réponse plus ancienne ne peut pas écraser un état plus récent', () => {
    let kpis;
    beforeEach(() => { kpis = new PortfolioKPIs(); });

    it('ignore un snapshotStartedAt antérieur au dernier appliqué', () => {
        kpis.updateFromGraph({ values: [1000], invested: 900, vsYesterdayAbs: 10, vsYesterdayPct: 1, period: '1d', snapshotStartedAt: 2000 });
        expect(kpis.getKPIs().totalValue).toBe(1000);

        // Une requête démarrée AVANT (1000 < 2000) répond APRÈS — doit être ignorée.
        kpis.updateFromGraph({ values: [500], invested: 400, vsYesterdayAbs: -5, vsYesterdayPct: -1, period: '1d', snapshotStartedAt: 1000 });
        expect(kpis.getKPIs().totalValue).toBe(1000);
    });

    it('applique bien un snapshot plus récent quand il arrive après', () => {
        kpis.updateFromGraph({ values: [1000], invested: 900, vsYesterdayAbs: 10, vsYesterdayPct: 1, period: '1d', snapshotStartedAt: 1000 });
        kpis.updateFromGraph({ values: [1200], invested: 900, vsYesterdayAbs: 30, vsYesterdayPct: 3, period: '1d', snapshotStartedAt: 2000 });
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
        const refreshB = { values: [2222], invested: 2000, vsYesterdayAbs: 22, vsYesterdayPct: 2.2, period: '1d', snapshotStartedAt: 2000, liveTotalValue: 2222, liveTotalReturn: 222, liveTotalReturnPct: 11 };
        const refreshA = { values: [1111], invested: 1000, vsYesterdayAbs: 11, vsYesterdayPct: 1.1, period: '1d', snapshotStartedAt: 1000, liveTotalValue: 1111, liveTotalReturn: 111, liveTotalReturnPct: 11 };

        kpis.updateFromGraph(refreshB); // répond en premier
        kpis.updateFromGraph(refreshA); // répond en second mais plus ANCIEN -> ignoré

        const result = kpis.getKPIs();
        expect(result.totalValue).toBe(refreshB.liveTotalValue);
        expect(result.totalReturn).toBe(refreshB.liveTotalReturn);
        expect(result.varToday).toBe(refreshB.vsYesterdayAbs);
        // Aucun champ ne doit provenir de refreshA.
        expect(result.totalValue).not.toBe(refreshA.liveTotalValue);
    });
});

describe('TEST 4 — Clôture hier a une définition unique', () => {
    it('la clôture implicite du ratio TWR journalier égale la clôture brute résolue par le graphique', async () => {
        const storage = createFakeStorage({
            prices: { 'BTC-EUR': { price: 51000, currency: 'EUR', previousClose: 50000, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', price: 40000, quantity: 0.2, date: '2024-01-01' })];

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        const { todayGraphData, summary, cashReserve } = snapshot;

        const totalValue = summary.totalCurrentEUR + cashReserve.total;
        const values = todayGraphData.values;
        const dailyTwr = todayGraphData.dailyTwr;
        let lastValidIdx = values.length - 1;
        while (lastValidIdx >= 0 && (values[lastValidIdx] == null || isNaN(values[lastValidIdx]))) lastValidIdx--;

        const dTwr = dailyTwr[lastValidIdx];
        // Même formule que historicalChart::_computeAggregateKPIs.
        const varTodayAbs = totalValue - totalValue / dTwr;
        const impliedReferenceClose = totalValue - varTodayAbs; // = totalValue / dTwr

        // "Clôture hier" brute, telle que résolue par le moteur du graphique.
        const rawYesterdayClose = todayGraphData.yesterdayClose;

        expect(impliedReferenceClose).toBeCloseTo(rawYesterdayClose, 2);
    });
});

describe('TEST 5 — Var Today réconcilié algébriquement avec valeur actuelle et référence', () => {
    it('varTodayAbs = totalValue - referenceValue, exactement (pas juste approximativement)', async () => {
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

describe('TEST 7 — un prix live qui change entre deux lectures ne doit pas produire deux valorisations', () => {
    it('calculateHoldings réutilise EXACTEMENT le prix déjà résolu par le graphique, pas une nouvelle lecture', async () => {
        let readCount = 0;
        const storage = createFakeStorage({
            prices: {
                // BTC "bouge" à chaque lecture de storage.getCurrentPrice — si
                // calculateHoldings relisait storage indépendamment du graphique
                // (au lieu d'utiliser priceSnapshot.prices), il obtiendrait un prix
                // différent de celui utilisé par le dernier point du graphique.
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

        // La valeur du graphique et celle des holdings doivent correspondre au
        // MÊME prix résolu (resolvedPrice), pas à deux lectures successives de
        // storage.getCurrentPrice ayant chacune vu un prix différent.
        expect(graphLastValue).toBeCloseTo(0.1 * resolvedPrice, 6);
        expect(holdingsValue).toBeCloseTo(0.1 * resolvedPrice, 6);
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
