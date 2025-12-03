
import { Storage } from './storage.js';

const storage = new Storage();
const purchases = storage.getPurchases();
const prices = storage.currentData;

console.log(`Checking ${purchases.length} purchases...`);

let errors = 0;
purchases.forEach((p, i) => {
    if (!p.ticker || !p.price || !p.quantity || !p.date) {
        console.error(`Purchase #${i} is missing required fields:`, p);
        errors++;
    }
    if (isNaN(p.price) || isNaN(p.quantity)) {
        console.error(`Purchase #${i} has invalid numbers:`, p);
        errors++;
    }
});

console.log(`Checking price cache...`);
Object.entries(prices).forEach(([ticker, data]) => {
    if (!data.price || isNaN(data.price)) {
        console.warn(`Invalid price for ${ticker}:`, data);
    }
});

if (errors === 0) {
    console.log("✅ Data integrity check passed!");
} else {
    console.error(`❌ Found ${errors} errors in purchase data.`);
}
