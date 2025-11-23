// ========================================
// dataManager.js - (v25 - Ajout Calcul TWR)
// ========================================

import { USD_TO_EUR_FALLBACK_RATE, YAHOO_MAP } from './config.js'; 
import { parseDate } from './utils.js';

export class DataManager {
    constructor(storage, api) {
        this.storage = storage;
        this.api = api;
    }

    // ... (calculateCashReserve, calculateHoldings, calculateSummary, calculateEnrichedPurchases, generateFullReport inchangés) ...
    
    calculateCashReserve(allPurchases) {
        const cashMovements = allPurchases.filter(p => p.assetType === 'Cash');
        const byBroker = {};
        let total = 0;
        cashMovements.forEach(move => {
            const broker = move.broker || 'Unknown';
            if (!byBroker[broker]) byBroker[broker] = 0;
            byBroker[broker] += move.price;
            total += move.price;
        });
        return { total, byBroker };
    }

    calculateHoldings(assetPurchases) {
        const aggregated = {};
        const dynamicRate = this.storage.getConversionRate('USD_TO_EUR') || USD_TO_EUR_FALLBACK_RATE;

        assetPurchases.forEach(p => {
            const t = p.ticker.toUpperCase();
            if (!aggregated[t]) {
                aggregated[t] = {
                    name: p.name,
                    assetType: p.assetType || 'Stock',
                    quantity: 0,
                    invested: 0, 
                    purchases: []
                };
            }
            aggregated[t].quantity += p.quantity;
            aggregated[t].invested += p.price * p.quantity;
            aggregated[t].purchases.push(p);
        });

        const enriched = Object.entries(aggregated).map(([ticker, data]) => {
            const d = this.storage.getCurrentPrice(ticker) || {};
            const currency = d.currency || 'EUR';
            const currentPrice = d.price;
            const previousClose = d.previousClose;

            const rate = currency === 'USD' ? dynamicRate : 1;

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
                assetType: data.assetType,
                quantity: data.quantity,
                avgPrice: avgPriceEUR,
                invested: investedEUR,
                currentPrice: currentPrice ? currentPrice * rate : null,
                currentValue: currentValueEUR,
                gainEUR,
                gainPct,
                dayChange,
                dayPct,
                weight: 0, 
                purchases: data.purchases
            };
        });

        return enriched;
    }

calculateSummary(holdings) {
        let totalInvestedEUR = 0;
        let totalCurrentEUR = 0;
        let totalDayChangeEUR = 0;
        const assetTotalPerformances = [];
        const assetDayPerformances = [];
        
        // Pour le calcul des secteurs
        const sectorStats = {}; 

        holdings.forEach(asset => {
            totalInvestedEUR += asset.invested || 0;
            totalCurrentEUR += asset.currentValue || 0;
            totalDayChangeEUR += asset.dayChange || 0;

            // Calcul par secteur
            const type = asset.assetType || 'Other';
            if (!sectorStats[type]) {
                sectorStats[type] = { value: 0, name: type };
            }
            sectorStats[type].value += (asset.currentValue || 0);

            if (asset.currentValue !== null) {
                assetTotalPerformances.push({
                    ticker: asset.ticker,
                    name: asset.name,
                    gainPct: asset.gainPct || 0,
                    gain: asset.gainEUR || 0
                });
                
                assetDayPerformances.push({
                    ticker: asset.ticker,
                    name: asset.name,
                    dayPct: asset.dayPct || 0,
                    dayChange: asset.dayChange || 0
                });
            }
        });

        // Trouver le Top Sector
        let bestSector = { name: '-', value: 0, pct: 0 };
        if (totalCurrentEUR > 0) {
            let maxVal = -1;
            Object.values(sectorStats).forEach(s => {
                if (s.value > maxVal) {
                    maxVal = s.value;
                    bestSector = {
                        name: s.name,
                        value: s.value,
                        pct: (s.value / totalCurrentEUR) * 100
                    };
                }
            });
        }

        const gainTotal = totalCurrentEUR - totalInvestedEUR;
        const gainPct = totalInvestedEUR > 0 ? (gainTotal / totalInvestedEUR) * 100 : 0;

        const totalPreviousCloseEUR = totalCurrentEUR - totalDayChangeEUR;
        const dayChangePct = totalPreviousCloseEUR > 0
            ? (totalDayChangeEUR / totalPreviousCloseEUR) * 100
            : 0;

        const sortedTotal = assetTotalPerformances.sort((a, b) => b.gainPct - a.gainPct);
        const bestAsset = sortedTotal.length > 0 ? sortedTotal[0] : null;
        const worstAsset = sortedTotal.length > 0 ? sortedTotal[sortedTotal.length - 1] : null;
        
        const sortedDay = assetDayPerformances.sort((a, b) => b.dayPct - a.dayPct);
        const bestDayAsset = sortedDay.length > 0 ? sortedDay[0] : null;
        const worstDayAsset = sortedDay.length > 0 ? sortedDay[sortedDay.length - 1] : null;

        return {
            totalInvestedEUR,
            totalCurrentEUR,
            totalDayChangeEUR,
            gainTotal,
            gainPct,
            dayChangePct,
            bestAsset,
            worstAsset,
            bestDayAsset,
            worstDayAsset,
            topSector: bestSector, // Maintenant un objet complet
            assetsCount: holdings.length,
            movementsCount: holdings.reduce((sum, h) => sum + h.purchases.length, 0)
        };
    }
    calculateEnrichedPurchases(filteredPurchases) {
        const dynamicRate = this.storage.getConversionRate('USD_TO_EUR') || USD_TO_EUR_FALLBACK_RATE;
        
        return filteredPurchases.map(p => {
            if (p.assetType === 'Cash') {
                return {
                    ...p,
                    currency: 'EUR',
                    currentPriceOriginal: null,
                    buyPriceOriginal: p.price,
                    currentPriceEUR: null, 
                    investedEUR: null,     
                    currentValueEUR: null, 
                    gainEUR: p.price, 
                    gainPct: null
                };
            }

            const t = p.ticker.toUpperCase();
            const d = this.storage.getCurrentPrice(t) || {};
            const assetCurrency = d.currency || p.currency || 'EUR';
            const currentPriceOriginal = d.price;
            const buyPriceOriginal = p.price;
            
            const rate = assetCurrency === 'USD' ? dynamicRate : 1;

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
                currentPriceEUR, 
                investedEUR,     
                currentValueEUR, 
                gainEUR,
                gainPct
            };
        });
    }

    generateFullReport(purchases) {
        const assetPurchases = purchases.filter(p => p.assetType !== 'Cash');
        const cashPurchases = purchases.filter(p => p.assetType === 'Cash');
        const holdings = this.calculateHoldings(assetPurchases);
        const summary = this.calculateSummary(holdings);
        const cashReserve = this.calculateCashReserve(cashPurchases);
        holdings.forEach(asset => {
            asset.weight = summary.totalCurrentEUR > 0 ? (asset.currentValue / summary.totalCurrentEUR) * 100 : 0;
        });
        return {
            summary: {
                totalValue: summary.totalCurrentEUR,
                totalInvested: summary.totalInvestedEUR,
                totalGain: summary.gainTotal,
                totalGainPct: summary.gainPct,
                dayChange: summary.totalDayChangeEUR,
                dayChangePct: summary.dayChangePct,
                cashReserve: cashReserve.total
            },
            diversification: this.calculateDiversification(holdings),
            performance: this.analyzePerformance(holdings),
            risk: this.calculateRisk(holdings),
            assets: holdings, 
            generatedAt: new Date().toISOString()
        };
    }
    calculateDiversification(holdings) {
        const herfindahl = holdings.reduce((sum, asset) => sum + Math.pow(asset.weight / 100, 2), 0);
        const effectiveAssets = herfindahl > 0 ? 1 / herfindahl : 0;
        const maxDiversity = holdings.length;
        const diversityScore = maxDiversity > 0 ? (effectiveAssets / maxDiversity) * 100 : 0;
        return { herfindahl: herfindahl.toFixed(4), effectiveAssets: effectiveAssets.toFixed(2), diversityScore: diversityScore.toFixed(1), totalAssets: holdings.length, recommendation: this.getDiversificationAdvice(diversityScore, holdings.length) };
    }
    getDiversificationAdvice(score, assetCount) {
        if (assetCount < 5) return 'Portfolio très concentré.';
        if (score < 30) return 'Diversification faible.';
        if (score < 60) return 'Diversification moyenne.';
        if (score < 80) return 'Bonne diversification.';
        return 'Excellente diversification.';
    }
    analyzePerformance(holdings) {
        const sorted = [...holdings].sort((a, b) => b.gainPct - a.gainPct);
        const winners = sorted.filter(a => a.gainPct > 0);
        const losers = sorted.filter(a => a.gainPct < 0);
        const avgGain = holdings.length > 0 ? holdings.reduce((sum, a) => sum + (a.gainPct || 0), 0) / holdings.length : 0;
        const winRate = holdings.length > 0 ? (winners.length / holdings.length) * 100 : 0;
        return { topPerformers: sorted.slice(0, 3), worstPerformers: sorted.slice(-3).reverse(), winners: winners.length, losers: losers.length, avgGain: avgGain.toFixed(2), winRate: winRate.toFixed(1), summary: 'Performance analysée' };
    }
    calculateRisk(holdings) {
        if (holdings.length === 0) return { volatility: '0.00', maxDrawdown: '0.00', riskLevel: 'N/A', recommendation: 'Aucune donnée.' };
        const returns = holdings.map(a => a.gainPct || 0);
        const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
        const volatility = Math.sqrt(variance);
        const maxDrawdown = Math.min(...returns.map(r => Math.min(r, 0)));
        return { volatility: volatility.toFixed(2), maxDrawdown: maxDrawdown.toFixed(2), riskLevel: volatility < 15 ? 'Faible' : 'Élevé', recommendation: 'Risque calculé' };
    }

    async calculateHistory(purchases, days) {
        const assetPurchases = purchases.filter(p => p.assetType !== 'Cash');
        return this.calculateGenericHistory(assetPurchases, days, false);
    }
    
    async calculateAssetHistory(ticker, days) {
        const purchases = this.storage.getPurchases().filter(p => p.ticker.toUpperCase() === ticker.toUpperCase());
        if (purchases.length === 0) return { labels: [], invested: [], values: [], yesterdayClose: null, unitPrices: [], purchasePoints: [] };
        return this.calculateGenericHistory(purchases, days, true);
    }

    // === FONCTION COEUR (Avec Calcul TWR) ===
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
        const isCrypto = this.isCryptoTicker(sampleTicker || '');
        const isWeekend = today.getDay() === 0 || today.getDay() === 6; 

        let displayStartUTC;
        let bufferDays = 30;
        let hardStopEndTs = null; 

        if (!isCrypto && isWeekend && (days === 1 || days === 2)) {
            const daysToGoBack = today.getDay() === 0 ? 2 : 1; 
            const lastTradingDay = new Date(today);
            lastTradingDay.setDate(today.getDate() - daysToGoBack);
            lastTradingDay.setHours(23, 59, 59, 999);
            hardStopEndTs = lastTradingDay.getTime();
            const startTradingDay = new Date(lastTradingDay);
            startTradingDay.setHours(0, 0, 0, 0);
            if (days === 2) startTradingDay.setDate(startTradingDay.getDate() - 1);
            displayStartUTC = new Date(Date.UTC(startTradingDay.getFullYear(), startTradingDay.getMonth(), startTradingDay.getDate(), 0, 0, 0));
            bufferDays = 5; 
        } else {
            if (days === 1) {
                displayStartUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0));
                bufferDays = 2; 
            } else if (days === 2) {
                const twoDaysAgo = new Date(today);
                twoDaysAgo.setDate(twoDaysAgo.getDate() - 1);
                displayStartUTC = new Date(Date.UTC(twoDaysAgo.getFullYear(), twoDaysAgo.getMonth(), twoDaysAgo.getDate(), 0, 0, 0));
                bufferDays = 5; 
            } else if (days !== 'all') {
                const localDisplay = new Date(today);
                localDisplay.setDate(localDisplay.getDate() - (days - 1));
                displayStartUTC = new Date(Date.UTC(localDisplay.getFullYear(), localDisplay.getMonth(), localDisplay.getDate()));
                if (displayStartUTC < firstPurchase) displayStartUTC = new Date(firstPurchase);
            } else {
                displayStartUTC = new Date(firstPurchase);
            }
        }

        let dataStartUTC = new Date(displayStartUTC);
        dataStartUTC.setUTCDate(dataStartUTC.getUTCDate() - bufferDays); 
        
        const startTs = Math.floor(dataStartUTC.getTime() / 1000);
        const endTs = Math.floor(todayUTC.getTime() / 1000);
        
        const interval = this.getIntervalForPeriod(days); 
        const labelFormat = this.getLabelFormat(days);
        
        const historicalDataMap = new Map();
        const tickers = Array.from(assetMap.keys());
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
        const unitPrices = [];
        const purchasePoints = [];
        const twr = []; // === NOUVEAU TABLEAU TWR ===
        
        const allTimestamps = new Set();
        historicalDataMap.forEach(hist => {
            Object.keys(hist).forEach(ts => allTimestamps.add(parseInt(ts)));
        });
        let sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);
        
        let yesterdayClose = null; 
        const referenceStartTs = displayStartUTC.getTime();
        const allTimestampsBeforeStart = sortedTimestamps.filter(ts => ts < referenceStartTs);

        if (allTimestampsBeforeStart.length > 0) {
            const lastTsBeforeToday = allTimestampsBeforeStart[allTimestampsBeforeStart.length - 1];
            let totalYesterdayValue = 0;
            let assetsFound = 0;
            const lastDayQuantities = new Map();
            for (const t of tickers) lastDayQuantities.set(t, 0);
            for (const [t, buyList] of assetMap.entries()) {
                for (const buy of buyList) {
                    if (buy.date.getTime() <= lastTsBeforeToday) {
                        lastDayQuantities.set(t, lastDayQuantities.get(t) + buy.quantity);
                    }
                }
            }
            for (const t of tickers) {
                const hist = historicalDataMap.get(t);
                const qty = lastDayQuantities.get(t);
                if (qty > 0) {
                    const price = this.findClosestPrice(hist, lastTsBeforeToday, '1wk');
                    if (price !== null) {
                        totalYesterdayValue += price * qty;
                        assetsFound++;
                    }
                }
            }
            if (assetsFound > 0) yesterdayClose = totalYesterdayValue;
        }
        
        const displayStartTs = displayStartUTC.getTime();
        let displayEndTs;
        if (hardStopEndTs) displayEndTs = hardStopEndTs;
        else if (days === 1) displayEndTs = displayStartTs + (24 * 60 * 60 * 1000);
        else displayEndTs = Infinity;
        
        let displayTimestamps = sortedTimestamps.filter(ts => ts >= displayStartTs && ts <= displayEndTs);

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
                if (price !== null) lastKnownPrices.set(t, price);
            }
        }
        
        // === VARIABLES POUR CALCUL TWR ===
        let previousTotalValue = 0; // Valeur de la veille
        let currentTWR = 1.0;       // TWR cumulé (Base 1)
        
        for (let i = 0; i < displayTimestamps.length; i++) {
            const ts = displayTimestamps[i];
            let tsChangedInvested = false;
            const prevTs = (i === 0) ? displayStartUTC.getTime() - 1 : displayTimestamps[i - 1];

            // 1. Mise à jour des quantités (Achats/Ventes)
            let cashFlow = 0; // Flux de trésorerie sur cette période
            
            for (const [t, buyList] of assetMap.entries()) {
                for (const buy of buyList) {
                    if (buy.date.getTime() > prevTs && buy.date.getTime() <= ts) {
                        assetQuantities.set(t, assetQuantities.get(t) + buy.quantity);
                        const flow = buy.price * buy.quantity;
                        assetInvested.set(t, assetInvested.get(t) + flow);
                        cashFlow += flow; // On enregistre le flux
                        tsChangedInvested = true;
                    }
                }
            }

            // 2. Calcul Valeur Totale
            let currentTsTotalValue = 0;
            let totalInvested = 0;
            let hasAtLeastOnePrice = false;
            let currentTsUnitPrice = null; 

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
                        if (isSingleAsset) currentTsUnitPrice = price;
                    } else {
                        const lastPrice = lastKnownPrices.get(t);
                        if (lastPrice !== undefined && lastPrice !== null) {
                            currentTsTotalValue += lastPrice * qty;
                            hasAtLeastOnePrice = true; 
                            if (isSingleAsset) currentTsUnitPrice = lastPrice;
                        }
                    }
                }
            }
            
            // 3. Calcul TWR (Time-Weighted Return)
            // TWR isole la performance du marché en ignorant les cashflows
            if (i > 0 && previousTotalValue > 0) {
                // Formule : (Valeur Fin - CashFlow) / Valeur Début
                // On retire le cashflow de la valeur finale pour voir la "performance pure" du capital qui était là au début
                const periodReturn = (currentTsTotalValue - cashFlow - previousTotalValue) / previousTotalValue;
                currentTWR = currentTWR * (1 + periodReturn);
            }
            twr.push(currentTWR);
            previousTotalValue = currentTsTotalValue; // Prépare pour le tour suivant

            const label = labelFormat(ts);
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

            let maxToleranceMs;
            if (days === 1) maxToleranceMs = 2 * 60 * 60 * 1000; 
            else if (days <= 7) maxToleranceMs = 12 * 60 * 60 * 1000; 
            else maxToleranceMs = 4 * 24 * 60 * 60 * 1000; 

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
        
        return { 
            labels, 
            invested, 
            values, 
            yesterdayClose, 
            unitPrices, 
            purchasePoints,
            timestamps: displayTimestamps,
            twr // Ajouté à l'objet de retour
        };
    }

    // ... (getIntervalForPeriod, getLabelFormat, getLastTradingDay, isCryptoTicker, formatTicker, findClosestPrice inchangés) ...
	getIntervalForPeriod(days) {
		if (days === 1) return '5m';
		if (days === 2) return '15m';
		if (days <= 7) return '90m';
		if (days <= 30) return '1d';
		if (days <= 90) return '1d';
		if (days <= 180) return '1d';
		if (days <= 365) return '1d';
		return '1d';
	}

	getLabelFormat(days) {
		return (dateUTC) => {
			const local = new Date(dateUTC);
			if (days === 1) return local.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
			if (days <= 7) return local.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
			return local.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });
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
        if (interval === '5m' || interval === '15m' || interval === '90m') maxDiff = 7 * 24 * 60 * 60 * 1000; 
        else maxDiff = 10 * 24 * 60 * 60 * 1000;
        const timestamps = Object.keys(hist).map(Number).sort((a, b) => a - b);
        let closestTs = null;
        for (let i = timestamps.length - 1; i >= 0; i--) {
            if (timestamps[i] <= targetTs) {
                closestTs = timestamps[i];
                break;
            }
        }
        if (closestTs === null) return null;
        if ((targetTs - closestTs) > maxDiff) return null;
        return hist[closestTs];
    }
}