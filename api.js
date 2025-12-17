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

  // NOUVELLE MÉTHODE SPÉCIFIQUE DASHBOARD: Récupère les données d'indices avec previousClose et lastTradingDayClose
  async fetchIndexDataForDashboard(ticker) {
    const symbol = this.formatTicker(ticker);
    const type = 'STOCK'; // Les indices sont toujours de type STOCK

    try {
      // Déterminer l'intervalle selon le type d'actif
      const isBitcoin = ticker.includes('BTC');
      const interval = isBitcoin ? '5m' : '1d';
      const url = `${PRICE_PROXY_URL}?symbol=${symbol}&type=${type}&range=5d&interval=${interval}`;

      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);

      const data = await res.json();

      // Parser les données Yahoo
      if (!data.chart || !data.chart.result || data.chart.result.length === 0) {
        throw new Error('Invalid Yahoo format from proxy');
      }

      const chartData = data.chart.result[0];
      const meta = chartData.meta || {};
      const quote = chartData.indicators?.quote?.[0] || {};
      const timestamps = chartData.timestamp || [];
      const closes = quote.close || [];

      // Prix actuel
      let currentPrice = meta.regularMarketPrice || closes[closes.length - 1];
      if (!currentPrice || currentPrice <= 0) {
        throw new Error('No valid current price');
      }

      // previousClose de base
      let previousClose = meta.chartPreviousClose || meta.previousClose;
      if (!previousClose || previousClose <= 0) {
        previousClose = currentPrice;
      }

      const currency = meta.currency || 'EUR';

      // LOGIQUE SPÉCIFIQUE INDICES : Récupérer previousClose et lastTradingDayClose via historique
      let truePreviousClose = null;
      let lastTradingDayClose = null;

      try {
        const nowSec = Math.floor(Date.now() / 1000);
        let histInterval, histRange;

        // Futures (ES=F, NQ=F) et Bitcoin : intervalle 5m pour données intraday lisses
        const isFuture = ticker.endsWith('=F');
        if (isBitcoin || isFuture) {
          // Bitcoin/Futures : récupérer les 2 derniers jours avec intervalle 5m
          histInterval = '5m';
          histRange = nowSec - (2 * 24 * 60 * 60);
        } else {
          // Indices classiques : récupérer 5 jours avec intervalle 1d
          histInterval = '1d';
          histRange = nowSec - (5 * 24 * 60 * 60);
        }

        const hist = await this.getHistoricalPricesWithRetry(
          ticker,
          histRange,
          nowSec,
          histInterval
        );

        if (hist && Object.keys(hist).length > 0) {
          // Normalisation des timestamps en MS pour la comparaison
          const sortedKeys = Object.keys(hist).sort((a, b) => Number(b) - Number(a));
          const snapshots = sortedKeys.map(key => {
            let ts = Number(key);
            // Détection heuristique : Si < 1000000000000 (10^12), c'est probablement des secondes (l'an 2001 en ms est > 10^12)
            // Le timestamp actuel est env 1.7 * 10^12 (ms) ou 1.7 * 10^9 (sec)
            const isSeconds = ts < 1000000000000;
            return {
              originalKey: key,
              tsMs: isSeconds ? ts * 1000 : ts,
              price: hist[key]
            };
          });

          if (isBitcoin) {
            // Pour Bitcoin : utiliser Minuit UTC comme référence (standard crypto)
            const now = new Date();
            const midnightMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0);

            const snapBeforeMidnight = snapshots.find(s => s.tsMs < midnightMs);
            if (snapBeforeMidnight) {
              truePreviousClose = snapBeforeMidnight.price;
            }

            // lastTradingDayClose = minuit UTC d'hier
            const midnightYesterdayMs = midnightMs - (24 * 60 * 60 * 1000);

            const snapBeforeYesterday = snapshots.find(s => s.tsMs < midnightYesterdayMs);
            if (snapBeforeYesterday) {
              lastTradingDayClose = snapBeforeYesterday.price;
            }
          } else {
            // Pour les indices : TOUJOURS utiliser J-1 comme référence
            // On ne compare JAMAIS avec le prix du même jour
            const latestDate = new Date(snapshots[0].tsMs);
            const todayDate = new Date();
            const isToday = latestDate.toDateString() === todayDate.toDateString();

            if (isToday && snapshots.length > 1) {
              // Aujourd'hui existe → previousClose = hier (snapshots[1])
              truePreviousClose = snapshots[1].price;
              lastTradingDayClose = snapshots.length > 2 ? snapshots[2].price : snapshots[1].price;
            } else {
              // Pas de données aujourd'hui → previousClose = dernier jour (snapshots[0])
              truePreviousClose = snapshots[0].price;
              lastTradingDayClose = snapshots.length > 1 ? snapshots[1].price : snapshots[0].price;
            }
          }

          console.log(`[IndexDashboard ${ticker}] previousClose (J): ${truePreviousClose?.toFixed(4)}, lastTradingDayClose (J-1): ${lastTradingDayClose?.toFixed(4)}`);
        }
      } catch (err) {
        console.warn(`Could not fetch historical close for ${ticker}:`, err.message);
      }

      // Convertir en EUR si nécessaire
      // On ne convertit QUE les actions (Stocks) listées dans USD_TICKERS ou explicitement en USD.
      // Les Indices (^GSPC, ^IXIC) restent en points.
      // Les Futures (GC=F) restent en USD.
      // Le Forex (EURUSD=X) reste en taux.
      const isUSD = (currency === 'USD') && !ticker.startsWith('^') && !ticker.endsWith('=F') && !ticker.endsWith('=X');

      if (isUSD) {
        const rate = (this.storage.getConversionRate('USD_TO_EUR') || 0.925);
        currentPrice = currentPrice * rate;
        if (truePreviousClose) truePreviousClose = truePreviousClose * rate;
        if (lastTradingDayClose) lastTradingDayClose = lastTradingDayClose * rate;
      }

      return {
        price: currentPrice,
        previousClose: truePreviousClose || previousClose,
        lastTradingDayClose: lastTradingDayClose || truePreviousClose || previousClose,
        currency: 'EUR',
        marketState: meta.marketState || 'CLOSED'
      };

    } catch (err) {
      console.error(`[IndexDashboard] Error fetching ${ticker}:`, err.message);
      return null;
    }
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
        // [FIX] On utilise interval=1d pour avoir un chartPreviousClose correct (Clôture veille officielle)
        // L'intervalle 5m renvoyait parfois des NAV post-clôture ou des incohérences pour les ETF.
        const url = `${PRICE_PROXY_URL}?symbol=${symbol}&type=${type}&range=5d&interval=1d`;

        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);

        const data = await res.json();

        let result;
        let source;

        if (type === 'CRYPTO') {
          // Logique CoinGecko/Binance (Le proxy a déjà géré le fallback)
          let coinId = (symbol.split('-')[0] || symbol).toLowerCase();

          // Format CoinGecko: {bitcoin: {eur: 95000, eur_24h_change: 2.5}}
          if (data[coinId] && data[coinId].eur) {
            const coinData = data[coinId];
            result = {
              price: coinData.eur,
              previousClose: coinData.eur_24h_change
                ? coinData.eur / (1 + (coinData.eur_24h_change / 100))
                : coinData.eur,
              currency: 'EUR',
              marketState: 'OPEN'
            };
            source = 'CoinGecko Proxy';
          }
          // Format Binance: {lastPrice: "95000", prevClosePrice: "93000"}
          else if (data.lastPrice) {
            result = {
              price: parseFloat(data.lastPrice),
              previousClose: parseFloat(data.prevClosePrice || data.lastPrice),
              currency: 'EUR',
              marketState: 'OPEN'
            };
            source = 'Binance Proxy';
          }
          // Format simple: {price: 95000, previousClose: 93000}
          else if (data.price) {
            result = {
              price: parseFloat(data.price),
              previousClose: parseFloat(data.previousClose || data.price),
              currency: 'EUR',
              marketState: 'OPEN'
            };
            source = 'Crypto Proxy';
          }
          else {
            // Si la CF n'a rien trouvé, on échoue ici
            console.error('Crypto response format:', data);
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

          // PRIORITÉ: Calculer le previousClose à partir des bougies historiques (1d)
          // Yahoo MetaData (chartPreviousClose) est souvent erroné pour les ETF européens (NAV vendredi vs Lundi)
          // On cherche la dernière bougie qui n'est PAS celle d'aujourd'hui.
          let calculatedPreviousClose = null;
          let calculatedLastTradingDayClose = null;

          if (timestamps && timestamps.length > 1) {
            const now = new Date();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;

            // Trouver la dernière bougie avant aujourd'hui
            for (let i = timestamps.length - 1; i >= 0; i--) {
              const ts = timestamps[i];
              if (ts < todayStart && quotes[i] !== null) {
                calculatedPreviousClose = parseFloat(quotes[i]);
                // Si possible, trouver celle d'avant pour J-1 (optionnel)
                break;
              }
            }
          }

          let previousClose = calculatedPreviousClose;

          // Fallback sur Meta si pas trouvé dans l'historique
          if (!previousClose || previousClose <= 0) {
            previousClose = meta.chartPreviousClose || meta.previousClose;
          }

          // Dernier fallback: utiliser currentPrice si toujours null
          if (!previousClose || previousClose <= 0) {
            previousClose = currentPrice;
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
    let assetType = this.storage.getAssetType(ticker) ? this.storage.getAssetType(ticker).toUpperCase() : 'STOCK';

    // CRITICAL FIX: Skip dividend assets immediately - they have no historical price data
    if (assetType === 'DIVIDEND' || assetType === 'CASH') {
      console.log(`[API History] Skipping ${ticker} (type: ${assetType}) - no price history for transactions`);
      return {};
    }

    // PATCH: Force Crypto type for known patterns (e.g. Dashboard indices not in portfolio)
    // REMOVED: BTC-EUR and others should use standard Yahoo history for better chart compatibility
    /*
    if (formatted.endsWith('-EUR') || formatted.endsWith('-USD') || formatted === 'BTC-EUR' || ['BTC', 'ETH'].includes(formatted)) {
      assetType = 'CRYPTO';
    }
    */

    // Fix Gold ETF longue période (utilisé pour les requêtes Yahoo)
    // PATCH GOLD AVANCÉ : On utilise l'historique de GOLD.PA (USD) car celui de GOLD-EUR.PA est vide
    // MAIS on appliquera un ratio pour revenir au prix en EUR (~146€ vs ~74$)
    const longIntervals = ['1d', '1wk', '1mo', '3mo', '6mo', '1y'];
    let isGoldSwapped = false;
    if (formatted === 'GOLD-EUR.PA' && longIntervals.includes(interval)) {
      formatted = 'GOLD.PA';
      isGoldSwapped = true;
    }

    // Le cacheKey utilise une v5 pour forcer le rafraîchissement après les bugs de conversion
    let cacheKey = `v5_${formatted}_${startTs}_${endTs}_${interval}_${isGoldSwapped ? 'SWAP' : ''}`;
    if (['5m', '15m', '90m'].includes(interval)) {
      const rounded = Math.floor(Date.now() / 300000) * 300000;
      cacheKey += `_${rounded}`;
    }

    if (this.historicalPriceCache[cacheKey]) return this.historicalPriceCache[cacheKey];

    // L'appel se fait vers le Proxy Cloud Function pour l'historique
    // Nous passons tous les paramètres nécessaires au proxy
    let proxyUrl = `${PRICE_PROXY_URL}?symbol=${formatted}&type=${assetType}&interval=${interval}&period1=${startTs}&period2=${endTs}`;
    console.log(`[API History] Fetching ${ticker} (${interval}):`, proxyUrl);

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
        console.log(`[DEBUG ${ticker}] Raw data type:`, typeof data);
        console.log(`[DEBUG ${ticker}] Has chart property:`, !!data.chart);

        const chartData = data.chart ? data : (typeof data === 'string' ? JSON.parse(data) : data);

        console.log(`[DEBUG ${ticker}] chartData.chart exists:`, !!chartData.chart);
        console.log(`[DEBUG ${ticker}] chartData.chart.result exists:`, !!chartData.chart?.result);
        console.log(`[DEBUG ${ticker}] chartData.chart.result[0] exists:`, !!chartData.chart?.result?.[0]);
        console.log(`[DEBUG ${ticker}] chartData.chart.result[0].timestamp exists:`, !!chartData.chart?.result?.[0]?.timestamp);

        if (!chartData.chart?.result?.[0]?.timestamp) {
          console.warn(`[DEBUG ${ticker}] No timestamp data - market closed or no data for period`);
          return {}; // Retourner vide au lieu de throw - le code utilisera les fallbacks
        }

        const result = chartData.chart.result[0];
        const timestamps = result.timestamp;
        const quotes = result.indicators.quote[0].close;

        if (!timestamps || timestamps.length < 2) {
          console.warn(`[DEBUG ${ticker}] Insufficient data (${timestamps?.length || 0} points)`);
          return {};
        }

        const prices = {};

        // Les indices (^GSPC), futures (GC=F), et forex (EURUSD=X) ne doivent PAS être convertis
        // On respecte la logique "points" / valeurs natives
        const isIndex = ticker.startsWith('^');
        const isFuture = ticker.endsWith('=F');
        const isForex = ticker.endsWith('=X');
        const shouldNotConvert = isIndex || isFuture || isForex;

        const isUSD = !shouldNotConvert && USD_TICKERS.has(ticker.toUpperCase());
        const rate = isUSD ? (this.storage.getConversionRate('USD_TO_EUR') || 0.925) : 1;

        // CALCUL DU RATIO GOLD SI NÉCESSAIRE
        let goldRatio = 1;
        if (isGoldSwapped) {
          const targetPriceObj = this.storage.getCurrentPrice('GOLD-EUR.PA');
          // Si on n'a pas le prix cible en cache, on utilise un ratio fixe approximatif (146/74 ~ 1.97)
          // Ce cas est rare car l'app fetch d'abord le snapshot
          const targetPrice = targetPriceObj ? targetPriceObj.price : 146.8;

          // Le prix source (74$) est dans "quotes". On prend le dernier.
          const lastSourcePrice = quotes[quotes.length - 1];
          if (lastSourcePrice && lastSourcePrice > 0) {
            goldRatio = targetPrice / lastSourcePrice;
            console.log(`[GOLD FIX] Applying ratio ${goldRatio.toFixed(4)} (Target: ${targetPrice} / Source: ${lastSourcePrice})`);
          } else {
            goldRatio = 1.97;
          }
        }

        timestamps.forEach((ts, idx) => {
          if (quotes[idx] !== null) {
            let val = parseFloat(quotes[idx]);

            // Appliquer le Ratio Gold
            if (isGoldSwapped) {
              val = val * goldRatio;
            }
            // Appliquer la conversion USD standard (sauf si déjà traité par goldRatio? Non, GoldRatio fait tout)
            // Si on a appliqué goldRatio (TargetEUR / SourceUSD), le résultat est en EUR.
            // Donc on ne ré-applique PAS "rate" si isGoldSwapped est true (car targetPrice est déjà en EUR).
            else if (isUSD) {
              val = val * rate;
            }

            prices[ts * 1000] = val;
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