// ========================================
// dataManager.js - Le cerveau des calculs (Unifié v3)
// ========================================

import { USD_TO_EUR_RATE, YAHOO_MAP } from './config.js'; 

export class DataManager {
    constructor(storage, api) {
        this.storage = storage;
        this.api = api;
    }

    /**
     * Calcule la liste agrégée et enrichie des actifs (pour la page Investissements)
     */
    calculateHoldings(filteredPurchases) {
        const aggregated = {};

        // 1. Agréger les achats par ticker
        filteredPurchases.forEach(p => {
            const t = p.ticker.toUpperCase();
            if (!aggregated[t]) {
                aggregated[t] = {
                    name: p.name,
                    assetType: p.assetType || 'Stock', // Ajout pour l'analyse
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

            const investedEUR = data.invested * rate;
            const avgPrice = (data.quantity > 0) ? data.invested / data.quantity : 0;
            const avgPriceEUR = avgPrice * rate;

            const currentValue = currentPrice ? currentPrice * data.quantity : null;
            const currentValueEUR = currentValue ? currentValue * rate : null;

            const gainEUR = currentValueEUR ? currentValueEUR - investedEUR : null;
            const gainPct = investedEUR > 0 && gainEUR ? (gainEUR / investedEUR) * 100 : null;

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
                assetType: data.assetType, // Ajout pour l'analyse
                quantity: data.quantity,
                avgPrice: avgPriceEUR,
                invested: investedEUR,
                currentPrice: currentPrice ? currentPrice * rate : null,
                currentValue: currentValueEUR,
                gainEUR,
                gainPct,
                dayChange,
                dayPct,
                weight: 0, // Sera calculé dans generateFullReport
                purchases: data.purchases
            };
        });

        return enriched;
    }

    /**
     * Calcule le résumé global du portefeuille (pour les cartes)
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

        const totalPreviousCloseEUR = totalCurrentEUR - totalDayChangeEUR;
        const dayChangePct = totalPreviousCloseEUR > 0
            ? (totalDayChangeEUR / totalPreviousCloseEUR) * 100
            : 0;

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

    /**
     * NOUVEAU: Calcule la liste enrichie des transactions (pour la page Transactions)
     * (Logique déplacée depuis achatsPage.js)
     */
    calculateEnrichedPurchases(filteredPurchases) {
        return filteredPurchases.map(p => {
            const t = p.ticker.toUpperCase();
            const d = this.storage.getCurrentPrice(t) || {};
            const assetCurrency = d.currency || p.currency || 'EUR';
            const currentPriceOriginal = d.price;
            const buyPriceOriginal = p.price;
            
            const rate = assetCurrency === 'USD' ? USD_TO_EUR_RATE : 1;

            const currentPriceEUR = currentPriceOriginal * rate;
            const buyPriceEUR = buyPriceOriginal * rate;
            
            const investedEUR = buyPriceEUR * p.quantity;
            const currentValueEUR = currentPriceEUR ? currentPriceEUR * p.quantity : null;
            const gainEUR = currentValueEUR !== null ? currentValueEUR - investedEUR : null;
            const gainPct = investedEUR > 0 && gainEUR !== null ? (gainEUR / investedEUR) * 100 : null;

            return {
                ...p,
                assetType: p.assetType || 'Stock',
                broker: p.broker || 'RV-CT',
                currency: assetCurrency,
                currentPriceOriginal,
                buyPriceOriginal,
                currentPriceEUR, // Note: c'est le prix unitaire en EUR
                investedEUR,     // Note: c'est l'investi total en EUR
                currentValueEUR, // Note: c'est la valeur totale en EUR
                gainEUR,
                gainPct
            };
        });
    }

    // ==========================================================
    // NOUVELLES FONCTIONS (DÉPLACÉES DE analytics.js)
    // ==========================================================

    /**
     * NOUVEAU: Génère le rapport complet pour la page Analytics
     */
    generateFullReport(purchases) {
        // 1. Calculer les holdings (actifs agrégés)
        const holdings = this.calculateHoldings(purchases);
        
        // 2. Calculer le résumé global (pour les KPIs)
        const summary = this.calculateSummary(holdings);

        // 3. Mettre à jour le poids (weight) de chaque actif
        holdings.forEach(asset => {
            asset.weight = summary.totalCurrentEUR > 0 
                ? (asset.currentValue / summary.totalCurrentEUR) * 100 
                : 0;
        });

        // 4. Calculer les métriques d'analyse
        const diversification = this.calculateDiversification(holdings);
        const performance = this.analyzePerformance(holdings);
        const risk = this.calculateRisk(holdings);

        return {
            summary: {
                totalValue: summary.totalCurrentEUR,
                totalInvested: summary.totalInvestedEUR,
                totalGain: summary.gainTotal,
                totalGainPct: summary.gainPct,
                dayChange: summary.totalDayChangeEUR,
                dayChangePct: summary.dayChangePct
            },
            diversification,
            performance,
            risk,
            assets: holdings, // holdings enrichis avec 'weight'
            generatedAt: new Date().toISOString()
        };
    }

    /**
     * NOUVEAU: Logique de 'analytics.js'
     */
    calculateDiversification(holdings) {
        // Indice de Herfindahl (concentration)
        const herfindahl = holdings.reduce((sum, asset) => 
            sum + Math.pow(asset.weight / 100, 2), 0
        );

        const effectiveAssets = herfindahl > 0 ? 1 / herfindahl : 0;
        const maxDiversity = holdings.length;
        const diversityScore = maxDiversity > 0
            ? (effectiveAssets / maxDiversity) * 100
            : 0;

        return {
            herfindahl: herfindahl.toFixed(4),
            effectiveAssets: effectiveAssets.toFixed(2),
            diversityScore: diversityScore.toFixed(1),
            totalAssets: holdings.length,
            recommendation: this.getDiversificationAdvice(diversityScore, holdings.length)
        };
    }

    getDiversificationAdvice(score, assetCount) {
        if (assetCount < 5) return 'Portfolio très concentré. Envisagez plus de diversification.';
        if (score < 30) return 'Diversification faible. Quelques actifs dominent.';
        if (score < 60) return 'Diversification moyenne. Peut être améliorée.';
        if (score < 80) return 'Bonne diversification du portfolio.';
        return 'Excellente diversification du portfolio.';
    }

    /**
     * NOUVEAU: Logique de 'analytics.js'
     */
    analyzePerformance(holdings) {
        const sorted = [...holdings].sort((a, b) => b.gainPct - a.gainPct);
        
        const winners = sorted.filter(a => a.gainPct > 0);
        const losers = sorted.filter(a => a.gainPct < 0);
        
        const avgGain = holdings.length > 0
            ? holdings.reduce((sum, a) => sum + (a.gainPct || 0), 0) / holdings.length
            : 0;

        const winRate = holdings.length > 0
            ? (winners.length / holdings.length) * 100
            : 0;

        return {
            topPerformers: sorted.slice(0, 3),
            worstPerformers: sorted.slice(-3).reverse(),
            winners: winners.length,
            losers: losers.length,
            avgGain: avgGain.toFixed(2),
            winRate: winRate.toFixed(1),
            summary: this.getPerformanceSummary(avgGain, winRate)
        };
    }
    
    getPerformanceSummary(avgGain, winRate) {
        if (avgGain > 10 && winRate > 70) return 'Performance exceptionnelle 🚀';
        if (avgGain > 5 && winRate > 60) return 'Très bonne performance 📈';
        if (avgGain > 0 && winRate > 50) return 'Performance positive ✅';
        if (avgGain > -5) return 'Performance stable ⚖️';
        return 'Performance en difficulté 📉';
    }

    /**
     * NOUVEAU: Logique de 'analytics.js'
     */
    calculateRisk(holdings) {
        if (holdings.length === 0) {
             return {
                volatility: '0.00',
                maxDrawdown: '0.00',
                sharpeRatio: '0.00',
                riskLevel: 'N/A',
                recommendation: 'Aucune donnée pour calculer le risque.'
            };
        }
        
        const returns = holdings.map(a => a.gainPct || 0);
        const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
        const variance = returns.reduce((sum, r) => 
            sum + Math.pow(r - avgReturn, 2), 0
        ) / returns.length;
        const volatility = Math.sqrt(variance);

        const maxDrawdown = Math.min(...returns.map(r => Math.min(r, 0)));
        const sharpeRatio = volatility > 0 ? avgReturn / volatility : 0;

        return {
            volatility: volatility.toFixed(2),
            maxDrawdown: maxDrawdown.toFixed(2),
            sharpeRatio: sharpeRatio.toFixed(2),
            riskLevel: this.getRiskLevel(volatility),
            recommendation: this.getRiskAdvice(volatility, maxDrawdown)
        };
    }

    getRiskLevel(volatility) {
        if (volatility < 5) return 'Faible';
        if (volatility < 15) return 'Modéré';
        if (volatility < 30) return 'Élevé';
        return 'Très élevé';
    }

    getRiskAdvice(volatility, maxDrawdown) {
        if (volatility > 30) {
            return 'Volatilité élevée. Considérez des actifs plus stables.';
        }
        if (maxDrawdown < -20) {
            return 'Certains actifs en forte perte. Réévaluez votre stratégie.';
        }
        return 'Profil de risque acceptable pour un portfolio diversifié.';
    }


    // ==========================================================
    // LOGIQUE DU GRAPHIQUE (Déjà présente et conservée)
    // ==========================================================

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

    async calculateGenericHistory(purchases, days, isSingleAsset = false) {
        // ... (TOUTE LA LOGIQUE EXISTANTE DE calculateGenericHistory RESTE ICI) ...
        // ... (Elle utilise déjà this.api.getHistoricalPricesWithRetry, c'est parfait)
        
        // (Copie de la logique existante pour être complet)
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
        dataStartUTC.setUTCDate(dataStartUTC.getUTCDate() - 5); 
        
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
        
        const lastKnownPrices = new Map();
        const allTsBefore = sortedTimestamps.filter(ts => ts < displayStartTs);
        const lastTsOverall = allTsBefore.length > 0 ? allTsBefore[allTsBefore.length - 1] : null;

        if (lastTsOverall !== null) {
            for (const t of tickers) {
                const hist = historicalDataMap.get(t);
                let price = this.findClosestPrice(hist, lastTsOverall, '1wk'); 
                if (price === null) {
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

            let currentTsTotalValue = 0;
            let totalInvested = 0;
            let hasAtLeastOnePrice = false; 

            for (const t of tickers) {
                const hist = historicalDataMap.get(t);
                const qty = assetQuantities.get(t);
                const inv = assetInvested.get(t);

                if (qty > 0) {
                    totalInvested += inv;
                    const price = this.findClosestPrice(hist, ts, interval);
                    
                    if (price !== null) {
                        lastKnownPrices.set(t, price);
                        currentTsTotalValue += price * qty;
                        hasAtLeastOnePrice = true;
                    } else {
                        const lastPrice = lastKnownPrices.get(t);
                        if (lastPrice !== undefined && lastPrice !== null) { 
                            currentTsTotalValue += lastPrice * qty;
                            hasAtLeastOnePrice = true; 
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
    // UTILITAIRES (Déjà présents et conservés)
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
        if (day === 0) result.setDate(result.getDate() - 2);
        else if (day === 6) result.setDate(result.getDate() - 1);
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
        const cryptos = ['ETH','SOL','ADA','DOT','LINK','LTC','XRP','XLM','BNB','AVAX'];
        return cryptos.includes(ticker) ? ticker + '-EUR' : ticker;
    }

    findClosestPrice(hist, targetTs, interval) {
        if (!hist || Object.keys(hist).length === 0) return null;
        if (hist[targetTs]) return hist[targetTs];
        
        let maxDiff;
        const threeDays = 3 * 24 * 60 * 60 * 1000; 

        if (interval === '5m') maxDiff = threeDays;
        else if (interval === '15m') maxDiff = threeDays;
        else if (interval === '30m') maxDiff = threeDays;
        else if (interval === '1h') maxDiff = threeDays;
        else if (interval === '1d') maxDiff = threeDays;
        else maxDiff = 8 * 24 * 60 * 60 * 1000;

        const timestamps = Object.keys(hist).map(Number).sort((a, b) => a - b);
        
        let closestTs = null;
        for (let i = timestamps.length - 1; i >= 0; i--) {
            if (timestamps[i] <= targetTs) {
                closestTs = timestamps[i];
                break;
            }
        }

        if (closestTs === null) {
            return null;
        }

        if ((targetTs - closestTs) > maxDiff) {
            return null;
        }

        return hist[closestTs];
    }
}