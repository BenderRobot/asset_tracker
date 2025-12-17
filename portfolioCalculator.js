// ========================================
// portfolioCalculator.js - Logique Métier du Portefeuille
// ========================================
import { USD_TO_EUR_FALLBACK_RATE } from './config.js';

export class PortfolioCalculator {
    constructor(storage, dataManager) {
        this.storage = storage;
        this.dataManager = dataManager;
    }

    // === 1. CALCUL DES POSITIONS ACTUELLES (SNAPSHOT) ===

    calculateHoldings(purchases) {
        const assetMap = new Map();

        // A. Agrégation des achats par ticker
        purchases.forEach(p => {
            if (p.type === 'dividend') return; // Les dividendes sont traités à part (Cash)

            const ticker = p.ticker.toUpperCase();
            if (!assetMap.has(ticker)) {
                assetMap.set(ticker, {
                    quantity: 0,
                    invested: 0,
                    name: p.name,
                    assetType: p.assetType,
                    purchases: []
                });
            }
            const asset = assetMap.get(ticker);
            asset.quantity += parseFloat(p.quantity);
            // Sell logic usually negative quantity, but confirm:
            // Standard purchases have positive quantity/price.
            // If selling, quantity should be negative in input or handled here.
            // Assuming p.quantity is signed correctly in storage.js or here.
            asset.invested += parseFloat(p.price) * parseFloat(p.quantity);
            asset.purchases.push(p);
        });

        // B. Enrichissement avec les prix actuels
        const enriched = Array.from(assetMap.entries()).map(([ticker, data]) => {
            let currentPriceData = this.storage.getCurrentPrice(ticker);

            // FALLBACK CRYPTO: Si pas de prix pour 'BTC', essayer 'BTC-EUR'
            // (Permet de récupérer le prix chargé par la carte Indices)
            if (!currentPriceData || !currentPriceData.price) {
                const formatted = this.dataManager.formatTicker(ticker);
                if (formatted !== ticker) {
                    const fallbackData = this.storage.getCurrentPrice(formatted);
                    if (fallbackData && fallbackData.price) {
                        currentPriceData = fallbackData;
                    }
                }
            }

            currentPriceData = currentPriceData || {};
            const currentPriceOriginal = currentPriceData.price || 0;
            const previousCloseOriginal = currentPriceData.previousClose || currentPriceOriginal;
            const currency = currentPriceData.currency || 'EUR';

            const dynamicRate = this.storage.getConversionRate('USD_TO_EUR') || USD_TO_EUR_FALLBACK_RATE;
            const rate = (currency === 'USD') ? dynamicRate : 1;

            const currentPrice = currentPriceOriginal;
            const previousClose = previousCloseOriginal;

            const avgPriceEUR = data.quantity > 0 ? (data.invested / data.quantity) * rate : 0; // Approx si achats mixtes devises
            const investedEUR = data.invested * rate; // Approx
            const currentValueEUR = currentPrice * rate * data.quantity;

            const gainEUR = currentValueEUR - investedEUR;
            const gainPct = investedEUR > 0 ? (gainEUR / investedEUR) * 100 : 0;

            // CALCUL ATOMIQUE 1D : (Prix Actuel - Clôture Veille) * Quantité
            let dayChange = 0;
            let dayPct = 0;
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

    calculateCashReserve(cashPurchases) {
        let total = 0;
        cashPurchases.forEach(p => {
            total += parseFloat(p.price); // Pour le cash, price = montant
        });
        return { total };
    }

    calculateSummary(holdings) {
        let totalInvestedEUR = 0;
        let totalCurrentEUR = 0;
        let totalDayChangeEUR = 0;

        holdings.forEach(asset => {
            totalInvestedEUR += asset.invested || 0;
            totalCurrentEUR += asset.currentValue || 0;

            // SOMME ATOMIQUE DES VARIATIONS
            if (asset.dayChange !== null && !isNaN(asset.dayChange)) {
                totalDayChangeEUR += asset.dayChange;
            }
        });

        const gainTotal = totalCurrentEUR - totalInvestedEUR;
        const gainPct = totalInvestedEUR > 0 ? (gainTotal / totalInvestedEUR) * 100 : 0;

        // Calcul du % jour basé sur la variation totale
        const totalPreviousCloseEUR = totalCurrentEUR - totalDayChangeEUR;
        const dayChangePct = totalPreviousCloseEUR > 0
            ? (totalDayChangeEUR / totalPreviousCloseEUR) * 100
            : 0;

        return {
            totalInvestedEUR,
            totalCurrentEUR,
            totalDayChangeEUR,
            dayChangePct,
            gainTotal,
            gainPct,
            assetsCount: holdings.length,
            movementsCount: holdings.reduce((sum, h) => sum + h.purchases.length, 0)
        };
    }

    // === 2. CALCUL DE L'HISTORIQUE (POUR LE GRAPHIQUE) ===

    async calculateHistory(purchases, days) {
        // Exclure Cash ET Dividendes du calcul de valeur des ACTIFS (les dividendes sont du cash)
        const assetPurchases = purchases.filter(p => p.assetType !== 'Cash' && p.type !== 'dividend');
        if (assetPurchases.length === 0) return { labels: [], values: [], invested: [] };

        // 1. Définir la plage de temps
        const today = new Date();
        const endTs = Math.floor(today.getTime() / 1000);
        let startTs;

        // Logique de début simplifiée mais robuste
        if (days === 1) {
            const d = new Date(today);
            d.setHours(0, 0, 0, 0); // Minuit local
            // Si on est lundi matin avant l'ouverture, on veut peut-être voir vendredi ?
            // Pour l'instant on reste simple : 1D = Aujourd'hui minuit à maintenant.
            startTs = Math.floor(d.getTime() / 1000);
        } else {
            const d = new Date(today);
            d.setDate(d.getDate() - days);
            startTs = Math.floor(d.getTime() / 1000);
        }

        const interval = this.dataManager.getIntervalForPeriod(days);
        const tickers = [...new Set(assetPurchases.map(p => p.ticker.toUpperCase()))];

        // 2. Récupérer l'historique pour chaque actif
        const historicalDataMap = new Map();
        await Promise.all(tickers.map(async (t) => {
            try {
                const hist = await this.dataManager.getHistoricalPrices(t, startTs, endTs, interval);
                historicalDataMap.set(t, hist || {});
            } catch (e) {
                console.warn(`Pas d'historique pour ${t}`);
                historicalDataMap.set(t, {});
            }
        }));

        // 3. Reconstituer la valeur du portefeuille point par point
        // On rassemble tous les timestamps disponibles
        const allTimestamps = new Set();
        historicalDataMap.forEach(hist => {
            Object.keys(hist).forEach(ts => allTimestamps.add(parseInt(ts)));
        });

        // Ajout du point "Maintenant" avec les prix live
        const nowMs = Date.now();
        // On arrondit à la minute pour s'aligner un peu
        const nowAligned = Math.floor(nowMs / 60000) * 60000;
        allTimestamps.add(nowAligned);

        const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

        // Filtrage : on ne garde que ce qui est dans la plage demandée
        const displayTimestamps = sortedTimestamps.filter(ts => ts >= startTs * 1000);

        const labels = [];
        const values = [];
        const invested = [];

        // Cache pour "Forward Fill" (dernier prix connu)
        const lastKnownPrices = new Map();

        // Initialisation des prix connus avant le début de la période (pour éviter de partir de 0)
        // [FIX] On pré-remplit avec le prix actuel (ou la veille) pour les actifs qui n'ont pas encore de données ajd (ex: Stocks le lundi matin)
        tickers.forEach(t => {
            const priceData = this.storage.getCurrentPrice(t);
            if (priceData) {
                // Priorité : Prix actuel > Clôture veille > 0
                const initPrice = priceData.price || priceData.previousClose || 0;
                if (initPrice > 0) {
                    lastKnownPrices.set(t, initPrice);
                }
            }
        });

        displayTimestamps.forEach(ts => {
            // A. Calculer la quantité détenue à cet instant 'ts'
            const quantities = new Map();
            let investedAtTs = 0;

            assetPurchases.forEach(p => {
                if (p.date.getTime() <= ts) {
                    const t = p.ticker.toUpperCase();
                    quantities.set(t, (quantities.get(t) || 0) + p.quantity);
                    investedAtTs += p.price * p.quantity; // Simplifié (devrait gérer devise)
                }
            });

            // B. Valoriser le portefeuille
            let valueAtTs = 0;
            let hasValue = false;

            tickers.forEach(t => {
                const qty = quantities.get(t) || 0;
                if (qty > 0) {
                    const hist = historicalDataMap.get(t);
                    let price = null;

                    // 1. Prix historique exact ?
                    if (hist && hist[ts]) {
                        price = hist[ts];
                    }
                    // 2. Prix Live pour le dernier point ?
                    else if (ts === nowAligned) {
                        const live = this.storage.getCurrentPrice(t);
                        if (live) price = live.price;
                    }

                    // Mise à jour Forward Fill
                    if (price !== null) {
                        lastKnownPrices.set(t, price);
                    } else {
                        price = lastKnownPrices.get(t);
                    }

                    if (price !== null) {
                        valueAtTs += price * qty; // Simplifié (devrait gérer devise)
                        hasValue = true;
                    }
                }
            });

            if (hasValue || investedAtTs > 0) {
                labels.push(ts);
                values.push(valueAtTs);
                invested.push(investedAtTs);
            }
        });

        return {
            labels,
            values,
            invested,
            yesterdayClose: null // Sera calculé/forcé par le ChartRenderer si besoin
        };
    }
}
