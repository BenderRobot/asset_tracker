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
    findClosestPrice
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
                const t = p.ticker.toUpperCase();
                if (!assetMap.has(t)) assetMap.set(t, []);
                assetMap.get(t).push({
                    date: parseDate(p.date),
                    price: parseFloat(p.price),
                    quantity: parseFloat(p.quantity),
                    currency: p.currency || 'EUR'
                });
            });
        }

        assetMap.forEach(list => list.sort((a, b) => a.date - b.date));

        let firstPurchase = null;
        for (const list of assetMap.values()) {
            if (list.length > 0 && (!firstPurchase || list[0].date < firstPurchase)) {
                firstPurchase = list[0].date;
            }
        }

        if (!firstPurchase) return { labels: [], invested: [], values: [], yesterdayClose: null, unitPrices: [], purchasePoints: [], twr: [] };

        const today = new Date();
        const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999));

        const sampleTicker = isSingleAsset ? ticker : Array.from(assetMap.keys())[0];
        const isCrypto = isSingleAsset
            ? isCryptoTicker(sampleTicker || '')
            : Array.from(assetMap.keys()).some(t => isCryptoTicker(t));

        const isWeekend = today.getDay() === 0 || today.getDay() === 6;
        let displayStartUTC;
        let bufferDays = 30;
        let hardStopEndTs = null;

        // SIMPLIFICATION LOGIQUE DATES
        // On distingue 2 cas : Actifs 24/7 (Crypto/Mixte) vs Actifs Boursiers Purs (Stocks)

        if (isCrypto || days >= 7) {
            // mode 24/7 ou Long terme : On recule simplement de N jours
            const localDisplay = new Date(today);
            localDisplay.setHours(0, 0, 0, 0);

            if (days === 1) {
                // 1D : Minuit ce matin
            } else if (days === 2) {
                localDisplay.setDate(localDisplay.getDate() - 1); // Hier minuit
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

                    if (hasEU) {
                        displayStartUTC = new Date(Date.UTC(y, m, d, 8, 0, 0)); // 08:00 UTC (09:00 Paris Winter)
                    } else {
                        displayStartUTC = new Date(Date.UTC(y, m, d, 14, 30, 0)); // 14:30 UTC (15:30 Paris Winter)
                    }
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
        }

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
                    const hist = await this.getHistoryWithCache(t, startTs, endTs, interval);
                    historicalDataMap.set(t, hist);
                } catch (err) {
                    historicalDataMap.set(t, {});
                }
            }));
        }

        // FALLBACK: Si aucune donnée pour aujourd'hui
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
                            const hist = await this.api.getHistoricalPricesWithRetry(t, newStartTs, newEndTs, interval);
                            historicalDataMap.set(t, hist);
                        } catch (err) {
                            historicalDataMap.set(t, {});
                        }
                    }));
                }
            }
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
        const allTimestamps = new Set();
        historicalDataMap.forEach(hist => {
            Object.keys(hist).forEach(ts => allTimestamps.add(parseInt(ts)));
        });

        if (displayStartUTC) {
            allTimestamps.add(displayStartUTC.getTime());
        }

        let sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

        // --- CALCUL DES BORNES TEMPORELLES (Déplacé avant la logique de prix) ---
        const displayStartTs = displayStartUTC.getTime();
        let displayEndTs;
        if (hardStopEndTs) displayEndTs = hardStopEndTs;
        else if (days === 1) displayEndTs = displayStartTs + (24 * 60 * 60 * 1000);
        else displayEndTs = Infinity;

        let displayTimestamps = sortedTimestamps.filter(ts => {
            if (ts < displayStartTs || ts > displayEndTs) return false;
            // Filter 8am for stocks if mixed? keeping reliable logic.
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
        for (const t of tickers) {
            if (!lastKnownPrices.has(t)) {
                let backfillPrice = null;
                const hist = historicalDataMap.get(t);
                const isTickerCrypto = isCryptoTicker(t);

                // Pour les Actions sur court terme, préférer le Storage (Previous Close)
                if (!isTickerCrypto && days <= 2) {
                    const priceData = this.storage.getCurrentPrice(t);
                    if (priceData && priceData.previousClose > 0) {
                        backfillPrice = priceData.previousClose;
                    }
                }

                // Sinon premier point historique
                if (!backfillPrice && hist) {
                    const timestamps = Object.keys(hist).map(Number).sort((a, b) => a - b);
                    if (timestamps.length > 0) {
                        const firstPrice = hist[timestamps[0]]; // Peut être le point à 00:00
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
            if (!lastKnownPrices.has(t) && t !== 'CASH' && t !== 'EUR') {
                const priceData = this.storage.getCurrentPrice(t);
                if (priceData) {
                    const initPrice = priceData.price || priceData.previousClose || 0;
                    if (initPrice > 0) {
                        lastKnownPrices.set(t, initPrice);
                    }
                }
            }
        }

        // --- CALCUL CLOTURE HIER (BASÉ SUR LE POINT DE DÉPART) ---
        // On calcule la valeur du portefeuille à l'instant exact displayStartTs
        // Cela force la ligne pointillée à coller au début du graphique.
        let yesterdayClose = 0;
        let startAssetsFound = 0;

        // Calculer les quantités détenues au DEBUT de la période
        const startQuantities = new Map();
        for (const t of tickers) startQuantities.set(t, 0);

        for (const [t, buyList] of assetMap.entries()) {
            for (const buy of buyList) {
                if (buy.date.getTime() < displayStartTs) {
                    startQuantities.set(t, startQuantities.get(t) + buy.quantity);
                }
            }
        }

        for (const t of tickers) {
            const qty = startQuantities.get(t);
            if (qty > 0) {
                // Prix au démarrage ?
                let startPrice = null;
                const hist = historicalDataMap.get(t);

                // A-t-on un prix exact à startTs (ex: Crypto 00:00) ?
                if (hist && hist[displayStartTs]) {
                    startPrice = hist[displayStartTs];
                } else {
                    // Sinon on utilise le lastKnownPrices qu'on vient d'initialiser (Friday Close pour Stocks)
                    startPrice = lastKnownPrices.get(t);
                }

                if (startPrice && startPrice > 0) {
                    let rate = 1;
                    if (!isSingleAsset) {
                        const priceData = this.storage.getCurrentPrice(t);
                        const currency = priceData?.currency || 'EUR';
                        if (currency === 'USD') rate = dynamicRate;
                    }
                    yesterdayClose += startPrice * qty * rate;
                    startAssetsFound++;
                }
            }
        }

        if (startAssetsFound === 0) yesterdayClose = null;

        let previousTotalValue = 0;
        let currentTWR = 1.0;

        for (let i = 0; i < displayTimestamps.length; i++) {
            const ts = displayTimestamps[i];
            let tsChangedInvested = false;
            const prevTs = (i === 0) ? displayStartUTC.getTime() - 1 : displayTimestamps[i - 1];
            let cashFlow = 0;

            for (const [t, buyList] of assetMap.entries()) {
                for (const buy of buyList) {
                    if (buy.date.getTime() > prevTs && buy.date.getTime() <= ts) {
                        assetQuantities.set(t, assetQuantities.get(t) + buy.quantity);
                        const flow = buy.price * buy.quantity; // Not converted here (Invested keeps historical currency? Or should convert? TWR calculation issue mostly)
                        // Actually TWR uses (Value - Invested). If Value is EUR, Invested MUST be EUR.
                        // assetInvested needs conversion if we want TWR in EUR.
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

            for (const t of tickers) {
                const hist = historicalDataMap.get(t);
                const qty = assetQuantities.get(t);

                if (qty > 0) {
                    let price = null;
                    // Support CASH/Liquidité
                    if (t === 'CASH' || t === 'EUR') {
                        price = 1.0;
                    } else if (hist && hist[ts]) {
                        price = hist[ts];
                    } else {
                        if (lastKnownPrices.has(t)) price = lastKnownPrices.get(t);
                    }

                    if (price !== null) {
                        let rate = 1;
                        if (!isSingleAsset) {
                            const priceData = this.storage.getCurrentPrice(t);
                            const currency = priceData?.currency || 'EUR';
                            if (currency === 'USD') rate = dynamicRate;
                        }

                        currentTsTotalValue += price * qty * rate;
                        hasAtLeastOnePrice = true;
                        lastKnownPrices.set(t, price); // Keep store raw price for forward fill 
                        if (isSingleAsset) currentTsUnitPrice = price;
                    }
                }
                const investedAmount = assetInvested.get(t);
                totalInvested += investedAmount;
            }

            // CALCUL MODE RENTABILITÉ (ROI) pour cohérence Dashboard
            // Au lieu du TWR, on calcule (Valeur - Investi) / Investi
            // Cela assure que le dernier point correspond au KPI "Total Return"
            if (totalInvested > 0) {
                currentTWR = (currentTsTotalValue - totalInvested) / totalInvested;
                // On ajoute +1 pour matcher l'échelle de base 1.0 du graphique TWR précédent (ou on adapte)
                // Le chart attendait un facteur (ex: 1.10 pour +10%). 
                // ROI est 0.10. Donc TWR = 1 + ROI.
                currentTWR += 1.0;
            } else {
                currentTWR = 1.0;
            }

            twr.push(currentTWR);
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

        console.log(`[Return] yesterdayClose = ${yesterdayClose ? yesterdayClose.toFixed(2) : 'null'}`);

        return {
            labels,
            invested,
            values,
            yesterdayClose,
            unitPrices,
            purchasePoints,
            timestamps: displayTimestamps,
            twr,
            historicalDataMap
        };
    }
}
