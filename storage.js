// ========================================
// storage.js - (v5 - Synchro Multi-Onglets)
// ========================================

import { 
    CACHE_EXPIRY_STOCKS_MARKET_OPEN, 
    CACHE_EXPIRY_STOCKS_MARKET_CLOSED, 
    CACHE_EXPIRY_CRYPTO,
    YAHOO_MAP,
    USD_TICKERS
} from './config.js';

// On importe l'eventBus pour notifier l'app qu'un autre onglet a changé les données
import { eventBus } from './eventBus.js';

export class Storage {
    constructor() {
        this.purchases = this.loadPurchases();
        this.currentData = this.loadCurrentData();
        this.priceTimestamps = this.loadTimestamps();
        
        // Index pour recherche rapide
        this.purchaseIndex = this.buildIndex();
		this.conversionRates = this.loadConversionRates();

        // === MAGIE : Écouteur de synchronisation entre onglets ===
        window.addEventListener('storage', (e) => {
            if (e.key === 'currentData' && e.newValue) {
                console.log('🔄 Sync: Prix mis à jour par un autre onglet');
                this.currentData = JSON.parse(e.newValue);
                this.priceTimestamps = this.loadTimestamps(); // Recharger aussi les timestamps
                // Optionnel: On pourrait déclencher un render ici via eventBus
            }
            if (e.key === 'purchases' && e.newValue) {
                console.log('🔄 Sync: Transactions mises à jour par un autre onglet');
                this.purchases = JSON.parse(e.newValue);
                this.rebuildIndex();
                // Optionnel: On pourrait déclencher un render ici
            }
        });
    }

    // === CHARGEMENT OPTIMISÉ ===
    loadPurchases() {
        try {
            const data = localStorage.getItem('purchases');
            return data ? JSON.parse(data) : [];
        } catch (e) {
            console.error('Erreur chargement achats:', e);
            return [];
        }
    }

    loadCurrentData() {
        try {
            const data = localStorage.getItem('currentData');
            return data ? JSON.parse(data) : {};
        } catch (e) {
            console.error('Erreur chargement prix:', e);
            return {};
        }
    }

    loadTimestamps() {
        try {
            const data = localStorage.getItem('priceTimestamps');
            return data ? JSON.parse(data) : {};
        } catch (e) {
            console.error('Erreur chargement timestamps:', e);
            return {};
        }
    }

	loadConversionRates() {
        try {
            const data = localStorage.getItem('conversionRates');
            // On ne garde que les taux de moins de 24h
            const parsed = data ? JSON.parse(data) : {};
            const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
            
            Object.keys(parsed).forEach(key => {
                if (parsed[key].timestamp < twentyFourHoursAgo) {
                    delete parsed[key];
                }
            });
            
            return parsed;
        } catch (e) {
            console.error('Erreur chargement taux de change:', e);
            return {};
        }
    }

    // === INDEX POUR RECHERCHE RAPIDE ===
    buildIndex() {
        const index = new Map();
        this.purchases.forEach((purchase, idx) => {
            const key = this.getRowKey(purchase);
            index.set(key, idx);
        });
        return index;
    }

    rebuildIndex() {
        this.purchaseIndex = this.buildIndex();
    }

    // === GESTION DES ACHATS ===
    getPurchases() {
        return this.purchases;
    }

    addPurchase(purchase) {
        if (!purchase.ticker || !purchase.name || !purchase.price || 
            !purchase.date || !purchase.quantity) {
            throw new Error('Données incomplètes');
        }

        this.purchases.push({
            ...purchase,
            ticker: purchase.ticker.toUpperCase(),
            price: parseFloat(purchase.price),
            quantity: parseFloat(purchase.quantity),
            addedAt: Date.now()
        });
        
        this.savePurchases();
        this.rebuildIndex();
    }

    updatePurchase(key, updates) {
        const idx = this.purchaseIndex.get(key);
        if (idx === undefined) return false;

        this.purchases[idx] = {
            ...this.purchases[idx],
            ...updates,
            updatedAt: Date.now()
        };
        
        this.savePurchases();
        this.rebuildIndex();
        return true;
    }

    removePurchase(key) {
        const idx = this.purchaseIndex.get(key);
        if (idx === undefined) return false;

        this.purchases.splice(idx, 1);
        this.savePurchases();
        this.rebuildIndex();
        return true;
    }

    removePurchases(keys) {
        const keysArray = Array.from(keys);
        this.purchases = this.purchases.filter(p => 
            !keysArray.includes(this.getRowKey(p))
        );
        
        this.savePurchases();
        this.rebuildIndex();
    }

    getPurchaseByKey(key) {
        const idx = this.purchaseIndex.get(key);
        return idx !== undefined ? this.purchases[idx] : null;
    }

    savePurchases() {
        try {
            localStorage.setItem('purchases', JSON.stringify(this.purchases));
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                this.cleanOldData();
                localStorage.setItem('purchases', JSON.stringify(this.purchases));
            }
        }
    }

    // === GESTION DES PRIX AVEC CACHE INTELLIGENT ===
    getCurrentPrice(ticker) {
        // On retourne directement la donnée mémoire (qui est maintenant synchro)
        return this.currentData[ticker.toUpperCase()];
    }

    setCurrentPrice(ticker, data) {
        const upperTicker = ticker.toUpperCase();
        
        if (this.currentData[upperTicker] && (!data || !data.price)) {
            this.priceTimestamps[upperTicker] = Date.now();
            this.savePricesCache();
            return;
        }
        
        this.currentData[upperTicker] = data;
        this.priceTimestamps[upperTicker] = Date.now();
        this.savePricesCache();
    }

    savePricesCache() {
        try {
            localStorage.setItem('currentData', JSON.stringify(this.currentData));
            localStorage.setItem('priceTimestamps', JSON.stringify(this.priceTimestamps));
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                this.cleanOldPrices();
            }
        }
    }

    isCacheValid(ticker, assetType = 'Stock') {
        const upperTicker = ticker.toUpperCase();
        const ts = this.priceTimestamps[upperTicker];
        
        if (!ts) return false;
        
        const age = Date.now() - ts;
        
        if (assetType === 'Crypto') {
            return age < CACHE_EXPIRY_CRYPTO; 
        }
        
        const category = this.getAssetCategory(upperTicker, assetType);
        const marketIsOpen = this.isMarketOpen(category);

        if (marketIsOpen) {
            return age < CACHE_EXPIRY_STOCKS_MARKET_OPEN;
        } else {
            return age < CACHE_EXPIRY_STOCKS_MARKET_CLOSED;
        }
    }

    cleanExpiredCache() {
        // ... (Logique de nettoyage standard)
        let cleaned = 0;
        Object.keys(this.currentData).forEach(ticker => {
            const ts = this.priceTimestamps[ticker];
            if (!ts) return;
            const assetType = this.currentData[ticker]?.source === 'CoinGecko' ? 'Crypto' : 'Stock';
            if (!this.isCacheValid(ticker, assetType)) {
                 delete this.currentData[ticker];
                 delete this.priceTimestamps[ticker];
                 cleaned++;
            }
        });
        if (cleaned > 0) this.savePricesCache();
    }

    cleanOldPrices() {
        const sorted = Object.entries(this.priceTimestamps)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 100);
        const newCurrentData = {};
        const newTimestamps = {};
        sorted.forEach(([ticker, ts]) => {
            newTimestamps[ticker] = ts;
            if (this.currentData[ticker]) newCurrentData[ticker] = this.currentData[ticker];
        });
        this.currentData = newCurrentData;
        this.priceTimestamps = newTimestamps;
        this.savePricesCache();
    }

    cleanOldData() {
        const twoYearsAgo = Date.now() - (2 * 365 * 24 * 60 * 60 * 1000);
        this.purchases = this.purchases.filter(p => new Date(p.date).getTime() > twoYearsAgo);
    }

    // === UTILITAIRES ===
    getRowKey(purchase) {
        return `${purchase.ticker.toUpperCase()}|${purchase.date}|${purchase.price}|${purchase.quantity}`;
    }

    getAssetType(ticker) {
        const purchase = this.purchases.find(p => p.ticker.toUpperCase() === ticker.toUpperCase());
        return purchase?.assetType || 'Stock';
    }

    isMarketOpen(category = 'EUR') {
        const now = new Date();
        const day = now.getDay();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const currentTime = hours * 60 + minutes;

        if (day === 0 || day === 6) return false;
        if (category === 'CRYPTO') return true;
        if (category === 'EUR') {
            const marketOpen = 9 * 60; 
            const marketClose = 17 * 60 + 30; 
            return (currentTime >= marketOpen && currentTime <= marketClose);
        }
        if (category === 'USA') {
            const marketOpen = 15 * 60 + 30; 
            const marketClose = 22 * 60;
            return (currentTime >= marketOpen && currentTime <= marketClose);
        }
        return false;
    }

    getAssetCategory(ticker, assetType) {
        const upperTicker = ticker.toUpperCase();
        if (assetType === 'Crypto') return 'CRYPTO';
        if (!assetType) {
             const purchase = this.purchases.find(p => p.ticker.toUpperCase() === upperTicker);
             if (purchase?.assetType === 'Crypto') return 'CRYPTO';
        }
        const yahooSymbol = YAHOO_MAP[upperTicker] || upperTicker;
        if (USD_TICKERS.has(upperTicker)) return 'USA';
        if (!yahooSymbol.includes('.') && !yahooSymbol.endsWith('-EUR') && yahooSymbol !== 'BTC') return 'USA';
        return 'EUR';
    }

    getPriceAge(ticker) {
        const ts = this.priceTimestamps[ticker.toUpperCase()];
        if (!ts) return null;
        const ageMs = Date.now() - ts;
        const ageMinutes = Math.floor(ageMs / 60000);
        if (ageMinutes < 60) return `${ageMinutes}min`;
        const ageHours = Math.floor(ageMinutes / 60);
        return `${ageHours}h`;
    }

	getConversionRate(pair) {
        const rateData = this.conversionRates[pair.toUpperCase()];
        if (rateData) return rateData.rate;
        return null;
    }

    setConversionRate(pair, rate) {
        this.conversionRates[pair.toUpperCase()] = { rate: rate, timestamp: Date.now() };
        try {
            localStorage.setItem('conversionRates', JSON.stringify(this.conversionRates));
        } catch (e) {}
    }
}