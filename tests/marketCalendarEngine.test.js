import { describe, it, expect } from 'vitest';
import { MarketCalendarEngine } from '../src/MarketCalendarEngine.js';

const engine = new MarketCalendarEngine();

describe('TEST N — BTC est traité comme 24/7', () => {
    it('BTC-EUR est toujours un jour de trading, quel que soit le jour civil', () => {
        expect(engine.getTradingModel('BTC-EUR')).toBe('crypto_24_7');
        const saturday = new Date('2024-06-01T12:00:00Z'); // un samedi réel
        const sunday = new Date('2024-06-02T12:00:00Z');
        expect(engine.isTradingDay('BTC-EUR', saturday)).toBe(true);
        expect(engine.isTradingDay('BTC-EUR', sunday)).toBe(true);
        expect(engine.isMarketOpen('BTC-EUR', saturday.getTime())).toBe(true);
    });

    it('la session BTC couvre exactement 00:00 → 24:00 locale (24/7, pas de fermeture)', () => {
        const day = new Date('2024-06-01T15:00:00');
        const session = engine.getSession('BTC-EUR', day);
        expect(session.closeUTCMs - session.openUTCMs).toBe(24 * 3600000);
    });
});

describe('TEST G — weekend : les actions ne cotent pas, la crypto continue', () => {
    it('un ticker action (US, sans suffixe) n\'a pas de session le samedi/dimanche', () => {
        const saturday = new Date('2024-06-01T12:00:00Z');
        expect(engine.isTradingDay('AAPL', saturday)).toBe(false);
        expect(engine.getSession('AAPL', saturday)).toBeNull();
    });

    it('un ticker EU (.PA) n\'a pas de session le dimanche non plus', () => {
        const sunday = new Date('2024-06-02T12:00:00Z');
        expect(engine.isTradingDay('SAP.PA', sunday)).toBe(false);
        expect(engine.getSession('SAP.PA', sunday)).toBeNull();
    });
});

describe('TEST M — un actif individuel utilise sa propre session, pas celle du portefeuille global', () => {
    it('AAPL (US, sans suffixe) et SAP.DE (EU) ont des fenêtres de session différentes le même jour', () => {
        const weekday = new Date('2024-06-03T12:00:00Z'); // lundi
        const aapl = engine.getSession('AAPL', weekday);
        const sap = engine.getSession('SAP.DE', weekday);

        expect(aapl).not.toBeNull();
        expect(sap).not.toBeNull();
        expect(engine.getTimezone('AAPL')).toBe('America/New_York');
        expect(engine.getTimezone('SAP.DE')).toBe('Europe/Paris');
        // Les deux fenêtres ne doivent pas être identiques (fuseaux différents).
        expect(aapl.openUTCMs).not.toBe(sap.openUTCMs);
    });
});

describe('Sessions précédente/suivante — sautent le weekend', () => {
    it("la session précédente d'un lundi (action US) est le vendredi, pas le dimanche", () => {
        const monday = new Date('2024-06-03T12:00:00Z');
        const prev = engine.getPreviousTradingSession('AAPL', monday);
        const prevDate = new Date(prev.openUTCMs);
        expect(prevDate.getUTCDay()).toBe(5); // vendredi
    });

    it("la session suivante d'un vendredi (action US) est le lundi, pas le samedi", () => {
        const friday = new Date('2024-05-31T12:00:00Z');
        const next = engine.getNextTradingSession('AAPL', friday);
        const nextDate = new Date(next.openUTCMs);
        expect(nextDate.getUTCDay()).toBe(1); // lundi
    });

    it('BTC : la session précédente est simplement la veille (24/7, jamais de saut)', () => {
        // getSession() ancre le jour crypto sur minuit LOCAL (comme le reste de
        // l'app pour les frontières de journée) — on compare donc en jour LOCAL,
        // pas UTC, pour ne pas dépendre du fuseau de la machine qui exécute le test.
        const monday = new Date('2024-06-03T12:00:00Z');
        const prev = engine.getPreviousTradingSession('BTC-EUR', monday);
        const prevDate = new Date(prev.openUTCMs);
        expect(prevDate.getDay()).toBe(0); // dimanche — la crypto ne saute jamais le weekend
    });
});

describe('TEST I — DST (changement heure été/hiver)', () => {
    it("l'heure d'ouverture US en UTC change d'exactement 1h entre hiver (EST) et été (EDT)", () => {
        // 2024 : le marché US bascule en heure d'été le dimanche 10 mars.
        const beforeDst = new Date('2024-03-01T12:00:00Z'); // EST (UTC-5)
        const afterDst = new Date('2024-03-15T12:00:00Z');  // EDT (UTC-4)

        const sessionBefore = engine.getSession('AAPL', beforeDst);
        const sessionAfter = engine.getSession('AAPL', afterDst);

        // 09:30 EST = 14:30 UTC ; 09:30 EDT = 13:30 UTC — l'heure d'ouverture
        // "recule" d'une heure en UTC, sans que rien n'ait été hardcodé.
        const hourBefore = new Date(sessionBefore.openUTCMs).getUTCHours();
        const hourAfter = new Date(sessionAfter.openUTCMs).getUTCHours();
        expect(hourBefore - hourAfter).toBe(1);
    });

    it("l'heure d'ouverture EU change d'exactement 1h entre hiver (CET) et été (CEST)", () => {
        // 2024 : l'Europe bascule le dimanche 31 mars.
        const beforeDst = new Date('2024-03-01T12:00:00Z'); // CET (UTC+1)
        const afterDst = new Date('2024-04-15T12:00:00Z');  // CEST (UTC+2)

        const sessionBefore = engine.getSession('SAP.PA', beforeDst);
        const sessionAfter = engine.getSession('SAP.PA', afterDst);

        const hourBefore = new Date(sessionBefore.openUTCMs).getUTCHours();
        const hourAfter = new Date(sessionAfter.openUTCMs).getUTCHours();
        expect(hourBefore - hourAfter).toBe(1);
    });
});
