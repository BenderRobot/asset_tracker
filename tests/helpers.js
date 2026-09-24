// Test doubles for storage.js and api.js — implement only the surface
// DataManager/HistoryCalculator actually read. Deliberately NOT the real
// storage.js/api.js: these tests exercise the real engine classes in
// isolation from localStorage/Firestore/network, which is what makes them
// fast, deterministic and side-effect-free.

// isCacheValid par défaut à `false` (toujours "à rafraîchir") — c'est ce dont
// ont besoin les tests de coalescing de fetchBatchPrices (voir
// liveBatchPriceDeduplication.test.js) : un cache jamais valide garantit que
// shouldRefresh reste vrai, donc qu'un fetch a bien lieu, sans quoi la
// dédup(l'absence de second fetch) serait indiscernable d'un simple "rien à
// rafraîchir".
export function createFakeStorage({ prices = {}, conversionRate = null, assetTypes = {}, purchases = [], isCacheValid = false } = {}) {
    const priceStore = new Map(Object.entries(prices));
    return {
        getCurrentPrice(ticker) {
            const entry = priceStore.get(ticker.toUpperCase());
            return typeof entry === 'function' ? entry() : (entry || null);
        },
        setCurrentPrice(ticker, data) {
            priceStore.set(ticker.toUpperCase(), data);
        },
        getConversionRate(pair) {
            if (pair === 'USD_TO_EUR') return conversionRate;
            return null;
        },
        getAssetType(ticker) {
            return assetTypes[ticker.toUpperCase()] || null;
        },
        getAssetCategory() {
            return null;
        },
        getPurchases() {
            return purchases;
        },
        isCacheValid() {
            return isCacheValid;
        },
        priceTimestamps: {}
    };
}

// Every network method HistoryCalculator/DataManager might call, all
// answering with "no historical data" by default — the engine is written to
// fall back to storage.getCurrentPrice()'s previousClose/price in that case
// (see MarketUtils.resolveTickerPreviousClose), which is exactly the
// deterministic, network-free path these tests want.
export function createFakeApi(overrides = {}) {
    return {
        async getHistoricalPricesWithRetry() { return {}; },
        async fetchCryptoKlinesFromBinance() { return {}; },
        async fetchBatchPrices() { return {}; },
        ...overrides
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
