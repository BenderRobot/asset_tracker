// Fixtures below are REAL responses captured live from this project's own
// Cloudflare price proxy (asset-tracker-prices.blaurens31.workers.dev) during
// the Phase 2.5 audit — not invented shapes. Trimmed to the fields relevant
// here; irrelevant candle arrays omitted.
import { describe, it, expect } from 'vitest';
import { MarketCalendarEngine } from '../src/MarketCalendarEngine.js';

const REAL_AAPL_META = {
    currency: 'USD', symbol: 'AAPL', exchangeName: 'NMS', fullExchangeName: 'NasdaqGS',
    instrumentType: 'EQUITY', firstTradeDate: 345479400, regularMarketTime: 1790102772,
    hasPrePostMarketData: true, gmtoffset: -14400, timezone: 'EDT',
    exchangeTimezoneName: 'America/New_York', regularMarketPrice: 341.21,
    chartPreviousClose: 336.13, priceHint: 2,
    currentTradingPeriod: {
        pre: { timezone: 'EDT', start: 1790064000, end: 1790083800, gmtoffset: -14400 },
        regular: { timezone: 'EDT', start: 1790083800, end: 1790107200, gmtoffset: -14400 },
        post: { timezone: 'EDT', start: 1790107200, end: 1790121600, gmtoffset: -14400 }
    },
    dataGranularity: '1d', range: '2d'
    // NOTE: no `marketState` key — confirmed absent from the real response.
};

const REAL_AAPL_META_INTRADAY_WITH_TRADING_PERIODS = {
    ...REAL_AAPL_META,
    dataGranularity: '5m', range: '1d',
    tradingPeriods: [[{ timezone: 'EDT', start: 1790083800, end: 1790107200, gmtoffset: -14400 }]]
};

const REAL_SU_PA_META = {
    currency: 'EUR', symbol: 'SU.PA', exchangeName: 'PAR', fullExchangeName: 'Paris',
    instrumentType: 'EQUITY', gmtoffset: 7200, timezone: 'CEST',
    exchangeTimezoneName: 'Europe/Paris',
    currentTradingPeriod: {
        regular: { timezone: 'CEST', start: 1790060400, end: 1790091000, gmtoffset: 7200 }
    },
    dataGranularity: '1d', range: '2d'
};

const REAL_BTC_EUR_META = {
    currency: 'EUR', symbol: 'BTC-EUR', exchangeName: 'CCC', fullExchangeName: 'CCC',
    instrumentType: 'CRYPTOCURRENCY', gmtoffset: 0, timezone: 'UTC',
    exchangeTimezoneName: 'UTC',
    currentTradingPeriod: {
        regular: { timezone: 'UTC', start: 1790035200, end: 1790121540, gmtoffset: 0 }
    },
    dataGranularity: '1d', range: '2d'
};

describe('TEST metadata 1 — exchangeTimezoneName du provider est utilisé quand fourni', () => {
    it('AAPL : America/New_York, exactement la valeur Yahoo, pas une déduction', () => {
        const engine = new MarketCalendarEngine();
        engine.ingestProviderMetadata('AAPL', REAL_AAPL_META);
        expect(engine.getTimezone('AAPL')).toBe('America/New_York');
        expect(engine.getTimezoneSource('AAPL')).toBe('provider');
    });

    it('SU.PA : Europe/Paris, exactement la valeur Yahoo', () => {
        const engine = new MarketCalendarEngine();
        engine.ingestProviderMetadata('SU.PA', REAL_SU_PA_META);
        expect(engine.getTimezone('SU.PA')).toBe('Europe/Paris');
        expect(engine.getTimezoneSource('SU.PA')).toBe('provider');
    });

    it('BTC-EUR : instrumentType CRYPTOCURRENCY du provider classe en 24/7 (pas la liste de tickers codée en dur)', () => {
        const engine = new MarketCalendarEngine();
        engine.ingestProviderMetadata('BTC-EUR', REAL_BTC_EUR_META);
        expect(engine.getTradingModel('BTC-EUR')).toBe('crypto_24_7');
        expect(engine.getTimezone('BTC-EUR')).toBe('UTC');
    });
});

describe("TEST metadata 2 — sans exchangeTimezoneName, repli heuristique documenté", () => {
    it("un ticker jamais ingéré retombe sur l'heuristique par suffixe, explicitement identifiable", () => {
        const engine = new MarketCalendarEngine();
        expect(engine.getTimezone('NVDA')).toBe('America/New_York');
        expect(engine.getTimezoneSource('NVDA')).toBe('heuristic-fallback');
    });
});

describe('TEST metadata 3 — tradingPeriods / currentTradingPeriod résolvent une vraie session', () => {
    it('la session régulière AAPL résolue correspond exactement aux bornes réelles Yahoo (en ms)', () => {
        const engine = new MarketCalendarEngine();
        engine.ingestProviderMetadata('AAPL', REAL_AAPL_META_INTRADAY_WITH_TRADING_PERIODS);
        const today = new Date(REAL_AAPL_META.currentTradingPeriod.regular.start * 1000);
        const session = engine.getSession('AAPL', today);

        expect(session.source).toBe('provider');
        expect(session.openUTCMs).toBe(REAL_AAPL_META.currentTradingPeriod.regular.start * 1000);
        expect(session.closeUTCMs).toBe(REAL_AAPL_META.currentTradingPeriod.regular.end * 1000);
    });

    it('ne confond jamais pre/post-market avec la session régulière (seule `regular` est exploitée)', () => {
        const engine = new MarketCalendarEngine();
        engine.ingestProviderMetadata('AAPL', REAL_AAPL_META);
        const today = new Date(REAL_AAPL_META.currentTradingPeriod.regular.start * 1000);
        const session = engine.getSession('AAPL', today);

        // La session résolue doit correspondre à `regular`, pas à `pre` (qui commence
        // plus tôt) ni `post` (qui finit plus tard).
        expect(session.openUTCMs).toBe(REAL_AAPL_META.currentTradingPeriod.regular.start * 1000);
        expect(session.openUTCMs).not.toBe(REAL_AAPL_META.currentTradingPeriod.pre.start * 1000);
        expect(session.closeUTCMs).not.toBe(REAL_AAPL_META.currentTradingPeriod.post.end * 1000);
    });
});

describe('TEST metadata 4 — absence de marketState gérée sans planter (confirmé absent du vrai payload)', () => {
    it("ingestProviderMetadata n'exige pas marketState et ne plante jamais sans lui", () => {
        const engine = new MarketCalendarEngine();
        expect(() => engine.ingestProviderMetadata('AAPL', REAL_AAPL_META)).not.toThrow();
        expect('marketState' in REAL_AAPL_META).toBe(false); // documente la réalité constatée du payload
    });

    it('isMarketOpen dérive ouvert/fermé des bornes de session réelles, jamais de marketState (absent)', () => {
        const engine = new MarketCalendarEngine();
        engine.ingestProviderMetadata('AAPL', REAL_AAPL_META);
        const duringSession = REAL_AAPL_META.currentTradingPeriod.regular.start * 1000 + 60000;
        const afterSession = REAL_AAPL_META.currentTradingPeriod.regular.end * 1000 + 60000;
        expect(engine.isMarketOpen('AAPL', duringSession)).toBe(true);
        expect(engine.isMarketOpen('AAPL', afterSession)).toBe(false);
    });
});

describe('TEST metadata 5 — provider absent : le système ne plante jamais', () => {
    it('ingestProviderMetadata(ticker, null/undefined) est un no-op sûr', () => {
        const engine = new MarketCalendarEngine();
        expect(() => engine.ingestProviderMetadata('AAPL', null)).not.toThrow();
        expect(() => engine.ingestProviderMetadata('AAPL', undefined)).not.toThrow();
        expect(() => engine.ingestProviderMetadata(null, REAL_AAPL_META)).not.toThrow();
        expect(engine.getProviderMetadata('AAPL')).toBeNull();
    });

    it('toutes les méthodes du moteur restent utilisables sans jamais avoir ingéré de métadonnées', () => {
        const engine = new MarketCalendarEngine();
        expect(() => engine.getSession('AAPL', new Date())).not.toThrow();
        expect(() => engine.isMarketOpen('AAPL')).not.toThrow();
        expect(() => engine.getPreviousTradingSession('AAPL')).not.toThrow();
    });
});
