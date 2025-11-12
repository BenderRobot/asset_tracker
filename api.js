// ========================================
// api.js - RÉCUPÉRATION DES PRIX (ACTUELS + HISTORIQUES)
// (VERSION CORRIGÉE AVEC PROXIES MULTIPLES ET BATCHS RAPIDES)
// ========================================
import { RAPIDAPI_KEY, YAHOO_MAP, USD_TO_EUR_RATE } from './config.js';
import { sleep } from './utils.js';

const USD_TICKERS = new Set(['BKSY', 'SPY', 'VOO']);

// Configuration des APIs (GRATUITES - À configurer)
const API_KEYS = {
  FMP: 'qyy6jDPLGl4aekEISutLjmMdMXcRsNFF',
  // Créez une clé gratuite sur https://www.alphavantage.co/support/#api-key
  ALPHA_VANTAGE: 'EDUO8C8GYUM385LF',
  // Créez une clé gratuite sur https://finnhub.io/register
  FINNHUB: 'd447bqhr01qge0d0spfgd447bqhr01qge0d0spg0'
};

// Statistiques des providers
const providerStats = {
  YAHOO_V2: { success: 0, fails: 0, lastError: null, lastUse: null },
  ALPHA_VANTAGE: { success: 0, fails: 0, lastError: null, lastUse: null },
  FINNHUB: { success: 0, fails: 0, lastError: null, lastUse: null },
  FMP: { success: 0, fails: 0, lastError: null, lastUse: null },
  YAHOO_RAPID: { success: 0, fails: 0, lastError: null, lastUse: null }
};

export class PriceAPI {
  constructor(storage) {
    this.storage = storage;
    this.providerIndex = 0;

    // === Logique proxy unifiée ===
    this.corsProxies = [
      'https://api.allorigins.win/raw?url=',
      'https://corsproxy.io/?',
      'https://api.codetabs.com/v1/proxy?quest='
    ];
    this.currentProxyIndex = 0;

    // === Cache pour les PRIX HISTORIQUES (déplacé de historicalChart.js) ===
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

  // NOUVEAU: Vérifier si c'est un ticker VRAIMENT américain
  isUSTickerOnly(ticker) {
    const yahooSymbol = YAHOO_MAP[ticker] || ticker;
    return USD_TICKERS.has(ticker.toUpperCase()) ||
           (!yahooSymbol.includes('.F') &&
            !yahooSymbol.includes('.PA') &&
            !yahooSymbol.includes('.AS'));
  }

  // Convertir USD en EUR si nécessaire
  convertToEUR(price, ticker) {
    if (USD_TICKERS.has(ticker.toUpperCase())) {
      return { price, currency: 'USD' };
    }
    return {
      price: price * USD_TO_EUR_RATE,
      currency: 'EUR'
    };
  }

  // ==========================================================
  // RÉCUPÉRATION PRIX ACTUELS (INCHANGÉ)
  // ==========================================================

  async fetchBatchPrices(tickers, forceWeekend = false) {
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
    const stats = this.getPriceSourceStats();
    console.log('Sources des prix:', {
      'Yahoo V2': stats.yahooV2,
      'Alpha Vantage': stats.alphaVantage,
      'Finnhub': stats.finnhub,
      'FMP': stats.fmp,
      'Yahoo Rapid': stats.yahooRapid,
      'Cache': stats.cached,
      'Manquants': stats.missing
    });

    this.logProviderStats();
  }

  // ... (Toute la logique de fetchPricesWithFallback, fetchAlphaVantagePrices,
  // fetchFinnhubPrices, fetchYahooV2Prices, fetchFMPPrices, fetchYahooPrices,
  // fetchCryptoPrice est INCHANGÉE) ...
  // ...
    async fetchPricesWithFallback(tickers) {
    const europeanTickers = tickers.filter(t => !this.isUSTickerOnly(t));
    const usTickers = tickers.filter(t => this.isUSTickerOnly(t));
    let allSuccess = true;

    // TICKERS EUROPÉENS : Yahoo V2 UNIQUEMENT
    if (europeanTickers.length > 0) {
      console.log(`Tickers européens (${europeanTickers.length}): Yahoo V2 uniquement`);
      const providers = [
        { name: 'YAHOO_V2', method: this.fetchYahooV2Prices.bind(this) },
        { name: 'YAHOO_RAPID', method: this.fetchYahooPrices.bind(this) }
      ];
      let success = false;
      for (const provider of providers) {
        try {
          console.log(`Essai ${provider.name} (tickers EU)...`);
          success = await provider.method(europeanTickers);
          if (success) {
            providerStats[provider.name].success++;
            providerStats[provider.name].lastUse = Date.now();
            console.log(`${provider.name} OK (tickers EU)`);
            break;
          }
        } catch (err) {
          providerStats[provider.name].fails++;
          providerStats[provider.name].lastError = err.message;
          console.warn(`${provider.name} échoué (tickers EU): ${err.message}`);
        }
      }
      if (!success) {
        console.error(`Tous les providers ont échoué pour les tickers EU`);
        allSuccess = false;
      }
    }

    // TICKERS US : Alpha Vantage, Finnhub, etc.
    if (usTickers.length > 0) {
      console.log(`Tickers US (${usTickers.length}): Toutes APIs disponibles`);
      const providers = [
        { name: 'ALPHA_VANTAGE', method: this.fetchAlphaVantagePrices.bind(this) },
        { name: 'FINNHUB', method: this.fetchFinnhubPrices.bind(this) },
        { name: 'FMP', method: this.fetchFMPPrices.bind(this) }
      ];
      let success = false;
      for (const provider of providers) {
        try {
          console.log(`Essai ${provider.name} (tickers US)...`);
          success = await provider.method(usTickers);
          if (success) {
            providerStats[provider.name].success++;
            providerStats[provider.name].lastUse = Date.now();
            console.log(`${provider.name} OK (tickers US)`);
            break;
          }
        } catch (err) {
          providerStats[provider.name].fails++;
          providerStats[provider.name].lastError = err.message;
          console.warn(`${provider.name} échoué (tickers US): ${err.message}`);
        }
      }
      if (!success) {
        console.error(`Tous les providers ont échoué pour les tickers US`);
        allSuccess = false;
      }
    }

    return allSuccess;
  }

  // Alpha Vantage avec conversion EUR (POUR TICKERS US SEULEMENT)
  async fetchAlphaVantagePrices(tickers) {
    if (API_KEYS.ALPHA_VANTAGE === 'demo' || API_KEYS.ALPHA_VANTAGE.includes('VOTRE')) {
      console.warn('Alpha Vantage: Créez votre clé sur https://www.alphavantage.co/support/#api-key');
      return false;
    }

    const results = [];
    for (const ticker of tickers) {
      try {
        const symbol = ticker.toUpperCase();
        const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${API_KEYS.ALPHA_VANTAGE}`;
        const res = await fetch(url);

        if (!res.ok) {
          console.warn(`Alpha Vantage erreur HTTP pour ${ticker}: ${res.status}`);
          continue;
        }

        const data = await res.json();
        if (data['Note']) {
          console.warn('Alpha Vantage rate limit atteint');
          return false;
        }

        const quote = data['Global Quote'];
        if (quote && quote['05. price']) {
          const usdPrice = parseFloat(quote['05. price']);
          const priceData = {
            price: usdPrice,
            previousClose: quote['08. previous close'] ? parseFloat(quote['08. previous close']) : null,
            currency: 'USD',
            marketState: 'CLOSED',
            lastUpdate: Date.now(),
            source: 'AlphaVantage'
          };

          this.storage.setCurrentPrice(ticker.toUpperCase(), priceData);
          console.log(`Alpha Vantage: ${ticker} = ${priceData.price.toFixed(2)} ${priceData.currency}`);
          results.push(ticker);
        }

        if (tickers.indexOf(ticker) < tickers.length - 1) {
          await sleep(12000);
        }
      } catch (err) {
        console.error(`Erreur Alpha Vantage pour ${ticker}:`, err.message);
      }
    }
    return results.length > 0;
  }

  // Finnhub avec conversion EUR (POUR TICKERS US SEULEMENT)
  async fetchFinnhubPrices(tickers) {
    if (API_KEYS.FINNHUB === 'demo' || API_KEYS.FINNHUB.includes('VOTRE')) {
      console.warn('Finnhub: Créez votre clé sur https://finnhub.io/register');
      return false;
    }

    const results = [];
    for (const ticker of tickers) {
      try {
        const symbol = ticker.toUpperCase();
        const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${API_KEYS.FINNHUB}`;
        const res = await fetch(url);

        if (!res.ok) {
          console.warn(`Finnhub erreur HTTP pour ${ticker}: ${res.status}`);
          continue;
        }

        const data = await res.json();
        if (data.c && data.c > 0) {
          const usdPrice = parseFloat(data.c);
          const priceData = {
            price: usdPrice,
            previousClose: data.pc ? parseFloat(data.pc) : null,
            currency: 'USD',
            marketState: 'CLOSED',
            lastUpdate: Date.now(),
            source: 'Finnhub'
          };

          this.storage.setCurrentPrice(ticker.toUpperCase(), priceData);
          console.log(`Finnhub: ${ticker} = ${priceData.price.toFixed(2)} ${priceData.currency}`);
          results.push(ticker);
        }

        if (tickers.indexOf(ticker) < tickers.length - 1) {
          await sleep(1000);
        }
      } catch (err) {
        console.error(`Erreur Finnhub pour ${ticker}:`, err.message);
      }
    }
    return results.length > 0;
  }

  // === FIX 2 : Fonction Yahoo V2 rendue robuste ===
  async fetchYahooV2Prices(tickers) {
    const results = [];
    for (const ticker of tickers) {
      try {
        const symbol = YAHOO_MAP[ticker] || `${ticker}.F`;
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
        
        // Logique de proxy robuste
        const proxy = this.corsProxies[this.currentProxyIndex];
        const url = `${proxy}${encodeURIComponent(yahooUrl)}`;
        
        // Ajout d'un timeout de 8s
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) }); 

        if (!res.ok) {
          throw new Error(`Erreur HTTP ${res.status}`); // Provoquer le catch
        }

        const data = await res.json();
        const quote = data?.chart?.result?.[0]?.meta;

        if (quote && quote.regularMarketPrice) {
          let previousClose = null;
          if (quote.previousClose) previousClose = parseFloat(quote.previousClose);
          else if (quote.chartPreviousClose) previousClose = parseFloat(quote.chartPreviousClose);
          else if (quote.regularMarketPreviousClose) previousClose = parseFloat(quote.regularMarketPreviousClose);

          if (!previousClose) {
            const indicators = data?.chart?.result?.[0]?.indicators?.quote?.[0];
            const closes = indicators?.close;
            if (closes && closes.length > 1) {
              previousClose = closes[closes.length - 2];
            }
          }

          const priceData = {
            price: parseFloat(quote.regularMarketPrice),
            previousClose: previousClose,
            currency: quote.currency || 'EUR',
            marketState: quote.marketState || 'CLOSED',
            lastUpdate: Date.now(),
            source: 'YahooV2'
          };

          this.storage.setCurrentPrice(ticker.toUpperCase(), priceData);
          console.log(`Yahoo V2: ${ticker} = ${priceData.price.toFixed(2)} ${priceData.currency} (prev: ${previousClose ? previousClose.toFixed(2) : 'N/A'})`);
          results.push(ticker);
        }

        if (tickers.indexOf(ticker) < tickers.length - 1) {
          await sleep(500); // Garder une petite pause
        }
      } catch (err) {
        console.error(`Erreur Yahoo V2 pour ${ticker}:`, err.message);
        
        // Changer de proxy en cas d'échec
        this.currentProxyIndex = (this.currentProxyIndex + 1) % this.corsProxies.length;
        console.warn(`Proxy échoué. Passage au proxy suivant: ${this.corsProxies[this.currentProxyIndex]}`);
      }
    }
    return results.length > 0;
  }

  async fetchFMPPrices(tickers) {
    const results = [];
    for (const ticker of tickers) {
      try {
        const fmpSymbol = ticker.toUpperCase();
        const url = `https://financialmodelingprep.com/api/v3/quote/${fmpSymbol}?apikey=${API_KEYS.FMP}`;
        const res = await fetch(url);

        if (!res.ok) {
          console.warn(`FMP erreur pour ${ticker}: ${res.status}`);
          continue;
        }

        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) {
          console.warn(`${ticker} non trouvé sur FMP`);
          continue;
        }

        const quote = data[0];
        if (quote.price) {
          const priceData = {
            price: parseFloat(quote.price),
            previousClose: quote.previousClose ? parseFloat(quote.previousClose) : null,
            currency: 'USD',
            marketState: 'CLOSED',
            lastUpdate: Date.now(),
            source: 'FMP'
          };

          this.storage.setCurrentPrice(ticker.toUpperCase(), priceData);
          console.log(`FMP: ${ticker} = ${priceData.price.toFixed(2)} ${priceData.currency}`);
          results.push(ticker);
        }

        if (tickers.indexOf(ticker) < tickers.length - 1) {
          await sleep(500);
        }
      } catch (err) {
        console.error(`Erreur FMP pour ${ticker}:`, err.message);
      }
    }
    return results.length > 0;
  }

  async fetchYahooPrices(tickers) {
    const symbols = tickers.map(t => YAHOO_MAP[t] || `${t}.F`).join(',');
    const url = `https://apidojo-yahoo-finance-v1.p.rapidapi.com/market/v2/get-quotes?symbols=${encodeURIComponent(symbols)}&region=US`;

    try {
      const res = await fetch(url, {
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': 'apidojo-yahoo-finance-v1.p.rapidapi.com'
        }
      });

      if (res.status === 429) {
        console.warn('Rate limit Yahoo RapidAPI atteint');
        return false;
      }
      if (!res.ok) {
        console.warn(`Yahoo RapidAPI erreur: ${res.status}`);
        return false;
      }

      const data = await res.json();
      const results = data?.quoteResponse?.result || [];

      if (results.length === 0) {
        console.warn('Aucun résultat Yahoo RapidAPI');
        return false;
      }

      results.forEach(quote => {
        const symbol = quote.symbol.replace(/\..*$/, '').toUpperCase();
        const originalTicker = Object.keys(YAHOO_MAP).find(k => YAHOO_MAP[k] === quote.symbol) || symbol;

        let price = quote.regularMarketPrice ?? quote.postMarketPrice ?? quote.regularMarketPreviousClose;
        if (price !== null && price !== undefined) {
          const priceData = {
            price: parseFloat(price),
            previousClose: quote.regularMarketPreviousClose ? parseFloat(quote.regularMarketPreviousClose) : null,
            currency: quote.currency || 'EUR',
            marketState: quote.marketState || 'CLOSED',
            lastUpdate: Date.now(),
            source: 'YahooRapid'
          };

          this.storage.setCurrentPrice(originalTicker, priceData);
          console.log(`Yahoo Rapid: ${originalTicker} = ${price.toFixed(2)} ${priceData.currency}`);
        }
      });

      return true;
    } catch (err) {
      console.error('Erreur Yahoo RapidAPI:', err.message);
      return false;
    }
  }

  async fetchCryptoPrice(ticker) {
    const upper = ticker.toUpperCase();
    try {
      let coinId;
      if (upper === 'BTC') coinId = 'bitcoin';
      else if (upper === 'ETH') coinId = 'ethereum';
      else return; // Ne gère pas les autres cryptos pour l'instant

      // === NOUVELLE LOGIQUE DE CLÔTURE 00:00 UTC ===
      let previousClose = null;
      try {
        // 1. Obtenir la date d'aujourd'hui au format coingecko (dd-mm-yyyy)
        const today = new Date();
        const dateStr = `${today.getUTCDate()}-${today.getUTCMonth() + 1}-${today.getUTCFullYear()}`;

        // 2. Interroger l'historique pour CETTE date (donne le prix à 00:00 UTC)
        const historyRes = await fetch(`https://api.coingecko.com/api/v3/coins/${coinId}/history?date=${dateStr}&localization=false`);
        if (historyRes.ok) {
          const historyData = await historyRes.json();
          if (historyData?.market_data?.current_price?.eur) {
            previousClose = historyData.market_data.current_price.eur;
            console.log(`Clôture 00:00 UTC pour ${upper}: ${previousClose} EUR`);
          }
        }
      } catch (e) {
        console.warn(`Erreur lors de la récupération de la clôture 00:00 pour ${upper}:`, e.message);
      }
      // === FIN DE LA NOUVELLE LOGIQUE ===

      // Récupération du prix actuel (inchangée)
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=eur`);
      if (res.ok) {
        const data = await res.json();
        const price = data[coinId]?.eur;
        
        if (price) {
          // Si on n'a pas réussi à avoir le prix de 00:00, on se rabat sur l'ancienne méthode
          if (previousClose === null) {
              console.warn(`Utilisation de la clôture 24h (fallback) pour ${upper}`);
              // Il faut refaire l'appel pour avoir le change24h
              const res24h = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=eur&include_24hr_change=true`);
              const data24h = await res24h.json();
              const change24h = data24h[coinId]?.eur_24h_change || 0;
              previousClose = price * (1 - change24h / 100);
          }

          this.storage.setCurrentPrice(upper, {
            price,
            previousClose, // Utilise la nouvelle valeur de 00:00 !
            currency: 'EUR',
            marketState: 'OPEN',
            lastUpdate: Date.now(),
            source: 'CoinGecko'
          });

          console.log(`Crypto: ${upper} = ${price} EUR (Préc: ${previousClose})`);
        }
      }
    } catch (e) {
      console.error(`Erreur CoinGecko pour ${upper}:`, e.message);
    }
  }
  
  // ==========================================================
  // NOUVELLES FONCTIONS (DÉPLACÉES DE historicalChart.js)
  // ==========================================================

  async getHistoricalPricesWithRetry(ticker, startTs, endTs, interval, retries = 3) {
    const formatted = this.formatTicker(ticker); // Utilise la nouvelle méthode formatTicker
    let cacheKey = `${formatted}_${startTs}_${endTs}_${interval}`;
    
    // Logique de cache intraday (inchangée)
    if (['5m', '15m', '30m', '1h'].includes(interval)) {
        const now = Date.now();
        const rounded = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000);
        cacheKey = `${formatted}_${startTs}_${endTs}_${interval}_${rounded}`;
    }

    if (this.historicalPriceCache[cacheKey]) {
        console.log(`Cache historique hit pour ${ticker}`);
        return this.historicalPriceCache[cacheKey];
    }

    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${formatted}?period1=${startTs}&period2=${endTs}&interval=${interval}`;

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            let response;
            
            // On utilise la logique de proxy DE CETTE CLASSE
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
            console.log(`Prix historiques récupérés pour ${ticker}: ${Object.keys(prices).length} points`);
            return prices;
        } catch (error) {
            console.warn(`Tentative historique ${attempt + 1} échouée pour ${ticker}:`, error.message);
            
            // On utilise le changement de proxy DE CETTE CLASSE
            this.currentProxyIndex = (this.currentProxyIndex + 1) % this.corsProxies.length;
            console.warn(`Proxy historique échoué. Passage à ${this.corsProxies[this.currentProxyIndex]}`);
            await sleep(2000); // Utilise sleep de utils.js
        }
    }
    console.error(`Échec final de récupération historique pour ${ticker}`);
    return {}; // Retourne un objet vide en cas d'échec final
  }
  
  // Utilitaire pour la fonction ci-dessus
  formatTicker(ticker) {
    ticker = ticker.toUpperCase().trim();
    if (YAHOO_MAP[ticker]) return YAHOO_MAP[ticker];
    // Logique simplifiée de l'original
    const cryptos = ['ETH','SOL','ADA','DOT','LINK','LTC','XRP','XLM','BNB','AVAX'];
    return cryptos.includes(ticker) ? ticker + '-EUR' : ticker;
  }

  // ==========================================================
  // NOUVELLE GESTION DE CACHE (DÉPLACÉE)
  // ==========================================================

  loadHistoricalCache() {
    try {
        const cached = localStorage.getItem('historicalPriceCache');
        if (!cached) return {};
        const parsed = JSON.parse(cached);
        // Garde le cache pour 7 jours
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
    try {
        this.cleanIntradayCache(); // Nettoie d'abord les vieilles données intraday
        localStorage.setItem('historicalPriceCache', JSON.stringify({ timestamp: Date.now(), data: this.historicalPriceCache }));
    } catch (e) {
        if (e.name === 'QuotaExceededError') {
            // Si le cache est plein, on le vide
            console.warn('Quota localStorage dépassé, cache historique vidé.');
            this.historicalPriceCache = {};
            localStorage.removeItem('historicalPriceCache');
        }
    }
  }

  cleanIntradayCache() {
    // Nettoie les clés de cache intraday (ex: 5m, 1h) qui ont plus de 2h
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
    const keysToDelete = [];
    for (const key in this.historicalPriceCache) {
        const parts = key.split('_');
        // Clé intraday_roundedTimestamp (ex: ..._5m_1678886400000)
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

  // ==========================================================
  // AUTRES FONCTIONS (INCHANGÉES)
  // ==========================================================
  
  getMarketStatus() {
    // ... (inchangé)
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
    // ... (inchangé)
    const purchases = this.storage.getPurchases();
    const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];

    let alphaVantageCount = 0, finnhubCount = 0, yahooV2Count = 0;
    let fmpCount = 0, yahooRapidCount = 0, cachedCount = 0, missingCount = 0;

    tickers.forEach(ticker => {
      const priceData = this.storage.getCurrentPrice(ticker);
      if (!priceData || !priceData.price) {
        missingCount++;
      } else if (priceData.source === 'AlphaVantage') alphaVantageCount++;
      else if (priceData.source === 'Finnhub') finnhubCount++;
      else if (priceData.source === 'YahooV2') yahooV2Count++;
      else if (priceData.source === 'FMP') fmpCount++;
      else if (priceData.source === 'YahooRapid') yahooRapidCount++;
      else cachedCount++; // Inclut CoinGecko et cache
    });

    return {
      total: tickers.length,
      alphaVantage: alphaVantageCount,
      finnhub: finnhubCount,
      yahooV2: yahooV2Count,
      fmp: fmpCount,
      yahooRapid: yahooRapidCount,
      cached: cachedCount,
      missing: missingCount
    };
  }

  logProviderStats() {
    // ... (inchangé)
    console.log('Statistiques des providers:');
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