// ========================================
// dataManager.js - Le cerveau des calculs (Corrigé v2)
// ========================================

// Ajout de YAHOO_MAP pour les utilitaires
import { USD_TO_EUR_RATE, YAHOO_MAP } from './config.js'; 

export class DataManager {
    // Le constructeur a maintenant besoin de 'api'
    constructor(storage, api) {
        this.storage = storage;
        this.api = api;
    }

    /**
     * Calcule la liste agrégée et enrichie des actifs (pour le tableau)
     * à partir d'une liste d'achats (potentiellement filtrée).
     */
    calculateHoldings(filteredPurchases) {
        const aggregated = {};

        // 1. Agréger les achats par ticker
        filteredPurchases.forEach(p => {
            const t = p.ticker.toUpperCase();
            if (!aggregated[t]) {
                aggregated[t] = {
                    name: p.name,
                    quantity: 0,
                    invested: 0, // Investi dans la devise d'origine
                    purchases: []
                };
            }
            aggregated[t].quantity += p.quantity;
            aggregated[t].invested += p.price * p.quantity;
            aggregated[t].purchases.push(p);
        });

        // 2. Enrichir avec les données de marché
        const enriched = Object.entries(aggregated).map(([ticker, data]) => {
            const d = this.storage.getCurrentPrice(ticker) || {};
            const currency = d.currency || 'EUR';
            const currentPrice = d.price;
            const previousClose = d.previousClose;

            const rate = currency === 'USD' ? USD_TO_EUR_RATE : 1;

            // Investi en EUR
            const investedEUR = data.invested * rate;
            const avgPrice = data.invested / data.quantity;
            const avgPriceEUR = avgPrice * rate;

            // Valeur actuelle en EUR
            const currentValue = currentPrice ? currentPrice * data.quantity : null;
            const currentValueEUR = currentValue ? currentValue * rate : null;

            // P&L Total en EUR
            const gainEUR = currentValueEUR ? currentValueEUR - investedEUR : null;
            const gainPct = investedEUR > 0 && gainEUR ? (gainEUR / investedEUR) * 100 : null;

            // P&L du jour en EUR
            let dayChange = null;
            let dayPct = null;

            if (currentPrice && previousClose && previousClose > 0) {
                const dayChangeOriginal = (currentPrice - previousClose) * data.quantity;
                dayChange = dayChangeOriginal * rate;
                dayPct = ((currentPrice - previousClose) / previousClose) * 100;
            }

            return {
                ticker,
                name: data.name,
                quantity: data.quantity,
                avgPrice: avgPriceEUR,
                invested: investedEUR, // On stocke l'investi en EUR
                currentPrice: currentPrice ? currentPrice * rate : null,
                currentValue: currentValueEUR,
                gainEUR,
                gainPct,
                dayChange,
                dayPct,
                purchases: data.purchases
            };
        });

        return enriched;
    }

    /**
     * Calcule le résumé global du portefeuille (pour les cartes)
     * à partir de la liste des holdings *déjà calculée*.
     */
    calculateSummary(holdings) {
        let totalInvestedEUR = 0;
        let totalCurrentEUR = 0;
        let totalDayChangeEUR = 0;
        const assetPerformances = [];

        holdings.forEach(asset => {
            totalInvestedEUR += asset.invested || 0;
            totalCurrentEUR += asset.currentValue || 0;
            totalDayChangeEUR += asset.dayChange || 0;

            if (asset.currentValue !== null) {
                assetPerformances.push({
                    ticker: asset.ticker,
                    name: asset.name,
                    gainPct: asset.gainPct || 0,
                    gain: asset.gainEUR || 0
                });
            }
        });

        const gainTotal = totalCurrentEUR - totalInvestedEUR;
        const gainPct = totalInvestedEUR > 0 ? (gainTotal / totalInvestedEUR) * 100 : 0;

        // Calcul du % de variation du jour
        const totalPreviousCloseEUR = totalCurrentEUR - totalDayChangeEUR;
        const dayChangePct = totalPreviousCloseEUR > 0
            ? (totalDayChangeEUR / totalPreviousCloseEUR) * 100
            : 0;

        // Meilleur et pire performeur
        const sortedAssets = assetPerformances.sort((a, b) => b.gainPct - a.gainPct);
        const bestAsset = sortedAssets.length > 0 ? sortedAssets[0] : null;
        const worstAsset = sortedAssets.length > 0 ? sortedAssets[sortedAssets.length - 1] : null;

        return {
            totalInvestedEUR,
            totalCurrentEUR,
            totalDayChangeEUR,
            gainTotal,
            gainPct,
            dayChangePct,
            bestAsset,
            worstAsset,
            assetsCount: holdings.length,
            movementsCount: holdings.reduce((sum, h) => sum + h.purchases.length, 0)
        };
    }

    // ==========================================================
    // NOUVELLES FONCTIONS (DÉPLACÉES DE historicalChart.js)
    // ==========================================================

    /**
     * Calcule l'historique pour le graphique
     */
    async calculateHistory(purchases, days) {
        return this.calculateGenericHistory(purchases, days, false);
    }
    async calculateAssetHistory(ticker, days) {
        const purchases = this.storage.getPurchases().filter(p => p.ticker.toUpperCase() === ticker.toUpperCase());
        if (purchases.length === 0) return { labels: [], invested: [], values: [], yesterdayClose: null };
        return this.calculateGenericHistory(purchases, days, true);
    }
    async calculateMultipleAssetsHistory(purchases, days) {
        return this.calculateGenericHistory(purchases, days, false);
    }

    /**
     * Logique de calcul générique (anciennement dans historicalChart.js)
     */
    async calculateGenericHistory(purchases, days, isSingleAsset = false) {
        const assetMap = new Map();
        const ticker = isSingleAsset ? purchases[0].ticker.toUpperCase() : null;

        if (isSingleAsset) {
            assetMap.set(ticker, purchases.map(p => ({
                date: new Date(p.date),
                price: parseFloat(p.price),
                quantity: parseFloat(p.quantity)
            })));
        } else {
            purchases.forEach(p => {
                const t = p.ticker.toUpperCase();
                if (!assetMap.has(t)) assetMap.set(t, []);
                assetMap.get(t).push({
                    date: new Date(p.date),
                    price: parseFloat(p.price),
                    quantity: parseFloat(p.quantity)
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
        if (!firstPurchase) return { labels: [], invested: [], values: [], yesterdayClose: null };

        // Déterminer si le calcul concerne un crypto ou non
        const isCryptoOrGlobal = isSingleAsset ? this.isCryptoTicker(ticker) : true;

        const today = new Date();
        let effectiveDate = new Date(today);

        if (!isCryptoOrGlobal) {
            const day = today.getDay();
            if (day === 0 || day === 6) {
                effectiveDate = this.getLastTradingDay(today);
            }
        }

        const todayUTC = new Date(Date.UTC(
            effectiveDate.getFullYear(),
            effectiveDate.getMonth(),
            effectiveDate.getDate(),
            23, 59, 59, 999
        ));

        let displayStartUTC;
        let displayDate = new Date(effectiveDate);

        if (days === 1) {
            displayStartUTC = new Date(Date.UTC(displayDate.getFullYear(), displayDate.getMonth(), displayDate.getDate(), 0, 0, 0));
        } else if (days === 2) {
            const twoDaysAgo = new Date(displayDate);
            twoDaysAgo.setDate(twoDaysAgo.getDate() - 1);
            displayStartUTC = new Date(Date.UTC(twoDaysAgo.getFullYear(), twoDaysAgo.getMonth(), twoDaysAgo.getDate(), 0, 0, 0));
        } else if (days !== 'all') {
            const localDisplay = new Date(displayDate);
            localDisplay.setDate(localDisplay.getDate() - (days - 1));
            displayStartUTC = new Date(Date.UTC(localDisplay.getFullYear(), localDisplay.getMonth(), localDisplay.getDate()));
            if (displayStartUTC < firstPurchase) displayStartUTC = new Date(firstPurchase);
        } else {
            displayStartUTC = new Date(firstPurchase);
        }

        let dataStartUTC = new Date(displayStartUTC);
        
        // === CORRECTION DU BUG 2D / WEEKEND (LIGNE 183) ===
        // On remonte 5 jours en arrière au lieu de 1, pour être
        // sûr de récupérer le dernier prix de clôture (ex: un vendredi)
        // si le graphique démarre un lundi.
        dataStartUTC.setUTCDate(dataStartUTC.getUTCDate() - 5); // Anciennement -1
        // === FIN DE LA CORRECTION ===
        
        const startTs = Math.floor(dataStartUTC.getTime() / 1000);
        const endTs = Math.floor(todayUTC.getTime() / 1000);
        
        const interval = this.getIntervalForPeriod(days); 
        const labelFormat = this.getLabelFormat(days);
        const historicalDataMap = new Map();
        const tickers = isSingleAsset ? [ticker] : Array.from(assetMap.keys());
        const batchSize = 3;

        for (let i = 0; i < tickers.length; i += batchSize) {
            const batch = tickers.slice(i, i + batchSize);
            await Promise.all(batch.map(async (t) => {
                try {
                    // ON UTILISE this.api MAINTENANT !
                    const hist = await this.api.getHistoricalPricesWithRetry(t, startTs, endTs, interval);
                    historicalDataMap.set(t, hist);
                } catch (err) {
                    historicalDataMap.set(t, {});
                }
            }));
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
        let yesterdayClose = null;
        const allTimestamps = new Set();
        historicalDataMap.forEach(hist => {
            Object.keys(hist).forEach(ts => allTimestamps.add(parseInt(ts)));
        });
        const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);
        const displayStartTs = displayStartUTC.getTime();
        const displayTimestamps = sortedTimestamps.filter(ts => ts >= displayStartTs);

        // On ne calcule "yesterdayClose" QUE pour la vue 1D.
        if (days === 1 && sortedTimestamps.length > 0) {
            const beforeDisplayTs = sortedTimestamps.filter(ts => ts < displayStartTs);
            if (beforeDisplayTs.length > 0) {
                const lastTsBeforeDisplay = beforeDisplayTs[beforeDisplayTs.length - 1];
                let totalYesterday = 0;
                let assetsFound = 0;
                for (const t of tickers) {
                    const hist = historicalDataMap.get(t);
                    const qty = assetQuantities.get(t);
                    if (qty > 0) {
                        // Utilisation de la logique "stricte" (v4.9)
                        const price = this.findClosestPrice(hist, lastTsBeforeDisplay, interval); 
                        if (price !== null) {
                            totalYesterday += price * qty;
                            assetsFound++;
                        }
                    }
                }
                if (assetsFound > 0) yesterdayClose = totalYesterday;
            }
        }
        
        // Logique "Hybride" (v4.8)
        const lastKnownPrices = new Map();
        
        // On pré-remplit avec la valeur juste avant le début du graphique
        const allTsBefore = sortedTimestamps.filter(ts => ts < displayStartTs);
        const lastTsOverall = allTsBefore.length > 0 ? allTsBefore[allTsBefore.length - 1] : null;

        if (lastTsOverall !== null) {
            // Pre-fill lastKnownPrices with the closing price
            for (const t of tickers) {
                const hist = historicalDataMap.get(t);
                
                // On utilise une recherche "permissive" ('1wk') pour le pré-remplissage
                let price = this.findClosestPrice(hist, lastTsOverall, '1wk'); 
                
                if (price === null) {
                    // Si cela échoue, on cherche le dernier prix de cet actif
                    const tickerTimestamps = Object.keys(hist).map(Number).filter(ts => ts < displayStartTs);
                    if (tickerTimestamps.length > 0) {
                        const lastTickerTs = tickerTimestamps[tickerTimestamps.length - 1];
                        price = this.findClosestPrice(hist, lastTickerTs, '1wk');
                    }
                }

                if (price !== null) {
                    lastKnownPrices.set(t, price);
                }
            }
        }
        
        for (const ts of displayTimestamps) {
            let tsChangedInvested = false;
            for (const [t, buyList] of assetMap.entries()) {
                for (const buy of buyList) {
                    
                    const currentIndex = displayTimestamps.indexOf(ts);
                    const prevTs = (currentIndex === 0) ? displayStartUTC.getTime() : displayTimestamps[currentIndex - 1];
                    
                    if (buy.date.getTime() > prevTs && buy.date.getTime() <= ts) {
                        assetQuantities.set(t, assetQuantities.get(t) + buy.quantity);
                        assetInvested.set(t, assetInvested.get(t) + (buy.price * buy.quantity));
                        tsChangedInvested = true;
                    }
                }
            }

            let currentTsTotalValue = 0; // La valeur pour ce point
            let totalInvested = 0;
            let hasAtLeastOnePrice = false; // Flag pour savoir si on a au moins une valeur

            for (const t of tickers) {
                const hist = historicalDataMap.get(t);
                const qty = assetQuantities.get(t);
                const inv = assetInvested.get(t);

                if (qty > 0) {
                    totalInvested += inv;
                    
                    // On utilise la logique "stricte" (v4.9)
                    const price = this.findClosestPrice(hist, ts, interval);
                    
                    if (price !== null) {
                        // Prix trouvé ! On met à jour le dernier prix connu et on l'ajoute.
                        lastKnownPrices.set(t, price);
                        currentTsTotalValue += price * qty;
                        hasAtLeastOnePrice = true;
                    } else {
                        // Prix MANQUANT (périmé). On utilise le dernier prix connu pour CE ticker.
                        const lastPrice = lastKnownPrices.get(t);
                        if (lastPrice !== undefined && lastPrice !== null) { 
                            // On a un ancien prix, on l'utilise
                            currentTsTotalValue += lastPrice * qty;
                            hasAtLeastOnePrice = true; 
                        } else {
                            // Cet actif n'a jamais eu de prix.
                        }
                    }
                }
            }
            
            if (hasAtLeastOnePrice || tsChangedInvested) {
                labels.push(labelFormat(ts));
                invested.push(totalInvested);
                values.push(currentTsTotalValue);
            }
        }
        
        return { labels, invested, values, yesterdayClose };
    }

    // ==========================================================
    // NOUVELLES FONCTIONS UTILITAIRES (DÉPLACÉES)
    // ==========================================================

    getIntervalForPeriod(days) {
        if (days === 1) return '5m';
        if (days === 2) return '15m';
        if (days <= 7) return '30m';
        if (days <= 30) return '1h';
        if (days <= 90) return '1d';
        if (days <= 180) return '1d';
        if (days <= 365) return '1d';
        return '1wk';
    }

    getLabelFormat(days) {
        return (dateUTC) => {
            const local = new Date(dateUTC);
            if (days === 1 || days === 2) return local.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            if (days <= 7) return local.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
            if (days <= 30) return local.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
            if (days <= 365) return local.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
            return local.toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });
        };
    }

    getLastTradingDay(date) {
        const day = date.getDay();
        const result = new Date(date);
        if (day === 0) result.setDate(result.getDate() - 2); // Dimanche -> Vendredi
        else if (day === 6) result.setDate(result.getDate() - 1); // Samedi -> Vendredi
        return result;
    }

    isCryptoTicker(ticker) {
        const cryptoList = ['BTC','ETH','SOL','ADA','DOT','LINK','LTC','XRP','XLM','BNB','AVAX','DOGE','SHIB','MATIC','UNI','AAVE'];
        ticker = ticker.toUpperCase();
        return cryptoList.includes(ticker) || ticker.includes('-EUR') || ticker.includes('-USD');
    }

    formatTicker(ticker) {
        ticker = ticker.toUpperCase().trim();
        if (YAHOO_MAP[ticker]) return YAHOO_MAP[ticker];
        // Logique simplifiée de l'original, peut nécessiter ajustement
        const cryptos = ['ETH','SOL','ADA','DOT','LINK','LTC','XRP','XLM','BNB','AVAX'];
        return cryptos.includes(ticker) ? ticker + '-EUR' : ticker;
    }

    //
    // C'est la fonction "stricte" de la v4.5, qui est la bonne.
    //
    findClosestPrice(hist, targetTs, interval) { // Ajout de 'interval'
        if (!hist || Object.keys(hist).length === 0) return null;
        if (hist[targetTs]) return hist[targetTs]; // Correspondance exacte
        
        // Définition de la tolérance (à quel point un prix peut être "vieux")
        let maxDiff;
        const threeDays = 3 * 24 * 60 * 60 * 1000; // Tolérance pour survivre au week-end

        // ==========================================================
        // === CORRECTION APPLIQUÉE (POUR 2D / 1M / ETC.) ===
        // ==========================================================
        
        // Les intervalles intraday DOIVENT avoir une tolérance
        // suffisante pour survivre à un week-end (au moins 3 jours).
        
        if (interval === '5m') maxDiff = threeDays; // Anciennement 10 min
        else if (interval === '15m') maxDiff = threeDays; // Anciennement 30 min
        else if (interval === '30m') maxDiff = threeDays; // Anciennement 1 heure
        else if (interval === '1h') maxDiff = threeDays; // Anciennement 2 heures
        
        // ==========================================================
        // === FIN DE LA CORRECTION ===
        // ==========================================================
        
        else if (interval === '1d') maxDiff = threeDays; // 3 jours (pour les weekends)
        else maxDiff = 8 * 24 * 60 * 60 * 1000; // 8 jours (pour '1wk' et pré-remplissage)

        const timestamps = Object.keys(hist).map(Number).sort((a, b) => a - b);
        
        // Trouver le prix juste avant
        let closestTs = null;
        for (let i = timestamps.length - 1; i >= 0; i--) {
            if (timestamps[i] <= targetTs) {
                closestTs = timestamps[i];
                break;
            }
        }

        if (closestTs === null) {
            // Si pas de prix avant, on ne peut rien faire
            return null;
        }

        // NOUVEAU: Vérifier si ce prix est trop vieux
        if ((targetTs - closestTs) > maxDiff) {
            return null; // Oui, le prix est "périmé"
        }

        // C'est un prix valide et suffisamment récent
        return hist[closestTs];
    }
}