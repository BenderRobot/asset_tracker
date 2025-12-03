
import { DataManager } from './dataManager.js';

// Mock storage
const mockStorage = {
    getConversionRate: () => 1.1,
    getCurrentPrice: (ticker) => {
        if (ticker === 'AIR.PA') return { price: 100, previousClose: 95, currency: 'EUR' };
        if (ticker === 'AAPL') return { price: 150, previousClose: 145, currency: 'USD' };
        return { price: 50000, previousClose: 49000, currency: 'USD' };
    },
    getPurchases: () => []
};

// Mock API
const mockApi = {
    getHistoricalPricesWithRetry: async (ticker, startTs, endTs, interval) => {
        // Generate hourly data for today
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const startOfDay = today.getTime();

        const data = {};
        for (let i = 0; i < 24; i++) {
            const ts = startOfDay + (i * 3600 * 1000);
            // Add 30 min point for 15:30 check
            if (i === 15) {
                const ts30 = startOfDay + (15 * 3600 * 1000) + (30 * 60 * 1000);
                data[ts30] = 100 + i + 0.5;
            }
            data[ts] = 100 + i;
        }
        return data;
    }
};

const dataManager = new DataManager(mockStorage, mockApi);

async function checkStartTime(ticker, expectedHour, expectedMinute) {
    const purchases = [{
        ticker: ticker,
        date: new Date().toISOString(),
        price: 100,
        quantity: 1,
        currency: 'EUR'
    }];

    console.log(`Testing ${ticker}...`);
    try {
        const result = await dataManager.calculateGenericHistory(purchases, 1, true);
        const timestamps = result.timestamps;

        if (timestamps.length === 0) {
            console.error(`FAIL: ${ticker} returned no data.`);
            return;
        }

        const firstTs = timestamps[0];
        const firstDate = new Date(firstTs);

        console.log(`First timestamp: ${firstDate.toLocaleTimeString()}`);

        if (firstDate.getHours() === expectedHour && firstDate.getMinutes() === expectedMinute) {
            console.log(`PASS: ${ticker} started at ${expectedHour}:${expectedMinute < 10 ? '0' + expectedMinute : expectedMinute}`);
        } else {
            console.error(`FAIL: ${ticker} started at ${firstDate.getHours()}:${firstDate.getMinutes()} instead of ${expectedHour}:${expectedMinute}`);
        }

    } catch (e) {
        console.error(`FAIL: ${ticker} crashed.`, e);
    }
}

async function runTests() {
    // Crypto -> 00:00
    await checkStartTime('BTC', 0, 0);

    // EU Stock (AIR.PA) -> 09:00
    await checkStartTime('AIR.PA', 9, 0);

    // US Stock (AAPL) -> 15:30
    await checkStartTime('AAPL', 15, 30);
}

runTests();
