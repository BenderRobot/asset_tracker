// ========================================
// HistoryCalculator.js - Logic for historical data processing
// ========================================

import { USD_TO_EUR_FALLBACK_RATE } from './config.js';
import { parseDate } from './utils.js';
import {
    getIntervalForPeriod,
    getLabelFormat,
    getLastTradingDay,
    isCryptoTicker,
    isMixedPortfolio,
    findClosestPrice,
    formatTicker,
    resolveTickerPreviousClose,
    getCloseCutoffForTicker,
    getMarketOpenUTCHour
} from './MarketUtils.js';

export class HistoryCalculator {
    constructor(storage, api) {
        this.storage = storage;
        this.api = api;
    }

    // === SMART SYNC (Performance Optim) ===
    async getHistoryWithCache(ticker, startTs, endTs, interval) {
        if (!ticker) return {};
        const year = new Date(startTs * 1000).getFullYear();
        const cacheKey = `${ticker}_${interval}_${year}`;

        // 1. Charger le cache existant (Firestore via Storage)
        // Storage.getMarketData doit renvoyer { lastUpdated, data: [ [ts, price], ... ] } ou { timestamps, prices }
        // On suppose que storage.js gère le format stocké
        const cached = await this.storage.getMarketData(ticker, interval, year);

        // Si cache valide et couvre la période demandée (à peu près)
        // La logique de Smart Sync est complexe. Pour simplifier ici, on utilise l'API si pas de cache
        // Si on a un cache, on vérifie s'il est à jour pour "aujourd'hui"

        const now = Math.floor(Date.now() / 1000);
        const oneDay = 86400;

        // Note: L'implémentation complète du Smart Sync nécessiterait de comparer les dates
        // Pour l'instant, on délègue à l'API qui a son propre cache (api.js historicalPriceCache)
        // Mais dataManager.js avait une logique spécifique ici.
        // On va utiliser api.getHistoricalPricesWithRetry directement qui a un cache mémoire.
        // Si le user voulait le cache Firestore, il faudrait réimplémenter toute la logique de delta.
        // Pour ce refactoring "Simplification", on garde l'appel API qui est robuste.

        return await this.api.getHistoricalPricesWithRetry(ticker, startTs, endTs, interval);
    }

    async calculateGenericHistory(purchases, days, isSingleAsset = false) {
        const dynamicRate = this.storage.getConversionRate('USD_TO_EUR') || USD_TO_EUR_FALLBACK_RATE;

        const assetMap = new Map();
        const ticker = isSingleAsset ? purchases[0].ticker.toUpperCase() : null;

        if (isSingleAsset) {
            assetMap.set(ticker, purchases.map(p => ({
                date: parseDate(p.date),
                price: parseFloat(p.price),
                quantity: parseFloat(p.quantity),
                currency: p.currency || 'EUR'
            })));
        } else {
            purchases.forEach(p => {
                const type = (p.assetType || '').toLowerCase();
                const isCash = type === 'cash' || p.ticker.toUpperCase() === 'CASH' || p.ticker.toUpperCase() === 'EUR';
                const currency = p.currency || 'EUR';
                const t = isCash ? `CASH-${currency}` : p.ticker.toUpperCase();
                
                if (!assetMap.has(t)) assetMap.set(t, []);
                
                if (isCash) {
                    // For cash, `price` literally stores the EUR/USD amount delta in our app
                    const amount = parseFloat(p.price) || 0;
                    assetMap.get(t).push({
                        date: parseDate(p.date),
                        price: 1.0,
                        quantity: amount,
                        currency: currency
                    });
                } else {
                    assetMap.get(t).push({
                        date: parseDate(p.date),
                        price: parseFloat(p.price),
                        quantity: parseFloat(p.quantity),
                        currency: currency
                    });
                }
            });
        }

        assetMap.forEach(list => list.sort((a, b) => a.date - b.date));

        let firstPurchase = null;
        for (const list of assetMap.values()) {
            if (list.length > 0 && (!firstPurchase || list[0].date < firstPurchase)) {
                firstPurchase = list[0].date;
            }
        }

        if (!firstPurchase) return { labels: [], invested: [], values: [], yesterdayClose: null, perTickerYesterdayClose: new Map(), unitPrices: [], purchasePoints: [], twr: [], dailyTwr: [] };

        const today = new Date();
        const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999));

        const sampleTicker = isSingleAsset ? ticker : Array.from(assetMap.keys())[0];
        const tickersEarly = Array.from(assetMap.keys());
        const isCrypto = isSingleAsset
            ? isCryptoTicker(sampleTicker || '')
            : tickersEarly.filter(t => !t.startsWith('CASH-')).some(t => isCryptoTicker(t));
        const isMixed = !isSingleAsset && isMixedPortfolio(tickersEarly);

        // [DEBUG] Verify crypto detection for mixed portfolios
        console.log(`[HistoryCalc] Portfolio type: ${isSingleAsset ? 'Single' : (isMixed ? 'Mixed (crypto+stocks)' : 'Multi')}`);
        console.log(`[HistoryCalc] isCrypto: ${isCrypto}, isMixed: ${isMixed}, days: ${days}`);
        console.log(`[HistoryCalc] Tickers:`, tickersEarly);

        const isWeekend = today.getDay() === 0 || today.getDay() === 6;
        let displayStartUTC;
        let bufferDays = 30;
        let hardStopEndTs = null;

        // SIMPLIFICATION LOGIQUE DATES
        // On distingue 2 cas : Actifs 24/7 (Crypto/Mixte) vs Actifs Boursiers Purs (Stocks)

        // === YTD : 1er janvier de l'année en cours → aujourd'hui ===
        if (days === 'ytd') {
            console.log('[HistoryCalc] YTD mode: Jan 1st of current year');
            displayStartUTC = new Date(today.getFullYear(), 0, 1, 0, 0, 0); // 1er janvier
            bufferDays = 5;

        // === 2Y : 730 jours en arrière ===
        } else if (days === 730) {
            console.log('[HistoryCalc] 2Y mode: 730 days back');
            const localDisplay = new Date(today);
            localDisplay.setHours(0, 0, 0, 0);
            localDisplay.setDate(localDisplay.getDate() - 729);
            displayStartUTC = localDisplay;
            bufferDays = 14;

        } else if (isCrypto || days >= 7) {
            console.log('[HistoryCalc] Using 24/7 mode (Crypto or Long-Term view)');
            // mode 24/7 ou Long terme : On recule simplement de N jours
            const localDisplay = new Date(today);
            localDisplay.setHours(0, 0, 0, 0);

            if (days === 1) {
                // 1D : Minuit ce matin
            } else if (days === 2) {
                // Portefeuille MIXTE (actions + crypto) un lundi : "hier" au sens boursier
                // est vendredi, pas dimanche (les actions n'y cotent pas). Démarrer la
                // fenêtre dimanche ferait reposer toute la base 0% du lundi sur une
                // valorisation dimanche où seule la partie crypto a bougé, désynchronisant
                // ce graphique 2J de la vue 1D (qui, elle, ancre correctement sur la
                // clôture de vendredi via resolveCloseValueBeforeDay/preferLiveClose).
                if (isMixed && today.getDay() === 1) {
                    localDisplay.setDate(localDisplay.getDate() - 3); // Vendredi
                } else {
                    localDisplay.setDate(localDisplay.getDate() - 1); // Hier minuit
                }
            } else if (days !== 'all') {
                localDisplay.setDate(localDisplay.getDate() - (days - 1));
            } else {
                localDisplay.setTime(firstPurchase ? firstPurchase.getTime() : Date.now());
            }

            // Cas particulier 1D Crypto : Optionnel pour commencer à 00:00
            // Mon code existant gère déjà 'localStart' pour days=1
            if (days === 1) {
                displayStartUTC = new Date(today);
                displayStartUTC.setHours(0, 0, 0, 0);
            } else {
                displayStartUTC = localDisplay;
            }

            bufferDays = (days <= 7) ? 2 : 14;

        } else {
            // MODE STOCKS PURS (Jours ouvrés uniquement)
            // Gestion Week-end pour 1D et 2D
            if (isWeekend && (days === 1 || days === 2)) {
                // ... logic existing for "Voir vendredi le weekend" ...
                const daysToGoBack = today.getDay() === 0 ? 2 : 1;
                const lastTradingDay = new Date(today);
                lastTradingDay.setDate(today.getDate() - daysToGoBack);
                lastTradingDay.setHours(23, 59, 59, 999);
                hardStopEndTs = lastTradingDay.getTime();
                const startTradingDay = new Date(lastTradingDay);
                startTradingDay.setHours(0, 0, 0, 0);
                if (days === 2) startTradingDay.setDate(startTradingDay.getDate() - 1);
                displayStartUTC = startTradingDay;
                bufferDays = 5;
            } else {
                // Semaine (Lundi-Vendredi)
                const localStart = new Date(today);
                localStart.setHours(0, 0, 0, 0);

                if (days === 1) {
                    const tickersList = Array.from(assetMap.keys());
                    // FIX: Check currency too (AL2SI might not have .PA suffix but is EUR)
                    const hasEU = tickersList.some(t =>
                        t.endsWith('.PA') ||
                        t.endsWith('.DE') ||
                        t.includes('EUR') ||
                        (assetMap.get(t) && assetMap.get(t)[0] && assetMap.get(t)[0].currency === 'EUR')
                    );

                    // FIX: Construct UTC Date explicitly to avoid "Yesterday" shift.
                    // If we use localStart.setUTCHours on a date that is "Yesterday 23:00 UTC" (00:00 Local), it keeps "Yesterday".
                    const y = today.getFullYear();
                    const m = today.getMonth();
                    const d = today.getDate();

                    // DST-aware : l'ancien code figeait l'heure d'ouverture en heure
                    // d'hiver toute l'année (08:00 UTC Paris / 14:30 UTC NYSE), donc
                    // décalé d'1h pendant l'heure d'été (fin mars-fin octobre) — le
                    // point de départ du graphique 1D tombait alors 1h APRÈS la vraie
                    // ouverture, ratant le vrai prix d'ouverture (remplacé par l'injection
                    // synthétique de la clôture de la veille).
                    const openUTCHour = hasEU
                        ? getMarketOpenUTCHour(9, 'Europe/Paris', today)      // Euronext ouvre 9h locale
                        : getMarketOpenUTCHour(9.5, 'America/New_York', today); // NYSE/Nasdaq ouvrent 9h30 locale
                    const openHourInt = Math.floor(openUTCHour);
                    const openMinute = Math.round((openUTCHour - openHourInt) * 60);
                    displayStartUTC = new Date(Date.UTC(y, m, d, openHourInt, openMinute, 0));
                } else if (days === 2) {
                    // Hier + Auj
                    // Si on est Lundi, Hier = Dimanche (Fermé).
                    // Donc on veut Vendredi + Lundi ?
                    // Le user a dit "Dimanche et Lundi" (probablement pour Crypto).
                    // Mais ici on est dans le bloc "!isCrypto".
                    // Donc on veut Vendredi + Auj.
                    if (today.getDay() === 1) { // Lundi
                        localStart.setDate(localStart.getDate() - 3); // Vendredi
                    } else {
                        localStart.setDate(localStart.getDate() - 1); // Hier
                    }
                    displayStartUTC = localStart;
                } else if (days !== 'all') {
                    // Pour Stocks > 2J, on prend les jours calendaires quand même
                    localStart.setDate(localStart.getDate() - (days - 1));
                    displayStartUTC = localStart;
                } else {
                    displayStartUTC = new Date(firstPurchase);
                }
                bufferDays = 5;
            }
        } // fin du bloc else stocks
        let dataStartUTC = new Date(displayStartUTC);
        dataStartUTC.setUTCDate(dataStartUTC.getUTCDate() - bufferDays);

        const startTs = Math.floor(dataStartUTC.getTime() / 1000);
        const endTs = Math.floor(todayUTC.getTime() / 1000);

        const interval = getIntervalForPeriod(days);
        const labelFormatFunc = getLabelFormat(days);

        const historicalDataMap = new Map();
        const tickers = Array.from(assetMap.keys());
        const batchSize = 3;

        for (let i = 0; i < tickers.length; i += batchSize) {
            const batch = tickers.slice(i, i + batchSize);
            await Promise.all(batch.map(async (t) => {
                try {
                    if (t.startsWith('CASH-')) {
                        historicalDataMap.set(t, {});
                        return;
                    }
                    // CRITICAL FIX: Format ticker for Yahoo Finance API (BTC → BTC-EUR)
                    // Without this, crypto tickers fail silently and return no weekend data!
                    const yahooTicker = formatTicker(t);
                    const hist = await this.getHistoryWithCache(yahooTicker, startTs, endTs, interval);
                    historicalDataMap.set(t, hist); // Store with ORIGINAL ticker as key
                } catch (err) {
                    historicalDataMap.set(t, {});
                }
            }));
        }

        // FALLBACK BINANCE : Si Yahoo Finance ne retourne pas de données intraday pour un crypto
        // (ex: BTC-EUR indisponible), utiliser l'API Binance (gratuit, sans auth) pour les vraies données 5m
        if (days === 1) {
            const midnightMs = new Date().setHours(0, 0, 0, 0);
            const nowMs = Date.now();

            for (const t of tickers) {
                if (!isCryptoTicker(t)) continue;
                const hist = historicalDataMap.get(t);
                if (hist && Object.keys(hist).length > 0) continue; // Données Yahoo OK

                console.log(`[HistoryCalc] Yahoo vide pour ${t} → tentative Binance...`);
                try {
                    const binancePrices = await this.api.fetchCryptoKlinesFromBinance(t, midnightMs, nowMs);
                    if (Object.keys(binancePrices).length > 0) {
                        historicalDataMap.set(t, binancePrices);
                        console.log(`[HistoryCalc] ✅ Binance fallback OK pour ${t}: ${Object.keys(binancePrices).length} points`);
                    }
                } catch (err) {
                    console.warn(`[HistoryCalc] Binance fallback échoué pour ${t}:`, err.message);
                }
            }
        }

        if (days === 1 && !isCrypto) {
            let hasDataForToday = false;
            const checkStartTs = displayStartUTC.getTime();

            for (const t of tickers) {
                const hist = historicalDataMap.get(t);
                if (hist) {
                    const timestamps = Object.keys(hist).map(Number);
                    if (timestamps.some(ts => ts >= checkStartTs)) {
                        hasDataForToday = true;
                        break;
                    }
                }
            }

            if (!hasDataForToday) {
                let lastTradingDay = getLastTradingDay(new Date());
                const today = new Date();

                if (lastTradingDay.toDateString() === today.toDateString()) {
                    lastTradingDay.setDate(lastTradingDay.getDate() - 1);
                    lastTradingDay = getLastTradingDay(lastTradingDay);
                }

                lastTradingDay.setHours(0, 0, 0, 0);
                displayStartUTC = lastTradingDay;

                const fallbackStart = new Date(displayStartUTC);
                fallbackStart.setUTCDate(fallbackStart.getUTCDate() - bufferDays);
                const newStartTs = Math.floor(fallbackStart.getTime() / 1000);

                const fallbackEnd = new Date(displayStartUTC);
                fallbackEnd.setHours(23, 59, 59, 999);
                hardStopEndTs = fallbackEnd.getTime();
                const newEndTs = Math.floor(hardStopEndTs / 1000);

                for (let i = 0; i < tickers.length; i += batchSize) {
                    const batch = tickers.slice(i, i + batchSize);
                    await Promise.all(batch.map(async (t) => {
                        try {
                            if (t.startsWith('CASH-')) {
                                historicalDataMap.set(t, {});
                                return;
                            }
                            const yahooTicker = formatTicker(t); // Also format here for consistency
                            const hist = await this.api.getHistoricalPricesWithRetry(yahooTicker, newStartTs, newEndTs, interval);
                            historicalDataMap.set(t, hist);
                        } catch (err) {
                            historicalDataMap.set(t, {});
                        }
                    }));
                }
            }
        }

        // [VALIDATION] Check for Weekend Data Availability (Cache Buster & Debug)
        if (days === 7) {
            tickers.forEach(t => {
                if (isCryptoTicker(t)) {
                    const hist = historicalDataMap.get(t);
                    if (hist) {
                        const count = Object.keys(hist).filter(k => {
                            const d = new Date(parseInt(k));
                            return d.getDay() === 0 || d.getDay() === 6;
                        }).length;
                        console.log(`[Validation] ${t} 1W Weekend Data Points: ${count}`);
                    }
                }
            });
        }

        const assetQuantities = new Map();
        const assetInvested = new Map();
        for (const t of tickers) {
            assetQuantities.set(t, 0);
            assetInvested.set(t, 0);
        }
        for (const [t, buyList] of assetMap.entries()) {
            for (const buy of buyList) {
                if (buy.date < displayStartUTC) {
                    assetQuantities.set(t, assetQuantities.get(t) + buy.quantity);
                    assetInvested.set(t, assetInvested.get(t) + (buy.price * buy.quantity));
                }
            }
        }

        const labels = [];
        const invested = [];
        const values = [];
        const unitPrices = [];
        const purchasePoints = [];
        const twr = [];
        const dailyTwr = [];
        const allTimestamps = new Set();
        historicalDataMap.forEach(hist => {
            Object.keys(hist).forEach(ts => {
                let timestamp = parseInt(ts);
                // FIX: Pour les vues long terme, on arrondit à minuit UTC pour éviter 
                // l'accumulation de points intraday (plateau) à la fin du graphique multi-actifs.
                if (interval === '1d' || interval === '1wk') {
                    const d = new Date(timestamp);
                    d.setUTCHours(23, 59, 59, 999);
                    timestamp = d.getTime();
                }
                allTimestamps.add(timestamp);
            });
        });

        if (displayStartUTC) {
            allTimestamps.add(displayStartUTC.getTime());
        }

        if (days === 1) {
            for (const [t, buyList] of assetMap.entries()) {
                for (const buy of buyList) {
                    const buyTs = buy.date.getTime();
                    if (buyTs >= displayStartUTC.getTime() && buyTs <= displayStartUTC.getTime() + (24 * 60 * 60 * 1000)) {
                        allTimestamps.add(buyTs);
                    }
                }
            }
        }

        const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

        // === DIAGNOSTIC 1D ===
        if (days === 1) {
            const midLog = displayStartUTC.getTime();
            console.log(`[HistoryCalc DIAG] displayStartUTC: ${displayStartUTC.toISOString()}`);
            console.log(`[HistoryCalc DIAG] allTimestamps total: ${sortedTimestamps.length}`);
            console.log(`[HistoryCalc DIAG] timestamps after displayStart: ${sortedTimestamps.filter(t => t >= midLog).length}`);
            historicalDataMap.forEach((hist, t) => {
                const keys = Object.keys(hist);
                const afterMid = keys.filter(k => parseInt(k) >= midLog);
                console.log(`[HistoryCalc DIAG] ${t}: ${keys.length} total points, ${afterMid.length} after displayStart`);
                if (afterMid.length > 0) console.log(`[HistoryCalc DIAG] ${t} first after: ${new Date(parseInt(afterMid[0])).toISOString()}`);
            });
        }


        // --- CALCUL DES BORNES TEMPORELLES (Déplacé avant la logique de prix) ---
        const displayStartTs = displayStartUTC.getTime();
        let displayEndTs;
        if (hardStopEndTs) displayEndTs = hardStopEndTs;
        else if (days === 1) displayEndTs = displayStartTs + (24 * 60 * 60 * 1000);
        else displayEndTs = Infinity;

        let displayTimestamps;

        // CORRECTION MAJEURE : Pour la vue 1W (7 jours), on génère une GRILLE RÉGULIÈRE
        // au lieu d'utiliser l'union des timestamps disponibles.
        // Cela évite la distorsion si un jour a beaucoup de points (ex: Crypto Samedi) et les autres peu.
        if (days === 7) {
            displayTimestamps = [];
            const step = (interval === '1h' || interval === '60m') ? 3600000 :
                (interval === '30m') ? 1800000 :
                    (interval === '15m') ? 900000 : 3600000; // Default 1h

            // On cale le démarrage sur une heure pile pour faire propre
            let currentGridTs = Math.ceil(displayStartTs / step) * step;
            const safeEndTs = (displayEndTs === Infinity) ? Date.now() : displayEndTs;

            while (currentGridTs <= safeEndTs) {
                // Filtre basique (pas avant le start réel)
                if (currentGridTs >= displayStartTs) {
                    displayTimestamps.push(currentGridTs);
                }
                currentGridTs += step;
            }
            console.log(`[HistoryCalculator] Generated Uniform Grid for 1W: ${displayTimestamps.length} points (Step: ${step / 60000}m)`);
        } else {
            // Comportement standard pour 1D ou autres (basé sur les données réelles pour précision max)
            // NOTE: For 1D view we MUST include the midnight point (displayStartTs) so the chart
            // starts at 00:00 and shows crypto moves overnight (fixes Monday issue).
            displayTimestamps = sortedTimestamps.filter(ts => {
                if (ts < displayStartTs || ts > displayEndTs) return false;
                // Always keep the exact displayStart timestamp (midnight) for 1D
                if (days === 1 && ts === displayStartTs) return true;

                // Filter 8am points for stock-dominated portfolios, but never drop midnight
                if (days === 1 && !isCrypto) {
                    const tsDate = new Date(ts);
                    const hour = tsDate.getHours();
                    const hasDataAfter8am = sortedTimestamps.some(t => {
                        const d = new Date(t);
                        return d.getHours() >= 8 && t >= displayStartTs && t <= displayEndTs;
                    });
                    if (hasDataAfter8am && hour < 8) return false;
                }
                return true;
            });
        }

        // --- INITIALISATION LAST KNOWN PRICES (Backfill) ---
        // Doit être fait AVANT de calculer yesterdayClose pour garantir la cohérence
        const lastKnownPrices = new Map();

        // 1. Chercher le dernier prix connu AVANT le début du graphique (dans l'historique récupéré)
        const allTsBefore = sortedTimestamps.filter(ts => ts < displayStartTs);
        const lastTsOverall = allTsBefore.length > 0 ? allTsBefore[allTsBefore.length - 1] : null;

        if (lastTsOverall !== null) {
            for (const t of tickers) {
                const hist = historicalDataMap.get(t);
                let price = findClosestPrice(hist, lastTsOverall, '1wk'); // Loose match
                if (price !== null) lastKnownPrices.set(t, price);
            }
        }

        // 2. Backfill via Storage (Crucial pour Stocks Lundi Matin)
        // FIX: Pour les actions sur vues courtes (1D/2D), toujours overrider l'étape 1 avec
        // storage.previousClose. L'étape 1 fait un forward-lookahead avec une tolérance d'1 semaine
        // et peut trouver le prix d'ouverture du lundi (futur proche) au lieu de la clôture du vendredi.
        // Sans cet override, les actions affichent leurs variations futures dès minuit au lieu de
        // les montrer à l'heure réelle d'ouverture du marché (bug lundi).
        for (const t of tickers) {
            const isTickerCrypto = isCryptoTicker(t);

            // Pour les actions sur court terme : override inconditionnellement l'étape 1
            if (!isTickerCrypto && !t.startsWith('CASH-') && days <= 2) {
                const priceData = this.storage.getCurrentPrice(t);
                if (priceData && priceData.previousClose > 0) {
                    lastKnownPrices.set(t, priceData.previousClose);
                    continue;
                }
            }

            if (!lastKnownPrices.has(t)) {
                let backfillPrice = null;
                const hist = historicalDataMap.get(t);

                // Sinon premier point historique
                if (!backfillPrice && hist) {
                    const timestamps = Object.keys(hist).map(Number).sort((a, b) => a - b);
                    if (timestamps.length > 0) {
                        const firstPrice = hist[timestamps[0]];
                        if (firstPrice !== null && firstPrice > 0) backfillPrice = firstPrice;
                    }
                }

                // Ultime recours Live Price
                if (!backfillPrice && !isTickerCrypto) {
                    const priceData = this.storage.getCurrentPrice(t);
                    if (priceData && priceData.price > 0) backfillPrice = priceData.price;
                    else if (priceData && priceData.previousClose > 0) backfillPrice = priceData.previousClose;
                }

                if (backfillPrice !== null) {
                    lastKnownPrices.set(t, backfillPrice);
                }
            }
        }

        // ULTIMATE FALLBACK INIT:
        for (const t of tickers) {
            if (!lastKnownPrices.has(t) && !t.startsWith('CASH-')) {
                const priceData = this.storage.getCurrentPrice(t);
                if (priceData) {
                    const initPrice = priceData.price || priceData.previousClose || 0;
                    if (initPrice > 0) {
                        lastKnownPrices.set(t, initPrice);
                    }
                }
            }
        }

        // --- CALCUL CLOTURE HIER (BASÉ SUR LE DERNIER JOUR DE TRADING) ---
        // CRITICAL FIX: yesterdayClose doit TOUJOURS représenter la valeur à la clôture du DERNIER jour de trading,
        // indépendamment de la période affichée (1D, 1W, 1M, etc.)
        // Cela garantit la cohérence entre toutes les vues et avec le dashboard.

        // Pour la vue 1J: la clôture d'hier = valeur à la clôture du dernier jour de trading (23:59 dernier jour)
        // Pour la vue 2J: la clôture d'hier = clôture du jour AVANT hier (23:59)
        // IMPORTANT: Utiliser la MÊME logique pour 1D et 2D pour garantir que 1D = zoom de 2D
        
        let lastMarketCloseTs;
        // Utiliser la MÊME logique pour tous les cas: clôture du DERNIER jour de trading
        let lastTradingDay = getLastTradingDay(new Date());
        lastTradingDay.setHours(23, 59, 59, 999);
        lastMarketCloseTs = lastTradingDay.getTime();
        
        console.log(`[HistoryCalc] Daily reference ("clôture") at: ${new Date(lastMarketCloseTs).toISOString()}`);
        console.log(`[HistoryCalc] Today: ${today.toISOString()}, Last Trading Day: ${lastTradingDay.toISOString()}, Days: ${days}`);

        // Résout la valeur du portefeuille à la clôture PRÉCÉDANT refDate, par actif.
        // Les cryptos/cash tradent 24/7 : leur clôture de référence est le calendrier
        // civil (refDate - 1 jour, 23:59:59), pas le dernier jour BOURSIER (qui saute
        // le week-end). Les actions, elles, n'ont aucune cotation le week-end donc
        // leur "dernier jour de trading" reste la bonne référence.
        // SINGLE SOURCE OF TRUTH : la résolution par ticker (cutoff + chaîne de fallback)
        // vit désormais dans MarketUtils.resolveTickerPreviousClose, partagée avec les
        // cartes indices/dashboard. Cette fonction ne fait plus qu'agréger le résultat par
        // ticker en un total portefeuille (quantités détenues à la clôture + conversion FX).
        // useDedicatedFetch : quand true, ignore historicalDataMap DE CETTE VUE et force
        // resolveTickerPreviousClose à faire (ou réutiliser depuis le cache partagé
        // api.historicalPriceCache) sa PROPRE requête standardisée (bougies '1d', même
        // fenêtre quel que soit l'appelant). Nécessaire car 1J/2J/1S déclenchent chacun
        // leur propre fetch de données intraday avec des fenêtres différentes — Yahoo
        // peut renvoyer une bougie de clôture légèrement différente pour "le même"
        // vendredi selon la fenêtre exacte demandée. Sans ça, l'ancrage "clôture d'hier"
        // de la courbe (PÉRIODE/VAR JOUR/CLÔTURE HIER) pouvait différer entre vues pour
        // le même jour, même après avoir supprimé la préférence pour le prix live.
        const resolveCloseValueBeforeDay = async (refDate, label = '', preferLiveClose = false, useDedicatedFetch = false) => {
            const quantities = new Map();
            for (const t of tickers) quantities.set(t, 0);

            for (const [t, buyList] of assetMap.entries()) {
                const cutoffTs = getCloseCutoffForTicker(t, refDate);
                for (const buy of buyList) {
                    if (buy.date.getTime() <= cutoffTs) {
                        quantities.set(t, quantities.get(t) + buy.quantity);
                    }
                }
            }

            let total = 0;
            let assetsFound = 0;
            const prices = new Map(); // Prix natif (avant taux de change) utilisé pour chaque ticker

            for (const t of tickers) {
                const qty = quantities.get(t);
                if (qty > 0) {
                    // Cash: price is always 1.0, no lookup needed
                    if (t.startsWith('CASH-')) {
                        total += qty;
                        assetsFound++;
                        prices.set(t, 1.0);
                        continue;
                    }

                    const { closePrice } = await resolveTickerPreviousClose(t, {
                        storage: this.storage,
                        api: useDedicatedFetch ? this.api : undefined,
                        refDate,
                        preferLiveClose,
                        historicalDataMap: useDedicatedFetch ? null : (historicalDataMap.get(t) || null),
                        allowFetch: useDedicatedFetch
                    });

                    if (closePrice && closePrice > 0) {
                        prices.set(t, closePrice);
                        let rate = 1;
                        if (!isSingleAsset) {
                            const priceData = this.storage.getCurrentPrice(t);
                            const currency = priceData?.currency || 'EUR';
                            if (currency === 'USD') rate = dynamicRate;
                        }
                        total += closePrice * rate * qty;
                        assetsFound++;
                    }
                }
            }

            console.log(`[HistoryCalc] resolveCloseValueBeforeDay${label} @ ${refDate.toISOString()}: total=${total.toFixed(2)}€, assets=${assetsFound}/${tickers.length}`);
            return { total: assetsFound > 0 ? total : 0, quantities, prices };
        };

        // Pour la vue 1D, "hier" doit être calculé par rapport au jour EFFECTIVEMENT affiché
        // (displayStartUTC), pas par rapport à la date calendaire réelle ("today").
        // Sinon, quand le marché est fermé (week-end) et que le graphique bascule sur le
        // dernier jour de bourse (ex: vendredi), getLastTradingDay(today) renvoie ce même
        // vendredi : "yesterdayClose" devient alors la clôture du jour affiché lui-même
        // au lieu de la clôture de la veille (jeudi), ce qui écrase la variation du jour
        // (affiche 0.00€) ou la fausse complètement selon la fraîcheur des données par titre.
        const yesterdayCloseRefDate = (days === 1) ? displayStartUTC : today;
        // preferLiveClose = false, TOUJOURS : ce yesterdayClose alimente perTickerYesterdayClose
        // (donc la colonne "Day P&L" du tableau) ET, via la boucle TWR plus bas, le graphique/
        // VAR TODAY/CLÔTURE HIER. Ces deux usages DOIVENT résoudre le même prix pour être
        // cohérents — préférer le prix live ici (comme avant) faisait diverger le tableau
        // (basé sur storage.previousClose) du graphique (basé sur la clôture officielle
        // résolue plus bas avec preferLiveClose=false), donnant 3 chiffres différents pour
        // "la variation du jour" (tableau, VAR TODAY, sélection sur la courbe) alors que
        // l'utilisateur ne veut qu'UNE seule source de vérité. Le prix live ne reste qu'un
        // filet de secours (dans resolveTickerPreviousClose) si la clôture officielle est
        // introuvable.
        // useDedicatedFetch=true : ce yesterdayClose doit être identique quelle que soit la
        // période actuellement affichée dans le graphique (1J/2J/1S...), pas dépendant de la
        // fenêtre de fetch propre à la vue courante.
        const { total: yesterdayClose, quantities: closeQuantities, prices: closePrices } = await resolveCloseValueBeforeDay(yesterdayCloseRefDate, ' (yesterdayClose)', false, true);

        // CORRECTION DE LA VRAIE CLÔTURE : la dernière bougie intraday (5m/15m) d'un jour
        // TERMINÉ (ex: vendredi, vu depuis lundi) peut différer du vrai cours de clôture
        // officiel (ex: enchère de clôture sur certaines actions EU, non captée par le
        // dernier tick intraday à 17h25-17h30) — vérifié : écart réel de plusieurs
        // centaines d'euros sur le portefeuille pour certains titres. Sans correction, la
        // courbe elle-même (et donc tout ce qui en dérive : sélection à la souris,
        // tooltips, PÉRIODE) racontait une histoire différente de VAR TODAY/CLÔTURE HIER
        // (qui utilisent la clôture officielle résolue ci-dessus). On force donc le
        // dernier point intraday de "hier" à égaler exactement cette clôture officielle.
        for (const t of tickers) {
            if (t.startsWith('CASH-') || isCryptoTicker(t)) continue;
            const nativeClose = closePrices.get(t);
            if (!nativeClose || nativeClose <= 0) continue;
            const hist = historicalDataMap.get(t);
            if (!hist) continue;
            const cutoffTs = getCloseCutoffForTicker(t, yesterdayCloseRefDate);
            const histKeys = Object.keys(hist).map(Number).sort((a, b) => a - b);
            let lastTsBeforeCutoff = null;
            for (const ts of histKeys) {
                if (ts <= cutoffTs) lastTsBeforeCutoff = ts; else break;
            }
            if (lastTsBeforeCutoff !== null && hist[lastTsBeforeCutoff] !== nativeClose) {
                console.log(`[HistoryCalc] Correction clôture réelle pour ${t} @ ${new Date(lastTsBeforeCutoff).toISOString()}: ${hist[lastTsBeforeCutoff]} → ${nativeClose}`);
                hist[lastTsBeforeCutoff] = nativeClose;
            }
        }

        // Injecter un prix synthétique à minuit pour les actions (pas de cotation avant l'ouverture).
        // Le lundi, lastMarketCloseTs = dimanche 23:59 → l'ancienne condition (< 1h) ne s'appliquait pas.
        if (days === 1) {
            const injectMidnightStocks =
                (displayStartTs <= lastMarketCloseTs && lastMarketCloseTs < displayStartTs + 3600000) ||
                (isMixed && today.getDay() === 1);

            if (injectMidnightStocks) {
                for (const t of tickers) {
                    if (t.startsWith('CASH-') || isCryptoTicker(t)) continue;
                    const hist = historicalDataMap.get(t);
                    if (!hist || hist[displayStartTs]) continue;

                    // PRIORITÉ: réutiliser exactement le prix de clôture déjà résolu pour
                    // yesterdayClose (closePrices), pour garantir que le premier point
                    // affiché du graphique 1D EST la base à 0%, au centime près.
                    let midnightPrice = closePrices.get(t) || null;

                    if (!midnightPrice) {
                        const priceData = this.storage.getCurrentPrice(t);
                        if (priceData && priceData.previousClose > 0) midnightPrice = priceData.previousClose;
                    }

                    // Fallback: chercher dans l'historique (jamais vers le futur pour une action)
                    if (!midnightPrice) {
                        midnightPrice = findClosestPrice(hist, displayStartTs - 3600000, '1h', false);
                    }

                    if (midnightPrice && midnightPrice > 0) {
                        hist[displayStartTs] = midnightPrice;
                        console.log(`[HistoryCalc] Injected synthetic midnight price for ${t}: ${midnightPrice.toFixed(2)}€ at ${new Date(displayStartTs).toISOString()}`);
                    }
                }

                // AUSSI: Injecter les prix pour les cryptos à minuit
                for (const t of tickers) {
                    if (!isCryptoTicker(t) || t.startsWith('CASH-')) continue;
                    const hist = historicalDataMap.get(t);
                    if (!hist || hist[displayStartTs]) continue;

                    // Même principe: réutiliser le prix déjà résolu par resolveCloseValueBeforeDay.
                    let midnightPrice = closePrices.get(t) || null;

                    if (!midnightPrice) {
                        const priceData = this.storage.getCurrentPrice(t);
                        if (priceData && priceData.previousClose > 0) {
                            midnightPrice = priceData.previousClose;
                        } else if (priceData && priceData.price > 0) {
                            midnightPrice = priceData.price;
                        }
                    }

                    // Fallback: chercher dans l'historique
                    if (!midnightPrice) {
                        midnightPrice = findClosestPrice(hist, displayStartTs - 3600000, '1h');
                    }

                    if (midnightPrice && midnightPrice > 0) {
                        hist[displayStartTs] = midnightPrice;
                        console.log(`[HistoryCalc] Injected midnight price for crypto ${t}: ${midnightPrice.toFixed(2)}€ at ${new Date(displayStartTs).toISOString()}`);
                    }
                }
            }
        }

        // Add midnight to displayTimestamps for 1D if it's not already there
        if (days === 1) {
            const firstDisplayTs = displayTimestamps[0];
            if (displayStartTs < firstDisplayTs && !displayTimestamps.includes(displayStartTs)) {
                displayTimestamps.unshift(displayStartTs);
                console.log(`[HistoryCalc] Added midnight (${new Date(displayStartTs).toISOString()}) to start of 1D timestamps`);
            }

            const nowTs = Math.min(Date.now(), displayEndTs);
            if (nowTs > displayStartTs && !displayTimestamps.includes(nowTs)) {
                displayTimestamps.push(nowTs);
                console.log(`[HistoryCalc] Added current point (${new Date(nowTs).toISOString()}) to 1D timestamps`);
            }

            displayTimestamps = Array.from(new Set(displayTimestamps)).sort((a, b) => a - b);
        }

        // --- CALCUL VALEUR DÉBUT JOURNÉE (POUR VUE 1D DES PORTFOLIOS 24/7) ---
        // Pour les portfolios qui tradent 24/7 (crypto), il y a un gap entre:
        // - yesterdayClose (23:59 hier)
        // - Début de la journée 1D (00:00 aujourd'hui ou heure d'ouverture)
        // En vue 1D, la PÉRIODE doit utiliser le début du graphique, pas la clôture d'hier

        let dayStartValue = null;

        // Calculer la valeur au premier timestamp du graphique (seulement pour vue 1D)
        if (days === 1 && displayTimestamps.length > 0) {
            const firstTs = displayTimestamps[0];
            let startAssetsFound = 0;
            dayStartValue = 0;

            // Calculer les quantités au premier point du graphique
            const firstPointQuantities = new Map();
            for (const t of tickers) firstPointQuantities.set(t, 0);

            for (const [t, buyList] of assetMap.entries()) {
                for (const buy of buyList) {
                    if (buy.date.getTime() <= firstTs) {
                        firstPointQuantities.set(t, firstPointQuantities.get(t) + buy.quantity);
                    }
                }
            }

            for (const t of tickers) {
                const qty = firstPointQuantities.get(t);
                if (qty > 0) {
                    // Cash: price is always 1.0
                    if (t.startsWith('CASH-')) {
                        dayStartValue += qty;
                        startAssetsFound++;
                        continue;
                    }

                    let startPrice = null;
                    const hist = historicalDataMap.get(t);

                    // Chercher le prix au premier timestamp (jamais vers le futur pour une action)
                    if (hist) {
                        startPrice = findClosestPrice(hist, firstTs, interval, isCryptoTicker(t));
                    }

                    // Fallback: utiliser lastKnownPrices
                    if (!startPrice || startPrice <= 0) {
                        startPrice = lastKnownPrices.get(t);
                    }

                    if (startPrice && startPrice > 0) {
                        let rate = 1;
                        if (!isSingleAsset) {
                            const priceData = this.storage.getCurrentPrice(t);
                            const currency = priceData?.currency || 'EUR';
                            if (currency === 'USD') rate = dynamicRate;
                        }
                        dayStartValue += startPrice * qty * rate;
                        startAssetsFound++;
                    }
                }
            }

            if (startAssetsFound === 0) dayStartValue = null;
            console.log(`[HistoryCalc] dayStartValue (1D first point): ${dayStartValue ? dayStartValue.toFixed(2) : 'null'}€`);
        }

        // --- CALCUL VALEUR AUJOURD'HUI DES ACTIFS POSSÉDÉS HIER (AVANT LA BOUCLE) ---
        // Pour calculer le TWR de façon pure, on a besoin de cette valeur dès le début
        let todayValueOfYesterdayHoldings = null;

        // SINGLE SOURCE OF TRUTH : détail par ticker de la résolution ci-dessus
        // (closePrices/closeQuantities), pour que la table (calculateHoldings) et le
        // KPI du graphique (yesterdayClose/vsYesterdayAbs) partagent exactement les
        // mêmes valeurs de référence par actif au lieu de deux résolutions séparées.
        const perTickerYesterdayClose = new Map();

        if (days === 1) {
            let todayValue = 0;
            let todayAssetsFound = 0;

            for (const t of tickers) {
                if (t.startsWith('CASH-')) continue;
                const qtyYesterday = closeQuantities.get(t) || 0; // Quantité possédée hier

                if (qtyYesterday > 0) {
                    // Récupérer le prix ACTUEL de l'actif
                    const priceData = this.storage.getCurrentPrice(t);
                    let currentPrice = null;

                    if (priceData && priceData.price > 0) {
                        currentPrice = priceData.price;
                    }

                    let rate = 1;
                    const currency = priceData?.currency || 'EUR';
                    if (!isSingleAsset && currency === 'USD') rate = dynamicRate;

                    const closePrice = closePrices.get(t) || null;
                    const yesterdayCloseTotal = (closePrice && closePrice > 0) ? closePrice * qtyYesterday * rate : null;

                    if (currentPrice && currentPrice > 0) {
                        todayValue += currentPrice * qtyYesterday * rate;
                        todayAssetsFound++;
                    }

                    perTickerYesterdayClose.set(t, {
                        yesterdayCloseTotal,
                        todayValueOfYesterdayHoldingsTotal: (currentPrice && currentPrice > 0) ? currentPrice * qtyYesterday * rate : null,
                        quantityYesterday: qtyYesterday,
                        currency
                    });
                }
            }

            if (todayAssetsFound > 0) {
                todayValueOfYesterdayHoldings = todayValue;
                console.log(`[HistoryCalc] todayValueOfYesterdayHoldings = ${todayValueOfYesterdayHoldings.toFixed(2)}€ (value today of assets held yesterday)`);
            }
        }

        let previousTotalValue = 0;
        let currentTWR = 1.0;

        // Base TWR : SOURCE UNIQUE DE VÉRITÉ = la valeur réellement affichée au premier point
        // du graphique (comme dailyTwrDenominator plus bas), et non plus un calcul externe
        // (resolveCloseValueBeforeDay) qui pouvait diverger du premier point réellement tracé.
        // Avant ce fix, twrDenominator valait "yesterdayClose" (calcul séparé) alors que le
        // tracé du graphique démarrait sur une autre valeur : les KPI (Var Today, Total Return)
        // et le graphique/tooltip pouvaient donc afficher deux chiffres différents pour "la
        // même" variation du jour. Désormais twrDenominator, dailyTwrDenominator ET la valeur
        // "CLÔTURE HIER" affichée proviennent tous du même point calculé plus bas.
        let twrDenominator = null;
        // Valeur exposée pour l'affichage "CLÔTURE HIER" : initialisée au calcul externe (utile
        // pour les périodes où le TWR n'est pas ancré sur un point du graphique, ex: si la
        // résolution de clôture échoue totalement), puis écrasée par la valeur unique dès
        // qu'elle est connue (voir plus bas).
        let displayedYesterdayClose = yesterdayClose;
        // Étendu à days<=7 (1J/2J/1S) : restreint à 1D/2D seulement, un zoom 1S retombait
        // sur un calcul de ROI (valeur/investi) totalement différent du calcul "clôture à
        // clôture" du 1D — deux métriques sans rapport, d'où des chiffres incohérents entre
        // zooms pour les MÊMES jours (ex: sélectionner "lundi" sur la vue 1S donnait un
        // delta différent du VAR TODAY de la vue 1J). Chaque frontière de jour déclenche
        // maintenant une résolution dédiée (useDedicatedFetch, voir plus bas) — pas étendu
        // au-delà de 7 jours pour l'instant pour limiter le nombre de requêtes déclenchées
        // (une par frontière de jour) sur les vues plus longues (1M/1Y/...).
        const shouldUseTwrFromClose = (days === 1 || (typeof days === 'number' && days <= 7));

        // Série "dailyTwr" : comme twr, mais la base (0%) est réinitialisée à chaque
        // changement de jour civil, sur la clôture de la veille de CE jour-là (via
        // resolveCloseValueBeforeDay). C'est cette série qui doit alimenter le tracé
        // du graphique (twr[] reste un ancrage unique sur toute la période, utilisé
        // par le "PERIOD RETURN" et la sélection au glisser-déposer).
        let dailyTwrDenominator = null;
        let dailyTwrDayKey = null;

        // ANCIEN CODE DÉSACTIVÉ: Utilisait dayStartValue pour 1D mixte, ce qui créait une discontinuité
        // if (days === 1 && isMixed && dayStartValue > 0) {
        //     twrDenominator = dayStartValue;
        //     console.log(`[HistoryCalc] Mixed 1D: TWR denominator = dayStartValue ${twrDenominator.toFixed(2)}€`);
        // }

        let baseValueForPeriod = null;
        // Tracking des flux de trésorerie intraday pour ajustement TWR
        for (let i = 0; i < displayTimestamps.length; i++) {
            const ts = displayTimestamps[i];
            let tsChangedInvested = false;
            const prevTs = (i === 0) ? displayStartUTC.getTime() - 1 : displayTimestamps[i - 1];
            let cashFlow = 0;

            for (const [t, buyList] of assetMap.entries()) {
                for (const buy of buyList) {
                    if (buy.date.getTime() > prevTs && buy.date.getTime() <= ts) {
                        assetQuantities.set(t, assetQuantities.get(t) + buy.quantity);
                        const flow = buy.price * buy.quantity;
                        let rate = 1;
                        if (!isSingleAsset) {
                            const d = this.storage.getCurrentPrice(t);
                            const c = d?.currency || buy.currency || 'EUR';
                            if (c === 'USD') rate = dynamicRate;
                        }
                        assetInvested.set(t, assetInvested.get(t) + (flow * rate));
                        cashFlow += flow * rate;
                        tsChangedInvested = true;
                    }
                }
            }

            let currentTsTotalValue = 0;
            let totalInvested = 0;
            let hasAtLeastOnePrice = false;
            let currentTsUnitPrice = null;
            let yesterdayHoldingsValue = 0;
            let hasYesterdayHoldingsPrice = false;
            // Une valorisation n'est "complète" que si CHAQUE ligne détenue a un prix résolu
            // à ce ts précis : sinon la réutiliser comme base 0% du graphique produirait un
            // faux saut dès qu'une ligne manquante (peu liquide) reçoit enfin un prix.
            let expectedHoldingsCount = 0;
            let pricedHoldingsCount = 0;

            for (const t of tickers) {
                const hist = historicalDataMap.get(t);
                const qty = assetQuantities.get(t);
                const yesterdayQty = closeQuantities.get(t) || 0;

                // For CASH we allow negative balance (margin etc)
                // For assets it should be >= 0 but floating point 0.0000001 could trigger. But `qty !== 0` is safer.
                if (Math.abs(qty) > 0.000001 || yesterdayQty > 0) {
                    let price = null;

                    // Support CASH/Liquidité
                    if (t.startsWith('CASH-')) {
                        price = 1.0;
                    } else if (hist) {
                        if (hist[ts]) {
                            price = hist[ts];
                        } else {
                            // allowForward réservé à la crypto (24/7, données éparses le
                            // week-end) — pour les actions, ne JAMAIS accrocher un prix
                            // futur (ex: bougie lundi matin, souvent un print illiquide)
                            // sur les points de nuit du week-end : ça créait une fausse
                            // chute/marche à la frontière du lundi sur les vues 1S+.
                            const closePrice = findClosestPrice(hist, ts, interval, isCryptoTicker(t));
                            if (closePrice !== null) {
                                price = closePrice;
                            } else if (lastKnownPrices.has(t)) {
                                price = lastKnownPrices.get(t);
                            }
                        }
                    } else {
                        if (lastKnownPrices.has(t)) {
                            price = lastKnownPrices.get(t);
                        }
                    }

                    const priceData = this.storage.getCurrentPrice(t);
                    const currency = priceData?.currency || 'EUR';

                    if (Math.abs(qty) > 0.000001) expectedHoldingsCount++;

                    if (price !== null) {
                        let rate = 1;
                        if (!isSingleAsset) {
                            if (currency === 'USD') rate = dynamicRate;
                        }

                        if (Math.abs(qty) > 0.000001) {
                            const value = price * qty * rate;
                            currentTsTotalValue += value;
                            hasAtLeastOnePrice = true;
                            pricedHoldingsCount++;

                            if (isSingleAsset) currentTsUnitPrice = price;
                        }

                        if (yesterdayQty > 0) {
                            yesterdayHoldingsValue += price * yesterdayQty * rate;
                            hasYesterdayHoldingsPrice = true;
                        }

                        // Toujours mettre à jour lastKnownPrices : carry-forward naturel.
                        // Si un actif n'a plus de données (après clôture), il gardera son dernier prix connu.
                        lastKnownPrices.set(t, price);
                    }
                }
                const investedAmount = assetInvested.get(t);
                totalInvested += investedAmount;
            }

            // Premier point réel : on mémorise la valeur de départ (utilisée ensuite pour ancrer à 0%)
            if (i === 0 && currentTsTotalValue > 0 && hasAtLeastOnePrice) {
                baseValueForPeriod = currentTsTotalValue;
            }

            // CALCUL TIME-WEIGHTED RETURN (TWR) — SOURCE UNIQUE DE VÉRITÉ.
            // twrDenominator (ancrage sur toute la période, utilisé par "PERIOD RETURN"/KPI) et
            // dailyTwrDenominator (réinitialisé à chaque jour civil, utilisé par le TRACÉ et son
            // tooltip) sont tous les deux ancrés sur la VRAIE clôture de la veille (même
            // résolution par-ticker que le tableau), pas sur la valeur du premier point
            // intraday du jour — sinon tout écart réel d'ouverture (gap haussier/baissier)
            // serait invisible, la courbe repartant toujours artificiellement à 0%.
            if (shouldUseTwrFromClose) {
                const dayKey = new Date(ts).toDateString();
                if (dayKey !== dailyTwrDayKey) {
                    // PRIORITÉ : la vraie clôture de la veille (résolution par-ticker,
                    // cutoff-aware), JAMAIS la valeur du premier point intraday du jour.
                    // Utiliser ce premier point comme ancrage à 0% EFFACE tout écart réel
                    // d'ouverture (le marché peut ouvrir en hausse ou en baisse vs la
                    // clôture précédente — un vrai "gap" que l'utilisateur veut voir).
                    //
                    // preferLiveClose = false (jamais, ici) : cet ancrage doit rester
                    // fondé UNIQUEMENT sur la même série de bougies historiques que celle
                    // réellement tracée par la courbe (multi-jours/2J/1S...), sinon la
                    // vue 1J peut ancrer sur un prix "live" stocké différent de ce que
                    // montre la courbe continue pour ce même instant — exactement le
                    // genre d'incohérence 1J vs 2J qu'on corrige ici. La préférence pour
                    // le prix live n'a de sens que pour le tableau (fraîcheur), pas pour
                    // l'ancrage de la courbe elle-même.
                    //
                    // useDedicatedFetch=true : ignore le historicalDataMap propre à CETTE
                    // vue (1J/2J/1S ont chacune leur propre fenêtre de fetch, potentiellement
                    // légèrement différente pour "la même" bougie de clôture chez Yahoo) —
                    // force une requête (ou un cache) standardisée et partagée, identique
                    // quelle que soit la vue qui la déclenche.
                    let resolvedDayBase = null;
                    const { total: dailyBase } = await resolveCloseValueBeforeDay(new Date(ts), ` (daily ${dayKey})`, false, true);
                    if (dailyBase > 0) resolvedDayBase = dailyBase;

                    if (resolvedDayBase !== null) {
                        console.log(`[TWR BASE] dailyTwr base (${dayKey}) = vraie clôture de la veille: ${resolvedDayBase.toFixed(2)}€`);
                    } else {
                        // Filet de secours UNIQUEMENT si la vraie clôture est introuvable
                        // (cas dégradé) : valeur du 1er point intraday, mais seulement s'il
                        // valorise TOUTES les lignes détenues (sinon un faux saut est
                        // possible dès qu'une ligne peu liquide reçoit enfin un prix).
                        const isCompleteValuation = expectedHoldingsCount > 0 && pricedHoldingsCount === expectedHoldingsCount;
                        if (isCompleteValuation && currentTsTotalValue > 0) {
                            resolvedDayBase = currentTsTotalValue;
                            console.log(`[TWR BASE] dailyTwr base (${dayKey}) = filet de secours (clôture veille introuvable), valeur du 1er point: ${resolvedDayBase.toFixed(2)}€`);
                        }
                    }

                    if (resolvedDayBase !== null) {
                        dailyTwrDayKey = dayKey;
                        dailyTwrDenominator = resolvedDayBase;
                        // twrDenominator ne s'ancre qu'une seule fois pour toute la période
                        // affichée (1er jour) : sur le 2ème jour d'une vue 2J, dailyTwrDenominator
                        // se réinitialise mais twrDenominator doit rester sur l'ancrage du 1er jour.
                        if (twrDenominator === null) {
                            twrDenominator = resolvedDayBase;
                            // "CLÔTURE HIER" affiché doit être ce même chiffre, pas le calcul
                            // externe (yesterdayClose) potentiellement différent.
                            displayedYesterdayClose = resolvedDayBase;
                            console.log(`[TWR BASE] twrDenominator (période) ancré sur ${resolvedDayBase.toFixed(2)}€`);
                        }
                    }
                }
            }

            // Ajustement TWR pour achats intraday : le dénominateur doit être mis à l'échelle
            // pour que l'achat lui-même n'apparaisse pas comme un gain. On utilise le cash flow réel
            // de l'achat (prix d'achat × quantité) comme prix de référence.
            const useTwrFromClose = shouldUseTwrFromClose && twrDenominator !== null && twrDenominator > 0;
            if (tsChangedInvested && useTwrFromClose && cashFlow > 0) {
                const valueBeforePurchase = currentTsTotalValue - cashFlow;
                if (valueBeforePurchase > 0) {
                    twrDenominator *= (currentTsTotalValue / valueBeforePurchase);
                    console.log(`[TWR FIX] Achat intraday: cashFlow=${cashFlow.toFixed(2)}, avant=${valueBeforePurchase.toFixed(2)}, après=${currentTsTotalValue.toFixed(2)}, nouveau denom=${twrDenominator.toFixed(2)}`);
                } else {
                    console.warn(`[TWR FIX] Ignored intraday adjustment because valueBeforePurchase <= 0 (cashFlow=${cashFlow.toFixed(2)}, total=${currentTsTotalValue.toFixed(2)})`);
                }
            }

            const useDailyTwr = shouldUseTwrFromClose && dailyTwrDenominator !== null && dailyTwrDenominator > 0;
            if (tsChangedInvested && useDailyTwr && cashFlow > 0) {
                const valueBeforePurchase = currentTsTotalValue - cashFlow;
                if (valueBeforePurchase > 0) {
                    dailyTwrDenominator *= (currentTsTotalValue / valueBeforePurchase);
                }
            }

            // Pour la vue 1D, conserver la base yesterdayClose afin que la performance
            // reflète réellement l'évolution depuis la clôture d'hier.
            // Le premier point graphique peut être à 00h00 ou un peu plus tard,
            // mais l'échelle du TWR doit rester liée à yesterdayClose.

            if (!hasAtLeastOnePrice && !tsChangedInvested) {
                // Si aucun prix réel ni mouvement d'investissement n'est disponible,
                // on doit marquer le point comme manquant plutôt que de creuser un faux trou à 0%.
                currentTWR = null;
            } else if (useTwrFromClose) {
                currentTWR = currentTsTotalValue / twrDenominator;

                if (i % 50 === 0 || i === displayTimestamps.length - 1) {
                    console.log(`[HistoryCalc TWR] i=${i}, value=${currentTsTotalValue.toFixed(2)}, denom=${twrDenominator.toFixed(2)}, TWR=${currentTWR.toFixed(4)} (${((currentTWR - 1) * 100).toFixed(2)}%)`);
                }
            } else if (totalInvested > 0) {
                // Autres vues: ROI classique
                currentTWR = (currentTsTotalValue - totalInvested) / totalInvested;
                // On ajoute +1 pour matcher l'échelle de base 1.0 du graphique TWR précédent (ou on adapte)
                // Le chart attendait un facteur (ex: 1.10 pour +10%). 
                // ROI est 0.10. Donc TWR = 1 + ROI.
                currentTWR += 1.0;
            } else {
                currentTWR = 1.0;
            }

            twr.push(currentTWR);

            if (!hasAtLeastOnePrice && !tsChangedInvested) {
                dailyTwr.push(null);
            } else if (useDailyTwr) {
                dailyTwr.push(currentTsTotalValue / dailyTwrDenominator);
            } else {
                dailyTwr.push(null);
            }

            previousTotalValue = currentTsTotalValue;

            const label = labelFormatFunc(ts);
            labels.push(label);

            if (hasAtLeastOnePrice || tsChangedInvested) {
                invested.push(totalInvested);
                values.push(currentTsTotalValue);
                if (isSingleAsset) unitPrices.push(currentTsUnitPrice);
            } else {
                invested.push(null);
                values.push(null);
                if (isSingleAsset) unitPrices.push(null);
            }
        }

        if (isSingleAsset) {
            const buyList = assetMap.get(ticker);
            const finalEndTs = (displayEndTs === Infinity ? todayUTC.getTime() : displayEndTs);
            let maxToleranceMs = (days === 1) ? 2 * 3600000 : 4 * 86400000;

            for (const buy of buyList) {
                const buyTs = buy.date.getTime();
                if (buyTs >= displayStartTs && buyTs <= finalEndTs) {
                    let closestIdx = -1;
                    let minDiff = Infinity;
                    for (let i = 0; i < displayTimestamps.length; i++) {
                        const diff = Math.abs(displayTimestamps[i] - buyTs);
                        if (diff < minDiff) {
                            minDiff = diff;
                            closestIdx = i;
                        }
                    }
                    if (closestIdx !== -1 && minDiff <= maxToleranceMs) {
                        const rate = buy.currency === 'USD' ? dynamicRate : 1;
                        purchasePoints.push({
                            x: labels[closestIdx],
                            y: buy.price * rate,
                            quantity: buy.quantity,
                            date: buy.date
                        });
                    }
                }
            }
        }

        // dayStartValue était calculé séparément (avant la boucle, sa propre résolution de prix)
        // et pouvait donc diverger du point réellement tracé. On l'aligne ici sur la même base
        // unique que twrDenominator/CLÔTURE HIER pour la vue 1D (une seule journée affichée).
        if (days === 1 && twrDenominator !== null && twrDenominator > 0) {
            dayStartValue = twrDenominator;
        }

        console.log(`[Return] yesterdayClose (unifié) = ${displayedYesterdayClose ? displayedYesterdayClose.toFixed(2) : 'null'}`);

        // Le TWR de tous les points est déjà calculé sur la base de yesterdayClose (0% = clôture d'hier).
        // Pas de point 'Clôture' artificiel: le graphique commence au premier vrai point intraday.

        return {
            labels,
            invested,
            values,
            yesterdayClose: displayedYesterdayClose,
            dayStartValue,  // NEW: Valeur au début de la journée 1D (pour calcul PÉRIODE)
            todayValueOfYesterdayHoldings,  // NEW: Valeur aujourd'hui des actifs possédés hier (pour VAR JOUR pure)
            perTickerYesterdayClose,  // NEW: détail par ticker (single source of truth pour la table)
            unitPrices,
            purchasePoints,
            timestamps: displayTimestamps,
            twr,
            dailyTwr,
            historicalDataMap,
            isMixed
        };
    }
}

