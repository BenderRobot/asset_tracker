import { describe, expect, it } from 'vitest';
import { buildAllocationTimeline, calculateCurrentAllocation } from '../src/allocation.js';

const tx = (date, quantity, price, broker = 'A') => ({ date, quantity, price, broker });

const holdings = [
    {
        ticker: 'ETF', assetType: 'ETF', quantity: 5, invested: 500, currentValue: 1000,
        purchases: [tx('2024-01-01', 10, 100), tx('2025-01-01', -5, 150)]
    },
    {
        ticker: 'STOCK', assetType: 'Stock', quantity: 10, invested: 1000, currentValue: 500,
        purchases: [tx('2024-06-01', 10, 100)]
    }
];

describe('Asset allocation calculations', () => {
    it('uses current market values for the main allocation', () => {
        const result = calculateCurrentAllocation(holdings, 'market');
        expect(result.total).toBe(1500);
        expect(result.rows.find(row => row.type === 'ETF')).toMatchObject({ value: 1000, pct: expect.closeTo(66.666666, 4) });
        expect(result.rows.find(row => row.type === 'Stock')).toMatchObject({ value: 500, pct: expect.closeTo(33.333333, 4) });
    });

    it('includes cash in the current and invested allocation denominators', () => {
        const market = calculateCurrentAllocation(holdings, 'market', 500);
        expect(market.total).toBe(2000);
        expect(market.rows.find(row => row.type === 'Cash')).toMatchObject({ value: 500, pct: 25 });
        expect(market.rows.find(row => row.type === 'ETF').pct).toBe(50);

        const invested = calculateCurrentAllocation(holdings, 'invested', 500);
        expect(invested.total).toBe(2000);
        expect(invested.rows.find(row => row.type === 'Cash')).toMatchObject({ value: 500, pct: 25 });
    });

    it('uses the remaining canonical cost basis for invested allocation', () => {
        const result = calculateCurrentAllocation(holdings, 'invested');
        expect(result.total).toBe(1500);
        expect(result.rows.find(row => row.type === 'ETF')).toMatchObject({ value: 500, pct: expect.closeTo(33.333333, 4) });
        expect(result.rows.find(row => row.type === 'Stock')).toMatchObject({ value: 1000, pct: expect.closeTo(66.666666, 4) });
    });

    it('replays sales and makes the chart endpoint equal the current allocation', () => {
        const timeline = buildAllocationTimeline(holdings, 'market', new Date('2026-10-04T12:00:00Z'));
        expect(timeline.points.at(-1).values).toMatchObject({ ETF: 1000, Stock: 500 });
        expect(timeline.points.at(-1).pcts.ETF).toBeCloseTo(66.666666, 4);
        expect(timeline.points.at(-1).pcts.Stock).toBeCloseTo(33.333333, 4);
    });

    it('keeps canonical EUR invested amounts when raw purchases were in another currency', () => {
        const usdHolding = [{
            ticker: 'USD', assetType: 'Stock', quantity: 10, invested: 920, currentValue: 1100,
            purchases: [tx('2024-01-01', 10, 100)]
        }];
        const timeline = buildAllocationTimeline(usdHolding, 'invested', new Date('2026-10-04T12:00:00Z'));
        expect(timeline.total).toBe(920);
        expect(timeline.points.at(-1).values.Stock).toBe(920);
    });

    it('replays cash movements and keeps the endpoint equal to canonical cash', () => {
        const cash = [
            { ticker: 'EUR', assetType: 'Cash', currency: 'EUR', price: 800, quantity: 1, date: '2024-01-01' },
            { ticker: 'EUR', assetType: 'Cash', currency: 'EUR', price: -300, quantity: 1, date: '2025-01-01' }
        ];
        const timeline = buildAllocationTimeline(holdings, 'market', new Date('2026-10-04T12:00:00Z'), 500, cash);
        expect(timeline.points.at(-1).values.Cash).toBe(500);
        expect(timeline.points.at(-1).pcts.Cash).toBe(25);
    });

    it('fails closed when a current market value is unavailable', () => {
        const result = calculateCurrentAllocation([
            ...holdings,
            { ticker: 'MISSING', assetType: 'ETF', quantity: 1, invested: 100, currentValue: null }
        ], 'market');
        expect(result.valid).toBe(false);
        expect(result.unavailable).toEqual(['MISSING']);
    });
});
