// Audit 2026-09-28, point 6 (A5/A6): a valuation at instant T may only read
// observations available at T. Session date and observation instant are
// distinct notions for daily bars.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { findClosestPrice } from '../src/MarketUtils.js';
import { createFakeApi, createFakeStorage, purchase } from './helpers.js';

const at = iso => Date.parse(iso);
const noon = date => at(`${date}T12:00:00Z`);

function manager(historyByTicker) {
    return new DataManager(createFakeStorage({ conversionRate: 1 }), createFakeApi({
        async getHistoricalPricesWithRetry(ticker) {
            return typeof historyByTicker === 'function' ? historyByTicker(ticker) : historyByTicker;
        }
    }));
}

describe('temporal causality of the valuation engine', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-26T10:00:00Z'));
        localStorage.clear();
    });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('A5 fixed: the session in progress is observed now, never at a future 23:59:59', async () => {
        const history = Object.fromEntries(['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'].map(d => [noon(d), 100]));
        history[at('2026-09-26T08:00:00Z')] = 101;
        const graph = await manager(history).calculateHistory([purchase({ date: '2026-09-01' })], 90);

        expect(graph.timestamps.every(ts => ts <= Date.now())).toBe(true);
        expect(graph.timestamps.at(-1)).toBe(Date.now());
        expect(graph.values.at(-1)).toBe(101);
        expect(graph.pointMeta.at(-1).sessionDate).toBe('2026-09-26');

        // A closed session keeps its end-of-day availability instant.
        const i = graph.pointMeta.findIndex(p => p.sessionDate === '2026-09-25');
        expect(graph.timestamps[i]).toBe(at('2026-09-25T23:59:59.999Z'));
        expect(graph.values[i]).toBe(100);
    });

    it('A6 fixed: the price lookup keeps the last known observation over a nearer future one', () => {
        const target = noon('2026-09-24');
        const history = { [target - 23 * 3600000]: 100, [target + 3600000]: 120 };
        expect(findClosestPrice(history, target, '1d')).toBe(100);
        expect(findClosestPrice(history, target, '90m')).toBe(100);
        // Forward snapping remains an explicit, visual-only opt-in.
        expect(findClosestPrice(history, target, '1d', true)).toBe(120);
        // Nothing observed yet: no value rather than a future one.
        expect(findClosestPrice({ [target + 3600000]: 120 }, target, '1d')).toBeNull();
    });

    it('a crypto position is valued at T with its last past quote, not with T+1h', async () => {
        const T = noon('2026-09-24');
        const graph = await manager(ticker => ticker === 'BTC-EUR'
            ? { [T - 23 * 3600000]: 100, [T + 3600000]: 120 }
            : { [T - 23 * 3600000]: 50, [T]: 50, [T + 3600000]: 50 })
            .calculateHistory([
                purchase({ ticker: 'AAPL', date: '2026-09-01', price: 50 }),
                purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', date: '2026-09-01' })
            ], 30);
        const i = graph.timestamps.indexOf(T);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(graph.values[i]).toBe(150);
        expect(graph.values[graph.timestamps.indexOf(T + 3600000)]).toBe(170);
    });

    it('a 1D series never contains a point after the calculation instant', async () => {
        vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
        const graph = await manager({
            [at('2026-09-24T08:00:00Z')]: 100,
            [at('2026-09-24T09:00:00Z')]: 101,
            [at('2026-09-24T11:00:00Z')]: 150
        }).calculateHistory([purchase({ date: '2026-09-01' })], 1);
        expect(graph.timestamps.length).toBeGreaterThan(0);
        expect(Math.max(...graph.timestamps)).toBeLessThanOrEqual(Date.now());
        expect(graph.values).not.toContain(150);
    });
});
