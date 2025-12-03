// ========================================
// api.js - VERSION CONSOLIDÉE GCP (Sécurisée via Cloud Function)
// ========================================
import { YAHOO_MAP, USD_TO_EUR_FALLBACK_RATE, PRICE_PROXY_URL } from './config.js';
import { sleep } from './utils.js';

// Les anciennes clés et proxys ont été retirés pour la sécurité

const USD_TICKERS = new Set(['BKSY', 'SPY', 'VOO']);

// Les providerStats sont simplifiés car le proxy est la seule source du Frontend
const providerStats = {
  GCP_PROXY: { success: 0, fails: 0, lastError: null }
};

export class PriceAPI {
  constructor(storage) {
    this.storage = storage;
    // Les anciens proxys corsProxies et currentProxyIndex sont supprimés
    this.historicalPriceCache = this.loadHistoricalCache();
  }

  isWeekend() {
    const day = new Date().getDay();
    return day === 0 || day === 6;
  }

  isMarketClosed() {
    const now = new Date();
    const hours = now.getHours();
    const day = now.getDay();
    if (day === 0 || day === 6) return true;
    if (hours < 8 || hours >= 23) return true;
    return false;
  }

  isUSTickerOnly(ticker) {
    const yahooSymbol = YAHOO_MAP[ticker] || ticker;
    return USD_TICKERS.has(ticker.toUpperCase()) ||
      (!yahooSymbol.includes('.F') && !yahooSymbol.includes('.PA') && !yahooSymbol.includes('.AS'));
  }

  formatTicker(ticker) {
    ticker = ticker.toUpperCase().trim();
    if (YAHOO_MAP[ticker]) return YAHOO_MAP[ticker];
    if (ticker.startsWith('^')) return ticker;
    if (ticker === '^IXIC') return '^IXIC';
    if (ticker === '^FCHI') return '^FCHI';
    if (ticker === '^STOXX50E') return '^STOXX50E';
    if (ticker === 'EURUSD=X') return 'EURUSD=X';
    if (ticker === 'GC=F') return 'GC=F';
    const cryptos = ['BTC', 'ETH', 'SOL', 'ADA', 'DOT', 'LINK', 'LTC', 'XRP', 'XLM', 'BNB', 'AVAX'];
    return cryptos.includes(ticker) ? ticker + '-EUR' : ticker;
  }

  // ==========================================================
  // RÉCUPÉRATION PRIX EN TEMPS RÉEL (Centralisée)
  // ==========================================================
  async fetchBatchPrices(tickers, forceRefresh = false) {
    const tickersToFetch = [];
    tickers.forEach(ticker => {
      if (forceRefresh) {
        tickersToFetch.push(ticker);
        return;
      }
      const cached = this.storage.getCurrentPrice(ticker);
      const assetType = this.storage.getAssetType(ticker);
      const isWeekend = this.isWeekend();

      if (isWeekend && cached && cached.price) {
        const ageMs = Date.now() - (this.storage.priceTimestamps[ticker.toUpperCase()] || 0);
        const ageDays = ageMs / (24 * 60 * 60 * 1000);
        if (ageDays < 7) return;
      }

      const shouldRefresh = !cached ||
        !cached.price ||
        !this.storage.isCacheValid(ticker, assetType) ||
        (assetType === 'Crypto' && !isWeekend);

      if (shouldRefresh) tickersToFetch.push(ticker);
    });

    if (tickersToFetch.length === 0) return;

    console.log(`API: Récupération de ${tickersToFetch.length} prix via GCP Proxy...`);
    const batchSize = 5;
    const pauseTime = 1000;

    for (let i = 0; i < tickersToFetch.length; i += batchSize) {
      const batch = tickersToFetch.slice(i, i + batchSize);
      if (i > 0) await sleep(pauseTime);
      
      // Appel unifié pour tous les actifs
      await this.fetchPricesViaProxy(batch); 
    }
    this.logProviderStats();
  }

  // NOUVELLE FONCTION CORE: Appelle le Cloud Function Proxy pour les prix en temps réel
  async fetchPricesViaProxy(tickers) {
    const tickersResult = [];
    for (const ticker of tickers) {
      const assetType = this.storage.getAssetType(ticker);
      const symbol = this.formatTicker(ticker);
      const type = assetType.toUpperCase() === 'CRYPTO' ? 'CRYPTO' : 'STOCK';
      
      try {
        // L'appel se fait vers le Cloud Function Proxy
        const url = `${PRICE_PROXY_URL}?symbol=${symbol}&type=${type}&range=5d&interval=5m`;
        
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
        
        const data = await res.json();
        
        let result;
        let source;

        if (type === 'CRYPTO') {
            // Logique CoinGecko/Binance (Le proxy a déjà géré le fallback)
            let coinId = (symbol.split('-')[0] || symbol).toLowerCase();
            if (data.coinId && data.coinId.eur) { // Si la structure est {BTC: {eur: x}}
                 result = {
                    price: data[coinId].eur,
                    previousClose: data[coinId].eur / (1 + (data[coinId].eur_24h_change / 100)) || data[coinId].eur,
                    currency: 'EUR',
                    marketState: 'OPEN'
                };
                source = 'CoinGecko Proxy';
            } else if (data.lastPrice) { // Tentative Binance si la réponse ressemble à du Binance
                 result = {
                    price: parseFloat(data.lastPrice),
                    previousClose: parseFloat(data.prevClosePrice),
                    currency: 'EUR',
                    marketState: 'OPEN'
                };
                source = 'Binance Proxy';
            }
            else {
                // Si la CF n'a rien trouvé, on échoue ici
                throw new Error('Crypto price not found in response.');
            }
        } else {
            // Logique Yahoo
            const chartData = data.chart ? data : (typeof data === 'string' ? JSON.parse(data) : data);
            if (!chartData.chart?.result?.[0]?.timestamp) throw new Error('Invalid Yahoo data');

            const yahooResult = chartData.chart.result[0];
            const timestamps = yahooResult.timestamp;
            const quotes = yahooResult.indicators.quote[0].close;
            const meta = yahooResult.meta;
            
            let currentPrice = null;
            let lastTradeTimestamp = null;
            for (let i = quotes.length - 1; i >= 0; i--) {
              if (quotes[i] !== null) {
                currentPrice = parseFloat(quotes[i]);
                lastTradeTimestamp = timestamps[i];
                break;
              }
            }
            if (currentPrice === null) throw new Error('Price not found');
            
            const tradeDate = new Date(lastTradeTimestamp * 1000);
            const tradeSessionStartUTC = Date.UTC(tradeDate.getUTCFullYear(), tradeDate.getUTCMonth(), tradeDate.getUTCDate()) / 1000;
            let previousClose = null;
            for (let i = timestamps.length - 1; i >= 0; i--) {
              if (timestamps[i] < tradeSessionStartUTC && quotes[i] !== null) {
                previousClose = parseFloat(quotes[i]);
                break;
              }
            }
            if (previousClose === null) {
              previousClose = meta.chartPreviousClose || meta.previousClose || currentPrice;
            }
            const currency = meta.currency || 'EUR';

            result = {
                price: currentPrice,
                previousClose,
                currency,
                marketState: meta.marketState || 'CLOSED'
            };
            source = 'Yahoo Proxy';
        }

        // --- DÉBUT DU FAILBACK DE SÉCURITÉ CONTRE LE PRIX ZÉRO (Conservé de l'original) ---
        let finalPrice = result.price;
        let finalPreviousClose = result.previousClose;
        const tickerUpper = ticker.toUpperCase();
        const oldData = this.storage.getCurrentPrice(tickerUpper);
        const oldPrice = oldData ? oldData.price : null;
        
        if (finalPrice <= 0 || isNaN(finalPrice)) {
          if (oldPrice > 0 && !isNaN(oldPrice)) {
            finalPrice = oldPrice;
            finalPreviousClose = oldData.previousClose;
            console.warn(`[FAILBACK] Prix de ${ticker} invalide. Utilisation du prix en cache: ${finalPrice}`);
          } else {
            throw new Error(`Prix reçu à zéro/invalide pour ${ticker} et pas de failback en cache.`);
          }
        }
        // --- FIN DU FAILBACK DE SÉCURITÉ ---

        this.storage.setCurrentPrice(ticker.toUpperCase(), {
          price: finalPrice, 
          previousClose: finalPreviousClose,
          currency: result.currency,
          marketState: result.marketState,
          lastUpdate: Date.now(),
          source: source
        });

        tickersResult.push(ticker);
        await sleep(500);

      } catch (err) {
        console.warn(`Price Proxy error for ${ticker}: ${err.message}`);
        providerStats.GCP_PROXY.fails++;
        await sleep(1000);
      }
    }
    return tickersResult.length > 0;
  }
  
  // Les anciennes fonctions fetchCryptoPrice, fetchBinancePrice, fetchPricesWithFallback, fetchYahooV2Prices SONT OBSOLÈTES

  // ================================================
  // HISTORIQUE (Centralisé)
  // ================================================
  async getHistoricalPricesWithRetry(ticker, startTs, endTs, interval, retries = 3) {
    let formatted = this.formatTicker(ticker);
    const assetType = this.storage.getAssetType(ticker).toUpperCase();

    // Fix Gold ETF longue période (utilisé pour les requêtes Yahoo)
    const longIntervals = ['1d', '1wk', '1mo', '3mo', '6mo', '1y'];
    if (formatted === 'GOLD-EUR.PA' && longIntervals.includes(interval)) {
      formatted = 'GOLD.PA';
    }

    // Le cacheKey utilise une v4 car la structure de l'URL change
    let cacheKey = `v4_${formatted}_${startTs}_${endTs}_${interval}`;
    if (['5m', '15m', '90m'].includes(interval)) {
      const rounded = Math.floor(Date.now() / 300000) * 300000;
      cacheKey += `_${rounded}`;
    }

    if (this.historicalPriceCache[cacheKey]) return this.historicalPriceCache[cacheKey];

    // L'appel se fait vers le Proxy Cloud Function pour l'historique
    // Nous passons tous les paramètres nécessaires au proxy
    let proxyUrl = `${PRICE_PROXY_URL}?symbol=${formatted}&type=${assetType}&interval=${interval}&period1=${startTs}&period2=${endTs}`;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`Proxy HTTP ${response.status}`);
        
        const data = await response.json();

        // Si Crypto, la CF nous retourne les prix directs {timestamp: price, ...}
        if (assetType === 'CRYPTO') {
            const prices = data;
            if (Object.keys(prices).length > 0) {
                 this.historicalPriceCache[cacheKey] = prices;
                 this.saveHistoricalCache();
                 return prices;
            }
            throw new Error('No historical data from proxy for crypto.');
        }

        // Si STOCK/ETF/Index, nous nous attendons au format Yahoo
        const chartData = data.chart ? data : (typeof data === 'string' ? JSON.parse(data) : data);
        if (!chartData.chart?.result?.[0]?.timestamp) throw new Error('Invalid Yahoo format from proxy');

        const result = chartData.chart.result[0];
        const timestamps = result.timestamp;
        const quotes = result.indicators.quote[0].close;

        if (!timestamps || timestamps.length < 2) throw new Error('Empty data');

        const prices = {};
        timestamps.forEach((ts, idx) => {
          if (quotes[idx] !== null) {
            prices[ts * 1000] = parseFloat(quotes[idx]);
          }
        });

        this.historicalPriceCache[cacheKey] = prices;
        this.saveHistoricalCache();
        return prices;

      } catch (error) {
        console.warn(`Historical Proxy attempt ${attempt + 1} failed: ${error.message}`);
        await sleep(1000);
      }
    }
    return {};
  }

  // --- Fonctions de Cache (Inchagées) ---
  loadHistoricalCache() {
    try {
      const cached = localStorage.getItem('historicalPriceCache');
      if (!cached) return {};
      const parsed = JSON.parse(cached);
      if (parsed.timestamp && (Date.now() - parsed.timestamp < 604800000)) return parsed.data || {};
    } catch (e) { }
    return {};
  }

  saveHistoricalCache() {
    try {
      this.cleanIntradayCache();
      localStorage.setItem('historicalPriceCache', JSON.stringify({ timestamp: Date.now(), data: this.historicalPriceCache }));
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        this.historicalPriceCache = {};
        localStorage.removeItem('historicalPriceCache');
      }
    }
  }

  cleanIntradayCache() {
    const limit = Date.now() - 7200000; // 2h
    for (const key in this.historicalPriceCache) {
      if (key.split('_').length > 4) {
        const ts = parseInt(key.split('_').pop());
        if (!isNaN(ts) && ts < limit) delete this.historicalPriceCache[key];
      }
    }
  }

  getPriceSourceStats() { return {}; }
  logProviderStats() { console.log(providerStats); }
}