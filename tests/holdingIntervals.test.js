// Audit 2026-09-28, point 4 (A3): only instruments held during a window —
// from its reference close (yesterday's quantity) through today's trades —
// are fetched and may invalidate it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFailedHistoricalResult } from '../src/api.js';
import { createFakeApi, createFakeStorage, purchase } from './helpers.js';

const at = iso => Date.parse(iso);
const week = Object.fromEntries(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'].map(d => [at(`${d}T12:00:00Z`), 100]));
const today = { [at('2026-09-24T08:00:00Z')]: 100, [at('2026-09-24T10:00:00Z')]: 102 };

function manager(history, prices = {}) {
    const api = createFakeApi({
        getHistoricalPricesWithRetry: vi.fn(async ticker => ticker === 'OLD' ? createFailedHistoricalResult({ status: 404 }) : history)
    });
    return new DataManager(createFakeStorage({ conversionRate: 1, prices }), api);
}

describe('useful holding intervals', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
        localStorage.clear();
    });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('A3 fixed: a line sold long ago and no longer quoted does not blank the current week', async () => {
        const dm = manager(week);
        const graph = await dm.calculateHistory([
            purchase({ ticker: 'OLD', date: '2024-01-01' }),
            purchase({ ticker: 'OLD', date: '2025-01-01', quantity: -1 }),
            purchase({ ticker: 'HELD', date: '2026-09-01' })
        ], 7);
        expect(graph.dataQuality).toMatchObject({ valid: true, failedInstruments: [] });
        expect(graph.values.some(Number.isFinite)).toBe(true);
        expect(dm.api.getHistoricalPricesWithRetry.mock.calls.map(([t]) => t)).not.toContain('OLD');
    });

    it('a held line that fails still invalidates values AND performance', async () => {
        const graph = await manager(week).calculateHistory([
            purchase({ ticker: 'OLD', date: '2026-09-01' }),
            purchase({ ticker: 'HELD', date: '2026-09-01' })
        ], 7);
        expect(graph.dataQuality).toMatchObject({ valid: false, failedInstruments: ['OLD'] });
        expect(graph.values.every(v => v === null)).toBe(true);
        expect(graph.twr.every(v => v === null)).toBe(true);
    });

    it('keeps the lines needed for today\'s measure: yesterday\'s quantity and today\'s sale', () => {
        const dm = manager(today);
        const rows = [
            purchase({ ticker: 'SOLDTODAY', date: '2026-09-01' }),
            purchase({ ticker: 'SOLDTODAY', date: '2026-09-24T09:00:00Z', quantity: -1 }),
            purchase({ ticker: 'BOUGHTTODAY', date: '2026-09-24T09:30:00Z' }),
            purchase({ ticker: 'HELD', date: '2026-09-01' }),
            purchase({ ticker: 'OLD', date: '2024-01-01' }),
            purchase({ ticker: 'OLD', date: '2025-01-01', quantity: -1 }),
            purchase({ ticker: 'EUR', assetType: 'Cash', price: 50, date: '2026-09-01' })
        ];
        expect(dm.requiredMarketTickers(rows, 1).sort()).toEqual(['BOUGHTTODAY', 'HELD', 'SOLDTODAY']);
        // A long period still requires what was held during it.
        expect(dm.requiredMarketTickers(rows, 'all')).toContain('OLD');
    });

    it("allocates day P&L by each broker's quantity at the previous close", async () => {
        const history = {
            [at('2026-09-23T16:00:00Z')]: 100,
            [at('2026-09-24T10:00:00Z')]: 120
        };
        const quote = { price: 120, previousClose: 100, currency: 'EUR', lastUpdate: Date.now() };
        const dm = manager(history, { AAPL: quote });
        const rows = [
            purchase({ ticker: 'AAPL', broker: 'OLD-BROKER', date: '2026-09-01' }),
            purchase({ ticker: 'AAPL', broker: 'NEW-BROKER', date: '2026-09-24T09:00:00Z', price: 120 })
        ];

        const result = await dm.calculateDayChangeByBroker(rows);

        expect(result.find(b => b.broker === 'OLD-BROKER').dayChange).toBe(20);
        expect(result.find(b => b.broker === 'NEW-BROKER').dayChange).toBe(0);
        expect(result.reduce((sum, broker) => sum + broker.dayChange, 0)).toBe(20);
    });

    it('the snapshot repository prices only held lines, so an unquoted old line cannot block it', async () => {
        const quote = { price: 102, previousClose: 100, currency: 'EUR', lastUpdate: Date.now() };
        const dm = manager(today, { HELD: quote });
        dm.api.liveFailures = new Map([['OLD', { reason: 'Proxy HTTP 404' }]]);
        dm.api.fetchBatchPrices = vi.fn(async () => true);
        const rows = [
            purchase({ ticker: 'OLD', date: '2024-01-01' }),
            purchase({ ticker: 'OLD', date: '2025-01-01', quantity: -1 }),
            purchase({ ticker: 'HELD', date: '2026-09-01' })
        ];
        const result = await dm.repository.getSnapshot(rows, []);
        expect(dm.api.fetchBatchPrices).toHaveBeenCalledWith(['HELD'], false);
        expect(result.snapshot.portfolioSnapshot.status).toBe('valid');
        expect(result.snapshot.portfolioSnapshot.totalValue).toBe(102);
    });
});
