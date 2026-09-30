import { fetchMarketResponse } from './marketDataTransport.js?v=3';
// ========================================
// api.js - Cloudflare Workers Proxy
// ========================================
import { YAHOO_MAP, PRICE_PROXY_URL } from './config.js?v=2';
import { sleep } from './utils.js';
import { formatTicker as resolveYahooTicker, resolveTickerPreviousClose, getLastTradingDay } from './MarketUtils.js';
import { marketCalendarEngine } from './MarketCalendarEngine.js';
import { marketDataMetrics } from './marketDataMetrics.js';
import { historicalPointStore, isDeltaFetchEligible } from './historicalPointStore.js';
import { withHistoryCurrency } from './currency.js';

// Les anciennes clés et proxys ont été retirés pour la sécurité

const USD_TICKERS = new Set(['BKSY', 'SPY', 'VOO']);

// requestType est purement diagnostique (voir marketDataMetrics.js) — ne
// change ni l'URL ni le comportement du fetch, sert seulement à distinguer
// les compteurs "browserRequests" par nature d'appel.
function _fetchTimeout(url, ms, requestType = 'unknown', ttl = 60000) {
  return fetchMarketResponse(url, ms, requestType, ttl);
}

// Les providerStats sont simplifiés car le proxy est la seule source du Frontend
const providerStats = {
  GCP_PROXY: { success: 0, fails: 0, lastError: null }
};

// FAIL-CLOSED (audit incident 2026-09-23 — Worker prices en panne, HTTP 500 sur
// toute requête historique) : getHistoricalPricesWithRetry() a toujours renvoyé
// `{}` aussi bien quand le marché n'a légitimement aucune donnée pour la
// période (réponse Yahoo valide, juste vide) QUE quand les 3 tentatives ont
// toutes échoué pour une raison réseau/HTTP (proxy en panne, timeout, 5xx).
// HistoryCalculator ne pouvait pas distinguer les deux et traitait les deux
// cas identiquement — en pratique en retombant sur des prix courants/derniers
// connus, un historique financier COMPLET produit à partir de zéro vraie
// donnée. Ce marqueur (non-énumérable — invisible à Object.keys()/
// JSON.stringify(), donc totalement transparent pour tout code qui itère
// l'objet comme une map timestamp->prix) permet à l'appelant de savoir, de
// façon explicite, que le résultat vide est une PANNE et non une absence de
// donnée légitime.
const FETCH_FAILED_FLAG = '__priceDataFetchFailed';
const FETCH_FAILED_DETAILS = '__priceDataFetchFailureDetails';

export function isHistoricalFetchFailure(historicalResult) {
  return !!(historicalResult && historicalResult[FETCH_FAILED_FLAG]);
}

export function getHistoricalFetchFailureDetails(historicalResult) {
  return historicalResult?.[FETCH_FAILED_DETAILS] || null;
}

function markFetchFailed(result = {}, details = null) {
  Object.defineProperty(result, FETCH_FAILED_FLAG, { value: true, enumerable: false, configurable: true });
  Object.defineProperty(result, FETCH_FAILED_DETAILS, {
    value: details ? Object.freeze({ ...details }) : null,
    enumerable: false,
    configurable: true
  });
  return result;
}

// Exposé pour les tests (et tout appelant ayant besoin de construire un
// résultat "échec confirmé" sans passer par un throw) : le contrat réel de
// getHistoricalPricesWithRetry() ne lève JAMAIS d'exception (voir plus bas —
// elle catch systématiquement et renvoie ce marqueur), donc un test qui
// simule une panne réseau via un simple `throw` dans un double de test ne
// reproduit PAS fidèlement ce contrat pour un appelant qui ferait sa propre
// requête sans passer par cette fonction (voir HistoryCalculator::
// _resolvePortfolioCloseBefore, useDedicatedFetch).
export function createFailedHistoricalResult(details = null) {
  return markFetchFailed({}, details);
}

export class PriceAPI {
  constructor(storage) {
    this.storage = storage;
    // Les anciens proxys corsProxies et currentProxyIndex sont supprimés
    this.historicalPriceCache = this.loadHistoricalCache();
    // Coalescing : le dashboard déclenche 3 chemins d'orchestration indépendants
    // (refreshDataInBackground / loadPortfolioData / initHistoricalChart) qui
    // redemandent quasiment simultanément le même (ticker, fenêtre, interval).
    // historicalPriceCache ci-dessus ne protège que APRÈS succès (écrit ligne
    // ~730) ; les 3 appels partent avant qu'aucun n'ait eu le temps de répondre
    // et le trouvent tous vide (cache-stampede) → jusqu'à 3× le trafic réseau
    // réel, seule cause du flood HTTP 429 observé en prod (audit 2026-09-23).
    // Cette map retient la PROMESSE en cours par cacheKey : un appel concurrent
    // pour la même clé reçoit la même promesse au lieu de relancer un fetch.
    // Auto-invalidante (retirée dès résolution) — un refresh explicite ultérieur
    // repart bien sur le réseau. Ne mémorise aucun résultat au-delà de la durée
    // de l'appel en cours : ce n'est pas une nouvelle source de vérité.
    this._inFlightHistoricalRequests = new Map();

    // VALIDATION ARCHITECTURE (2026-09-24, MarketDataRepository, décision
    // "coalescing") : même défaut confirmé par l'audit que celui déjà corrigé
    // ci-dessus pour l'historique, mais pour les prix LIVE — loadPortfolioData()
    // et HistoricalChart.update() (mode portefeuille) appellent chacun leur
    // propre fetchBatchPrices(tickers) pour EXACTEMENT le même jeu de tickers,
    // sans coordination (voir dashboardApp.js/historicalChart.js — aucun
    // changement requis là-bas, ce fix est purement interne à cette méthode).
    // Même garantie qu'_inFlightHistoricalRequests : un appel concurrent pour
    // le même jeu de tickers (+ même forceRefresh) reçoit la MÊME promesse au
    // lieu de relancer son propre passage réseau ; auto-invalidante, un appel
    // ultérieur non concurrent relance bien un vrai cycle.
    this._inFlightBatchPriceRequests = new Map();
    this.liveFailures = new Map();
    this._indexDaily = new Map();
    this.historicalFetchedAt = {};
  }

  async ensureConversionRate() {
    if (!this.storage.setConversionRate) return;
    const cached = this.storage.conversionRates?.USD_TO_EUR;
    if (cached?.rate > 0 && Date.now() - cached.timestamp < 86400000) return;
    const response = await fetchMarketResponse('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR', 10000, 'fx-reference', 86400000);
    const data = await response.json();
    if (!(data.rates?.EUR > 0)) throw new Error('FX_DATA_UNAVAILABLE');
    this.storage.setConversionRate('USD_TO_EUR', data.rates.EUR);
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
    const upperTicker = ticker.toUpperCase().trim();
    const yahooSymbol = YAHOO_MAP[upperTicker] || upperTicker;
    const assetCategory = this.storage.getAssetCategory(upperTicker);

    if (USD_TICKERS.has(upperTicker) || assetCategory === 'USA') return true;
    if (/\.(PA|AS|F|DE|MI|BR|MC|LS|VI|SW|ST|CO|HE|OL|L|AX)$/i.test(yahooSymbol)) return false;
    if (yahooSymbol.includes('-EUR')) return false;
    return true;
  }

  formatTicker(ticker) {
    const normalizedTicker = ticker.toUpperCase().trim();
    return resolveYahooTicker(normalizedTicker, this.storage.getAssetCategory(normalizedTicker));
  }

  // ==========================================================
  // RÉCUPÉRATION PRIX EN TEMPS RÉEL (Centralisée)
  // ==========================================================
  // Point d'entrée public — coalescing (voir commentaire du constructeur).
  // Le vrai travail est dans _doFetchBatchPrices ; cette méthode ne fait que
  // partager la promesse en vol pour un jeu de tickers identique.
  async fetchBatchPrices(tickers, forceRefresh = false) {
    const key = 'live_' + [...new Set((tickers || []).map(t => t.toUpperCase()))].sort().join(',') + (forceRefresh ? '_force' : '');

    const inFlight = this._inFlightBatchPriceRequests.get(key);
    if (inFlight) {
      marketDataMetrics.recordDedup();
      return inFlight;
    }

    const requestPromise = this._doFetchBatchPrices(tickers, forceRefresh)
      .finally(() => this._inFlightBatchPriceRequests.delete(key));
    this._inFlightBatchPriceRequests.set(key, requestPromise);
    return requestPromise;
  }

  async _doFetchBatchPrices(tickers, forceRefresh = false) {
    const tickersToFetch = [];
    tickers.forEach(ticker => {
      if (forceRefresh) {
        tickersToFetch.push(ticker);
        return;
      }
      const cached = this.storage.getCurrentPrice(ticker);
      const assetType = this.storage.getAssetType(ticker);
      const isWeekend = this.isWeekend();

      const isPotentialFallback = cached && !cached.source &&
        cached.price > 0 &&
        cached.price === cached.previousClose &&
        this.storage.getPurchases().some(p =>
          p.ticker.toUpperCase() === ticker.toUpperCase() &&
          Math.abs(Number(p.price) - cached.price) < 0.01
        );

      const shouldRefresh = this.liveFailures.has(ticker.toUpperCase()) || !cached ||
        !cached.price ||
        cached.source === 'Purchase fallback' ||
        isPotentialFallback ||
        !this.storage.isCacheValid(ticker, assetType);

      if (shouldRefresh) {
        tickersToFetch.push(ticker);
        marketDataMetrics.recordCacheMiss();
      } else {
        marketDataMetrics.recordCacheHit();
      }
    });

    if (tickersToFetch.length === 0) return;

    console.log(`API: Récupération de ${tickersToFetch.length} prix via GCP Proxy...`);
    const batchSize = 5;
    const pauseTime = 1000;

    for (let i = 0; i < tickersToFetch.length; i += batchSize) {
      const batch = tickersToFetch.slice(i, i + batchSize);
      if (i > 0) await sleep(pauseTime);

      // Appel unifié pour tous les actifs
      await this.fetchPricesViaProxy(batch, forceRefresh);
    }
    this.logProviderStats();
  }

  // NOUVELLE MÉTHODE SPÉCIFIQUE DASHBOARD: Récupère les données d'indices avec previousClose et lastTradingDayClose
  getCachedIndexDaily(ticker) {
    const entry = this._indexDaily.get(ticker);
    return entry && Date.now() - entry.fetchedAt < 60000 ? entry.points : null;
  }

  async fetchIndexDataForDashboard(ticker) {
    const symbol = this.formatTicker(ticker);
    const type = 'STOCK'; // Les indices sont toujours de type STOCK

    try {
      // Déterminer l'intervalle selon le type d'actif
      const isBitcoin = ticker.includes('BTC');
      const interval = isBitcoin ? '5m' : '1d';
      const url = `${PRICE_PROXY_URL}?symbol=${symbol}&type=${type}&range=7d&interval=${interval}`;

      const res = await _fetchTimeout(url, 8000, 'index-quote');
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
      if (interval === '1d') {
        const points = Object.fromEntries(timestamps.flatMap((ts,i) =>
          Number.isFinite(closes[i]) && closes[i] > 0 ? [[ts*1000, closes[i]]] : []));
        this._indexDaily.set(ticker, { points, fetchedAt: Date.now() });
      }

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

        const hist = (histInterval === '1d' && this.getCachedIndexDaily(ticker)) || await this.getHistoricalPricesWithRetry(
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
            // NOTE: laissé tel quel (pas migré sur resolveTickerPreviousClose) —
            // l'ancrage UTC 24/7 est une sémantique différente du cutoff
            // "dernier jour de bourse" que le résolveur partagé implémente pour
            // les actifs cotés en semaine ; les unifier changerait le comportement
            // sans pouvoir être vérifié en conditions réelles ici.
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
            // Pour les indices classiques : SINGLE SOURCE OF TRUTH — même résolveur
            // que le portefeuille (MarketUtils.resolveTickerPreviousClose), au lieu
            // d'une classification de bougies ad-hoc par position (snapshots[1]/[2]).
            // On réutilise `hist` déjà récupéré ci-dessus (aucun fetch supplémentaire).
            const previousCloseResult = await resolveTickerPreviousClose(ticker, {
              storage: this.storage,
              refDate: new Date(),
              historicalDataMap: hist
            });
            truePreviousClose = previousCloseResult.closePrice;

            const lastTradingDayResult = await resolveTickerPreviousClose(ticker, {
              storage: this.storage,
              refDate: getLastTradingDay(new Date()),
              historicalDataMap: hist
            });
            lastTradingDayClose = lastTradingDayResult.closePrice || truePreviousClose;
          }

          console.log(`[IndexDashboard ${ticker}] previousClose (J): ${truePreviousClose?.toFixed(4)}, lastTradingDayClose (J-1): ${lastTradingDayClose?.toFixed(4)}`);
        }
      } catch (err) {
        console.warn(`Could not fetch historical close for ${ticker}:`, err.message);
      }

      // FALLBACK NIVEAU 3: Si truePreviousClose est toujours null après l'historique, essayer le cache
      if (!truePreviousClose || truePreviousClose <= 0) {
        const cachedData = this.storage.getCurrentPrice(ticker);
        if (cachedData && cachedData.previousClose && cachedData.previousClose > 0) {
          truePreviousClose = cachedData.previousClose;
          console.log(`[IndexDashboard ${ticker}] Using cached previousClose: ${truePreviousClose.toFixed(4)}`);
        }
      }

      // Si lastTradingDayClose est null, utiliser truePreviousClose comme fallback minimal
      if (!lastTradingDayClose || lastTradingDayClose <= 0) {
        lastTradingDayClose = truePreviousClose;
      }

      // Convertir en EUR si nécessaire
      // On ne convertit QUE les actions (Stocks) listées dans USD_TICKERS ou explicitement en USD.
      // Les Indices (^GSPC, ^IXIC) restent en points.
      // Les Futures (GC=F) restent en USD.
      // Le Forex (EURUSD=X) reste en taux.
      const isUSD = (currency === 'USD') && !ticker.startsWith('^') && !ticker.endsWith('=F') && !ticker.endsWith('=X');

      if (isUSD) {
        const rate = this.storage.getConversionRate('USD_TO_EUR');
        if (!(rate > 0)) {
          // FAIL-CLOSED : pas de conversion inventée (ex. ancien 0.925).
          console.warn(`[IndexDashboard ${ticker}] USD_TO_EUR indisponible — refus de convertir.`);
          return null;
        }
        currentPrice = currentPrice * rate;
        if (truePreviousClose) truePreviousClose = truePreviousClose * rate;
        if (lastTradingDayClose) lastTradingDayClose = lastTradingDayClose * rate;
      }

      // S'assurer qu'on ne retourne jamais 0 ou null - FALLBACK FINAL
      const finalPreviousClose = truePreviousClose || previousClose || null;
      const finalLastTradingDayClose = lastTradingDayClose || truePreviousClose || previousClose || null;

      console.log(`[IndexDashboard ${ticker}] FINAL: price=${currentPrice.toFixed(2)}, previousClose=${finalPreviousClose?.toFixed(2)}, lastTradingDayClose=${finalLastTradingDayClose?.toFixed(2)}`);

      return {
        price: currentPrice,
        previousClose: finalPreviousClose,
        lastTradingDayClose: finalLastTradingDayClose,
        currency: 'EUR',
        marketState: meta.marketState || 'CLOSED',
        fetchedAt: res.fetchedAt || Date.now(),
        lastQuoteTime: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null
      };

    } catch (err) {
      console.error(`[IndexDashboard] Error fetching ${ticker}:`, err.message);
      return null;
    }
  }

  // NOUVELLE FONCTION CORE: Appelle le Cloud Function Proxy pour les prix en temps réel
  async fetchPricesViaProxy(tickers, forceRefresh = false) {
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

        // An explicit refresh crosses every cache layer. A zero TTL preserves
        // in-flight coalescing while bypassing memory and IndexedDB entries.
        const res = await _fetchTimeout(url, 8000, 'live-price', forceRefresh ? 0 : 60000);
        if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);

        const data = await res.json();

        let result;
        let source;

        // Le proxy retourne maintenant du format Yahoo Finance (chart) pour TOUT, y compris les Cryptos!
        // On conserve l'ancienne logique uniquement en "fallback" absolu si data.chart n'est pas présent
        if (type === 'CRYPTO' && !data.chart) {
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
              previousClose: data.prevClosePrice ? parseFloat(data.prevClosePrice) : null,
              currency: 'EUR',
              marketState: 'OPEN'
            };
            source = 'Binance Proxy';
          }
          // Format simple: {price: 95000, previousClose: 93000}
          else if (data.price) {
            result = {
              price: parseFloat(data.price),
              previousClose: data.previousClose ? parseFloat(data.previousClose) : null,
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
          if (!chartData.chart?.result?.[0]) throw new Error('Invalid Yahoo data');

          const yahooResult = chartData.chart.result[0];
          const timestamps = yahooResult.timestamp || [];
          const quotes = yahooResult.indicators?.quote?.[0]?.close || [];
          const meta = yahooResult.meta || {};

          let currentPrice = null;
          let lastTradeTimestamp = null;
          for (let i = quotes.length - 1; i >= 0; i--) {
            if (quotes[i] !== null) {
              currentPrice = parseFloat(quotes[i]);
              lastTradeTimestamp = timestamps[i];
              break;
            }
          }

          // Pour les actions peu liquides (ex: privées), Yahoo peut renvoyer
          // regularMarketPrice dans meta sans données de bougies.
          if (meta.regularMarketPrice) {
            currentPrice = parseFloat(meta.regularMarketPrice);
          }

          if (currentPrice === null) throw new Error('Price not found');

          const activePriceTimestamp = meta.regularMarketTime || lastTradeTimestamp;
          
          // PRIORITÉ: Calculer le previousClose à partir des bougies historiques (1d)
          // Yahoo MetaData (chartPreviousClose) est souvent erroné pour les ETF européens (NAV vendredi vs Lundi)
          // On cherche la bougie correspondant STRICTEMENT au jour de cotation précédant le currentPrice.
          let calculatedPreviousClose = null;

          if (timestamps && timestamps.length > 1) {
            // normaliser le ts actif avec +14400s pour éviter les décalages de timezone US/EU
            const activeDateStr = new Date((activePriceTimestamp + 14400) * 1000).toDateString();

            for (let i = timestamps.length - 1; i >= 0; i--) {
              const ts = timestamps[i];
              const tsDateStr = new Date((ts + 14400) * 1000).toDateString();

              // Si on trouve une bougie dont le jour est différent du jour de la cotation active, 
              // c'est notre "Previous Close" !
              if (tsDateStr !== activeDateStr && quotes[i] !== null) {
                calculatedPreviousClose = parseFloat(quotes[i]);
                break;
              }
            }
          }

          let previousClose = calculatedPreviousClose;

          // Fallback sur Meta si pas trouvé dans l'historique
          if (!previousClose || previousClose <= 0) {
            previousClose = meta.regularMarketPreviousClose ||
                            meta.chartPreviousClose ||
                            meta.previousClose;
          }

          // SECURITY/INTEGRITY FIX (audit P1) : ce fallback faisait
          // `previousClose = currentPrice` quand aucune vraie clôture veille
          // n'était trouvée — indiscernable ensuite d'une clôture réelle qui
          // vaudrait EXACTEMENT le prix courant. Toute la chaîne "Day P&L"
          // (dataManager._enrichAggregatedPosition, Var Today) interprète
          // alors silencieusement "donnée absente" comme "variation de 0%
          // aujourd'hui" — une affirmation financière fabriquée, pas une
          // absence de donnée honnête. On laisse désormais `previousClose`
          // absent et on marque explicitement `previousCloseUnavailable`,
          // pour que les lecteurs en aval (voir dataManager.js) affichent
          // "indisponible" plutôt qu'un 0% plausible mais faux.
          const previousCloseUnavailable = !previousClose || previousClose <= 0;

          const currency = meta.currency || 'EUR';

          result = {
            price: currentPrice,
            previousClose: previousCloseUnavailable ? null : previousClose,
            previousCloseUnavailable,
            currency,
            marketState: meta.marketState || 'CLOSED'
          };
          source = 'Yahoo Proxy';
        }

        // --- DÉBUT DU FAILBACK DE SÉCURITÉ CONTRE LE PRIX ZÉRO (Conservé de l'original) ---
        const finalPrice = result.price;
        const finalPreviousClose = result.previousClose;
        if (!Number.isFinite(finalPrice) || finalPrice <= 0) throw new Error('Invalid provider price');

        const upperTicker = ticker.toUpperCase();
        // STALE-IF-ERROR (audit 2026-09-28, B3) : the transport served the last
        // validated payload because this refresh failed. The quote stays
        // displayable with its real observation date, but it is not a success:
        // the failure is kept in liveFailures (flagged `stale`, so consumers can
        // tell "old data available" from "no data") and on the quote itself,
        // which is what travels to the financial snapshot.
        const refreshError = res.stale ? (res.error?.message || 'Market refresh failed') : null;
        const staleMarks = refreshError ? { stale: true, refreshError } : {};
        const observedAt = res.fetchedAt || Date.now();
        const existing = this.storage.getCurrentPrice(upperTicker);
        if (refreshError && existing?.price > 0 && (existing.lastUpdate || 0) > observedAt) {
          // A newer quote is already known (other tab/device): never replace
          // it with an older payload, only mark that its refresh failed.
          this.storage.setCurrentPrice(upperTicker, { ...existing, ...staleMarks });
        } else {
          this.storage.setCurrentPrice(upperTicker, {
            price: finalPrice,
            previousClose: finalPreviousClose,
            previousCloseUnavailable: !!result.previousCloseUnavailable,
            currency: result.currency,
            marketState: result.marketState,
            lastUpdate: observedAt,
            source: source,
            ...staleMarks
          });
        }

        if (refreshError) {
          this.liveFailures.set(upperTicker, {
            reason: refreshError, status: res.error?.status ?? null, at: Date.now(),
            stale: true, lastUpdate: this.storage.getCurrentPrice(upperTicker)?.lastUpdate ?? observedAt
          });
          console.warn(`Price Proxy refresh failed for ${ticker}: ${refreshError} — last quote kept (${new Date(observedAt).toISOString()}).`);
          providerStats.GCP_PROXY.fails++;
          continue;
        }
        this.liveFailures.delete(upperTicker);
        tickersResult.push(ticker);

      } catch (err) {
        // FAIL-CLOSED (validation architecture 2026-09-24, décision #1) : un
        // échec réseau/HTTP confirmé (429/500/502/timeout — tous remontent
        // ici de façon identique, voir _fetchTimeout) ne doit JAMAIS produire
        // un nouveau prix courant ni un nouveau previousClose. L'ancien
        // comportement substituait le prix d'achat ("Purchase fallback"),
        // indiscernable en aval d'une vraie cotation (day change à 0% fabriqué
        // — même défaut que le bug previousClose=currentPrice corrigé plus
        // haut dans ce fichier, voir financialFallbackIntegrity.test.js).
        // On ne touche plus storage.currentData ici : si une donnée valide
        // précédente existe déjà, elle reste affichée telle quelle (avec son
        // lastUpdate désormais daté — c'est la base du futur état
        // stale/degraded porté par MarketDataRepository) ; si aucune donnée
        // n'existe, le ticker reste correctement `priceDataUnavailable` en
        // aval (dataManager.js), sans valeur fabriquée.
        this.liveFailures.set(ticker.toUpperCase(), { reason: err.message, at: Date.now() });
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
    if (Math.abs(endTs * 1000 - Date.now()) < 60000) endTs = Math.floor(endTs / 60) * 60;
    let formatted = this.formatTicker(ticker);
    let assetType = this.storage.getAssetType(ticker) ? this.storage.getAssetType(ticker).toUpperCase() : 'STOCK';

    // CRITICAL FIX: Skip dividend assets immediately - they have no historical price data
    if (assetType === 'DIVIDEND' || assetType === 'CASH' || assetType === 'REAL ESTATE') {
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

    // Yahoo ne fournit pas d'historique exploitable pour l'alias GOLD-EUR.PA.
    // GOLD.PA est la même cotation Amundi Physical Gold (FR0013416716) sur
    // Euronext Paris. Ses bougies sont déjà dans l'échelle EUR, même si
    // Yahoo annonce parfois à tort `meta.currency = USD` pour ce symbole.
    const longIntervals = ['1d', '1wk', '1mo', '3mo', '6mo', '1y'];
    let isGoldSwapped = false;
    if (formatted === 'GOLD-EUR.PA' && longIntervals.includes(interval)) {
      formatted = 'GOLD.PA';
      isGoldSwapped = true;
    }

    // CACHE HISTORIQUE PAR POINT (validation architecture 2026-09-24, voir
    // historicalPointStore.js) : pour les intervalles daily+, un historique
    // déjà connu et CLÔTURÉ n'est jamais redemandé : seul le delta manquant
    // (souvent rien, ou quelques jours) part au réseau, au lieu de toute la
    // fenêtre glissante demandée. `effectiveStartTs`/`effectiveEndTs` ci-
    // dessous remplacent startTs/endTs UNIQUEMENT pour ce qui part
    // réellement au réseau — le résultat final couvre toujours la plage
    // ORIGINALEMENT demandée (voir finalizeResult).
    const deltaEligible = isDeltaFetchEligible(interval);
    // Historical market points are cached in their provider/native currency.
    // Currency conversion belongs to HistoryCalculator, which has the FX rate
    // for each historical date. Gold is the explicit exception because Yahoo's
    // USD metadata conflicts with the EUR listing confirmed by Euronext.
    // The new key invalidates only Gold points recalibrated from a live price;
    // unrelated native histories retain their existing cache entries.
    const pointKey = isGoldSwapped
      ? `gold-provider-eur-v1:${formatted}`
      : `native-v2:${formatted}|gold:none`;
    // Points already known from a previous page/session (IndexedDB hydration).
    if (deltaEligible) await historicalPointStore.ready;
    const plan = deltaEligible
      ? historicalPointStore.planFetch(pointKey, interval, startTs, endTs)
      : { plan: 'full', fetchStartTs: startTs, fetchEndTs: endTs };

    if (plan.plan === 'none') {
      marketDataMetrics.recordCacheHit(true);
      return historicalPointStore.getKnownPoints(pointKey, interval, startTs, endTs);
    }

    const effectiveStartTs = plan.fetchStartTs;
    const effectiveEndTs = plan.fetchEndTs;

    // FAIL-CLOSED : un delta qui échoue (429/500/502/timeout) doit rester un
    // échec TOTAL pour cet appel — jamais mélangé silencieusement avec les
    // anciens points déjà connus (ça masquerait la panne en produisant un
    // historique incomplet mais d'apparence valide). Seul un résultat RÉUSSI
    // est fusionné dans le store puis complété avec les points déjà connus.
    const finalizeResult = (result) => {
      if (isHistoricalFetchFailure(result)) return result;
      if (plan.plan === 'delta' && Object.keys(result).length === 0) return markFetchFailed();
      if (deltaEligible) {
        historicalPointStore.merge(pointKey, interval, result, { startTs: effectiveStartTs, endTs: effectiveEndTs });
        return historicalPointStore.getKnownPoints(pointKey, interval, startTs, endTs);
      }
      return result;
    };

    // Le cacheKey utilise une v6 pour forcer le rafraîchissement après migration Cloudflare
    // v11 invalide uniquement les historiques Gold dont tous les points
    // avaient été recalibrés avec le prix courant.
    const cacheVersion = isGoldSwapped ? 'v11' : 'v10';
    let cacheKey = `${cacheVersion}_${pointKey}_${effectiveStartTs}_${effectiveEndTs}_${interval}_${isGoldSwapped ? 'SWAP' : ''}`;
    if (['5m', '15m', '90m'].includes(interval)) {
      const rounded = Math.floor(Date.now() / 300000) * 300000;
      cacheKey += `_${rounded}`;
    }

    const historicalTtl = ['5m', '15m', '90m'].includes(interval) ? 60000 : (endTs * 1000 > Date.now() - 86400000 ? 900000 : 604800000);
    if (this.historicalPriceCache[cacheKey] && Date.now() - (this.historicalFetchedAt[cacheKey] || 0) < historicalTtl) {
      marketDataMetrics.recordCacheHit(true);
      return finalizeResult(this.historicalPriceCache[cacheKey]);
    }

    // Coalescing (voir commentaire du constructeur) : une requête déjà en vol
    // pour cette clé exacte est réutilisée telle quelle, succès ou échec inclus
    // (isHistoricalFetchFailure() reste vrai pour tous les appelants concernés,
    // aucun fallback silencieux introduit par le partage de la promesse).
    const inFlight = this._inFlightHistoricalRequests.get(cacheKey);
    if (inFlight) {
      marketDataMetrics.recordDedup();
      return inFlight.then(finalizeResult);
    }

    marketDataMetrics.recordCacheMiss(true);
    const requestPromise = this._doFetchHistoricalPrices(ticker, formatted, assetType, effectiveStartTs, effectiveEndTs, interval, isGoldSwapped, cacheKey, retries)
      .finally(() => this._inFlightHistoricalRequests.delete(cacheKey));
    this._inFlightHistoricalRequests.set(cacheKey, requestPromise);
    return requestPromise.then(finalizeResult);
  }

  async _doFetchHistoricalPrices(ticker, formatted, assetType, startTs, endTs, interval, isGoldSwapped, cacheKey, retries) {
    // L'appel se fait vers le Proxy Cloud Function pour l'historique
    // Nous passons tous les paramètres nécessaires au proxy
    let proxyUrl = `${PRICE_PROXY_URL}?symbol=${formatted}&type=${assetType}&interval=${interval}&period1=${startTs}&period2=${endTs}`;
    console.log(`[API History] Fetching ${ticker} (${interval}):`, proxyUrl);

    let failureDetails = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await _fetchTimeout(proxyUrl, 10000, 'historical');
        if (!response.ok) {
          const httpError = new Error(`Proxy HTTP ${response.status}`);
          httpError.status = response.status;
          throw httpError;
        }

        const data = await response.json();

        // Tous les actifs (stocks, ETFs, indices, crypto) retournent le format Yahoo Finance
        // Le Worker Cloudflare route tout via Yahoo Finance (BTC-EUR, ETH-EUR etc. supportés natifs)
        console.log(`[API History] Parsing Yahoo format for ${ticker} (${assetType})`);

        const chartData = data.chart ? data : (typeof data === 'string' ? JSON.parse(data) : data);

        if (!chartData.chart?.result?.[0]?.timestamp) {
          console.warn(`[DEBUG ${ticker}] No timestamp data - market closed or no data for period`);
          if (chartData.chart?.result?.[0] && !chartData.chart?.error) return {};
          throw new Error('Invalid historical response');
        }

        const result = chartData.chart.result[0];
        const timestamps = result.timestamp;
        const quotes = result.indicators.quote[0].close;

        // Phase 2.5 : alimente MarketCalendarEngine avec les VRAIES métadonnées
        // exchange/timezone/session que Yahoo renvoie déjà ici (exchangeTimezoneName,
        // currentTradingPeriod...) — jusqu'ici jamais extraites au-delà de `currency`.
        // Effet de bord pur : ne change ni la valeur ni la forme retournée par cette
        // fonction (voir audit Phase 2.5, section "éviter les changements API inutiles").
        marketCalendarEngine.ingestProviderMetadata(ticker, result.meta);

        if (!timestamps || timestamps.length < 1) {
          console.warn(`[DEBUG ${ticker}] Insufficient data (${timestamps?.length || 0} points)`);
          return {};
        }

        // Euronext confirme que GOLD.PA (ISIN FR0013416716) est coté en EUR.
        // Ne jamais déduire son échelle d'un cours courant : chaque bougie doit
        // rester immuable et provenir directement de l'historique fournisseur.
        const prices = withHistoryCurrency({}, isGoldSwapped ? 'EUR' : result.meta?.currency);

        timestamps.forEach((ts, idx) => {
          if (Number.isFinite(Number(quotes[idx])) && quotes[idx] != null && Number(quotes[idx]) > 0) {
            const val = parseFloat(quotes[idx]);
            // All non-Gold prices remain in Yahoo's native currency. The
            // portfolio engine performs the single date-aware FX conversion.

            prices[ts * 1000] = val;
          }
        });

        this.historicalPriceCache[cacheKey] = prices;
        this.historicalFetchedAt[cacheKey] = Date.now();
        this.saveHistoricalCache();
        return prices;

      } catch (error) {
        failureDetails = {
          status: Number.isFinite(Number(error.status)) ? Number(error.status) : null,
          retryAfterMs: Number.isFinite(Number(error.retryAfterMs)) ? Number(error.retryAfterMs) : null,
          message: error.message || 'Historical request failed'
        };
        console.warn(`Historical Proxy attempt ${attempt + 1} failed: ${error.message}`);
        // A 429 must stop immediately: retrying it only worsens the rate limit.
        // A transient Worker/upstream 5xx remains retryable; aborting on its
        // first occurrence made a single temporary 502 invalidate the complete
        // portfolio history.
        if (error.status === 429) break;
        // One shared retry is sufficient for a transient 5xx. A persistent
        // outage must not become three network calls for every portfolio line.
        if (error.status >= 500 && attempt >= 1) break;
        if (attempt + 1 < retries) await sleep(Math.min(1000 * 2 ** attempt, 8000));
      }
    }
    // Les `retries` tentatives ont TOUTES levé une exception (HTTP non-ok,
    // timeout, JSON invalide...) — jamais une seule réponse exploitable de
    // Yahoo/du proxy. Ce n'est PAS "aucune donnée pour la période" (voir
    // ligne 580 ci-dessus, qui reste un `{}` sans marqueur) — c'est un échec
    // de récupération. Ne jamais mettre ce résultat en cache (une panne
    // temporaire ne doit pas être mémorisée comme "il n'y a pas de données").
    return markFetchFailed({}, failureDetails);
  }

  // ================================================
  // FALLBACK BINANCE : Données intraday crypto (gratuit, sans auth)
  // Utilisé quand Yahoo Finance ne retourne pas de données 5m pour un crypto
  // ================================================
  async fetchCryptoKlinesFromBinance(ticker, startMs, endMs) {
    // Mapping ticker → symbole Binance (USDT pair)
    const BINANCE_SYMBOLS = {
      'BTC': 'BTCUSDT', 'ETH': 'ETHUSDT', 'SOL': 'SOLUSDT',
      'ADA': 'ADAUSDT', 'BNB': 'BNBUSDT', 'XRP': 'XRPUSDT',
      'DOT': 'DOTUSDT', 'AVAX': 'AVAXUSDT', 'DOGE': 'DOGEUSDT',
      'MATIC': 'MATICUSDT', 'LTC': 'LTCUSDT', 'LINK': 'LINKUSDT',
    };

    const baseTicker = ticker.split('-')[0].toUpperCase(); // 'BTC-EUR' → 'BTC'
    const symbol = BINANCE_SYMBOLS[baseTicker];
    if (!symbol) {
      console.warn(`[Binance Fallback] No Binance symbol for ${ticker}`);
      return {};
    }

    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&startTime=${startMs}&endTime=${endMs}&limit=500`;
    console.log(`[Binance Fallback] Fetching ${ticker} (${symbol}) from Binance...`);

    try {
      const res = await _fetchTimeout(url, 8000, 'binance');
      if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);

      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) return {};

      // Convertir USDT → EUR uniquement avec un taux FX réel.
      const usdToEur = this.storage.getConversionRate('USD_TO_EUR');
      if (!(usdToEur > 0)) {
        console.warn(`[Binance Fallback] USD_TO_EUR indisponible — refus de fabriquer des prix EUR pour ${ticker}.`);
        return {};
      }
      const prices = withHistoryCurrency({}, 'EUR');

      for (const candle of data) {
        const openTime = candle[0]; // ms
        const closePrice = parseFloat(candle[4]); // close price in USDT
        if (!isNaN(closePrice) && closePrice > 0) {
          prices[openTime] = closePrice * usdToEur;
        }
      }

      console.log(`[Binance Fallback] ✅ Got ${Object.keys(prices).length} points for ${ticker} (${baseTicker}/USDT → EUR @ ${usdToEur})`);
      return prices;

    } catch (err) {
      console.warn(`[Binance Fallback] ❌ Failed for ${ticker}:`, err.message);
      return {};
    }
  }

  // --- Fonctions de Cache (Inchagées) ---

  loadHistoricalCache() { return {}; }
  saveHistoricalCache() {
    const keys = Object.keys(this.historicalPriceCache);
    for (const key of keys) {
      if (Date.now() - (this.historicalFetchedAt[key] || 0) > 604800000 || Object.keys(this.historicalPriceCache).length > 200) {
        delete this.historicalPriceCache[key];
        delete this.historicalFetchedAt[key];
      }
    }
  }
  cleanIntradayCache() { this.saveHistoricalCache(); }

  getPriceSourceStats() { return {}; }
  logProviderStats() { console.log(providerStats); }
}
