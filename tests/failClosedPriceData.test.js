// FAIL-CLOSED — audit incident 2026-09-23 (Worker prices en panne, HTTP 500
// sur toute requête historique, l'application continuait pourtant à produire
// des KPI/Day P&L à partir de zéro vraie donnée).
//
// Ces tests verrouillent la règle : un snapshot financier n'est valide que si
// TOUTES les données nécessaires à sa valorisation sont valides. Sinon,
// snapshot.status = 'invalid' avec une raison explicite et la liste des
// instruments concernés — jamais un prix live/lastKnownPrices/
// midnightValuationSeed substitué silencieusement, jamais 0€ (une vraie
// valeur financière) à la place de "indisponible".
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { HistoricalChart } from '../src/historicalChart.js';
import { createFailedHistoricalResult } from '../src/api.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

// IMPORTANT : le VRAI getHistoricalPricesWithRetry() ne lève JAMAIS d'exception
// — il catch systématiquement en interne et renvoie un résultat marqué "échec"
// (voir api.js::createFailedHistoricalResult). Un double de test qui ferait un
// `throw` brut ne reproduirait PAS fidèlement ce contrat pour TOUS les
// appelants (HistoryCalculator::_resolvePortfolioCloseBefore fait sa PROPRE
// requête directe, sans try/catch autour, en confiance dans ce contrat —
// exactement comme le reste du moteur).
function apiThatFailsFor(failingTickers) {
    const failing = new Set(failingTickers);
    return createFakeApi({
        async getHistoricalPricesWithRetry(ticker) {
            if (failing.has(ticker)) return createFailedHistoricalResult();
            return {}; // succès (réponse Yahoo valide, juste aucune bougie pour la période)
        }
    });
}

describe('TEST 1/2/3 — un échec réseau/HTTP confirmé (500, 502, timeout) invalide le snapshot, jamais un historique produit à partir de rien', () => {
    const storage = () => createFakeStorage({
        prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
        conversionRate: 0.9
    });
    const purchases = () => [purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' })];

    // getHistoricalPricesWithRetry() traite en interne HTTP 500, HTTP 502 et un
    // timeout (AbortError) de façon IDENTIQUE — les 3 tentatives échouent
    // toutes, quelle qu'en soit la raison précise, et le résultat marqué
    // "échec" (createFailedHistoricalResult) est le même dans les 3 cas. Ces 3
    // tests documentent explicitement que l'invariant tient pour chacune des
    // causes citées par l'audit, même si le code emprunte le même chemin.

    it('HTTP 500 → snapshot.status = invalid, aucune métrique calculée à partir d\'un prix', async () => {
        const dm = new DataManager(storage(), apiThatFailsFor(['AAPL']));
        const snapshot = await dm.buildTodaySnapshot(purchases(), []);
        const ps = snapshot.portfolioSnapshot;
        expect(ps.status).toBe('invalid');
        expect(ps.invalidReason).toBe('PRICE_DATA_UNAVAILABLE');
        expect(ps.invalidInstruments).toContain('AAPL');
        expect(ps.totalValue).toBeNull();
        expect(ps.totalReturn).toBeNull();
        expect(ps.dayPnl).toBeNull();
    });

    it('HTTP 502 (upstream provider error) → même comportement', async () => {
        const dm = new DataManager(storage(), apiThatFailsFor(['AAPL']));
        const snapshot = await dm.buildTodaySnapshot(purchases(), []);
        expect(snapshot.portfolioSnapshot.status).toBe('invalid');
        expect(snapshot.portfolioSnapshot.totalValue).toBeNull();
    });

    it('Timeout (AbortError) → même comportement', async () => {
        const dm = new DataManager(storage(), apiThatFailsFor(['AAPL']));
        const snapshot = await dm.buildTodaySnapshot(purchases(), []);
        expect(snapshot.portfolioSnapshot.status).toBe('invalid');
        expect(snapshot.portfolioSnapshot.dayPnl).toBeNull();
    });
});

describe('TEST 4/5 — granularité par instrument', () => {
    const storage = () => createFakeStorage({
        prices: {
            AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() },
            MSFT: { price: 300, currency: 'EUR', previousClose: 305, lastUpdate: Date.now() }
        },
        conversionRate: 0.9
    });
    const purchases = () => [
        purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' }),
        purchase({ ticker: 'MSFT', price: 250, quantity: 2, date: '2024-01-01' })
    ];

    it('un seul actif en échec → snapshot invalid, la liste ne contient QUE ce ticker', async () => {
        const dm = new DataManager(storage(), apiThatFailsFor(['MSFT']));
        const snapshot = await dm.buildTodaySnapshot(purchases(), []);
        const ps = snapshot.portfolioSnapshot;
        expect(ps.status).toBe('invalid');
        expect(ps.invalidInstruments).toEqual(['MSFT']);
    });

    it('plusieurs actifs en échec → snapshot invalid avec la liste complète des instruments concernés', async () => {
        const dm = new DataManager(storage(), apiThatFailsFor(['AAPL', 'MSFT']));
        const snapshot = await dm.buildTodaySnapshot(purchases(), []);
        const ps = snapshot.portfolioSnapshot;
        expect(ps.status).toBe('invalid');
        expect([...ps.invalidInstruments].sort()).toEqual(['AAPL', 'MSFT']);
    });
});

describe('TEST 6/7/8 — aucune source de repli silencieuse ne comble un trou historique', () => {
    it("prix LIVE disponible mais historique indisponible → jamais utilisé pour la position en échec (currentValue/currentPrice restent null, pas le prix live)", async () => {
        const storage = createFakeStorage({
            // Prix live BIEN présent et frais pour MSFT — la tentation du repli.
            prices: { MSFT: { price: 999, currency: 'EUR', previousClose: 305, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, apiThatFailsFor(['MSFT']));
        const purchases = [purchase({ ticker: 'MSFT', price: 250, quantity: 2, date: '2024-01-01' })];
        const snapshot = await dm.buildTodaySnapshot(purchases, []);

        const msft = snapshot.holdings.find(h => h.ticker === 'MSFT');
        expect(msft.priceDataUnavailable).toBe(true);
        expect(msft.currentPrice).toBeNull();
        expect(msft.currentValue).toBeNull();
        // Preuve que le prix live (999) n'a fuité nulle part.
        expect(msft.currentValue).not.toBe(999 * 2 * 0.9);
    });

    it("lastKnownPrices interne (voir HistoryCalculator) disponible mais échec réseau confirmé → jamais utilisé pour publier un point de courbe", async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, apiThatFailsFor(['AAPL']));
        const purchases = [purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' })];
        const snapshot = await dm.buildTodaySnapshot(purchases, []);

        // La série entière (pas seulement le dernier point) est nulle — aucun
        // point ne peut silencieusement porter une valeur dérivée de
        // lastKnownPrices tant que dataQuality est invalide.
        expect(snapshot.todayGraphData.values.every(v => v === null)).toBe(true);
        expect(snapshot.todayGraphData.dataQuality.valid).toBe(false);
    });

    it("midnightValuationSeed disponible (position ouverte aujourd'hui) mais échec réseau confirmé → jamais utilisé pour masquer la panne", async () => {
        const today = new Date().toISOString().slice(0, 10);
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, apiThatFailsFor(['AAPL']));
        // Achat AUJOURD'HUI : c'est exactement le cas qui alimenterait
        // normalement midnightValuationSeed.
        const purchases = [purchase({ ticker: 'AAPL', price: 200, quantity: 3, date: today })];
        const snapshot = await dm.buildTodaySnapshot(purchases, []);

        expect(snapshot.portfolioSnapshot.status).toBe('invalid');
        expect(snapshot.todayGraphData.values.every(v => v === null)).toBe(true);
    });
});

describe('TEST 9/10 — alignLastPointToLiveSnapshot respecte la validité du snapshot live', () => {
    it('TEST 9 — snapshot live VALIDE : le comportement d\'alignement existant est inchangé', () => {
        const storage = createFakeStorage({});
        const dm = new DataManager(storage, createFakeApi());
        const liveSnapshot = dm.buildPortfolioSnapshot({
            holdings: [], summary: { totalCurrentEUR: 1000, totalInvestedEUR: 800, gainTotal: 200, totalDayChangeEUR: 10, dayChangePct: 1 },
            cashReserve: { total: 0 }, snapshotStartedAt: Date.now()
        });
        const rawGraphData = { values: [900, 950], investedAssetOnly: [800, 800], cash: [0, 0], totalReturn: [100, 150], totalReturnPct: [12.5, 18.75] };

        const aligned = dm.alignLastPointToLiveSnapshot(rawGraphData, liveSnapshot);
        expect(aligned.values[1]).toBeCloseTo(1000, 2);
        expect(aligned.totalReturn[1]).toBeCloseTo(200, 2);
    });

    it('TEST 10 — snapshot live INVALIDE : aucun alignement artificiel, le graphique reste tel quel', async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, apiThatFailsFor(['AAPL']));
        const purchases = [purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' })];
        const snapshot = await dm.buildTodaySnapshot(purchases, []);
        expect(snapshot.portfolioSnapshot.status).toBe('invalid');

        const rawGraphData = { values: [123, 456], investedAssetOnly: [1, 1], cash: [0, 0], totalReturn: [1, 2], totalReturnPct: [1, 2] };
        const aligned = dm.alignLastPointToLiveSnapshot(rawGraphData, snapshot.portfolioSnapshot);

        // Le graphique fourni n'a PAS été modifié pour "ressembler" au live —
        // aucune valeur du snapshot invalide (null) n'a été recopiée dessus.
        expect(aligned.values).toEqual([123, 456]);
        expect(aligned.totalReturn).toEqual([1, 2]);
    });
});

describe('TEST 11/14 — KPI (Var Today compris) : aucun nombre issu d\'un snapshot invalide', () => {
    it('_computeAggregateKPIs renvoie null pour toutes les métriques de prix quand le snapshot est invalide', async () => {
        const storage = createFakeStorage({});
        const dataManager = new DataManager(storage, createFakeApi());
        const investmentsPage = { filterManager: { getSelectedTickers: () => new Set() }, getChartTitleConfig: () => ({ mode: 'global' }), getFilteredPurchasesFromPage: () => [], renderData: () => {} };
        const chart = new HistoricalChart(storage, dataManager, null, investmentsPage);

        const invalidSnapshot = dataManager.buildPortfolioSnapshot({
            holdings: [],
            summary: { totalInvestedEUR: 1000, dataQuality: { valid: false, reason: 'PRICE_DATA_UNAVAILABLE', failedInstruments: ['AAPL'] } },
            cashReserve: { total: 50 },
            snapshotStartedAt: Date.now()
        });
        expect(invalidSnapshot.status).toBe('invalid');

        const kpiData = chart._computeAggregateKPIs({ portfolioSnapshot: invalidSnapshot });

        expect(kpiData.totalValue).toBeNull();
        expect(kpiData.totalReturn).toBeNull();
        expect(kpiData.totalReturnPct).toBeNull();
        // Invariant Var Today (TEST 14) : jamais un nombre calculé à partir
        // d'un snapshot invalide.
        expect(kpiData.varTodayAbs).toBeNull();
        expect(kpiData.varTodayPct).toBeNull();
    });
});

describe('TEST 12 — TABLE : aucun P&L calculé à partir d\'une donnée INVALID', () => {
    it('la ligne du ticker en échec expose currentValue/gainEUR/dayChange à null, jamais une valeur dérivée d\'un repli silencieux', async () => {
        const storage = createFakeStorage({
            prices: {
                AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() },
                MSFT: { price: 999, currency: 'EUR', previousClose: 305, lastUpdate: Date.now() } // prix live dispo pour MSFT
            },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, apiThatFailsFor(['MSFT']));
        const purchases = [
            purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' }),
            purchase({ ticker: 'MSFT', price: 250, quantity: 2, date: '2024-01-01' })
        ];
        const snapshot = await dm.buildTodaySnapshot(purchases, []);

        const aapl = snapshot.holdings.find(h => h.ticker === 'AAPL');
        const msft = snapshot.holdings.find(h => h.ticker === 'MSFT');

        // AAPL n'est PAS en échec : sa ligne reste normalement calculée.
        expect(aapl.priceDataUnavailable).toBe(false);
        expect(aapl.currentValue).not.toBeNull();

        // MSFT est en échec : toute la ligne P&L devient explicitement indisponible.
        expect(msft.priceDataUnavailable).toBe(true);
        expect(msft.currentValue).toBeNull();
        expect(msft.gainEUR).toBeNull();
        expect(msft.gainPct).toBeNull();
        expect(msft.dayChange).toBeNull();
        expect(msft.dayPct).toBeNull();
        // Le coût de revient (invested), lui, ne dépend d'aucun prix — reste connu.
        expect(msft.invested).toBeCloseTo(500, 2);
    });
});

describe('TEST 13 — GRAPH : aucun point INVALID converti en zéro', () => {
    it('la série de valeurs est composée de `null`, jamais de `0`, quand le snapshot est invalide', async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, apiThatFailsFor(['AAPL']));
        const purchases = [purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' })];
        const snapshot = await dm.buildTodaySnapshot(purchases, []);

        const values = snapshot.todayGraphData.values;
        expect(values.length).toBeGreaterThan(0);
        expect(values.some(v => v === 0)).toBe(false);
        expect(values.every(v => v === null)).toBe(true);
    });
});
