// @vitest-environment jsdom
// Buy/sell markers of the single-asset unit-price chart: position on the
// displayed point of the transaction day, side, and tooltip rows.
import { describe, it, expect, vi } from 'vitest';
import { HistoryCalculator } from '../src/HistoryCalculator.js';
import { HistoricalChart } from '../src/historicalChart.js';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi } from './helpers.js';

const H = 3600000;
const ledgerOf = (...entries) => ({ byTicker: new Map([['EUEA.AS', entries]]) });
const entry = (date, price, quantity) => ({ date: new Date(date), price, quantity, currency: 'EUR', broker: 'RV-CT' });

describe('Transaction markers', () => {
    // 1M-like intraday series: several candles per day sharing one label.
    const days = ['2026-09-23', '2026-09-24', '2026-09-25'];
    const timestamps = days.flatMap(d => [7, 10, 13].map(h => Date.parse(`${d}T00:00:00Z`) + h * H));
    const labels = timestamps.map(ts => new Date(ts).toISOString().slice(0, 10));
    const unitPrices = [64.0, 64.1, 64.2, 64.5, 64.17, 63.9, 64.3, 64.4, 64.2];
    const win = { displayStartTs: timestamps[0] - 12 * H, displayEndTs: timestamps.at(-1) + H };

    it('places a sale on its own day, on the candle closest to the executed price', () => {
        const calc = new HistoryCalculator(createFakeStorage(), createFakeApi());
        const points = calc._buildPurchasePoints(ledgerOf(entry('2026-09-24', 64.17, -12)), 'EUEA.AS',
            timestamps, labels, 30, win, 1, null, unitPrices);
        expect(points).toHaveLength(1);
        expect(points[0]).toMatchObject({ x: 4, y: 64.17, quantity: 12, side: 'sell', label: '2026-09-24' });
    });

    it('marks buys and falls back to the nearest point for a non-trading day', () => {
        const calc = new HistoryCalculator(createFakeStorage(), createFakeApi());
        const points = calc._buildPurchasePoints(ledgerOf(entry('2026-09-26', 64.4, 3)), 'EUEA.AS',
            timestamps, labels, 30, { ...win, displayEndTs: Date.parse('2026-09-27T00:00:00Z') }, 1, null, unitPrices);
        expect(points[0]).toMatchObject({ x: 8, side: 'buy', quantity: 3 });
    });

    it('lists the transactions of the hovered point in the tooltip', () => {
        const storage = createFakeStorage();
        const chart = new HistoricalChart(storage, new DataManager(storage, createFakeApi()), null, {
            filterManager: { getSelectedTickers: () => new Set() },
            getFilteredPurchasesFromPage: () => [], getChartTitleConfig: () => ({}), renderData: vi.fn()
        });
        chart.currentPeriod = 30;
        const graphData = { purchasePoints: [
            { x: 4, y: 64.17, quantity: 12, side: 'sell' },
            { x: 4, y: 64.2, quantity: 1, side: 'buy' },
            { x: 6, y: 64.3, quantity: 5, side: 'buy' }
        ] };
        const eurFmt = n => `${n.toFixed(2)} €`;
        const rows = chart._buildKpiRows(4, { graphData, displayValues: unitPrices, isUnitView: true, eurFmt, pctFmt: String });
        expect(rows.map(r => [r.label, r.eur, r.positive])).toEqual([
            ['Prix', '64.17 €', true],
            ['Vente · 12 parts', '64.17 €', false],
            ['Achat · 1 part', '64.20 €', true]
        ]);
    });
});
