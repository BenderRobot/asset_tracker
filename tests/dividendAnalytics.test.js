import { describe, expect, it } from 'vitest';
import { buildDividendAnalytics, aggregateByPeriod, periodRange } from '../src/dividendAnalytics.js';

const NOW = new Date('2026-10-07T12:00:00');
const div = (ticker, date, price, extra = {}) => ({ type: 'dividend', ticker, name: `${ticker} Corp`, date, price, quantity: 1, currency: 'EUR', broker: 'TR', ...extra });

describe('buildDividendAnalytics', () => {
    it('calcule totaux, 12 mois glissants et croissance', () => {
        const data = buildDividendAnalytics([
            div('KO', '2024-12-15', 10),
            div('KO', '2025-03-15', 10),
            div('KO', '2025-12-15', 12),
            div('KO', '2026-03-15', 12),
            div('KO', '2026-06-15', 12),
            div('KO', '2026-09-15', 12)
        ], { now: NOW });

        expect(data.kpis.total).toBe(68);
        expect(data.kpis.ttm).toBe(48);
        expect(data.kpis.prevTtm).toBe(20);
        expect(data.kpis.ttmGrowthPct).toBeCloseTo(140);
        expect(data.kpis.ytd).toBe(36);
        expect(data.kpis.prevYtd).toBe(10);
        expect(data.kpis.payerCount).toBe(1);
    });

    it('exclut les dividendes non convertibles et le signale', () => {
        const data = buildDividendAnalytics([
            div('KO', '2026-01-15', 10),
            div('AAPL', '2026-01-15', 5, { currency: 'USD' })
        ], { now: NOW, toEUR: d => (d.currency === 'EUR' ? d.price : null) });

        expect(data.kpis.total).toBe(10);
        expect(data.excludedCount).toBe(1);
    });

    it('détecte la fréquence, projette les actifs détenus et calcule les rendements', () => {
        const payments = ['2025-10-01', '2026-01-01', '2026-04-01', '2026-07-01'].map(d => div('KO', d, 25));
        const data = buildDividendAnalytics([...payments, div('OLD', '2025-11-01', 50)], {
            now: NOW,
            holdings: [{ ticker: 'KO', name: 'Coca-Cola', quantity: 10, invested: 2000, currentValue: 2500 }]
        });

        const ko = data.assets.find(a => a.ticker === 'KO');
        expect(ko.frequency).toBe('Trimestriel');
        expect(ko.held).toBe(true);
        expect(ko.name).toBe('Coca-Cola');
        expect(ko.projectedAnnual).toBe(100);
        expect(ko.yieldOnCost).toBeCloseTo(5);
        expect(ko.currentYield).toBeCloseTo(4);
        expect(ko.nextExpected.toISOString().slice(0, 7)).toBe('2026-09');

        const old = data.assets.find(a => a.ticker === 'OLD');
        expect(old.held).toBe(false);
        expect(old.projectedAnnual).toBe(0);
        expect(data.kpis.projectedAnnual).toBe(100);
        expect(data.kpis.heldPayerCount).toBe(1);
        expect(data.upcoming.length).toBeGreaterThanOrEqual(4);
    });

    it('fusionne les versements du même évènement répartis sur plusieurs courtiers', () => {
        const data = buildDividendAnalytics([
            div('KO', '2026-01-01', 10, { broker: 'A' }),
            div('KO', '2026-01-03', 5, { broker: 'B' }),
            div('KO', '2026-04-01', 15)
        ], { now: NOW });
        const ko = data.assets[0];
        expect(ko.count).toBe(3);
        expect(ko.eventCount).toBe(2);
        expect(ko.frequency).toBe('Trimestriel');
        expect(data.brokers.map(b => b.broker)).toEqual(['TR', 'A', 'B']);
    });
});

describe('aggregateByPeriod', () => {
    it('remplit les périodes vides et regroupe les actifs hors top en "Autres"', () => {
        const { payments } = buildDividendAnalytics([div('KO', '2026-01-10', 10), div('PG', '2026-03-10', 4)], { now: NOW });
        const s = aggregateByPeriod(payments, 'month', { now: new Date('2026-04-01'), tickers: new Set(['KO']) });
        expect(s.labels).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
        expect(s.total).toEqual([10, 0, 4, 0]);
        expect(s.byAsset.get('KO')).toEqual([10, 0, 0, 0]);
        expect(s.byAsset.get('__other__')).toEqual([0, 0, 4, 0]);
    });

    it('produit des trimestres et années continus', () => {
        expect(periodRange(new Date('2025-11-01'), new Date('2026-05-01'), 'quarter')).toEqual(['2025-T4', '2026-T1', '2026-T2']);
        expect(periodRange(new Date('2024-05-01'), new Date('2026-05-01'), 'year')).toEqual(['2024', '2025', '2026']);
    });
});
