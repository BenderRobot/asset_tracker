// Test double for storage.js — implements only the surface DataManager actually
// reads (getCurrentPrice, getConversionRate). Deliberately NOT the real
// storage.js: these tests exercise the real DataManager/HistoryCalculator engine
// in isolation from localStorage/Firestore, which is what makes them fast and
// side-effect-free.
export function createFakeStorage({ prices = {}, conversionRate = null } = {}) {
    return {
        getCurrentPrice(ticker) {
            return prices[ticker.toUpperCase()] || null;
        },
        getConversionRate(pair) {
            if (pair === 'USD_TO_EUR') return conversionRate;
            return null;
        }
    };
}

export function purchase(overrides) {
    return {
        id: Math.random().toString(36).slice(2),
        ticker: 'AAPL',
        name: 'Apple',
        assetType: 'Stock',
        currency: 'EUR',
        broker: 'RV-CT',
        price: 100,
        quantity: 1,
        date: '2024-01-01',
        ...overrides
    };
}
