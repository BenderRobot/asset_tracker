// VALIDATION ARCHITECTURE (2026-09-24) — HistoricalPointStore, en isolation
// (logique pure, aucun réseau). Voir api.js::getHistoricalPricesWithRetry
// pour l'intégration (tests réseau dans historicalDeltaFetch.test.js).
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { HistoricalPointStore, isDeltaFetchEligible } from '../src/historicalPointStore.js';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => localStorage.clear());

describe('isDeltaFetchEligible', () => {
    it('daily et plus longs éligibles, intraday jamais', () => {
        expect(isDeltaFetchEligible('1d')).toBe(true);
        expect(isDeltaFetchEligible('1wk')).toBe(true);
        expect(isDeltaFetchEligible('1mo')).toBe(true);
        expect(isDeltaFetchEligible('5m')).toBe(false);
        expect(isDeltaFetchEligible('15m')).toBe(false);
        expect(isDeltaFetchEligible('90m')).toBe(false);
    });
});

describe('HistoricalPointStore.planFetch', () => {
    it('aucune donnée connue -> plan "full" sur la plage demandée telle quelle', () => {
        const store = new HistoricalPointStore();
        const plan = store.planFetch('AAPL', '1d', 1000, 2000);
        expect(plan).toEqual({ plan: 'full', fetchStartTs: 1000, fetchEndTs: 2000 });
    });

    it('intervalle intraday -> toujours "full", même avec des points déjà connus', () => {
        const store = new HistoricalPointStore();
        store.merge('AAPL', '5m', { [Date.now() - 10 * DAY]: 100 });
        const plan = store.planFetch('AAPL', '5m', 0, Math.floor(Date.now() / 1000));
        expect(plan.plan).toBe('full');
    });

    it('historique déjà présent et clôturé jusqu\'à "maintenant" -> plan "none" (0 fetch)', () => {
        const store = new HistoricalPointStore();
        const now = new Date('2026-09-20T12:00:00Z').getTime();
        const startTs = Math.floor((now - 5 * DAY) / 1000);
        const endTs = Math.floor(now / 1000);

        // Points quotidiens couvrant toute la plage, tous à des jours
        // calendaires STRICTEMENT antérieurs à "now".
        const points = {};
        for (let d = 5; d >= 1; d--) points[now - d * DAY] = 100 + d;
        store.merge('AAPL', '1d', points);

        const plan = store.planFetch('AAPL', '1d', startTs, endTs, now);
        expect(plan.plan).toBe('none');

        const known = store.getKnownPoints('AAPL', '1d', startTs, endTs);
        expect(Object.keys(known).length).toBe(5);
    });

    it('historique partiellement présent (derniers jours manquants) -> plan "delta", seulement les nouveaux jours', () => {
        const store = new HistoricalPointStore();
        const now = new Date('2026-09-20T12:00:00Z').getTime();
        const startTs = Math.floor((now - 10 * DAY) / 1000);
        const endTs = Math.floor(now / 1000);

        // Ne connaît que les jours -10 à -3 (les jours -2, -1 et aujourd'hui manquent).
        const points = {};
        for (let d = 10; d >= 3; d--) points[now - d * DAY] = 100 + d;
        store.merge('AAPL', '1d', points);

        const plan = store.planFetch('AAPL', '1d', startTs, endTs, now);
        expect(plan.plan).toBe('delta');
        // Le delta doit démarrer juste après le dernier jour clôturé connu (-3),
        // jamais reprendre depuis le tout début de la plage originale.
        expect(plan.fetchStartTs).toBeGreaterThan(startTs);
        expect(plan.fetchStartTs).toBeLessThanOrEqual(endTs);
    });

    it('couverture connue ne commence pas au début de la plage demandée -> "full" (sécurité, pas de delta hasardeux)', () => {
        const store = new HistoricalPointStore();
        const now = new Date('2026-09-20T12:00:00Z').getTime();
        // Ne connaît QUE les 2 derniers jours, mais la plage demandée remonte à 30 jours.
        const points = { [now - 2 * DAY]: 100, [now - 1 * DAY]: 101 };
        store.merge('AAPL', '1d', points);

        const startTs = Math.floor((now - 30 * DAY) / 1000);
        const endTs = Math.floor(now / 1000);
        const plan = store.planFetch('AAPL', '1d', startTs, endTs, now);
        expect(plan.plan).toBe('full');
    });

    it('le point du jour même (déjà en cache ou non) ne déclenche jamais, à lui seul, un nouveau fetch — sa valeur vient du prix live ailleurs dans l\'app, pas de cet endpoint daily', () => {
        const store = new HistoricalPointStore();
        const now = new Date('2026-09-20T12:00:00Z').getTime();
        const startTs = Math.floor((now - 3 * DAY) / 1000);
        const endTs = Math.floor(now / 1000);

        const points = {};
        for (let d = 3; d >= 0; d--) points[now - d * DAY] = 100 + d; // inclut le jour même (d=0)
        store.merge('AAPL', '1d', points);

        const plan = store.planFetch('AAPL', '1d', startTs, endTs, now);
        // Le dernier jour clôturé connu est -1 (hier) ; le jour 0 n'étant
        // jamais clôturé, il n'y a rien de plus à demander de façon sûre.
        expect(plan.plan).toBe('none');
    });
});

describe('HistoricalPointStore.merge / persistance', () => {
    it('merge() fusionne sans écraser les points existants d\'un autre appel', () => {
        const store = new HistoricalPointStore();
        store.merge('AAPL', '1d', { 1000000: 10 });
        store.merge('AAPL', '1d', { 2000000: 20 });

        const known = store.getKnownPoints('AAPL', '1d', 0, 3000);
        expect(known[1000000]).toBe(10);
        expect(known[2000000]).toBe(20);
    });

    it('merge() est un no-op pour un intervalle intraday (hors périmètre delta-fetch)', () => {
        const store = new HistoricalPointStore();
        store.merge('AAPL', '5m', { 1000000: 10 });
        expect(store.getKnownPoints('AAPL', '5m', 0, 3000)).toEqual({});
    });

    it('un nouveau HistoricalPointStore recharge les points persistés en localStorage', () => {
        const store1 = new HistoricalPointStore();
        store1.merge('MSFT', '1d', { 5000000: 55 });

        const store2 = new HistoricalPointStore();
        const known = store2.getKnownPoints('MSFT', '1d', 0, 6000);
        expect(known[5000000]).toBe(55);
    });

    it('deux tickers différents ne partagent jamais leurs points', () => {
        const store = new HistoricalPointStore();
        store.merge('AAPL', '1d', { 1000000: 10 });
        store.merge('MSFT', '1d', { 1000000: 999 });

        expect(store.getKnownPoints('AAPL', '1d', 0, 2000)[1000000]).toBe(10);
        expect(store.getKnownPoints('MSFT', '1d', 0, 2000)[1000000]).toBe(999);
    });
});
