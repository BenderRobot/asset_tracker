
import { DataManager } from './dataManager.js';

// Mock dependencies
const mockStorage = {
    getCurrentPrice: () => ({ previousClose: 100 }),
    getConversionRate: () => 1,
    getPurchases: () => []
};

const mockApi = {
    getHistoricalPricesWithRetry: async () => {
        const now = Date.now();
        const yesterday = now - (24 * 60 * 60 * 1000);
        const data = {};
        // Add a point from yesterday
        data[yesterday] = 50000;
        // Add a point from today
        data[now] = 51000;
        return data;
    }
};

const dm = new DataManager(mockStorage, mockApi);

// Test calculateIndexData with days=1
dm.calculateIndexData('BTC-EUR', 1).then(data => {
    console.log("calculateIndexData success!");
    console.log("Labels count:", data.labels.length);
    console.log("Values count:", data.values.length);

    // Check if yesterday's data is filtered out
    // Since we only have 2 points, if filtering works, we should have 1 point (today's)
    // Note: This depends on when the script is run relative to midnight local time.
    // But assuming the script runs and 'yesterday' is indeed previous day.

    if (data.values.length === 1) {
        console.log("Filtering SUCCESS: Only 1 point returned (today's data).");
    } else {
        console.log("Filtering FAILED: " + data.values.length + " points returned.");
    }
}).catch(err => {
    console.error("calculateIndexData failed:", err);
});
