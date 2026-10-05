import { describe, expect, it } from 'vitest';
import {
    buildAppDataContext, buildTrackedIndicesContext,
    NOTIFICATION_CONTEXT_KEY, SCREENER_CONTEXT_KEY
} from '../src/appDataContext.js';

function memoryStorage(entries = {}) {
    return {
        getItem: key => entries[key] ?? null,
        setItem: (key, value) => { entries[key] = value; }
    };
}

describe('other application module context', () => {
    it('labels a tracked future explicitly and keeps cash/future quotes separate', () => {
        const now = Date.parse('2026-10-05T10:00:00Z');
        const [row] = buildTrackedIndicesContext(
            [{ ticker: '^GSPC', name: 'S&P 500', format: 'index' }],
            {
                '^GSPC': { price: 7000, changePercent: 1, lastUpdate: now },
                'ES=F': { price: 7010, changePercent: 0.3, lastUpdate: now }
            },
            { now }
        );
        expect(row).toMatchObject({ ticker: '^GSPC', price: 7000 });
        expect(row.future).toMatchObject({ ticker: 'ES=F', code: 'ES', label: 'FUTURE', price: 7010 });
    });

    it('reads screener and only the current user notification cache', () => {
        const now = Date.parse('2026-10-05T10:00:00Z');
        const storage = memoryStorage({
            [SCREENER_CONTEXT_KEY]: JSON.stringify({ ticker: 'AAPL', currentPrice: 200, updatedAt: now }),
            [NOTIFICATION_CONTEXT_KEY]: JSON.stringify({
                userId: 'user-a', updatedAt: now,
                settings: { stocks: { enabled: true, threshold: 3 } },
                rules: [{ asset: 'AAPL', metric: 'price', value: 180 }]
            })
        });
        expect(buildAppDataContext({ storage, userId: 'user-a', now }).notifications.rules).toHaveLength(1);
        expect(buildAppDataContext({ storage, userId: 'user-b', now }).notifications).toBeNull();
    });
});
