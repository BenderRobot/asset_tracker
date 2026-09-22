import { describe, it, expect } from 'vitest';
import { getGlobalWindow, getAssetWindow, localMidnightUTCMs } from '../src/TimeRangeEngine.js';
import { MarketCalendarEngine } from '../src/MarketCalendarEngine.js';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

const TZ = 'Europe/Paris';

describe('TEST 25 — TimeRangeEngine.getGlobalWindow : startTimestamp/endTimestamp/timezone/scope vérifiables', () => {
    it('Global 1D : 00:00 (Europe/Paris) -> maintenant', () => {
        const now = new Date('2024-06-17T15:00:00Z'); // lundi, l'heure n'a pas d'importance
        const win = getGlobalWindow(1, TZ, now);

        expect(win.scope).toBe('global');
        expect(win.timezone).toBe(TZ);
        expect(win.endMs).toBe(now.getTime());
        expect(win.startMs).toBe(localMidnightUTCMs(now, TZ));

        // Minuit Paris en juin (CEST, UTC+2) = 22:00 UTC la veille.
        expect(new Date(win.startMs).toISOString()).toBe('2024-06-16T22:00:00.000Z');
    });

    it('Global 2D : 2 jours CIVILS en arrière, pas 48h glissantes', () => {
        const now = new Date('2024-06-17T15:00:00Z'); // lundi
        const win = getGlobalWindow(2, TZ, now);
        // 2 jours civils en arrière depuis lundi 17 -> dimanche 16, minuit Paris.
        expect(new Date(win.startMs).toISOString()).toBe('2024-06-15T22:00:00.000Z');
    });

    it('Global 1W : 7 jours civils en arrière', () => {
        const now = new Date('2024-06-17T15:00:00Z');
        const win = getGlobalWindow(7, TZ, now);
        expect(new Date(win.startMs).toISOString()).toBe('2024-06-10T22:00:00.000Z');
    });

    it('Global YTD : 1er janvier minuit Paris de l\'année courante', () => {
        const now = new Date('2024-06-17T15:00:00Z');
        const win = getGlobalWindow('ytd', TZ, now);
        // 1er janvier 2024, minuit Paris (CET, UTC+1) = 2023-12-31T23:00:00Z.
        expect(new Date(win.startMs).toISOString()).toBe('2023-12-31T23:00:00.000Z');
    });

    it('Global ALL : aucune borne de début déductible du calendrier seul (dépend du portefeuille)', () => {
        const win = getGlobalWindow('all', TZ, new Date());
        expect(win.startMs).toBeNull();
    });

    it('Global 1M (30j) traverse un changement de mois civilement, pas juste 30*24h', () => {
        const now = new Date('2024-01-15T12:00:00Z');
        const win = getGlobalWindow(30, TZ, now);
        const startDate = new Date(win.startMs);
        // 30 jours civils avant le 15 janvier -> mi-décembre de l'année précédente.
        expect(startDate.getUTCFullYear()).toBe(2023);
    });
});

describe('TEST DST — la fenêtre Global change correctement avec heure été/hiver', () => {
    it("le passage hiver->été en Europe (dernier dimanche de mars) décale minuit Paris d'1h en UTC", () => {
        const winterRef = new Date('2024-03-01T12:00:00Z');
        const summerRef = new Date('2024-04-01T12:00:00Z');
        const winterMidnight = localMidnightUTCMs(winterRef, TZ);
        const summerMidnight = localMidnightUTCMs(summerRef, TZ);
        // Minuit Paris en hiver (CET, UTC+1) = 23:00 UTC veille ; en été (CEST, UTC+2) = 22:00 UTC veille.
        expect(new Date(winterMidnight).getUTCHours()).toBe(23);
        expect(new Date(summerMidnight).getUTCHours()).toBe(22);
    });
});

describe('TEST M (approfondi) — Global et Asset ne partagent jamais la même fenêtre 1D', () => {
    it('Global 1D (Europe/Paris, 00:00) diffère de la session AAPL (America/New_York, ouverture réelle)', () => {
        const engine = new MarketCalendarEngine();
        const now = new Date('2024-06-17T15:00:00Z'); // lundi, marché US ouvert

        const globalWin = getGlobalWindow(1, engine.getPortfolioTimezone(), now);
        const assetWin = getAssetWindow('AAPL', 1, engine, now);

        expect(globalWin.timezone).toBe('Europe/Paris');
        expect(assetWin.timezone).toBe('America/New_York');
        expect(globalWin.startMs).not.toBe(assetWin.startMs);
        // Global commence à minuit ; la session AAPL commence après l'ouverture du marché,
        // donc largement APRÈS minuit Paris.
        expect(assetWin.startMs).toBeGreaterThan(globalWin.startMs);
    });

    it('Asset 1D pour BTC est un vrai 24h, indépendant du fuseau portefeuille', () => {
        const engine = new MarketCalendarEngine();
        const now = new Date('2024-06-17T15:00:00Z');
        const win = getAssetWindow('BTC-EUR', 1, engine, now);
        expect(win.endMs - win.startMs).toBeLessThanOrEqual(24 * 3600000);
        expect(win.session.tradingModel).toBe('crypto_24_7');
    });

    it("Asset 1D un weekend retombe sur la DERNIÈRE session connue, pas une fenêtre vide", () => {
        const engine = new MarketCalendarEngine();
        const saturday = new Date('2024-06-15T12:00:00Z');
        const win = getAssetWindow('AAPL', 1, engine, saturday);
        expect(win).not.toBeNull();
        expect(new Date(win.startMs).getDay()).toBe(5); // vendredi
    });
});

describe('Hiérarchie de confiance — provider vs heuristique', () => {
    it("utilise exchangeTimezoneName du provider quand il a été ingéré pour AUJOURD'HUI", () => {
        const engine = new MarketCalendarEngine();
        const now = new Date();
        // Simule une VRAIE réponse Yahoo (structure observée en direct sur le proxy de
        // l'app pour SU.PA) plutôt qu'une valeur inventée.
        engine.ingestProviderMetadata('SU.PA', {
            exchangeName: 'PAR', fullExchangeName: 'Paris', exchangeTimezoneName: 'Europe/Paris',
            instrumentType: 'EQUITY',
            currentTradingPeriod: {
                regular: {
                    start: Math.floor(new Date(now).setHours(9, 0, 0, 0) / 1000),
                    end: Math.floor(new Date(now).setHours(17, 30, 0, 0) / 1000)
                }
            }
        });

        expect(engine.getTimezoneSource('SU.PA')).toBe('provider');
        expect(engine.getTimezone('SU.PA')).toBe('Europe/Paris');
        const session = engine.getSession('SU.PA', now);
        expect(session.source).toBe('provider');
    });

    it("retombe explicitement sur l'heuristique pour un ticker jamais vu par le provider", () => {
        const engine = new MarketCalendarEngine();
        expect(engine.getTimezoneSource('MSFT')).toBe('heuristic-fallback');
        const session = engine.getSession('MSFT', new Date('2024-06-17T15:00:00Z'));
        expect(session.source).toBe('heuristic-fallback');
    });

    it('getTradingDayStatus distingue TRADING_DAY / HOLIDAY_CONFIRMED / HOLIDAY_UNKNOWN', () => {
        const engine = new MarketCalendarEngine();
        const saturday = new Date('2024-06-15T12:00:00Z');
        const weekday = new Date('2024-06-17T12:00:00Z');

        expect(engine.getTradingDayStatus('AAPL', saturday)).toBe('HOLIDAY_CONFIRMED');
        // Aucune métadonnée provider ingérée pour AAPL : un jour de semaine reste
        // honnêtement UNKNOWN (pourrait être un jour férié réel) plutôt que d'affirmer
        // TRADING_DAY sans preuve.
        expect(engine.getTradingDayStatus('AAPL', weekday)).toBe('HOLIDAY_UNKNOWN');
        expect(engine.getTradingDayStatus('BTC-EUR', saturday)).toBe('TRADING_DAY');
    });
});

describe('Phase 3 — TimeRangeEngine réellement câblé dans HistoryCalculator (pas une logique parallèle)', () => {
    async function buildGraphData(days) {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 180, currency: 'EUR', previousClose: 178, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'AAPL', assetType: 'Stock', price: 150, quantity: 5, date: '2020-01-01' })];
        return dm.calculateGenericHistory(assetPurchases, days, false);
    }

    // Sans bougies réelles (fake api), le seul timestamp garanti dans la
    // fenêtre est win.displayStartTs lui-même (toujours ajouté à la grille) —
    // donc timestamps[0] expose directement la borne que _computeDisplayWindow
    // a calculée, sans ambiguïté.
    it('TEST 4/5 — Global 1M/3M : début exactement égal à TimeRangeEngine.getGlobalWindow', async () => {
        for (const days of [30, 90]) {
            const before = new Date();
            const graphData = await buildGraphData(days);
            const after = new Date();

            const expectedBefore = getGlobalWindow(days, TZ, before).startMs;
            const expectedAfter = getGlobalWindow(days, TZ, after).startMs;
            // Tolère le cas (très rare) où le test s'exécute pile à minuit Paris.
            expect([expectedBefore, expectedAfter]).toContain(graphData.timestamps[0]);
        }
    });

    it('TEST 6 — YTD : début exactement le 1er janvier minuit Paris', async () => {
        const before = new Date();
        const graphData = await buildGraphData('ytd');
        const expected = getGlobalWindow('ytd', TZ, before).startMs;
        expect(graphData.timestamps[0]).toBe(expected);
    });

    it('TEST 7/8 — 1Y/2Y : début exactement égal à TimeRangeEngine (jours civils, pas 365*24h approximatif)', async () => {
        for (const days of [365, 730]) {
            const before = new Date();
            const graphData = await buildGraphData(days);
            const expected = getGlobalWindow(days, TZ, before).startMs;
            expect(graphData.timestamps[0]).toBe(expected);
        }
    });

    it("TEST 29 — le fuseau du NAVIGATEUR/système n'intervient jamais : le début dépend de Europe/Paris, pas de l'horloge locale du process", async () => {
        // Si _computeDisplayWindow utilisait encore `new Date(); setHours(0,0,0,0)`
        // (fuseau système), ce test resterait vrai par coïncidence pour une machine
        // en Europe — la vraie preuve est que la valeur produite correspond
        // EXACTEMENT à getGlobalWindow('Europe/Paris', ...), jamais recalculée
        // séparément avec une autre logique locale.
        const before = new Date();
        const graphData = await buildGraphData(180);
        const expected = getGlobalWindow(180, TZ, before).startMs;
        expect(graphData.timestamps[0]).toBe(expected);
    });
});
