
// dividendManager.js - Gestion des Dividendes

const CORS_PROXIES = [
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?',
    'https://api.codetabs.com/v1/proxy?quest=',
];

// Nombre de tickers scannés en parallèle. Le scan était strictement séquentiel
// (un ticker après l'autre, chacun pouvant tenter jusqu'à 4 candidats x 3 proxies),
// ce qui rendait le scan très long dès que le portefeuille contenait plusieurs actifs.
const SCAN_CONCURRENCY = 5;

// Durée de vie du cache local des historiques de dividendes (évite de retaper
// Yahoo/les proxies à chaque clic sur "Scan Dividends" pendant la même session).
const DIVIDEND_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function _fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timeoutId));
}

// Exécute `fn` sur chaque item de `items` avec au plus `limit` exécutions en parallèle.
async function _mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

// Mapping ticker interne → listing primaire Yahoo Finance pour les dividendes.
// Les cotations Frankfurt/Paris (.F / .PA) n'ont souvent pas de données dividendes sur Yahoo.
// On redirige vers le listing US ou principal qui en a.
const DIVIDEND_TICKER_MAP = {
    // Nvidia
    'NVD': 'NVDA', 'NVD.F': 'NVDA',
    // Microsoft
    'MSF': 'MSFT', 'MSF.F': 'MSFT',
    // Apple
    'APC': 'AAPL', 'APC.F': 'AAPL',
    // Amazon
    'AMZ': 'AMZN', 'AMZ.F': 'AMZN',
    // Alphabet
    'ABEA': 'GOOGL', 'ABEA.F': 'GOOGL',
    // Applied Materials
    'AMAT': 'AMAT', 'AMAT.F': 'AMAT',
    '9D5': 'AMAT',  '9D5.F': 'AMAT',
    // Tesla
    'TL0': 'TSLA', 'TL0.DE': 'TSLA', 'TLO': 'TSLA',
    // Meta
    'META': 'META',
    // Coca-Cola
    'KO': 'KO',
    // P&G
    'PG': 'PG',
    // J&J
    'JNJ': 'JNJ',
    // McDonalds
    'MCD': 'MCD',
    // Pepsi
    'PEP': 'PEP',
};

export class DividendManager {
    constructor(storage, dataManager) {
        this.storage = storage;
        this.dataManager = dataManager;
    }

    // Fetch dividends pour un ticker donné depuis Yahoo Finance (direct)
    // range=10y (au lieu de 5y) pour ne pas rater les dividendes plus anciens.
    // Chaque tentative de proxy est bornée dans le temps : un proxy qui ne répond
    // pas (fréquent avec allorigins/corsproxy.io) ne doit pas geler tout le scan.
    async _fetchDividendsFromYahoo(ticker) {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=10y&interval=1d&events=div`;
        for (const proxy of CORS_PROXIES) {
            try {
                const res = await _fetchWithTimeout(`${proxy}${encodeURIComponent(url)}`, 9000);
                if (res.status === 404) return [];
                if (!res.ok) continue;
                const data = await res.json();
                const events = data.chart?.result?.[0]?.events?.dividends;
                if (events) {
                    return Object.keys(events).map(ts => ({
                        date: new Date(parseInt(ts) * 1000).toISOString().split('T')[0],
                        amount: events[ts].amount
                    }));
                }
                return [];
            } catch (e) {
                console.warn(`[Dividend] fetch failed for ${ticker} on ${proxy}:`, e.name === 'AbortError' ? 'timeout' : e.message);
            }
        }
        return [];
    }

    _readDividendCache(ticker) {
        try {
            const raw = localStorage.getItem(`divhist_v1_${ticker}`);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || (Date.now() - parsed.ts) > DIVIDEND_CACHE_TTL_MS) return null;
            return parsed.divs;
        } catch (e) {
            return null;
        }
    }

    _writeDividendCache(ticker, divs) {
        try {
            localStorage.setItem(`divhist_v1_${ticker}`, JSON.stringify({ ts: Date.now(), divs }));
        } catch (e) {
            // Quota localStorage dépassé ou navigation privée : on ignore, ce n'est qu'un cache.
        }
    }

    /**
     * Fetch dividend history for a specific ticker.
     * Tries multiple ticker formats: override map → raw → formatted.
     */
    async fetchDividendHistory(tickerRaw) {
        const raw = tickerRaw.toUpperCase().trim();
        const formatted = this.dataManager.api.formatTicker(raw);

        // Build ordered list of tickers to try (deduplicated)
        const candidates = [...new Set([
            DIVIDEND_TICKER_MAP[raw],       // ex: NVD → NVDA
            DIVIDEND_TICKER_MAP[formatted], // ex: NVD.F → NVDA
            raw,                            // ex: AMAT (direct US ticker)
            formatted,                      // ex: EUEA.AS (ETF Euronext)
        ].filter(Boolean))];

        const cached = this._readDividendCache(raw);
        if (cached) {
            console.log(`[Dividend] ${raw} : ${cached.length} dividende(s) (cache)`);
            return cached;
        }

        for (const ticker of candidates) {
            const divs = await this._fetchDividendsFromYahoo(ticker);
            if (divs.length > 0) {
                console.log(`[Dividend] ${raw} → ${ticker} : ${divs.length} dividende(s) trouvé(s)`);
                this._writeDividendCache(raw, divs);
                return divs;
            }
        }
        console.log(`[Dividend] Aucun dividende trouvé pour ${raw} (candidats: ${candidates.join(', ')})`);
        // On ne met PAS en cache les résultats vides : un échec de proxy temporaire
        // ne doit pas bloquer la détection pendant 12h au prochain scan.
        return [];
    }

    /**
     * Scan portfolio for missing dividends
     * @returns {Promise<Array>} List of detected dividends tailored to user holdings
     */
    async fetchExchangeRates() {
        // Fetch EURUSD=X history (1 EUR = x USD)
        // We need this to convert USD dividends to EUR (USD / Rate = EUR)
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?range=5y&interval=1d`;
        const rates = new Map();

        for (const proxy of CORS_PROXIES) {
            try {
                const target = `${proxy}${encodeURIComponent(url)}`;
                const res = await _fetchWithTimeout(target, 9000);
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

        // Actifs cotés en EUR en Europe mais dont les dividendes Yahoo sont en USD
        // → nécessite une conversion USD→EUR via taux de change
        const US_STOCKS_EUR = [
            'ABEA', 'MSF', 'NVD', 'APC', 'AMZ', 'TSLA', 'META', 'NFLX',
            'KO', 'PEP', 'JNJ', 'PG', 'MCD',
            '9D5',  // Applied Materials (Xetra : dividendes Yahoo en USD via AMAT)
        ];

        // Unique tickers actifs (Stock/ETF), en excluant uniquement les dividendes
        // On utilise !== 'dividend' plutôt que !p.type pour ne pas exclure
        // les ventes ou autres types de transactions légitimes
        const tickers = [...new Set(purchases
            .filter(p => (p.assetType === 'Stock' || p.assetType === 'ETF') && p.type !== 'dividend')
            .map(p => p.ticker)
        )];
        console.log(`[Dividend Scan] ${tickers.length} actifs à analyser :`, tickers);

        const exchangeRates = await this.fetchExchangeRates();

        // Chaque ticker était traité l'un après l'autre (attente réseau complète avant
        // de passer au suivant). On les traite maintenant par lots en parallèle
        // (SCAN_CONCURRENCY à la fois), ce qui réduit la durée totale du scan
        // d'un facteur proche de SCAN_CONCURRENCY sans surcharger les proxys CORS.
        const perTickerResults = await _mapWithConcurrency(tickers, SCAN_CONCURRENCY, async (ticker) => {
            const dividends = await this.fetchDividendHistory(ticker);
            const assetInfo = purchases.find(p => p.ticker === ticker);
            const assetCurrency = assetInfo ? assetInfo.currency : 'USD';
            const assetName = assetInfo ? assetInfo.name : ticker;
            const tickerSuggestions = [];

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

                    tickerSuggestions.push({
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
            return tickerSuggestions;
        });

        return perTickerResults.flat();
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
