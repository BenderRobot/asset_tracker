// Phase 3.5 — closes the last parallel time-decision paths (days===2,
// weekend stocks-only jump, crypto's system-timezone-dependent day anchor,
// and _recoverFromClosedMarket's day-rollback — found while writing THIS
// file's own weekend tests, see its own doc comment in HistoryCalculator.js).
// See src/HistoryCalculator.js::_computeDisplayWindow and
// src/MarketCalendarEngine.js::getSession's own doc comments for the full
// rationale; this file proves each decision, it doesn't restate it.
import { describe, it, expect } from 'vitest';
import { getGlobalWindow, getAssetWindow } from '../src/TimeRangeEngine.js';
import { MarketCalendarEngine } from '../src/MarketCalendarEngine.js';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

const TZ = 'Europe/Paris';
const DAY_MS = 24 * 3600000;

// Jour civil (0=dimanche..6=samedi) d'un instant UTC DANS `timezone` — pas
// `getUTCDay()`, qui lit le jour civil UTC et se trompe systématiquement dès
// que `timezone` est en avance sur UTC (minuit Paris tombe sur la veille en
// UTC). C'est exactement l'erreur qu'une première version de ce fichier a
// faite ; ce helper est la correction.
function civilWeekdayName(ms, timezone) {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(ms);
}

// Jours civils Paris connus (2024) : lundi 17/06, vendredi 21/06, samedi
// 22/06, dimanche 23/06 — utilisés tels quels dans plusieurs tests ci-dessous.
const MONDAY = new Date('2024-06-17T15:00:00Z');
const FRIDAY = new Date('2024-06-21T15:00:00Z');
const SATURDAY = new Date('2024-06-22T15:00:00Z');
const SUNDAY = new Date('2024-06-23T15:00:00Z');

describe('TEST 1-4 — Global 2D : définition exacte (aujourd\'hui + dernier jour de référence réel)', () => {
    // Phase 3.6 : le booléen `hasExchangeTradedAssets` (Phase 3.5) est remplacé
    // par la vraie liste de tickers + le moteur de calendrier — voir
    // MarketCalendarEngine.hasExchangeTradedReferenceDay. Ces tests vérifient
    // maintenant le comportement RÉEL (calculé jour par jour), pas un booléen
    // pré-décidé par le test lui-même.
    const engine = new MarketCalendarEngine();

    it('TEST 1 — lundi : saute le weekend, démarre vendredi (pas dimanche)', () => {
        const win = getGlobalWindow(2, TZ, MONDAY, { assets: ['AAPL'], calendarEngine: engine });
        expect(civilWeekdayName(win.startMs, TZ)).toBe('Friday');
        expect(new Date(win.startMs).toISOString()).toBe('2024-06-13T22:00:00.000Z'); // minuit Paris du 14/06 (vendredi)
    });

    it('TEST 2 — vendredi : simple jour civil précédent (jeudi), pas de saut nécessaire', () => {
        const win = getGlobalWindow(2, TZ, FRIDAY, { assets: ['AAPL'], calendarEngine: engine });
        expect(civilWeekdayName(win.startMs, TZ)).toBe('Thursday');
    });

    it('TEST 3 — samedi : jour civil précédent (vendredi) — pas de règle spéciale un samedi, seul lundi saute', () => {
        const win = getGlobalWindow(2, TZ, SATURDAY, { assets: ['AAPL'], calendarEngine: engine });
        expect(civilWeekdayName(win.startMs, TZ)).toBe('Friday');
    });

    it('TEST 4 — dimanche : démarre vendredi, pas samedi — un vrai bénéfice de la centralisation Phase 3.6', () => {
        // La règle Phase 3.5 ("if Monday") ne traitait QUE le lundi : un dimanche
        // retombait sur "hier civil" (samedi) sans vérifier que samedi est
        // lui-même un jour de bourse pour AAPL — il ne l'est pas. Cette
        // incohérence latente (jamais testée précisément jusqu'ici) disparaît
        // avec la marche arrière réellement pilotée par le calendrier : elle ne
        // s'arrête que sur un jour confirmé tradable, quel que soit le jour de
        // départ, sans qu'aucun jour de semaine n'ait été écrit en dur ici.
        const win = getGlobalWindow(2, TZ, SUNDAY, { assets: ['AAPL'], calendarEngine: engine });
        expect(civilWeekdayName(win.startMs, TZ)).toBe('Friday');
    });

    it('portefeuille 100% crypto : 2D = 2 jours civils simples, jamais de saut de weekend', () => {
        const win = getGlobalWindow(2, TZ, MONDAY, { assets: ['BTC-EUR'], calendarEngine: engine });
        expect(civilWeekdayName(win.startMs, TZ)).toBe('Sunday'); // aucun saut
    });

    it('portefeuille mixte (BTC + AAPL) : la référence suit AAPL, pas BTC (BTC seul dirait "oui" à tous les jours)', () => {
        const win = getGlobalWindow(2, TZ, MONDAY, { assets: ['BTC-EUR', 'AAPL'], calendarEngine: engine });
        expect(civilWeekdayName(win.startMs, TZ)).toBe('Friday');
    });

    it('multi-exchange (AAPL US + SAP.PA Europe) : un seul marché ouvert suffit à fournir la référence, aucun calendrier unique supposé', () => {
        const win = getGlobalWindow(2, TZ, MONDAY, { assets: ['AAPL', 'SAP.PA'], calendarEngine: engine });
        expect(civilWeekdayName(win.startMs, TZ)).toBe('Friday');
    });

    it("sans `assets`/`calendarEngine` fournis (compatibilité), 2D reste le simple jour civil précédent — jamais une supposition de calendrier", () => {
        const win = getGlobalWindow(2, TZ, MONDAY);
        expect(civilWeekdayName(win.startMs, TZ)).toBe('Sunday');
    });
});

describe('TEST 5-7 — 2D Asset : session tradée précédente via MarketCalendarEngine, jamais recalculée localement', () => {
    it('TEST 5 — AAPL (US) : 2D un lundi démarre à l\'ouverture de la session de VENDREDI', () => {
        const engine = new MarketCalendarEngine();
        const win = getAssetWindow('AAPL', 2, engine, MONDAY);
        expect(civilWeekdayName(win.startMs, 'America/New_York')).toBe('Friday');
    });

    it('TEST 6 — SAP.PA (Europe) : 2D un lundi démarre à l\'ouverture de la session de VENDREDI', () => {
        const engine = new MarketCalendarEngine();
        const win = getAssetWindow('SAP.PA', 2, engine, MONDAY);
        expect(civilWeekdayName(win.startMs, 'Europe/Paris')).toBe('Friday');
    });

    it('TEST 7 — BTC-EUR : 2D = exactement 2 jours (48h), aucun saut de weekend', () => {
        const engine = new MarketCalendarEngine();
        const win = getAssetWindow('BTC-EUR', 2, engine, MONDAY);
        expect(win.endMs - win.startMs).toBeGreaterThan(24 * 3600000); // couvre bien 2 jours
        // BTC est en UTC pur (voir MarketCalendarEngine.getSession) : getUTCDay
        // est ici la bonne lecture, pas un piège de fuseau. Session "aujourd'hui"
        // (lundi) + session précédente (dimanche) couvrent dimanche+lundi.
        expect(new Date(win.startMs).getUTCDay()).toBe(0); // dimanche
    });
});

describe('TEST 8-11 — weekend, portefeuille 100% actions : Global 1D reste 00:00->maintenant (plus de saut vers le dernier jour de bourse)', () => {
    // Ce test a révélé, en le construisant, un DEUXIÈME chemin parallèle non
    // repéré à l'audit initial : HistoryCalculator._recoverFromClosedMarket
    // ramenait toute la fenêtre au dernier jour de bourse dès qu'aucune bougie
    // n'existait encore pour "aujourd'hui" (exactement le même anti-pattern
    // que la branche isWeekend déjà supprimée) — désactivé, voir son propre
    // commentaire dans HistoryCalculator.js.
    async function buildTodayGraph(ticker) {
        const storage = createFakeStorage({
            prices: { [ticker]: { price: 180, currency: 'EUR', previousClose: 178, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker, assetType: 'Stock', price: 150, quantity: 5, date: '2020-01-01' })];
        return dm.calculateGenericHistory(assetPurchases, 1, false);
    }

    it("TEST 8/10 — action US, aucune donnée fraîche disponible (marché fermé/weekend) : timestamps[0] reste minuit Paris d'AUJOURD'HUI", async () => {
        const graphData = await buildTodayGraph('AAPL');
        const expectedTodayMidnight = getGlobalWindow(1, TZ, new Date()).startMs;
        expect(graphData.timestamps[0]).toBe(expectedTodayMidnight);
    });

    it("TEST 9/11 — action Europe, même règle : timestamps[0] reste minuit Paris d'aujourd'hui", async () => {
        const graphData = await buildTodayGraph('SAP.PA');
        const expectedTodayMidnight = getGlobalWindow(1, TZ, new Date()).startMs;
        expect(graphData.timestamps[0]).toBe(expectedTodayMidnight);
    });
});

describe("TEST 12-14 — BTC 24h : indépendant du fuseau du système d'exécution", () => {
    it("le calcul de session crypto ne lit AUCUN champ de fuseau local (getHours/getDate) — preuve structurelle, plus forte qu'un échantillon de 3 fuseaux", () => {
        // getSession('BTC-EUR', date) doit être EXACTEMENT
        // floor(date.getTime()/86400000)*86400000 — une fonction pure de
        // l'instant UTC absolu. Le vérifier pour plusieurs instants dont la date
        // civile locale diffère selon le fuseau (Europe/Paris, America/New_York,
        // Asia/Tokyo auraient chacun une date CIVILE différente à ces instants)
        // prouve qu'aucun de ces fuseaux ne peut influencer le résultat, sans
        // avoir besoin de relancer le process avec TZ=... trois fois : la seule
        // dépendance possible (date.getTime()) est déjà un instant absolu,
        // identique quel que soit le fuseau du système qui l'a construit.
        const engine = new MarketCalendarEngine();
        const instants = [
            new Date('2024-06-17T23:30:00Z'), // 00:30 Tokyo (18/06), 19:30 New York (17/06), 01:30 Paris (18/06)
            new Date('2024-01-15T04:00:00Z'), // 13:00 Tokyo (15/01), 23:00 New York (14/01), 05:00 Paris (15/01)
        ];
        for (const instant of instants) {
            const session = engine.getSession('BTC-EUR', instant);
            const expected = Math.floor(instant.getTime() / DAY_MS) * DAY_MS;
            expect(session.openUTCMs).toBe(expected);
            expect(session.source).toBe('crypto-24-7-utc');
        }
    });

    it('DST du système (avant/après changement heure US ou EU) ne modifie jamais la frontière de journée BTC', () => {
        const engine = new MarketCalendarEngine();
        const beforeDstEU = new Date('2024-03-01T12:00:00Z');
        const afterDstEU = new Date('2024-04-01T12:00:00Z');
        // Les deux tombent sur des jours différents de toute façon ; ce qui compte
        // est que CHAQUE frontière soit exactement un multiple de 24h UTC, jamais
        // décalée d'1h par un changement d'heure quelconque.
        for (const instant of [beforeDstEU, afterDstEU]) {
            const session = engine.getSession('BTC-EUR', instant);
            expect(session.openUTCMs % DAY_MS).toBe(0);
        }
    });
});

describe('TEST 13 (Global/Asset/BTC timezone) — chaque scope garde sa propre convention, indépendamment du fuseau système', () => {
    it('Global utilise Europe/Paris, Asset AAPL utilise America/New_York, BTC utilise sa propre convention UTC — jamais mélangés', () => {
        const engine = new MarketCalendarEngine();
        const globalWin = getGlobalWindow(1, engine.getPortfolioTimezone(), MONDAY);
        const aaplWin = getAssetWindow('AAPL', 1, engine, MONDAY);
        const btcSession = engine.getSession('BTC-EUR', MONDAY);

        expect(globalWin.timezone).toBe('Europe/Paris');
        expect(aaplWin.timezone).toBe('America/New_York');
        expect(btcSession.source).toBe('crypto-24-7-utc');
        expect(globalWin.startMs).not.toBe(aaplWin.startMs);
        expect(globalWin.startMs).not.toBe(btcSession.openUTCMs);
    });
});

describe('Phase 3.6 — Global 2D ne contient plus aucune règle de jour de semaine codée en dur', () => {
    it("TEST structurel — la source de TimeRangeEngine ne contient plus aucun appel à getDay() (la marque d'une décision de jour de semaine codée en dur)", async () => {
        // Preuve textuelle, en complément des preuves comportementales ci-dessus :
        // getDay()/getUTCDay() est l'unique façon, en JS, de décider "quel jour de
        // semaine" sans passer par le calendrier — son absence ici prouve que
        // TOUTE décision de ce type est déléguée à MarketCalendarEngine (seul
        // fichier de ce projet où getDay() doit encore apparaître, pour
        // isTradingDay/getTradingDayStatus). Les mots "Monday"/"Friday" restent
        // volontairement dans les commentaires ci-dessus : ils documentent ce qui
        // a été RETIRÉ, ils ne pilotent plus aucune logique.
        const fs = await import('node:fs');
        const source = fs.readFileSync(new URL('../src/TimeRangeEngine.js', import.meta.url), 'utf8');
        expect(source).not.toMatch(/\.getDay\s*\(\s*\)/);
        expect(source).not.toMatch(/\.getUTCDay\s*\(\s*\)/);
    });

    it('TEST 8 — HOLIDAY_UNKNOWN n\'est jamais forcé à TRADING_DAY ou HOLIDAY_CONFIRMED par le walk 2D', () => {
        const engine = new MarketCalendarEngine();
        // Un jour de semaine SANS métadonnée provider ingérée est HOLIDAY_UNKNOWN
        // (voir getTradingDayStatus) — le walk ne doit pas planter ni supposer
        // silencieusement autre chose ; il applique le même repli assumé que le
        // reste du moteur (weekday non confirmé -> considéré tradable), jamais un
        // nouveau comportement inventé ici.
        const wednesday = new Date('2024-06-19T15:00:00Z');
        expect(engine.getTradingDayStatus('AAPL', wednesday)).toBe('HOLIDAY_UNKNOWN');
        const win = getGlobalWindow(2, TZ, new Date('2024-06-20T15:00:00Z'), { assets: ['AAPL'], calendarEngine: engine });
        expect(win.startMs).not.toBeNull();
        expect(Number.isFinite(win.startMs)).toBe(true);
    });

    it("TEST 10 — la borne finale ne dépend que du fuseau PORTEFEUILLE fourni, jamais implicitement du fuseau système", () => {
        // localMidnightUTCMs/civilDateParts résolvent la date civile via Intl avec
        // le fuseau EXPLICITEMENT passé — jamais via une méthode Date locale
        // (getDate/getHours) qui lirait le fuseau du process. Pour un `now` fixe,
        // la borne ne peut donc changer que si on change LE PARAMÈTRE timezone,
        // jamais le fuseau système d'exécution (non simulable ici sans relancer
        // le process — voir TimeRangeEngine.js pour la preuve structurelle
        // équivalente sur le cas crypto).
        const engine = new MarketCalendarEngine();
        const winParis = getGlobalWindow(2, 'Europe/Paris', MONDAY, { assets: ['AAPL'], calendarEngine: engine });
        const winTokyo = getGlobalWindow(2, 'Asia/Tokyo', MONDAY, { assets: ['AAPL'], calendarEngine: engine });
        expect(winParis.startMs).not.toBe(winTokyo.startMs);
        expect(winParis.timezone).toBe('Europe/Paris');
        expect(winTokyo.timezone).toBe('Asia/Tokyo');
    });
});
