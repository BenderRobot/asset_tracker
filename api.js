// ========================================
// api.js - RÉCUPÉRATION DES PRIX (v9.1 - Taux Dynamique)
// ========================================

// MODIFICATION : Import du taux de SECOURS
import { RAPIDAPI_KEY, YAHOO_MAP, USD_TO_EUR_FALLBACK_RATE } from './config.js';
import { sleep } from './utils.js';

const USD_TICKERS = new Set(['BKSY', 'SPY', 'VOO']);

// Statistiques des providers (simplifié)
const providerStats = {
  YAHOO_V2: { success: 0, fails: 0, lastError: null, lastUse: null },
  COINGECKO: { success: 0, fails: 0, lastError: null, lastUse: null },
};

export class PriceAPI {
  constructor(storage) {
    this.storage = storage;

    // === Logique proxy unifiée ===
    this.corsProxies = [
      'https://api.allorigins.win/raw?url=',
      'https://corsproxy.io/?',
      'https://api.codetabs.com/v1/proxy?quest='
    ];
    this.currentProxyIndex = 0;

    // === Cache pour les PRIX HISTORIQUES ===
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
    // ... (code inchangé) ...
    const yahooSymbol = YAHOO_MAP[ticker] || ticker;
    return USD_TICKERS.has(ticker.toUpperCase()) ||
           (!yahooSymbol.includes('.F') &&
            !yahooSymbol.includes('.PA') &&
            !yahooSymbol.includes('.AS'));
  }

  // MODIFICATION : Utilise le taux dynamique du storage
  convertToEUR(price, ticker) {
    if (USD_TICKERS.has(ticker.toUpperCase())) {
      return { price, currency: 'USD' };
    }
    
    // Récupère le taux dynamique du storage
    const dynamicRate = this.storage.getConversionRate('USD_TO_EUR') || USD_TO_EUR_FALLBACK_RATE;

    return {
      price: price * dynamicRate, // Utilise le taux dynamique
      currency: 'EUR'
    };
  }

  // ==========================================================
  // RÉCUPÉRATION PRIX ACTUELS
  // ==========================================================

  async fetchBatchPrices(tickers, forceWeekend = false) {
    // ... (code inchangé) ...
    const tickersToFetch = [];
    tickers.forEach(ticker => {
      const cached = this.storage.getCurrentPrice(ticker);
      const assetType = this.storage.getAssetType(ticker);
      const isWeekend = this.isWeekend();
      const cacheAge = this.storage.getPriceAge(ticker);
      if (isWeekend && cached && cached.price) {
        const ageMs = Date.now() - (this.storage.priceTimestamps[ticker.toUpperCase()] || 0);
        const ageDays = ageMs / (24 * 60 * 60 * 1000);
        if (ageDays < 7) {
          console.log(`Cache weekend OK pour ${ticker}: ${cached.price} ${cached.currency} (${cacheAge})`);
          return;
        }
      }
      const shouldRefresh = !cached ||
                           !cached.price ||
                           !this.storage.isCacheValid(ticker, assetType) ||
                           (assetType === 'Crypto' && !isWeekend);
      if (shouldRefresh) {
        tickersToFetch.push(ticker);
      } else {
        console.log(`Cache OK pour ${ticker}: ${cached.price} ${cached.currency} (${cacheAge})`);
      }
    });
    if (tickersToFetch.length === 0) {
      console.log('Tous les prix sont en cache');
      return;
    }
    console.log(`Récupération de ${tickersToFetch.length} prix...`);
    const batchSize = forceWeekend ? 1 : 8;
    const pauseTime = forceWeekend ? 3000 : 1000; 
    for (let i = 0; i < tickersToFetch.length; i += batchSize) {
      const batch = tickersToFetch.slice(i, i + batchSize);
      if (i > 0) {
        console.log(`Pause ${pauseTime/1000}s pour éviter rate limit...`);
        await sleep(pauseTime);
      }
      const cryptos = batch.filter(t => this.storage.getAssetType(t) === 'Crypto');
      const others = batch.filter(t => this.storage.getAssetType(t) !== 'Crypto');
      for (const crypto of cryptos) {
        await this.fetchCryptoPrice(crypto);
      }
      if (others.length > 0) {
        await this.fetchPricesWithFallback(others);
      }
    }
    console.log('Récupération terminée');
    this.logProviderStats();
  }

  async fetchPricesWithFallback(tickers) {
    // ... (code inchangé) ...
    console.log(`[Source Unifiée] Récupération de ${tickers.length} tickers (Actions/ETF) via YahooV2...`);
    let success = false;
    try {
      success = await this.fetchYahooV2Prices(tickers);
      if (success) {
        providerStats['YAHOO_V2'].success++;
        providerStats['YAHOO_V2'].lastUse = Date.now();
        console.log(`[Source Unifiée] Yahoo V2 OK`);
      }
    } catch (err) {
      providerStats['YAHOO_V2'].fails++;
      providerStats['YAHOO_V2'].lastError = err.message;
      console.warn(`[Source Unifiée] Yahoo V2 échoué: ${err.message}`);
    }
    if (!success) {
      console.error(`[Source Unifiée] Échec de la récupération pour ${tickers.join(', ')}`);
    }
    return success;
  }

  async fetchYahooV2Prices(tickers) {
    // ... (code inchangé) ...
    const results = [];
    for (const ticker of tickers) {
      try {
        const symbol = YAHOO_MAP[ticker] || `${ticker}.F`;
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=2d`;
        const proxy = this.corsProxies[this.currentProxyIndex];
        const url = `${proxy}${encodeURIComponent(yahooUrl)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) }); 
        if (!res.ok) {
          throw new Error(`Erreur HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!data.chart?.result?.[0]?.timestamp) {
            throw new Error('Données de graphique invalides');
        }
        const result = data.chart.result[0];
        const timestamps = result.timestamp; 
        const quotes = result.indicators.quote[0].close; 
        const meta = result.meta;
        if (!timestamps || !quotes || timestamps.length === 0) {
             throw new Error('Timestamps ou quotes manquants');
        }
        let currentPrice = null;
        for (let i = quotes.length - 1; i >= 0; i--) {
            if (quotes[i] !== null) {
                currentPrice = parseFloat(quotes[i]);
                break;
            }
        }
        if (currentPrice === null) {
             throw new Error(`Aucun prix trouvé dans l'historique (quotes) pour ${ticker}`);
        }
        const todayTimestamp = new Date();
        todayTimestamp.setHours(0, 0, 0, 0); 
        const todayStartUTC = Date.UTC(todayTimestamp.getUTCFullYear(), todayTimestamp.getUTCMonth(), todayTimestamp.getUTCDate()) / 1000;
        let previousClose = null;
        for (let i = timestamps.length - 1; i >= 0; i--) {
            if (timestamps[i] < todayStartUTC && quotes[i] !== null) {
                previousClose = parseFloat(quotes[i]);
                break; 
            }
        }
        if (previousClose === null) {
            previousClose = meta.chartPreviousClose || meta.previousClose || currentPrice;
        }
        const currency = meta.currency || 'EUR';
        const priceData = {
            price: currentPrice,
            previousClose: previousClose,
            currency: currency,
            marketState: meta.marketState || 'CLOSED',
            lastUpdate: Date.now(),
            source: 'YahooV2 (5m)' 
        };
        this.storage.setCurrentPrice(ticker.toUpperCase(), priceData);
        console.log(`Yahoo V2 (5m): ${ticker} = ${priceData.price.toFixed(2)} ${priceData.currency} (prev: ${previousClose ? previousClose.toFixed(2) : 'N/A'})`);
        results.push(ticker);
        if (tickers.indexOf(ticker) < tickers.length - 1) {
          await sleep(500); 
        }
      } catch (err) {
        console.error(`Erreur Yahoo V2 (5m) pour ${ticker}:`, err.message);
        if (err.message.includes('HTTP') || err.message.includes('network')) {
            this.currentProxyIndex = (this.currentProxyIndex + 1) % this.corsProxies.length;
            console.warn(`Proxy échoué. Passage au proxy suivant: ${this.corsProxies[this.currentProxyIndex]}`);
        }
      }
    }
    return results.length > 0;
  }

  async fetchCryptoPrice(ticker) {
    // ... (code inchangé) ...
    const upper = ticker.toUpperCase();
    try {
      let coinId;
      if (upper === 'BTC') coinId = 'bitcoin';
      else if (upper === 'ETH') coinId = 'ethereum';
      else return; 
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
      } catch (e) {
        console.warn(`Erreur clôture 00:00 UTC pour ${upper}:`, e.message);
      }
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=eur`);
      if (res.ok) {
        const data = await res.json();
        const price = data[coinId]?.eur;
        if (price) {
          if (previousClose === null) {
              console.warn(`Utilisation de la clôture 24h (fallback) pour ${upper}`);
              const res24h = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=eur&include_24hr_change=true`);
              const data24h = await res24h.json();
              const change24h = data24h[coinId]?.eur_24h_change || 0;
              previousClose = price * (1 - change24h / 100);
          }
          this.storage.setCurrentPrice(upper, {
            price,
            previousClose, 
            currency: 'EUR',
            marketState: 'OPEN',
            lastUpdate: Date.now(),
            source: 'CoinGecko'
          });
          providerStats['COINGECKO'].success++;
          console.log(`Crypto: ${upper} = ${price} EUR (Préc: ${previousClose})`);
        }
      }
    } catch (e) {
      providerStats['COINGECKO'].fails++;
      console.error(`Erreur CoinGecko pour ${upper}:`, e.message);
    }
  }
  
  // ==========================================================
  // FONCTIONS HISTORIQUES (CORRIGÉES)
  // ==========================================================

  async getHistoricalPricesWithRetry(ticker, startTs, endTs, interval, retries = 3) {
    const formatted = this.formatTicker(ticker); 
    let cacheKey = `${formatted}_${startTs}_${endTs}_${interval}`;
    
    // Logique de cache intraday
    const shortIntervals = ['5m', '15m', '90m'];
    if (shortIntervals.includes(interval)) {
        const now = Date.now();
        const rounded = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000);
        cacheKey = `${formatted}_${startTs}_${endTs}_${interval}_${rounded}`;
    }

    if (this.historicalPriceCache[cacheKey]) {
        console.log(`Cache historique hit pour ${ticker}`);
        return this.historicalPriceCache[cacheKey];
    }

    // === CORRECTION LOGIQUE URL v4 ===
    // 'range' est *uniquement* pour 5m et 15m (intraday 1D et 2D)
    // 'period1'/'period2' est pour TOUT le reste (90m, 1d, 1wk, 1mo)
    
    let yahooUrl;
    
    if (interval === '5m') {
        yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${formatted}?range=2d&interval=5m`;
    } else if (interval === '15m') {
        yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${formatted}?range=5d&interval=${interval}`;
    } else {
        // 90m (pour 1W), 1d, 1wk, 1mo utilisent period1/period2
        yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${formatted}?period1=${startTs}&period2=${endTs}&interval=${interval}`;
    }
    // === FIN CORRECTION ===

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            let response;
            const proxy = this.corsProxies[this.currentProxyIndex];
            const url = proxy + encodeURIComponent(yahooUrl);

            response = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
            
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (!data.chart?.result?.[0]?.timestamp) throw new Error('Format invalide');

            const result = data.chart.result[0];
            const timestamps = result.timestamp;
            const quotes = result.indicators.quote[0];
            const prices = {};

            timestamps.forEach((ts, idx) => {
                const price = quotes.close?.[idx];
                if (price !== null && !isNaN(price)) {
                    prices[ts * 1000] = parseFloat(price); // Stocke en ms
                }
            });

            this.historicalPriceCache[cacheKey] = prices;
            this.saveHistoricalCache();
            console.log(`Prix historiques (Corrigé) récupérés pour ${ticker}: ${Object.keys(prices).length} points`);
            return prices;
        } catch (error) {
            console.warn(`Tentative historique ${attempt + 1} échouée pour ${ticker}:`, error.message);
            this.currentProxyIndex = (this.currentProxyIndex + 1) % this.corsProxies.length;
            console.warn(`Proxy historique échoué. Passage à ${this.corsProxies[this.currentProxyIndex]}`);
            await sleep(2000);
        }
    }
    console.error(`Échec final de récupération historique pour ${ticker}`);
    return {}; 
  }
  
  formatTicker(ticker) {
    ticker = ticker.toUpperCase().trim();
    if (YAHOO_MAP[ticker]) return YAHOO_MAP[ticker];
    const cryptos = ['ETH','SOL','ADA','DOT','LINK','LTC','XRP','XLM','BNB','AVAX'];
    return cryptos.includes(ticker) ? ticker + '-EUR' : ticker;
  }

  // ... (Le reste de api.js : loadHistoricalCache, saveHistoricalCache, cleanIntradayCache, getMarketStatus, etc. reste inchangé) ...
  loadHistoricalCache() {
    // ... (code inchangé) ...
    try {
        const cached = localStorage.getItem('historicalPriceCache');
        if (!cached) return {};
        const parsed = JSON.parse(cached);
        if (parsed.timestamp && (Date.now() - parsed.timestamp < 7 * 24 * 60 * 60 * 1000)) {
            return parsed.data || {};
        } else {
            localStorage.removeItem('historicalPriceCache');
        }
    } catch (e) {
        console.warn('Erreur chargement cache historique:', e);
    }
    return {};
  }
  saveHistoricalCache() {
    // ... (code inchangé) ...
    try {
        this.cleanIntradayCache(); 
        localStorage.setItem('historicalPriceCache', JSON.stringify({ timestamp: Date.now(), data: this.historicalPriceCache }));
    } catch (e) {
        if (e.name === 'QuotaExceededError') {
            console.warn('Quota localStorage dépassé, cache historique vidé.');
            this.historicalPriceCache = {};
            localStorage.removeItem('historicalPriceCache');
        }
    }
  }
  cleanIntradayCache() {
    // ... (code inchangé) ...
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
    const keysToDelete = [];
    for (const key in this.historicalPriceCache) {
        const parts = key.split('_');
        if (parts.length === 5 && !isNaN(parts[4])) {
            const timestamp = parseInt(parts[4]);
            if (timestamp < twoHoursAgo) {
                keysToDelete.push(key);
            }
        }
    }
    keysToDelete.forEach(key => delete this.historicalPriceCache[key]);
    if (keysToDelete.length > 0) {
        console.log(`Cache historique nettoyé: ${keysToDelete.length} entrées intraday supprimées`);
    }
  }
  getMarketStatus() {
    // ... (code inchangé) ...
    const now = new Date();
    const day = now.getDay();
    const hours = now.getHours();
    if (day === 0 || day === 6) {
      return {
        isOpen: false,
        reason: 'weekend',
        message: 'Marchés fermés (weekend) - Prix de clôture du vendredi'
      };
    }
    if (hours < 8 || hours >= 22) {
      return {
        isOpen: false,
        reason: 'closed',
        message: 'Marchés fermés - Prix de clôture affichés'
      };
    }
    return {
      isOpen: true,
      reason: 'open',
      message: 'Marchés ouverts'
    };
  }
  getPriceSourceStats() {
    // ... (code inchangé) ...
    const purchases = this.storage.getPurchases();
    const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
    let yahooV2Count = 0, coingeckoCount = 0, cachedCount = 0, missingCount = 0;
    tickers.forEach(ticker => {
      const priceData = this.storage.getCurrentPrice(ticker);
      if (!priceData || !priceData.price) {
        missingCount++;
      } else if (priceData.source === 'YahooV2 (5m)') yahooV2Count++;
      else if (priceData.source === 'CoinGecko') coingeckoCount++;
      else cachedCount++; 
    });
    return {
      total: tickers.length,
      yahooV2: yahooV2Count,
      coingecko: coingeckoCount,
      cached: cachedCount,
      missing: missingCount
    };
  }
  logProviderStats() {
    // ... (code inchangé) ...
    console.log('Statistiques des providers (Unifié):');
    Object.entries(providerStats).forEach(([name, stats]) => {
      const total = stats.success + stats.fails;
      const successRate = total > 0 ? ((stats.success / total) * 100).toFixed(1) : 0;
      console.log(` ${name}: ${stats.success} succès, ${stats.fails} échecs (${successRate}% succès)`);
      if (stats.lastError) {
        console.log(` Dernière erreur: ${stats.lastError}`);
      }
    });
  }
}