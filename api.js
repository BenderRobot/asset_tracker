// benderrobot/asset_tracker/asset_tracker-d2b20147fdbaa70dfad9c7d62d05505272e63ca2/api.js
// ========================================
// api.js - (v22 - FINAL FIX: 1D parfait partout)
// ========================================
import { RAPIDAPI_KEY, YAHOO_MAP, USD_TO_EUR_FALLBACK_RATE } from './config.js';
import { sleep } from './utils.js';

const USD_TICKERS = new Set(['BKSY', 'SPY', 'VOO']);

const providerStats = {
  YAHOO_V2: { success: 0, fails: 0, lastError: null },
  COINGECKO: { success: 0, fails: 0, lastError: null },
  BINANCE: { success: 0, fails: 0, lastError: null }
};

export class PriceAPI {
  constructor(storage) {
    this.storage = storage;
    this.corsProxies = [
      'https://corsproxy.io/?',
      'https://api.allorigins.win/raw?url=',
      'https://api.codetabs.com/v1/proxy?quest='
    ];
    this.currentProxyIndex = 0;
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
    const cryptos = ['BTC', 'ETH', 'SOL', 'ADA', 'DOT', 'LINK', 'LTC', 'XRP', 'XLM', 'BNB', 'AVAX'];
    return cryptos.includes(ticker) ? ticker + '-EUR' : ticker;
  }

  // ==========================================================
  // RÉCUPÉRATION PRIX EN TEMPS RÉEL
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

    console.log(`API: Récupération de ${tickersToFetch.length} prix...`);
    const batchSize = 5;
    const pauseTime = 1000;

    for (let i = 0; i < tickersToFetch.length; i += batchSize) {
      const batch = tickersToFetch.slice(i, i + batchSize);
      if (i > 0) await sleep(pauseTime);

      const cryptos = batch.filter(t => this.storage.getAssetType(t) === 'Crypto');
      const others = batch.filter(t => this.storage.getAssetType(t) !== 'Crypto');

      for (const crypto of cryptos) {
        const success = await this.fetchCryptoPrice(crypto);
        if (!success) {
          console.log(`CoinGecko failed for ${crypto}, trying Binance...`);
          await this.fetchBinancePrice(crypto);
        }
      }
      if (others.length > 0) {
        await this.fetchPricesWithFallback(others);
      }
    }
    this.logProviderStats();
  }

  // --- COINGECKO & BINANCE (inchangés) ---
  async fetchCryptoPrice(ticker) {
    const upper = ticker.toUpperCase();
    try {
      let coinId;
      if (upper === 'BTC') coinId = 'bitcoin';
      else if (upper === 'ETH') coinId = 'ethereum';
      else if (upper === 'SOL') coinId = 'solana';
      else if (upper === 'ADA') coinId = 'cardano';
      else if (upper === 'XRP') coinId = 'ripple';
      else if (upper === 'BNB') coinId = 'binancecoin';
      else return false;

      let previousClose = null;
      try {
        const today = new Date();
        const dateStr = `${today.getUTCDate()}-${today.getUTCMonth() + 1}-${today.getUTCFullYear()}`;
        const historyRes = await fetch(`https://api.coingecko.com/api/v3/coins/${coinId}/history?date=${dateStr}&localization=false`);
        if (historyRes.ok) {
          const historyData = await historyRes.json();
          if (historyData?.market_data?.current_price?.eur) {
            previousClose = historyData.market_data.current_price.eur;
          }
        }
      } catch (e) {}

      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=eur`);
      if (res.ok) {
        const data = await res.json();
        const price = data[coinId]?.eur;

        if (price) {
          if (previousClose === null) {
            const res24h = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=eur&include_24hr_change=true`);
            const d24 = await res24h.json();
            const change = d24[coinId]?.eur_24h_change || 0;
            previousClose = price / (1 + change / 100);
          }
          this.storage.setCurrentPrice(upper, {
            price,
            previousClose,
            currency: 'EUR',
            marketState: 'OPEN',
            lastUpdate: Date.now(),
            source: 'CoinGecko'
          });
          providerStats.COINGECKO.success++;
          return true;
        }
      }
      return false;
    } catch (e) {
      providerStats.COINGECKO.fails++;
      return false;
    }
  }

  async fetchBinancePrice(ticker) {
    const upper = ticker.toUpperCase();
    try {
      const symbol = `${upper}EUR`;
      const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
      if (res.ok) {
        const data = await res.json();
        const price = parseFloat(data.lastPrice);
        const prevClose = parseFloat(data.prevClosePrice);
        if (!isNaN(price)) {
          this.storage.setCurrentPrice(upper, {
            price,
            previousClose: prevClose,
            currency: 'EUR',
            marketState: 'OPEN',
            lastUpdate: Date.now(),
            source: 'Binance'
          });
          providerStats.BINANCE.success++;
          return true;
        }
      }
    } catch (e) {
      providerStats.BINANCE.fails++;
    }
    return false;
  }

  async fetchPricesWithFallback(tickers) {
    let success = false;
    try {
      success = await this.fetchYahooV2Prices(tickers);
      if (success) providerStats.YAHOO_V2.success++;
    } catch (err) {
      providerStats.YAHOO_V2.fails++;
      providerStats.YAHOO_V2.lastError = err.message;
    }
    return success;
  }

  async fetchYahooV2Prices(tickers) {
    const results = [];
    for (const ticker of tickers) {
      try {
        const symbol = this.formatTicker(ticker);
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=5d`;
        const proxy = this.corsProxies[this.currentProxyIndex];
        const url = `${proxy}${encodeURIComponent(yahooUrl)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const chartData = data.chart ? data : (typeof data === 'string' ? JSON.parse(data) : data);
        if (!chartData.chart?.result?.[0]?.timestamp) throw new Error('Invalid data');

        const result = chartData.chart.result[0];
        const timestamps = result.timestamp;
        const quotes = result.indicators.quote[0].close;
        const meta = result.meta;

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

        this.storage.setCurrentPrice(ticker.toUpperCase(), {
          price: currentPrice,
          previousClose,
          currency,
          marketState: meta.marketState || 'CLOSED',
          lastUpdate: Date.now(),
          source: 'YahooV2 (5m)'
        });

        results.push(ticker);
        await sleep(500);
      } catch (err) {
        console.warn(`Yahoo error ${ticker} (Proxy ${this.currentProxyIndex}): ${err.message}`);
        this.currentProxyIndex = (this.currentProxyIndex + 1) % this.corsProxies.length;
        await sleep(1000);
      }
    }
    return results.length > 0;
  }

  // ================================================
  // HISTORIQUE – Version finale (1D parfait partout)
  // ================================================
  async getHistoricalPricesWithRetry(ticker, startTs, endTs, interval, retries = 3) {
    let formatted = this.formatTicker(ticker);

    // Fix Gold ETF longue période
    const longIntervals = ['1d', '1wk', '1mo', '3mo', '6mo', '1y'];
    if (formatted === 'GOLD-EUR.PA' && longIntervals.includes(interval)) {
      formatted = 'GOLD.PA';
    }

    const isCrypto = this.storage.getAssetType(ticker) === 'Crypto' ||
                     ['BTC','ETH','SOL','ADA','XRP','BNB','DOT','AVAX','MATIC'].includes(ticker.toUpperCase());

    // LISTE DES INDICES DU DASHBOARD (ceux qui doivent avoir un vrai 1D pur)
    const isIndex = [
      '^GSPC',    // S&P 500
      '^IXIC',    // Nasdaq
      '^FCHI',    // CAC 40
      '^STOXX50E',// Euro Stoxx 50
      'BTC-EUR',  // Bitcoin
      'GC=F',     // Gold Futures
      'EURUSD=X'  // EUR/USD
    ].includes(formatted);

    let cacheKey = `${formatted}_${startTs}_${endTs}_${interval}`;
    if (['5m', '15m', '90m'].includes(interval)) {
      const rounded = Math.floor(Date.now() / 300000) * 300000;
      cacheKey += `_${rounded}`;
    }

    if (this.historicalPriceCache[cacheKey]) return this.historicalPriceCache[cacheKey];

    // 1. Binance en priorité pour les cryptos
    if (isCrypto) {
      try {
        const binanceData = await this.fetchBinanceHistory(ticker, startTs, endTs, interval);
        if (Object.keys(binanceData).length > 0) {
          this.historicalPriceCache[cacheKey] = binanceData;
          this.saveHistoricalCache();
          return binanceData;
        }
      } catch (e) {
        console.warn(`Binance history failed for ${ticker}, fallback Yahoo...`, e);
      }
    }

    // 2. Yahoo Finance – Range intelligent
    let yahooUrl;
    const noCache = `&_=${Date.now()}`;

    if (interval === '5m') {
      // Indice du dashboard → vrai 1 jour seulement
      // Portefeuille → on garde 5 jours pour voir tous les achats récents
      const range = isIndex ? '1d' : '5d';
      yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${formatted}?range=${range}&interval=5m${noCache}`;
    }
    else if (interval === '15m') {
      yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${formatted}?range=5d&interval=15m${noCache}`;
    }
    else if (interval === '90m') {
      yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${formatted}?range=30d&interval=90m${noCache}`;
    }
    else {
      yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${formatted}?period1=${startTs}&period2=${endTs}&interval=${interval}${noCache}`;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const proxy = this.corsProxies[this.currentProxyIndex];
        const url = `${proxy}${encodeURIComponent(yahooUrl)}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const chartData = data.chart ? data : (typeof data === 'string' ? JSON.parse(data) : data);

        if (!chartData.chart?.result?.[0]?.timestamp) throw new Error('Invalid format');

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
        this.currentProxyIndex = (this.currentProxyIndex + 1) % (this.corsProxies.length);
        await sleep(1000);
      }
    }
    return {};
  }

  // --- BINANCE HISTORY (inchangé) ---
  async fetchBinanceHistory(ticker, startTs, endTs, interval) {
    const symbol = `${ticker.toUpperCase()}EUR`;
    let bInterval = '1d';
    if (interval === '5m') bInterval = '5m';
    else if (interval === '15m') bInterval = '15m';
    else if (interval === '90m') bInterval = '1h';
    else if (interval === '1d') bInterval = '1d';

    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${bInterval}&startTime=${startTs * 1000}&endTime=${endTs * 1000}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Binance Error');
    const data = await res.json();
    const prices = {};
    data.forEach(candle => {
      const ts = candle[0];
      const close = parseFloat(candle[4]);
      prices[ts] = close;
    });
    return prices;
  }

  // Cache
  loadHistoricalCache() {
    try {
      const cached = localStorage.getItem('historicalPriceCache');
      if (!cached) return {};
      const parsed = JSON.parse(cached);
      if (parsed.timestamp && (Date.now() - parsed.timestamp < 604800000)) return parsed.data || {};
    } catch (e) {}
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