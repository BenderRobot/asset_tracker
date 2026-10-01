// Read-only regression checks for the six reproductions of the 2026-10-01 audit.
// Run: node audit/screener-audit-reproductions-2026-10-01.mjs
// No network, application edits, storage access, or real Chart.js rendering.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import * as metrics from '../src/screenerMetrics.js';

const results = [];
const record = (id, observed, expected) => results.push({ id, observed, expected });

const growth = metrics.annualSeriesStats([100, null, 121]);
assert.ok(Math.abs(growth.cagr - 10) < 1e-8);
record('Q1', growth.cagr, '10 % sur deux ans ; une année manquante ne raccourcit pas la durée');

const model = metrics.fairPriceModel({
    baseMetric: 10, growthRate: 0, multiple: 15, targetReturn: 0.1,
    currentPrice: 150 / 1.1, years: 1, includeDividends: false,
});
assert.ok(Math.abs(model.estReturn - 10) < 1e-8);
record('V1', model, 'Rendement de 10 % : achat 136,36, revente 150 un an plus tard');

const rows = metrics.fundamentalRows([{
    year: '2025', endDate: '2025-12-31', annualNetIncome: 1000,
    annualDilutedAverageShares: 100, annualDilutedEPS: 10,
}]);
assert.equal(rows[0].eps, 10);
record('Q2', rows[0].eps, 'BPA publié 10 ; le nombre actuel de titres ne doit pas réécrire les exercices passés');

const paris = [{ t: Date.parse('2026-09-02T07:00:00Z'), c: 100 }];
const newYork = [
    { t: Date.parse('2026-09-01T13:30:00Z'), c: 100 },
    { t: Date.parse('2026-09-02T13:30:00Z'), c: 110 },
];
const aligned = metrics.commonSessions(paris, newYork).map(p => p.other);
assert.deepEqual(aligned, [110]);
record('R1', aligned, 'Pour une comparaison par séance, utiliser la séance du 2 septembre ; définir explicitement la convention de clôture');

const invalidModel = metrics.fairPriceModel({
    baseMetric: 10, growthRate: -2, multiple: 15, targetReturn: 0.1,
    currentPrice: 100, years: 10, includeDividends: false,
});
assert.equal(invalidModel, null);
record('V3', invalidModel, 'Rejeter une croissance de -200 % avant calcul');

// Exercise the real rendering methods without executing Firebase imports or init().
const source = fs.readFileSync(new URL('../src/screenerApp.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../screener.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://asset-tracker.fr/screener.html' });
dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
class FakeChart {
    static charts = new Map();
    constructor(canvas, config) { this.canvas = canvas; this.config = config; }
    destroy() {}
    static getChart() { return null; }
}
const loggedErrors = [];
const context = vm.createContext({
    ...metrics,
    Storage: class {},
    document: dom.window.document,
    window: dom.window,
    Chart: FakeChart,
    PROXY: 'https://example.invalid',
    logger: { error: (...args) => loggedErrors.push(String(args.at(-1))) },
    isNum: v => typeof v === 'number' && Number.isFinite(v),
});
vm.runInContext(
    source.slice(source.indexOf('class ScreenerApp'), source.indexOf("document.addEventListener('DOMContentLoaded'"))
        + '\nglobalThis.App = ScreenerApp;',
    context,
);
const app = new context.App();
app.currentSymbol = 'TEST';
app.currentData = {
    quoteSummary: { summaryDetail: { dividendYield: { raw: 0.02 }, dividendRate: { raw: 2 } } },
    currency: { quote: 'USD', priceIso: 'USD', finIso: 'USD' },
    hasFundamentals: true,
    fundamentals: [
        { year: '2024', annualNetIncome: 100, annualCommonStockDividendPaid: -10 },
        { year: '2025', annualNetIncome: 110, annualCommonStockDividendPaid: -12 },
    ],
    rows: [
        { endTs: Date.parse('2024-12-31'), dividendPerShare: 1 },
        { endTs: Date.parse('2025-12-31'), dividendPerShare: 1.2 },
    ],
};
app.safeFetchJson = async () => ({ chart: { result: [{ events: {
    dividends: { 1700000000: { amount: 1 } },
} }] } });
let dividendError = null;
try { await app.renderDividendeTab(); } catch (error) { dividendError = String(error); }
assert.equal(dividendError, null);
assert.equal(loggedErrors.length, 0);
assert.equal(app.dividendCharts.length, 3);
record('D1', { dividendError, loggedErrors }, 'Ouvrir Dividende en premier doit fonctionner sans passage par Quantitatif');

console.log(JSON.stringify(results, null, 2));
console.log(`${results.length} régressions vérifiées : les défauts reproduits lors de l'audit sont corrigés.`);
dom.window.close();
