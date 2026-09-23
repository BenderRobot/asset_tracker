// DÉDUPLICATION DES FETCH HISTORIQUES — audit 2026-09-23.
//
// Constat en production : dashboardApp.js::init() lance 3 chemins
// d'orchestration concurrents (refreshDataInBackground / loadPortfolioData /
// initHistoricalChart -> chart.update) qui demandent chacun, quasi
// simultanément, le même historique (ticker, fenêtre, interval) pour
// valoriser le portefeuille — jusqu'à ~80 requêtes réseau pour ~27 tickers,
// déclenchant un flood HTTP 429 sur le Worker Cloudflare (rate limit 60/min).
//
// Cause racine : api.js::historicalPriceCache (et
// dataManager.js::_historicalFxMapCache) ne mémoïsent qu'APRÈS résolution
// d'un fetch — un cache "cold-stampede" classique. 3 appelants concurrents
// trouvent tous le cache vide avant qu'aucun n'ait eu le temps de répondre,
// et lancent donc chacun leur propre requête réseau pour EXACTEMENT la même
// donnée.
//
// Fix : coalescing par promesse en vol, keyée par le même identifiant
// déterministe déjà utilisé pour le cache de succès (api.js::cacheKey,
// dataManager.js::getHistoricalFxMap's rangeYears) — aucun changement de
// formule, aucune nouvelle source de vérité, aucun fallback silencieux
// introduit : un échec (429/500/502/timeout) reste un échec pour TOUS les
// appelants concurrents qui le partagent.
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PriceAPI, isHistoricalFetchFailure } from '../src/api.js';
import { DataManager } from '../src/dataManager.js';
import { FilterManager } from '../src/filters.js';
import { eventBus } from '../src/eventBus.js';
import { createFakeStorage, purchase } from './helpers.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function yahooResponse(closes, startSec = 1_790_000_000) {
    const timestamp = closes.map((_, i) => startSec + i * 86400);
    return {
        chart: {
            result: [{
                meta: { currency: 'EUR', exchangeTimezoneName: 'Europe/Paris' },
                timestamp,
                indicators: { quote: [{ close: closes }] }
            }],
            error: null
        }
    };
}

// TEST 1 — trois demandes simultanées pour le même (ticker, fenêtre, interval)
// ne déclenchent qu'UNE seule exécution réseau ; les 3 appelants reçoivent le
// même résultat.
describe('TEST 1 — coalescing au niveau réseau (api.js::getHistoricalPricesWithRetry)', () => {
    it('3 appels concurrents identiques -> 1 seul fetch(), même résultat pour les 3', async () => {
        let fetchCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            fetchCalls++;
            return { ok: true, json: async () => yahooResponse([100, 101, 102]) };
        }));

        const storage = createFakeStorage({ assetTypes: { DEDUP1: 'STOCK' } });
        const api = new PriceAPI(storage);

        const [r1, r2, r3] = await Promise.all([
            api.getHistoricalPricesWithRetry('DEDUP1', 1790000000, 1790259200, '1d'),
            api.getHistoricalPricesWithRetry('DEDUP1', 1790000000, 1790259200, '1d'),
            api.getHistoricalPricesWithRetry('DEDUP1', 1790000000, 1790259200, '1d'),
        ]);

        expect(fetchCalls).toBe(1);
        expect(r1).toEqual(r2);
        expect(r2).toEqual(r3);
    });

    it('des requêtes pour des tickers/fenêtres DIFFÉRENTS ne sont jamais coalescées ensemble', async () => {
        let fetchCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            fetchCalls++;
            return { ok: true, json: async () => yahooResponse([100, 101]) };
        }));

        const storage = createFakeStorage({ assetTypes: { DEDUP2A: 'STOCK', DEDUP2B: 'STOCK' } });
        const api = new PriceAPI(storage);

        await Promise.all([
            api.getHistoricalPricesWithRetry('DEDUP2A', 1790000000, 1790259200, '1d'),
            api.getHistoricalPricesWithRetry('DEDUP2B', 1790000000, 1790259200, '1d'),
        ]);

        expect(fetchCalls).toBe(2);
    });
});

// TEST 5 — un rafraîchissement EXPLICITE (appel non concurrent, après
// résolution du précédent) ne reste jamais bloqué sur un ancien résultat
// partagé : la coalescence est auto-invalidante (la promesse sort de la map
// dès qu'elle se résout, succès ou échec).
describe('TEST 5 — un appel ultérieur (hors concurrence) relance bien une vraie requête réseau', () => {
    it('après résolution du 1er échec réseau, un 2e appel séparé retente sur le réseau', async () => {
        let fetchCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            fetchCalls++;
            if (fetchCalls <= 3) return { ok: false, status: 429 }; // 3 tentatives internes échouent
            return { ok: true, json: async () => yahooResponse([50, 51]) };
        }));

        const storage = createFakeStorage({ assetTypes: { DEDUP5: 'STOCK' } });
        const api = new PriceAPI(storage);

        const first = await api.getHistoricalPricesWithRetry('DEDUP5', 1790000000, 1790259200, '1d');
        expect(isHistoricalFetchFailure(first)).toBe(true);
        expect(fetchCalls).toBe(3); // les 3 retries internes, jamais mis en cache (voir api.js)

        const second = await api.getHistoricalPricesWithRetry('DEDUP5', 1790000000, 1790259200, '1d');
        expect(isHistoricalFetchFailure(second)).toBe(false);
        expect(fetchCalls).toBe(4); // une vraie nouvelle requête réseau, pas un résultat d'échec réutilisé
    });
});

// TEST 6/7 — un échec réseau/HTTP partagé par coalescing reste un échec pour
// TOUS les appelants concurrents : jamais de fallback silencieux, jamais une
// donnée à 0€ introduite par le partage de la promesse.
describe('TEST 6/7 — HTTP 429/500/502/timeout restent fail-closed sous coalescing', () => {
    it.each([
        ['HTTP 429', () => ({ ok: false, status: 429 })],
        ['HTTP 500', () => ({ ok: false, status: 500 })],
        ['HTTP 502', () => ({ ok: false, status: 502 })],
    ])('%s coalescé sur 3 appelants concurrents -> les 3 reçoivent un échec marqué, 1 seul fetch()', async (_label, makeResponse) => {
        let fetchCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            fetchCalls++;
            return makeResponse();
        }));

        const storage = createFakeStorage({ assetTypes: { DEDUPFAIL: 'STOCK' } });
        const api = new PriceAPI(storage);

        const results = await Promise.all([
            api.getHistoricalPricesWithRetry('DEDUPFAIL', 1790000000, 1790259200, '1d'),
            api.getHistoricalPricesWithRetry('DEDUPFAIL', 1790000000, 1790259200, '1d'),
            api.getHistoricalPricesWithRetry('DEDUPFAIL', 1790000000, 1790259200, '1d'),
        ]);

        expect(fetchCalls).toBe(3); // 3 tentatives (retries) de la SEULE exécution coalescée, pas 9
        results.forEach(r => expect(isHistoricalFetchFailure(r)).toBe(true));
    });

    it('timeout (AbortError) coalescé -> échec marqué pour tous les appelants concurrents', async () => {
        let fetchCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async (_url, opts) => {
            fetchCalls++;
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
        }));

        const storage = createFakeStorage({ assetTypes: { DEDUPTIMEOUT: 'STOCK' } });
        const api = new PriceAPI(storage);

        const results = await Promise.all([
            api.getHistoricalPricesWithRetry('DEDUPTIMEOUT', 1790000000, 1790259200, '1d'),
            api.getHistoricalPricesWithRetry('DEDUPTIMEOUT', 1790000000, 1790259200, '1d'),
        ]);

        results.forEach(r => expect(isHistoricalFetchFailure(r)).toBe(true));
        expect(fetchCalls).toBeGreaterThan(0);
    });
});

// TEST 2/3 — reproduction du scénario réel dashboardApp.js::init() : deux
// orchestrateurs de haut niveau (calculateAllAssetsYesterdayClose,
// buildTodaySnapshot) demandent, SANS s'attendre l'un l'autre, l'historique
// du même portefeuille. Avant le fix, chacun déclenchait sa propre rafale
// réseau (2x, voire 3x avec initHistoricalChart) ; le coalescing réseau les
// fait converger sur les mêmes exécutions, sans que dataManager/
// HistoryCalculator n'aient eu besoin d'être modifiés pour "savoir" qu'ils
// se recoupent.
describe('TEST 2/3 — pas de double fetch entre calculateAllAssetsYesterdayClose et buildTodaySnapshot lancés concurremment', () => {
    it('les deux orchestrateurs, lancés en parallèle (comme dans init()), partagent le même trafic réseau et produisent des données cohérentes', async () => {
        const proxyCallsPerType = { curve: 0, dedicatedClose: 0, other: 0 };
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            if (url.includes('interval=1d')) proxyCallsPerType.dedicatedClose++;
            else proxyCallsPerType.curve++;
            return { ok: true, json: async () => yahooResponse([200, 201, 202, 203, 204]) };
        }));

        const storage = createFakeStorage({
            assetTypes: { DEDUPINIT: 'STOCK' },
            prices: { DEDUPINIT: { price: 204, currency: 'EUR', previousClose: 203, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const api = new PriceAPI(storage);
        const dm = new DataManager(storage, api);
        const purchases = [purchase({ ticker: 'DEDUPINIT', price: 150, quantity: 3, date: '2024-01-01' })];

        // Non-awaited l'un par rapport à l'autre, exactement comme
        // dashboardApp.js::init() (refreshDataInBackground / loadPortfolioData
        // / initHistoricalChart ne s'attendent pas entre eux).
        const [yesterdayCloseMap, snapshot] = await Promise.all([
            dm.calculateAllAssetsYesterdayClose(purchases),
            dm.buildTodaySnapshot(purchases, [])
        ]);

        // Avant le fix : chaque type de requête (courbe intraday + clôture
        // dédiée 1d) aurait été demandé une fois par orchestrateur -> 2 fetch
        // par type. Le coalescing garantit exactement 1 exécution réseau par
        // type, quel que soit le nombre d'appelants concurrents.
        expect(proxyCallsPerType.curve).toBe(1);
        expect(proxyCallsPerType.dedicatedClose).toBe(1);

        // Les deux orchestrateurs restent cohérents entre eux : la clôture
        // hier lue par le tableau (yesterdayCloseMap) et celle utilisée en
        // interne par le snapshot canonique (KPI) proviennent de la même
        // exécution réseau coalescée.
        expect(yesterdayCloseMap.get('DEDUPINIT').yesterdayClose).toBeGreaterThan(0);
        expect(snapshot.portfolioSnapshot.status).toBe('valid');
    });
});

// TEST 4 — un filtre "local" (qui reste sur le portefeuille global ou une
// sélection multi-tickers) ne doit jamais relancer de fetch historique :
// seul un filtre qui bascule sur un sous-ensemble réellement différent (un
// SEUL ticker sélectionné, mode actif unique) déclenche une nouvelle
// résolution — ce qui est déjà le cas et reste légitime (ce n'est pas la même
// requête, donc pas un candidat à la déduplication).
describe('TEST 4 — un filtre applicable localement ne déclenche aucun événement de rafraîchissement du graphique', () => {
    function domStorage(purchases) {
        return {
            getPurchases: () => purchases,
        };
    }

    it('0 ticker sélectionné (retour à "All Assets") -> aucun showAssetChart émis', () => {
        window.history.pushState({}, '', '/investments.html');
        const fm = new FilterManager(domStorage([purchase({ ticker: 'AAA' })]));
        const events = [];
        eventBus.addEventListener('showAssetChart', e => events.push(e));
        eventBus.addEventListener('clearAssetChart', e => events.push(e));

        fm.triggerFilterChange();

        expect(events.some(e => e.type === 'showAssetChart')).toBe(false);
    });

    it('plusieurs tickers sélectionnés (filtre multi-actifs) -> aucun showAssetChart émis, seulement un effacement du mode actif unique', () => {
        window.history.pushState({}, '', '/investments.html');
        const fm = new FilterManager(domStorage([purchase({ ticker: 'AAA' }), purchase({ ticker: 'BBB' })]));
        fm.selectedTickers.add('AAA');
        fm.selectedTickers.add('BBB');
        const events = [];
        eventBus.addEventListener('showAssetChart', e => events.push(e));
        eventBus.addEventListener('clearAssetChart', e => events.push(e));

        fm.triggerFilterChange();

        expect(events.some(e => e.type === 'showAssetChart')).toBe(false);
        expect(events.some(e => e.type === 'clearAssetChart')).toBe(true);
    });
});
