// ========================================
// dataManager.js - (v8 - Ajout support Indices)
// ========================================

import { USD_TO_EUR_FALLBACK_RATE, YAHOO_MAP } from './config.js';
import { parseDate } from './utils.js';
import { HistoryCalculator } from './HistoryCalculator.js?v=3';
import { db, auth } from './firebaseConfig.js';
import {
    getIntervalForPeriod,
    getLabelFormat,
    getLastTradingDay,
    isCryptoTicker,
    formatTicker,
    findClosestPrice
} from './MarketUtils.js';

export class DataManager {
    constructor(storage, api) {
        this.storage = storage;
        this.api = api;
        this.historyCalculator = new HistoryCalculator(storage, api);
    }

    // === HELPERS DELEGATION (Compatibilité Legacy) ===
    isCryptoTicker(ticker) { return isCryptoTicker(ticker); }
    formatTicker(ticker) { return formatTicker(ticker); }
    getIntervalForPeriod(days) { return getIntervalForPeriod(days); }
    getLastTradingDay(date) { return getLastTradingDay(date); }

    // Nouvelle fonction pour calculer yesterdayClose de tous les actifs
    async calculateAllAssetsYesterdayClose(assetPurchases) {
        // Reconstruction des définitions manquantes suite à corruption
        const tickers = [...new Set(assetPurchases.map(p => p.ticker.toUpperCase()))];
        const yesterdayCloseMap = new Map();

        console.log(`[calculateAllAssetsYesterdayClose] Calculating for ${tickers.length} assets: `, tickers);

        // Calculer l'historique 1D de chaque actif en parallèle (par batch de 3)
        const batchSize = 3;
        for (let i = 0; i < tickers.length; i += batchSize) {
            const batch = tickers.slice(i, i + batchSize);
            const promises = batch.map(async ticker => {
                try {
                    const graphData = await this.calculateAssetHistory(ticker, 1);
                    if (graphData && graphData.yesterdayClose !== null && graphData.yesterdayClose !== undefined) {
                        yesterdayCloseMap.set(ticker, {
                            yesterdayClose: graphData.yesterdayClose,
                            todayValueOfYesterdayHoldings: graphData.todayValueOfYesterdayHoldings ?? null
                        });
                        console.log(`[✓] ${ticker}: yesterdayClose = ${graphData.yesterdayClose.toFixed(2)}, todayYestQty = ${graphData.todayValueOfYesterdayHoldings?.toFixed(2) ?? 'n/a'}`);
                    } else {
                        console.warn(`[✗] ${ticker}: No yesterdayClose in graphData`, graphData);
                    }
                } catch (error) {
                    console.warn(`Failed to calculate yesterdayClose for ${ticker}: `, error);
                }
            });
            await Promise.all(promises);
        }

        console.log(`[calculateAllAssetsYesterdayClose] Completed. Map size: ${yesterdayCloseMap.size}/${tickers.length}`);
        return yesterdayCloseMap;
    }

    calculateCashReserve(allPurchases) {
        // Include Dividends in Cash Reserve calculation
        // CRITICAL FIX: Exclude sale transactions (negative quantity assets)
        // Sale creates 2 lines: 1) asset with qty=-1000, 2) cash with price=+75€
        // We only want the cash line, not the asset sale line
        const cashMovements = allPurchases.filter(p => {
            const type = (p.assetType || 'Stock').toLowerCase();
            const isCashOrDiv = type === 'cash' || type === 'dividend' || p.type === 'dividend';

            // If it's a cash/dividend type, include it
            if (isCashOrDiv) return true;

            // Otherwise, exclude it (it's a sale transaction with negative quantity)
            return false;
        });

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

    calculateHoldings(assetPurchases, yesterdayCloseMap = null) {
        const aggregated = {};
        const dynamicRate = this.storage.getConversionRate('USD_TO_EUR') || USD_TO_EUR_FALLBACK_RATE;

        // 1. TRIER PAR DATE
        assetPurchases.sort((a, b) => new Date(a.date) - new Date(b.date));

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

            const currency = p.currency || 'EUR';
            const rate = currency === 'USD' ? dynamicRate : 1;

            if (p.quantity > 0) {
                // ACHAT
                aggregated[t].quantity += p.quantity;
                aggregated[t].invested += p.price * p.quantity * rate;
            } else {
                // VENTE
                const sellQty = Math.abs(p.quantity);
                const currentQty = aggregated[t].quantity;

                if (currentQty > 0) {
                    const ratio = sellQty / currentQty;
                    aggregated[t].invested -= (aggregated[t].invested * ratio);
                    aggregated[t].quantity -= sellQty;
                } else {
                    aggregated[t].quantity -= sellQty;
                }

                if (aggregated[t].quantity <= 0.000001) {
                    aggregated[t].quantity = 0;
                    aggregated[t].invested = 0;
                }
            }
            aggregated[t].purchases.push(p);
        });

        const enriched = Object.entries(aggregated).map(([ticker, data]) => {
            const d = this.storage.getCurrentPrice(ticker) || {};
            const currency = d.currency || 'EUR';

            // rate = 1 because data.invested is already in EUR (converted per-purchase above)
            // currentRate converts the live market price for USD assets (e.g. BKSY)
            const currentRate = (currency === 'USD') ? dynamicRate : 1;
            const rate = 1;
            const previousClose = d.previousClose;

            let currentPrice = d.price;
            let currentValue = null;
            let investedEUR = data.invested * rate;

            // === SPECIAL LOGIC: REAL ESTATE ===
            // Real Estate assets don't have a market price. We calculate value based on linear interest.
            if (data.assetType === 'Real Estate') {
                // Calculate accumulated value from each purchase
                let totalREValue = 0;
                let totalREInvested = 0;

                data.purchases.forEach(p => {
                    const yieldPct = p.yield || 0;
                    const startDate = new Date(p.date);
                    const today = new Date();
                    const daysHeld = Math.max(0, (today - startDate) / (1000 * 60 * 60 * 24));
                    const pInvested = p.price * p.quantity;
                    const accrued = pInvested * (yieldPct / 100) * (daysHeld / 365);

                    totalREInvested += pInvested;
                    totalREValue += (pInvested + accrued);
                });

                investedEUR = totalREInvested;
                currentValue = totalREValue;
                // Set simulated "current price" so other calculations work if needed
                if (data.quantity > 0) {
                    currentPrice = currentValue / data.quantity;
                }
            } else {
                // Standard Market Asset Logic — apply currentRate to convert USD→EUR
                currentValue = currentPrice ? currentPrice * data.quantity * currentRate : null;
            }

            // FIX: Re-calculate avgPriceEUR after investedEUR is finalized
            const avgPriceEUR = (data.quantity > 0) ? investedEUR / data.quantity : 0;

            const currentValueEUR = currentValue || null; // currentRate already applied above
            const gainEUR = currentValueEUR ? currentValueEUR - investedEUR : null;
            const gainPct = investedEUR > 0 && gainEUR ? (gainEUR / investedEUR) * 100 : null;

            let dayChange = null;
            let dayPct = null;

            // DEBUG LOG
            if (ticker === 'AL2SI') {
                console.log(`[AL2SI Debug] yesterdayCloseMap has AL2SI: ${yesterdayCloseMap && yesterdayCloseMap.has(ticker)}`);
                console.log(`[AL2SI Debug] currentValue: ${currentValue}`);
                console.log(`[AL2SI Debug] previousClose from storage: ${previousClose}`);
                console.log(`[AL2SI Debug] currentPrice: ${currentPrice}`);
                if (yesterdayCloseMap && yesterdayCloseMap.has(ticker)) {
                    console.log(`[AL2SI Debug] yesterdayCloseMap value:`, yesterdayCloseMap.get(ticker));
                }
            }

            // LOGIQUE CORRIGÉE : Utiliser yesterdayCloseMap en priorité.
            // HistoryCalculator calcule finement la vraie clôture de la veille (ou le prix à minuit pour les cryptos)
            // en gérant les fallbacks Binance. yesterdayCloseMap contient la VALEUR TOTALE (prix * qty).
            let usedYesterdayCloseMap = false;

            if (yesterdayCloseMap && yesterdayCloseMap.has(ticker) && yesterdayCloseMap.get(ticker) !== null) {
                const mapEntry = yesterdayCloseMap.get(ticker);
                // Support ancien format (nombre) et nouveau format (objet)
                const yesterdayTotal = (typeof mapEntry === 'object') ? mapEntry.yesterdayClose : mapEntry;
                const todayYestQty   = (typeof mapEntry === 'object') ? mapEntry.todayValueOfYesterdayHoldings : null;

                if (yesterdayTotal > 0 && currentValueEUR !== null) {
                    // Utiliser todayValueOfYesterdayHoldings quand disponible :
                    // = currentPrice × qtyYesterday (pas qtyActuelle)
                    // Évite que les achats intraday gonfle artificiellement VAR TODAY
                    const referenceCurrentValue = (todayYestQty !== null && todayYestQty > 0)
                        ? todayYestQty
                        : currentValueEUR;
                    dayChange = referenceCurrentValue - yesterdayTotal;
                    dayPct = (dayChange / yesterdayTotal) * 100;
                    usedYesterdayCloseMap = true;

                    if (ticker === 'AL2SI' || ticker === 'BTC') {
                        console.log(`[${ticker} Debug] yesterdayTotal=${yesterdayTotal.toFixed(2)}, todayYestQty=${todayYestQty?.toFixed(2) ?? 'n/a'}, used=${referenceCurrentValue.toFixed(2)}, dayChange=${dayChange.toFixed(2)}`);
                    }
                } else if (yesterdayTotal === 0) {
                    // Si l'actif n'était pas détenu à la clôture d'hier,
                    // sa variation journalière ne doit pas être comptée sur le P&L d'aujourd'hui.
                    dayChange = 0;
                    dayPct = 0;
                    usedYesterdayCloseMap = true;
                    if (ticker === 'AL2SI' || ticker === 'BTC') {
                        console.log(`[${ticker} Debug] No holdings yesterday: setting dayChange to 0 for intraday purchase.`);
                    }
                }
            }

            // FALLBACK : Si yesterdayCloseMap n'a rien trouvé, on utilise storage.previousClose
            if (!usedYesterdayCloseMap && currentPrice && currentPrice > 0) {
                const effectivePreviousClose = (previousClose && previousClose > 0) ? previousClose : currentPrice;

                if (effectivePreviousClose !== currentPrice) {
                    dayPct = ((currentPrice - effectivePreviousClose) / effectivePreviousClose) * 100;
                    const dayChangeOriginal = (currentPrice - effectivePreviousClose) * data.quantity;
                    dayChange = dayChangeOriginal * currentRate;

                    if (ticker === 'AL2SI' || ticker === 'BTC') {
                        console.log(`[${ticker} Debug] Using storage.previousClose`);
                    }
                } else {
                    dayChange = 0;
                    dayPct = 0;
                }
            }

            return {
                ticker,
                name: data.name,
                assetType: data.assetType,
                quantity: data.quantity,
                avgPrice: avgPriceEUR,
                invested: investedEUR,
                currentPrice: currentPrice ? currentPrice * currentRate : null,
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

        const sectorStats = {};

        holdings.forEach(asset => {
            totalInvestedEUR += asset.invested || 0;
            totalCurrentEUR += asset.currentValue || 0;
            totalDayChangeEUR += asset.dayChange || 0;

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
                    gain: asset.gainEUR || 0,
                    currentValue: asset.currentValue,
                    currentPrice: asset.currentPrice
                });

                assetDayPerformances.push({
                    ticker: asset.ticker,
                    name: asset.name,
                    dayPct: asset.dayPct || 0,
                    dayChange: asset.dayChange || 0
                });
            }
        });

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
            topSector: bestSector,
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

            // === SPECIAL LOGIC: REAL ESTATE ===
            if (p.assetType === 'Real Estate') {
                const yieldPct = p.yield || 0;
                const startDate = new Date(p.date);
                const today = new Date();
                const daysHeld = Math.max(0, (today - startDate) / (1000 * 60 * 60 * 24));
                const invested = p.price * p.quantity;
                const accrued = invested * (yieldPct / 100) * (daysHeld / 365);
                const currentVal = invested + accrued;

                return {
                    ...p,
                    assetType: 'Real Estate',
                    broker: p.broker,
                    currency: p.currency || 'EUR',
                    currentPriceOriginal: currentVal / p.quantity, // Simulated unit price
                    buyPriceOriginal: p.price,
                    currentPriceEUR: currentVal / p.quantity,
                    investedEUR: invested,
                    currentValueEUR: currentVal,
                    gainEUR: accrued,
                    gainPct: (accrued / invested) * 100
                };
            }

            const t = p.ticker.toUpperCase();
            const d = this.storage.getCurrentPrice(t) || {};
            const assetCurrency = d.currency || p.currency || 'EUR';
            const currentPriceOriginal = d.price;
            const buyPriceOriginal = p.price;

            // currentPriceOriginal is already in EUR — storage.js converts USD→EUR at storage time
            const currentPriceEUR = currentPriceOriginal ?? null;
            // buyPriceOriginal is in p.currency (original purchase currency, never converted by storage)
            const buyRate = p.currency === 'USD' ? dynamicRate : 1;
            const buyPriceEUR = buyPriceOriginal * buyRate;

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

    // === CACHE MANAGEMENT FOR FAST LOADING ===

    /**
     * Load cached portfolio data from Firestore
     * @returns {Object|null} Cached data or null if not available/fresh
     */
    /**
     * Load cached portfolio data (Priority: LocalStorage -> Firestore)
     * @returns {Object|null} Cached data or null if not available/fresh
     */
    async loadCachedData() {
        const CACHE_KEY = 'portfolio_snapshot_cache';
        const MAX_AGE = 3600000; // 1 hour

        // 1. Try LocalStorage FIRST (Fastest, Offline-capable)
        try {
            const localRaw = localStorage.getItem(CACHE_KEY);
            if (localRaw) {
                const localCache = JSON.parse(localRaw);
                const age = Date.now() - localCache.timestamp;
                if (age < MAX_AGE) {
                    console.log(`[Cache] ✅ Loaded from LocalStorage (age: ${Math.round(age / 1000)}s)`);
                    return localCache.data;
                }
            }
        } catch (e) {
            console.warn('[Cache] LocalStorage read failed:', e);
        }

        // 2. Fallback to Firestore (if online & user logged in)
        const user = auth.currentUser;
        if (!user) return null;

        try {
            const cacheDoc = await db.collection('users')
                .doc(user.uid)
                .collection('cache')
                .doc('portfolioSnapshot')
                .get();

            if (cacheDoc.exists) {
                const cached = cacheDoc.data();
                const cacheAge = Date.now() - cached.timestamp;

                if (cacheAge < MAX_AGE) {
                    console.log(`[Cache] ✅ Loaded from Firestore (age: ${Math.round(cacheAge / 1000)}s)`);
                    // Update LocalStorage to keep it in sync
                    try {
                        localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
                    } catch (e) { }
                    return cached.data;
                } else {
                    console.log(`[Cache] ⏰ Firestore Cache expired (age: ${Math.round(cacheAge / 1000)}s)`);
                }
            }
        } catch (error) {
            console.warn('[Cache] Firestore load failed:', error);
        }

        return null;
    }

    /**
     * Save portfolio snapshot (Dual Write: LocalStorage + Firestore)
     * @param {Object} data - Full report data to cache
     */
    async saveCacheSnapshot(data) {
        const CACHE_KEY = 'portfolio_snapshot_cache';
        const payload = {
            data: data,
            timestamp: Date.now(),
            version: '1.0'
        };

        // 1. Save to LocalStorage (Always works, synchronous)
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
            console.log('[Cache] 💾 Snapshot saved to LocalStorage');
        } catch (e) {
            console.error('[Cache] LocalStorage save failed (Quota?):', e);
        }

        // 2. Save to Firestore (Best effort with TIMEOUT)
        // We use a timeout because Firestore SDK hangs indefinitely on "Quota Exceeded" retries
        const user = auth.currentUser;
        if (user) {
            try {
                const firestoreWrite = db.collection('users')
                    .doc(user.uid)
                    .collection('cache')
                    .doc('portfolioSnapshot')
                    .set(payload);

                const timeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Firestore write timed out (Quota/Network)')), 2000)
                );

                await Promise.race([firestoreWrite, timeout]);
                console.log('[Cache] ☁️ Snapshot saved to Firestore');
            } catch (error) {
                // Do NOT throw. Just log warning. This prevents UI blocking.
                console.warn('[Cache] ⚠️ Firestore save failed/skipped:', error.message);
            }
        }
    }

    generateFullReport(purchases, yesterdayCloseMap = null) {
        // Exclude Dividends from Asset Holdings
        const assetPurchases = purchases.filter(p => {
            const type = (p.assetType || 'Stock').toLowerCase();
            return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend';
        });
        // Include Dividends in Cash Purchases (so they appear in Cash Reserve, if logic supports it)
        const cashPurchases = purchases.filter(p => {
            const type = (p.assetType || 'Stock').toLowerCase();
            return type === 'cash' || type === 'dividend' || p.type === 'dividend';
        });

        let holdings = this.calculateHoldings(assetPurchases, yesterdayCloseMap);

        // CRITICAL FIX: Filter out zero-quantity holdings (fully sold assets)
        // This prevents sold assets from appearing in analytics and causing errors
        holdings = holdings.filter(h => (h.quantity || 0) > 0.000001);

        const summary = this.calculateSummary(holdings);
        const cashReserve = this.calculateCashReserve(cashPurchases);

        // Calculate performance before creating summary to get winRate
        const performance = this.analyzePerformance(holdings);

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
                cashReserve: cashReserve.total,
                winRate: performance.winRate  // Add winRate to summary
            },
            diversification: this.calculateDiversification(holdings),
            performance: performance,  // Use already calculated performance
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
        const assetPurchases = purchases.filter(p => {
            const type = (p.assetType || 'Stock').toLowerCase();
            return type !== 'dividend' && p.type !== 'dividend';
        });
        return this.calculateGenericHistory(assetPurchases, days, false);
    }

    async calculateAssetHistory(ticker, days) {
        const purchases = this.storage.getPurchases()
            .filter(p => p.ticker.toUpperCase() === ticker.toUpperCase())
            .filter(p => {
                const type = (p.assetType || 'Stock').toLowerCase();
                return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend';
            });
        if (purchases.length === 0) return { labels: [], invested: [], values: [], yesterdayClose: null, unitPrices: [], purchasePoints: [], twr: [] };
        return this.calculateGenericHistory(purchases, days, true);
    }

    // === NOUVEAU : Calcul pour un Indice pur (Pour le Dashboard) ===
    async calculateIndexData(ticker, days) {
        const interval = getIntervalForPeriod(days);

        const today = new Date();
        const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999));
        const endTs = Math.floor(todayUTC.getTime() / 1000);

        let startTs;
        if (days === 1) {
            startTs = endTs - (24 * 60 * 60) - (2 * 60 * 60);
        } else if (days === 7) {
            startTs = endTs - (7 * 24 * 60 * 60);
        } else if (days === 30) {
            startTs = endTs - (30 * 24 * 60 * 60);
        } else if (days === 90) {
            startTs = endTs - (90 * 24 * 60 * 60);
        } else if (days === 365) {
            startTs = endTs - (365 * 24 * 60 * 60);
        } else {
            startTs = endTs - (365 * 24 * 60 * 60);
        }

        const hist = await this.getHistoryWithCache(ticker, startTs, endTs, interval);

        const sortedTs = Object.keys(hist).map(Number).sort((a, b) => a - b);
        const labels = [];
        const values = [];
        const labelFn = getLabelFormat(days);

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const startOfDayTs = startOfDay.getTime();

        const filteredTs = (days === 1)
            ? sortedTs.filter(ts => ts >= startOfDayTs)
            : sortedTs;

        filteredTs.forEach(ts => {
            labels.push(labelFn(ts));
            values.push(hist[ts]);
        });

        const priceData = this.storage.getCurrentPrice(ticker);
        const trueYesterdayClose = priceData?.previousClose || null;

        return {
            labels: labels,
            values: values,
            invested: [],
            unitPrices: values,
            purchasePoints: [],
            truePreviousClose: trueYesterdayClose // IMPORTANT : Exposed for ChartKPIManager
        }
    }

    // === SMART SYNC (Délégué) ===
    async getHistoryWithCache(ticker, startTs, endTs, interval) {
        return this.historyCalculator.getHistoryWithCache(ticker, startTs, endTs, interval);
    }

    async calculateGenericHistory(purchases, days, isSingleAsset = false) {
        return this.historyCalculator.calculateGenericHistory(purchases, days, isSingleAsset);
    }
}
