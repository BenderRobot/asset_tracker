// VALIDATION ARCHITECTURE (2026-09-24) — "Dashboard initial → pas de triple
// pipeline". Reproduit fidèlement le motif RÉEL de dashboardApp.js::init() :
// 3 chemins d'orchestration lancés SANS s'attendre les uns les autres
// (refreshDataInBackground / loadPortfolioData / initHistoricalChart ->
// HistoricalChart.update()) pour le MÊME portefeuille — voir le commentaire
// "ANTI-RACE" dans dashboardApp.js. N'utilise pas dashboardApp.js lui-même
// (dépendances Firebase Auth/DOM/FCM trop lourdes pour un test unitaire),
// mais les VRAIS moteurs qu'il appelle (DataManager, PriceAPI, MarketDataRepository) —
// seuls storage/fetch sont des doubles déterministes.
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PriceAPI } from '../src/api.js';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, purchase } from './helpers.js';

const LIVE_URL_MARK = 'range=5d&interval=1d';

function yahooResponse(closes, startSec) {
    const timestamp = closes.map((_, i) => startSec + i * 86400);
    return {
        chart: {
            result: [{
                meta: { currency: 'EUR', regularMarketPrice: closes[closes.length - 1], chartPreviousClose: closes[closes.length - 2] },
                timestamp,
                indicators: { quote: [{ close: closes }] }
            }],
            error: null
        }
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Dashboard initial — coalescing des 3 chemins d\'init concurrents (refreshDataInBackground / loadPortfolioData / initHistoricalChart)', () => {
    it('un seul cycle réseau par ressource (prix live, historique par ticker), pas 2-3x, et les 3 chemins restent financièrement cohérents entre eux', async () => {
        const liveCalls = [];
        // HistoryCalculator demande, PAR TICKER, plusieurs ressources
        // DIFFÉRENTES à des fenêtres distinctes (courbe principale + ancre
        // "clôture veille" dédiée, voir l'audit 2026-09-24 section historique
        // — un comportement PRÉ-EXISTANT de HistoryCalculator, hors périmètre
        // de cette validation d'architecture, pas une coalescence manquée).
        // Ce test vérifie l'invariant réellement visé : CHAQUE ressource
        // DISTINCTE (ticker+fenêtre+intervalle) n'est jamais demandée plus
        // d'une fois au réseau, quel que soit le nombre d'orchestrateurs
        // concurrents qui la redemandent.
        const historicalCallCounts = {};

        vi.stubGlobal('fetch', vi.fn(async (url) => {
            const u = String(url);
            const params = new URL(u).searchParams;
            const symbol = params.get('symbol');

            if (u.includes(LIVE_URL_MARK)) {
                liveCalls.push(symbol);
                return { ok: true, json: async () => yahooResponse([100, 102], 1_790_000_000) };
            }

            const period1 = Number(params.get('period1'));
            const period2 = Number(params.get('period2'));
            const interval = params.get('interval');
            const resourceKey = `${symbol}|${interval}|${period1}|${period2}`;
            historicalCallCounts[resourceKey] = (historicalCallCounts[resourceKey] || 0) + 1;
            return { ok: true, json: async () => yahooResponse([98, 100, 102], period1) };
        }));

        const storage = createFakeStorage({
            assetTypes: { AAA: 'STOCK', BBB: 'STOCK' },
            conversionRate: 0.9
        });
        const api = new PriceAPI(storage);
        const dataManager = new DataManager(storage, api);

        const purchases = [
            purchase({ ticker: 'AAA', quantity: 2, price: 90, date: '2024-01-01' }),
            purchase({ ticker: 'BBB', quantity: 1, price: 95, date: '2024-01-01' })
        ];
        const tickers = ['AAA', 'BBB'];

        // Reproduit EXACTEMENT le motif dashboardApp.js::init() : les 3
        // chemins partent en parallèle, aucun n'attend les autres.
        const [
            yesterdayCloseMapFromBackgroundRefresh, // refreshDataInBackground()
            yesterdayCloseMapFromLoadPortfolioData, // loadPortfolioData() (après son propre fetchBatchPrices)
            chartRepoResult                          // initHistoricalChart() -> chart.update() -> repository.getSnapshot()
        ] = await Promise.all([
            dataManager.calculateAllAssetsYesterdayClose(purchases),
            (async () => {
                await api.fetchBatchPrices(tickers);
                return dataManager.calculateAllAssetsYesterdayClose(purchases);
            })(),
            dataManager.repository.getSnapshot(purchases, [])
        ]);

        // Prix LIVE : loadPortfolioData() ET le Repository (via
        // HistoricalChart.update()) demandent chacun fetchBatchPrices(tickers)
        // pour le MÊME jeu de tickers — coalescé sur 1 seule rafale réseau
        // (2 tickers = 2 requêtes live, jamais 4).
        expect(liveCalls.length).toBe(2);
        expect(new Set(liveCalls)).toEqual(new Set(['AAA', 'BBB']));

        // Historique : calculateAllAssetsYesterdayClose est appelé 2 FOIS
        // (refreshDataInBackground + loadPortfolioData) + le Repository fait
        // sa propre résolution interne (buildTodaySnapshot) — la coalescence
        // réseau existante (api.js::_inFlightHistoricalRequests) fait
        // converger tout ça sur 1 SEULE requête réseau PAR RESSOURCE
        // DISTINCTE (ticker+fenêtre+intervalle), jamais 2 ou 3 pour la même.
        expect(Object.values(historicalCallCounts).every(n => n === 1)).toBe(true);
        // Au moins une ressource par ticker a bien été demandée (le test ne
        // passe pas simplement parce qu'aucune requête n'a eu lieu).
        expect(Object.keys(historicalCallCounts).some(k => k.startsWith('AAA|'))).toBe(true);
        expect(Object.keys(historicalCallCounts).some(k => k.startsWith('BBB|'))).toBe(true);

        // Cohérence financière : les 2 calculs indépendants de yesterdayClose
        // (refreshDataInBackground vs loadPortfolioData) doivent converger
        // sur EXACTEMENT les mêmes valeurs, puisqu'ils ont partagé la même
        // exécution réseau coalescée.
        expect(yesterdayCloseMapFromBackgroundRefresh.get('AAA').yesterdayClose)
            .toBe(yesterdayCloseMapFromLoadPortfolioData.get('AAA').yesterdayClose);
        expect(yesterdayCloseMapFromBackgroundRefresh.get('BBB').yesterdayClose)
            .toBe(yesterdayCloseMapFromLoadPortfolioData.get('BBB').yesterdayClose);

        // Le snapshot canonique du Repository (source du graphique/KPI) reste
        // valide et cohérent avec ces mêmes données sous-jacentes.
        expect(chartRepoResult.snapshot.portfolioSnapshot.status).toBe('valid');
    });
});
