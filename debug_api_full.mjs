
// Mock dependencies
const RAPIDAPI_KEY = 'mock';
const YAHOO_MAP = {};
const USD_TO_EUR_FALLBACK_RATE = 0.95;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class MockStorage {
    getCurrentPrice(ticker) { return {}; }
    getAssetType(ticker) { return 'Crypto'; }
    isCacheValid() { return false; }
    setCurrentPrice() { }
}

// Copy of PriceAPI (simplified for debugging)
class PriceAPI {
    constructor(storage) {
        this.storage = storage;
        this.corsProxies = [
            'https://corsproxy.io/?',
            'https://api.allorigins.win/raw?url=',
            'https://thingproxy.freeboard.io/fetch/'
        ];
        this.currentProxyIndex = 0;
        this.historicalPriceCache = {};
    }

    formatTicker(ticker) {
        ticker = ticker.toUpperCase().trim();
        if (YAHOO_MAP[ticker]) return YAHOO_MAP[ticker];
        const cryptos = ['BTC', 'ETH', 'SOL', 'ADA', 'DOT', 'LINK', 'LTC', 'XRP', 'XLM', 'BNB', 'AVAX'];
        return cryptos.includes(ticker) ? ticker + '-EUR' : ticker;
    }

    async getHistoricalPricesWithRetry(ticker, startTs, endTs, interval) {
        let formatted = this.formatTicker(ticker);
        console.log(`Formatted ticker: ${formatted}`);

        const isCrypto = true; // Force true for test

        // Skip Binance for now as we know it fails
        // Fallback to Yahoo

        const range = '5d';
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${formatted}?range=${range}&interval=5m`;
        console.log(`Yahoo URL: ${yahooUrl}`);

        for (let proxy of this.corsProxies) {
            try {
                const url = `${proxy}${encodeURIComponent(yahooUrl)}`;
                console.log(`Trying proxy: ${proxy}`);
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                const result = data.chart.result[0];
                const timestamps = result.timestamp;
                const quotes = result.indicators.quote[0].close;

                const prices = {};
                timestamps.forEach((ts, idx) => {
                    if (quotes[idx] !== null) {
                        prices[ts * 1000] = parseFloat(quotes[idx]);
                    }
                });
                return prices;
            } catch (e) {
                console.error(`Proxy failed: ${e.message}`);
            }
        }
        return {};
    }
}

async function run() {
    const api = new PriceAPI(new MockStorage());
    const endTs = Math.floor(Date.now() / 1000);
    const startTs = endTs - 86400;

    console.log("Fetching history for BTC...");
    const data = await api.getHistoricalPricesWithRetry('BTC', startTs, endTs, '5m');

    const timestamps = Object.keys(data).map(Number).sort((a, b) => a - b);
    console.log(`Received ${timestamps.length} points.`);

    if (timestamps.length > 0) {
        const first = timestamps[0];
        console.log(`First timestamp: ${new Date(first).toISOString()} (${first})`);

        // Check today's start
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayTs = today.getTime();

        const todayPoints = timestamps.filter(ts => ts >= todayTs);
        if (todayPoints.length > 0) {
            console.log(`First point of TODAY: ${new Date(todayPoints[0]).toISOString()}`);
        } else {
            console.log("No points for today.");
        }
    }
}

run();
