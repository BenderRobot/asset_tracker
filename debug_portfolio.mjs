
import { DataManager } from './dataManager.js';

// Mock Storage
class MockStorage {
    getConversionRate(pair) { return 1.0; }
    getPurchases() {
        return [
            { ticker: 'BTC-EUR', date: '2023-01-01', price: 50000, quantity: 1, currency: 'EUR', assetType: 'Crypto' },
            { ticker: 'AI.PA', date: '2023-01-01', price: 100, quantity: 10, currency: 'EUR', assetType: 'Stock' }
        ];
    }
    getCurrentPrice(ticker) {
        if (ticker === 'BTC-EUR') return { price: 60000, previousClose: 59000 };
        if (ticker === 'AI.PA') return { price: 110, previousClose: 105 };
        return {};
    }
}

// Mock API
class MockAPI {
    async getHistoricalPricesWithRetry(ticker, startTs, endTs, interval) {
        const data = {};
        const start = new Date(startTs * 1000);
        const end = new Date(endTs * 1000);

        // Generate data every 5 minutes
        for (let d = new Date(start); d <= end; d.setMinutes(d.getMinutes() + 5)) {
            const ts = d.getTime();
            const hour = d.getUTCHours(); // Using UTC for simplicity

            if (ticker === 'BTC-EUR') {
                // Crypto has data 24/7
                data[ts] = 60000 + Math.random() * 100;
            } else if (ticker === 'AI.PA') {
                // Stock has data only 09:00 - 17:30
                // Assuming local time is UTC+1 for simplicity, so 08:00 UTC start
                if (hour >= 8 && hour < 16.5) {
                    data[ts] = 110 + Math.random() * 1;
                }
            }
        }
        return data;
    }
}

async function runDebug() {
    const storage = new MockStorage();
    const api = new MockAPI();
    const dataManager = new DataManager(storage, api);

    console.log("Calculating history for 1 day...");
    const result = await dataManager.calculateGenericHistory(storage.getPurchases(), 1, false);

    console.log("Labels:", result.labels.slice(0, 10));
    console.log("Values:", result.values.slice(0, 10));
    console.log("Timestamps:", result.timestamps.slice(0, 10));

    if (result.timestamps.length > 0) {
        const firstTs = result.timestamps[0];
        const firstDate = new Date(firstTs);
        console.log("First timestamp:", firstTs, firstDate.toISOString());
    } else {
        console.log("No timestamps returned!");
    }
}

runDebug();
