// Phase 2 integration tests: MarketCalendarEngine's rules as they actually
// affect the historical series engine (HistoryCalculator/DataManager), not
// just the standalone calendar module. No network (fake api), no DOM.
import { describe, it, expect } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { findClosestPrice } from '../src/MarketUtils.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

describe('TEST L — Global 1D commence à 00:00, pas à l\'ouverture du marché', () => {
    it('le premier timestamp de la fenêtre 1D est minuit local, pas 09:30/09:00', async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 180, currency: 'EUR', previousClose: 178, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'AAPL', assetType: 'Stock', price: 150, quantity: 5, date: '2024-01-01' })];

        const graphData = await dm.calculateGenericHistory(assetPurchases, 1, false);
        const firstTs = graphData.timestamps[0];
        const firstLocal = new Date(firstTs);

        expect(firstLocal.getHours()).toBe(0);
        expect(firstLocal.getMinutes()).toBe(0);
    });
});

describe('TEST A/B/C — marché fermé : valorisation réelle, aucune cotation fabriquée', () => {
    it('BTC évolue le weekend pendant qu\'AAPL (fermé) ne reçoit AUCUNE nouvelle observation', async () => {
        const storage = createFakeStorage({
            prices: {
                'BTC-EUR': { price: 52000, currency: 'EUR', previousClose: 50000, lastUpdate: Date.now() },
                AAPL: { price: 180, currency: 'EUR', previousClose: 180, lastUpdate: Date.now() } // AAPL n'a pas bougé (marché fermé)
            },
            conversionRate: 0.9
        });
        // RÉVISÉ (validation architecture 2026-09-24, Phase 4) : le graphique
        // ne se base plus JAMAIS sur le prix live (voir liveOverride
        // supprimé) — pour que ce scénario continue de démontrer "BTC bouge
        // pendant le weekend" via de VRAIES observations, on fournit
        // explicitement plusieurs bougies BTC réelles, à des instants et prix
        // distincts (jamais pour AAPL, qui doit rester à {} — c'est
        // précisément ce que ce test vérifie).
        const dm = new DataManager(storage, createFakeApi({
            async getHistoricalPricesWithRetry(ticker) {
                if (ticker !== 'BTC-EUR') return {};
                const now = Date.now();
                return {
                    [now - 3 * 3600000]: 50500,
                    [now - 2 * 3600000]: 51200,
                    [now - 1 * 3600000]: 52000
                };
            }
        }));
        const assetPurchases = [
            purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', price: 40000, quantity: 0.1, date: '2024-01-01' }),
            purchase({ ticker: 'AAPL', assetType: 'Stock', price: 150, quantity: 5, date: '2024-01-01' })
        ];

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        const { todayGraphData } = snapshot;

        // La série de VALORISATION du portefeuille a bien plusieurs points distincts
        // (BTC continue de bouger même marché actions fermé/weekend) — via de
        // VRAIES bougies, jamais un prix live injecté au dernier point.
        const distinctValues = new Set(todayGraphData.values.filter(v => v != null).map(v => Math.round(v * 100)));
        expect(distinctValues.size).toBeGreaterThan(1);

        // Mais AUCUNE observation de marché n'a été fabriquée pour AAPL : le fake
        // api renvoie toujours {} (aucune bougie) — si le moteur avait "rempli"
        // des bougies AAPL artificielles pour boucher le trou, cette map ne
        // serait plus vide après le calcul.
        expect(Object.keys(todayGraphData.historicalDataMap.get('AAPL') || {}).length).toBe(0);

        // La valorisation d'AAPL, elle, doit rester égale à son dernier prix RÉEL
        // connu (180) — pas 0, pas une extrapolation.
        const resolvedAapl = todayGraphData.resolvedPrices.get('AAPL');
        expect(resolvedAapl.price).toBeCloseTo(180, 6);
    });
});

describe("TEST D — un gap réel à l'ouverture (vendredi->lundi) reste un vrai gap, jamais une rampe interpolée", () => {
    it("un point demandé pendant le weekend reste figé sur la clôture du vendredi, jamais interpolé vers l'ouverture du lundi", () => {
        const fridayClose = new Date('2024-05-31T20:00:00Z').getTime();
        const mondayOpen = new Date('2024-06-03T13:30:00Z').getTime();
        const hist = { [fridayClose]: 180, [mondayOpen]: 185 };

        const midWeekend = fridayClose + (mondayOpen - fridayClose) / 2;
        // allowForward=false (comme pour toute action non-crypto — voir
        // HistoryCalculator._buildSeries) : ne doit JAMAIS retourner une valeur
        // entre 180 et 185 pour un point situé AVANT l'ouverture réelle.
        const midPrice = findClosestPrice(hist, midWeekend, '15m', false);
        expect(midPrice).toBe(180); // reste sur la dernière observation RÉELLE, pas une moyenne

        // Juste avant l'ouverture du lundi : toujours 180, pas d'anticipation.
        const justBeforeOpen = mondayOpen - 60000;
        expect(findClosestPrice(hist, justBeforeOpen, '15m', false)).toBe(180);

        // À l'ouverture réelle : le vrai gap apparaît d'un coup (185), jamais une
        // valeur intermédiaire.
        expect(findClosestPrice(hist, mondayOpen, '15m', false)).toBe(185);
    });
});

describe('TEST N (intégration) — un portefeuille 100% crypto reste valorisable un dimanche', () => {
    it('ne renvoie pas une série vide un jour où les actions ne cotent pas', async () => {
        const storage = createFakeStorage({
            prices: { 'BTC-EUR': { price: 51000, currency: 'EUR', previousClose: 50000, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', price: 40000, quantity: 0.1, date: '2024-01-01' })];

        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        expect(snapshot.todayGraphData.values.some(v => v != null && v > 0)).toBe(true);
    });
});
