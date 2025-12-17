
// dividendManager.js - Gestion des Dividendes

// Re-define proxies if not exported to avoid dependency issues for now
const CORS_PROXIES = [
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url=',
];

export class DividendManager {
    constructor(storage, dataManager) {
        this.storage = storage;
        this.dataManager = dataManager;
    }

    /**
     * Fetch dividend history for a specific ticker from Yahoo Finance
     * @param {string} tickerRaw 
     * @returns {Promise<Array>} List of dividend events { date: 'YYYY-MM-DD', amount: 0.5 }
     */
    async fetchDividendHistory(tickerRaw) {
        // Use the API's formatting logic (handles Suffixes like .PA, -EUR, etc.)
        const ticker = this.dataManager.api.formatTicker(tickerRaw);

        // Range 2y to catch recent history
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=2y&interval=1d&events=div`;

        for (const proxy of CORS_PROXIES) {
            try {
                const target = `${proxy}${encodeURIComponent(url)}`;
                const res = await fetch(target);

                if (res.status === 404) {
                    console.warn(`Yahoo Finance: Ticker ${ticker} not found (404).`);
                    return [];
                }

                if (!res.ok) continue;

                const data = await res.json();
                const result = data.chart.result?.[0];
                const events = result?.events?.dividends;

                if (events) {
                    return Object.keys(events).map(ts => ({
                        date: new Date(parseInt(ts) * 1000).toISOString().split('T')[0],
                        amount: events[ts].amount
                    }));
                }
                return [];
            } catch (e) {
                console.warn(`Dividend fetch failed for ${ticker} on ${proxy}:`, e);
            }
        }
        return [];
    }

    /**
     * Scan portfolio for missing dividends
     * @returns {Promise<Array>} List of detected dividends tailored to user holdings
     */
    async fetchExchangeRates() {
        // Fetch EURUSD=X history (1 EUR = x USD)
        // We need this to convert USD dividends to EUR (USD / Rate = EUR)
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?range=2y&interval=1d`;
        const rates = new Map();

        for (const proxy of CORS_PROXIES) {
            try {
                const target = `${proxy}${encodeURIComponent(url)}`;
                const res = await fetch(target);
                if (!res.ok) continue;

                const data = await res.json();
                const result = data.chart.result?.[0];
                const timestamps = result?.timestamp;
                const quotes = result?.indicators?.quote?.[0]?.close;

                if (timestamps && quotes) {
                    timestamps.forEach((ts, i) => {
                        if (quotes[i]) {
                            const date = new Date(ts * 1000).toISOString().split('T')[0];
                            rates.set(date, quotes[i]);
                        }
                    });
                    return rates;
                }
            } catch (e) {
                console.warn('Rate fetch failed', e);
            }
        }
        return rates;
    }

    async scanForMissingDividends() {
        const purchases = this.storage.getPurchases();
        const existingDividends = purchases.filter(p => p.type === 'dividend');

        // Import config logic (Dynamically to avoid top-level cyclic dependency issue if any, or assume global import)
        // Better: Rely on dataManager or assume we can modify imports at top of file.
        // Since I cannot easily change top imports in this block without potentially replacing whole file,
        // I will hardcode checks or rely on the `const` if I can import it.
        // Actually, I can just perform the checks here with the list passed/imported.
        // I'll assume consistent named imports or just hardcode the check for robustness if import is tricky.
        // Let's rely on standard import at top.

        const US_STOCKS_EUR = [
            'ABEA', 'MSF', 'NVD', 'APC', 'AMZ', 'TSLA', 'META', 'NFLX', 'KO', 'PEP', 'JNJ', 'PG', 'MCD'
        ];

        // Get unique active tickers (stocks/ETFs only)
        const tickers = [...new Set(purchases
            .filter(p => (p.assetType === 'Stock' || p.assetType === 'ETF') && !p.type)
            .map(p => p.ticker)
        )];

        const suggestions = [];
        const exchangeRates = await this.fetchExchangeRates();

        for (const ticker of tickers) {
            const dividends = await this.fetchDividendHistory(ticker);
            const assetInfo = purchases.find(p => p.ticker === ticker);
            const assetCurrency = assetInfo ? assetInfo.currency : 'USD';
            const assetName = assetInfo ? assetInfo.name : ticker;

            for (const div of dividends) {
                // Check if already recorded (Normalize Dates)
                const divDate = new Date(div.date).toISOString().split('T')[0];

                const alreadyExists = existingDividends.some(d => {
                    const existingDate = new Date(d.date).toISOString().split('T')[0];
                    return d.ticker === ticker && existingDate === divDate;
                });

                if (alreadyExists) continue;

                // Calculate quantity held at Ex-Date
                const quantityHeld = this.getQuantityAtDate(ticker, div.date);

                if (quantityHeld > 0) {
                    let grossAmount = quantityHeld * div.amount;
                    let currency = assetCurrency;
                    let originalAmount = null;
                    let originalCurrency = null;
                    let exchangeRateUsed = null;

                    // Always find closest rate for potential use (UI Toggle)
                    let potentialRate = exchangeRates.get(div.date);
                    if (!potentialRate) {
                        const d = new Date(div.date);
                        for (let i = 1; i <= 5; i++) {
                            d.setDate(d.getDate() - 1);
                            potentialRate = exchangeRates.get(d.toISOString().split('T')[0]);
                            if (potentialRate) break;
                        }
                    }

                    // Conversion Logic (USD -> EUR)
                    // Trigger if: Explicitly USD Asset OR In Known US-Stocks List
                    const shouldConvert = (assetCurrency === 'USD') || US_STOCKS_EUR.includes(ticker);

                    if (shouldConvert && potentialRate) {
                        originalAmount = grossAmount;
                        originalCurrency = 'USD';
                        grossAmount = grossAmount / potentialRate;
                        currency = 'EUR';
                        exchangeRateUsed = potentialRate;
                    }

                    suggestions.push({
                        ticker: ticker,
                        name: assetName,
                        date: div.date,
                        amountPerShare: div.amount,
                        quantity: quantityHeld,
                        grossAmount: grossAmount,
                        currency: currency,
                        originalAmount: originalAmount,
                        originalCurrency: originalCurrency,
                        exchangeRate: exchangeRateUsed || potentialRate, // Pass rate even if not used yet
                        broker: assetInfo ? assetInfo.broker : null, // Pass Broker
                        found: true
                    });
                }
            }
        }
        return suggestions;
    }

    /**
     * Calculate quantity of an asset held at a specific date
     */
    getQuantityAtDate(ticker, dateStr) {
        const targetDate = new Date(dateStr).getTime();
        const history = this.storage.getPurchases()
            .filter(p => p.ticker === ticker && p.type !== 'dividend');

        let quantity = 0;

        for (const tx of history) {
            const txDate = new Date(tx.date).getTime();

            // Check if transaction happened BEFORE or ON the ex-date
            if (txDate <= targetDate) {
                // In this app, quantities are signed:
                // Buy = Positive
                // Sell = Negative
                // So we just sum them up.
                const qty = parseFloat(tx.quantity);
                quantity += qty;

                // if (debugMode) console.log(`      -> Tx ${tx.date} (${tx.type}): ${qty} => New Qty: ${quantity}`);
            }
        }

        // if (debugMode) console.log(`    > Quantity of ${ticker} on ${dateStr}: ${quantity}`);
        return quantity;
    }
}
