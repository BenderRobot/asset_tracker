
const today = new Date();
today.setHours(0, 0, 0, 0);
console.log("Current Time:", new Date().toString());
console.log("Start of Day (Local):", today.toString());
console.log("Start of Day (Timestamp):", today.getTime());

const ticker = 'BTC-EUR';
const isCrypto = ['BTC', 'ETH', 'SOL', 'ADA', 'XRP', 'BNB', 'DOT', 'AVAX', 'MATIC', 'BTC-EUR'].includes(ticker.toUpperCase());
console.log("Is BTC-EUR crypto (hardcoded list)?", isCrypto);
