import { describe, expect, it } from 'vitest';
import { companyCalendarCandidates, parseUpcomingEarnings, selectPortfolioNewsSignals } from '../src/dashboardPortfolioRadar.js';

const now = Date.parse('2026-10-13T18:00:00Z');

describe('Dashboard portfolio radar', () => {
    it('pairs recent, explicitly matched headlines with the largest actual losses without inventing a cause', () => {
        const snapshot = {
            status: 'valid', dayPnl: -95, totalValue: 1000,
            positions: [
                { ticker: 'AMAT', name: 'Applied Materials', quantity: 1, dayPnl: -70, dayPnlPct: -8, currentValue: 500 },
                { ticker: 'AAPL', name: 'Apple', quantity: 1, dayPnl: -25, dayPnlPct: -2, currentValue: 500 }
            ]
        };
        const articles = [
            { title: 'Applied Materials publie ses résultats', assetName: 'Applied Materials', datetime: (now - 3600000) / 1000 },
            { title: 'Apple dévoile un produit', assetName: 'Apple', datetime: (now - 3 * 86400000) / 1000 },
            { title: 'Le CAC 40 recule', datetime: (now - 3600000) / 1000 }
        ];
        const result = selectPortfolioNewsSignals(snapshot, articles, now);
        expect(result.rows.map(row => [row.ticker, row.impact])).toEqual([['AMAT', -70], ['AAPL', -25]]);
        expect(result.rows[0].article).toBe(articles[0]);
        expect(result.rows[1].article).toBeNull();
        expect(selectPortfolioNewsSignals(snapshot, articles, now, { previousSession: true })).toEqual({ status: 'previous-session', rows: [] });
    });

    it('uses provider dates only, marks estimates, and ignores past dates', () => {
        const holding = { ticker: 'AMAT', name: 'Applied Materials', providerSymbol: 'AMAT' };
        const summary = { calendarEvents: { earnings: {
            earningsDate: [{ raw: (now + 7 * 86400000) / 1000 }], isEarningsDateEstimate: true
        } } };
        expect(parseUpcomingEarnings(holding, summary, now)).toMatchObject({ ticker: 'AMAT', date: now + 7 * 86400000, estimated: true });
        expect(parseUpcomingEarnings(holding, { calendarEvents: { earnings: { earningsDate: [{ raw: (now - 7 * 86400000) / 1000 }] } } }, now)).toBeNull();
        expect(parseUpcomingEarnings(holding, {}, now)).toBeNull();
    });

    it('requests only live company holdings and maps local ticker aliases', () => {
        const holdings = [
            { ticker: 'APC', name: 'Apple', quantity: 4, assetType: 'Stock' },
            { ticker: 'CSPX', name: 'S&P 500', quantity: 2, assetType: 'ETF' },
            { ticker: 'SOI', name: 'Soitec', quantity: 0, assetType: 'Stock' }
        ];
        expect(companyCalendarCandidates(holdings)).toEqual([{ ticker: 'APC', providerSymbol: 'APC.F', name: 'Apple' }]);
    });
});
