import { describe, expect, it } from 'vitest';
import {
    FUTURE_ACCENT_COLOR,
    getIndexFuture,
    isFutureSessionAvailable,
    selectIndexDisplayInstrument
} from '../src/indexFutures.js';

describe('Dashboard index futures', () => {
    it('maps the supported followed indices to explicit futures contracts', () => {
        expect(getIndexFuture('^GSPC')).toMatchObject({ ticker: 'ES=F', code: 'ES' });
        expect(getIndexFuture('^IXIC')).toMatchObject({ ticker: 'NQ=F', code: 'NQ' });
        expect(getIndexFuture('^DJI')).toMatchObject({ ticker: 'YM=F', code: 'YM' });
        expect(getIndexFuture('^RUT')).toMatchObject({ ticker: 'RTY=F', code: 'RTY' });
        expect(getIndexFuture('^N225')).toMatchObject({ ticker: 'NKD=F', code: 'NKD' });
        expect(FUTURE_ACCENT_COLOR).toBe('#a855f7');
    });

    it('uses the future while the cash index is closed on a weekday', () => {
        const mondayEvening = new Date(2026, 9, 5, 22, 30);
        expect(selectIndexDisplayInstrument('^GSPC', 'POST_MARKET', mondayEvening)).toMatchObject({
            ticker: 'ES=F', isFuture: true, future: { code: 'ES' }
        });
    });

    it('keeps the cash index during its regular session', () => {
        const mondayOpen = new Date(2026, 9, 5, 17, 0);
        expect(selectIndexDisplayInstrument('^GSPC', 'MARKET_OPEN', mondayOpen)).toEqual({
            ticker: '^GSPC', isFuture: false, future: null
        });
    });

    it('does not present a stale weekend quote as an active future', () => {
        expect(isFutureSessionAvailable(new Date(2026, 9, 3, 12, 0))).toBe(false);
        expect(selectIndexDisplayInstrument('^GSPC', 'WEEKEND', new Date(2026, 9, 3, 12, 0))).toEqual({
            ticker: '^GSPC', isFuture: false, future: null
        });
    });

    it('fails closed for an index whose future is unavailable from the proxy', () => {
        expect(selectIndexDisplayInstrument('^FCHI', 'POST_MARKET', new Date(2026, 9, 5, 20, 0))).toEqual({
            ticker: '^FCHI', isFuture: false, future: null
        });
    });
});
