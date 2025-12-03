
import { DataManager } from './dataManager.js';
import { Storage } from './storage.js';
import { PriceAPI } from './api.js';

// Mock dependencies
const mockStorage = {
    getCurrentPrice: () => ({ previousClose: 100 }),
    getConversionRate: () => 1,
    getPurchases: () => []
};

const mockApi = {
    getHistoricalPricesWithRetry: async () => ({
        1701414000: 50000,
        1701417600: 50100
    })
};

const dm = new DataManager(mockStorage, mockApi);

// Test calculateIndexData
dm.calculateIndexData('BTC-EUR', 1).then(data => {
    console.log("calculateIndexData success!");
    console.log("Labels:", data.labels);
    console.log("Values:", data.values);
}).catch(err => {
    console.error("calculateIndexData failed:", err);
});
