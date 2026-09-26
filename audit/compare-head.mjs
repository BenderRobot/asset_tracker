// Compare the committed engine with the working copy using synthetic data only.
// Run from the repository root: node audit/compare-head.mjs
import { execFileSync } from 'node:child_process';
import { createFakeApi, createFakeStorage, purchase } from '../tests/helpers.js';
import { HistoryCalculator as WorkingCalculator } from '../src/HistoryCalculator.js';

const root = new URL('../', import.meta.url);
const source = execFileSync('git', ['show', 'HEAD:src/HistoryCalculator.js'], { cwd: root, encoding: 'utf8' });
const resolvedSource = source.replace(/from\s+'(\.[^']+)'/g, (_, path) => `from '${new URL(path, new URL('src/', root)).href}'`);
const { HistoryCalculator: CommittedCalculator } = await import(`data:text/javascript;base64,${Buffer.from(resolvedSource).toString('base64')}`);
const RealDate = Date;
const fixedNow = RealDate.parse('2026-09-26T10:00:00Z');
globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
};
const originalLog = console.log;
const originalWarn = console.warn;
console.log = console.warn = () => {};
try {
    const candles = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [RealDate.parse(`2026-09-${17 + i}T08:00:00Z`), 100 + i]));
    const results = [];
    for (const [version, Calculator] of [['HEAD', CommittedCalculator], ['working-copy', WorkingCalculator]]) {
        for (const period of [1, 7, 30, 90, 180, 'ytd', 365, 730, 'all']) {
            const storage = createFakeStorage({ conversionRate: 1, prices: {
                AAPL: { price: 109, previousClose: 108, currency: 'EUR' },
                PRIVATE: { price: 125, previousClose: 125, currency: 'EUR' }
            } });
            const api = createFakeApi({ async getHistoricalPricesWithRetry(ticker, start, end) {
                return ticker === 'PRIVATE' ? {} : Object.fromEntries(Object.entries(candles).filter(([ts]) => Number(ts) >= start * 1000 && Number(ts) <= end * 1000));
            } });
            const graph = await new Calculator(storage, api).calculateGenericHistory([
                purchase({ ticker: 'AAPL', date: '2024-01-01' }),
                purchase({ ticker: 'PRIVATE', date: '2024-01-01' })
            ], period);
            results.push({ version, period, points: graph.values.length, finiteValues: graph.values.filter(Number.isFinite).length, finalValue: graph.values.at(-1), finalTwr: graph.twr.at(-1), dataQualityValid: graph.dataQuality.valid });
        }
    }
    originalLog(JSON.stringify(results, null, 2));
} finally {
    globalThis.Date = RealDate;
    console.log = originalLog;
    console.warn = originalWarn;
}
