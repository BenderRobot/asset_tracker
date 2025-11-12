// ========================================
// storage.js - Stockage optimisÃ© avec cache intelligent
// ========================================

import { CACHE_EXPIRY_STOCKS_MARKET_OPEN, CACHE_EXPIRY_STOCKS_MARKET_CLOSED, CACHE_EXPIRY_CRYPTO } from './config.js';

export class Storage {
    constructor() {
        this.purchases = this.loadPurchases();
        this.currentData = this.loadCurrentData();
        this.priceTimestamps = this.loadTimestamps();
        
        // Index pour recherche rapide
        this.purchaseIndex = this.buildIndex();
    }

    // === CHARGEMENT OPTIMISÃ‰ ===
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
        // Validation
        if (!purchase.ticker || !purchase.name || !purchase.price || 
            !purchase.date || !purchase.quantity) {
            throw new Error('DonnÃ©es incomplÃ¨tes');
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
        if (idx === undefined) {
            console.warn('Achat non trouvÃ©:', key);
            return false;
        }

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
            } else {
                throw e;
            }
        }
    }

    // === GESTION DES PRIX AVEC CACHE INTELLIGENT ===
    getCurrentPrice(ticker) {
        return this.currentData[ticker.toUpperCase()];
    }

    setCurrentPrice(ticker, data) {
        const upperTicker = ticker.toUpperCase();
        
        // Si on a dÃ©jÃ  un prix et que le nouveau est null, on garde l'ancien
        if (this.currentData[upperTicker] && (!data || !data.price)) {
            console.log(`ðŸ”„ Conservation du prix en cache pour ${upperTicker}`);
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

    // Cache valide selon le type d'actif ET l'état du marché
    isCacheValid(ticker, assetType = 'Stock') {
        const upperTicker = ticker.toUpperCase();
        const ts = this.priceTimestamps[upperTicker];
        
        if (!ts) return false;
        
        const age = Date.now() - ts;
        
        // Cryptos : cache court (5 min) car marchÃ© 24/7
        if (assetType === 'Crypto') {
            return age < CACHE_EXPIRY_CRYPTO;
        }
        
        // Actions/ETF : cache dÃ©pend de l'Ã©tat du marchÃ©
        const marketOpen = this.isMarketOpen();
        
        if (marketOpen) {
            // MarchÃ© ouvert : cache court (10 min) pour prix Ã  jour
            return age < CACHE_EXPIRY_STOCKS_MARKET_OPEN;
        } else {
            // MarchÃ© fermÃ©/weekend : cache long (7 jours) pour Ã©viter appels inutiles
            return age < CACHE_EXPIRY_STOCKS_MARKET_CLOSED;
        }
    }

    // === NETTOYAGE INTELLIGENT ===
    cleanExpiredCache() {
        let cleaned = 0;
        const now = Date.now();
        
        Object.keys(this.currentData).forEach(ticker => {
            const ts = this.priceTimestamps[ticker];
            
            if (!ts) return;
            
            const age = now - ts;
            
            // VÃ©rifier si c'est une crypto
            const isCrypto = ticker === 'BTC' || ticker === 'ETH';
            
            if (isCrypto && age > CACHE_EXPIRY_CRYPTO) {
                delete this.currentData[ticker];
                delete this.priceTimestamps[ticker];
                cleaned++;
            } else if (!isCrypto && age > CACHE_EXPIRY_STOCKS_MARKET_CLOSED) {
                // Pour actions, ne supprimer que si > 7 jours
                delete this.currentData[ticker];
                delete this.priceTimestamps[ticker];
                cleaned++;
            }
        });
        
        if (cleaned > 0) {
            console.log(`ðŸ§¹ ${cleaned} prix expirÃ©s nettoyÃ©s`);
            this.savePricesCache();
        }
    }

    cleanOldPrices() {
        // Garder seulement les 100 prix les plus rÃ©cents
        const sorted = Object.entries(this.priceTimestamps)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 100);
        
        const newCurrentData = {};
        const newTimestamps = {};
        
        sorted.forEach(([ticker, ts]) => {
            newTimestamps[ticker] = ts;
            if (this.currentData[ticker]) {
                newCurrentData[ticker] = this.currentData[ticker];
            }
        });
        
        this.currentData = newCurrentData;
        this.priceTimestamps = newTimestamps;
        
        this.savePricesCache();
        console.log('ðŸ§¹ Cache des prix nettoyÃ© (gardÃ© top 100)');
    }

    cleanOldData() {
        // Supprimer les achats de plus de 2 ans si localStorage est plein
        const twoYearsAgo = Date.now() - (2 * 365 * 24 * 60 * 60 * 1000);
        const oldCount = this.purchases.length;
        
        this.purchases = this.purchases.filter(p => {
            const date = new Date(p.date);
            return date.getTime() > twoYearsAgo;
        });
        
        console.log(`ðŸ§¹ ${oldCount - this.purchases.length} vieux achats supprimÃ©s`);
    }

    // === STATISTIQUES ===
    getStats() {
        const tickers = new Set(this.purchases.map(p => p.ticker.toUpperCase()));
        const totalInvested = this.purchases.reduce((sum, p) => 
            sum + (p.price * p.quantity), 0
        );
        
        return {
            totalPurchases: this.purchases.length,
            uniqueTickers: tickers.size,
            totalInvested: totalInvested,
            cachedPrices: Object.keys(this.currentData).length,
            storageUsed: this.getStorageSize()
        };
    }

    getStorageSize() {
        let size = 0;
        for (let key in localStorage) {
            if (localStorage.hasOwnProperty(key)) {
                size += localStorage[key].length + key.length;
            }
        }
        return (size / 1024).toFixed(2) + ' KB';
    }

    // === EXPORT/IMPORT ===
    exportData() {
        return {
            purchases: this.purchases,
            exportDate: new Date().toISOString(),
            version: '1.0'
        };
    }

    importData(data) {
        if (!data.purchases || !Array.isArray(data.purchases)) {
            throw new Error('Format invalide');
        }

        // Validation basique
        const valid = data.purchases.every(p => 
            p.ticker && p.name && p.price && p.date && p.quantity
        );

        if (!valid) {
            throw new Error('DonnÃ©es invalides dÃ©tectÃ©es');
        }

        this.purchases = data.purchases;
        this.savePurchases();
        this.rebuildIndex();
    }

    // === UTILITAIRES ===
    getRowKey(purchase) {
        // ClÃ© unique basÃ©e sur ticker, date et prix
        return `${purchase.ticker.toUpperCase()}|${purchase.date}|${purchase.price}|${purchase.quantity}`;
    }

    // Backup automatique
    createBackup() {
        const backup = {
            purchases: this.purchases,
            currentData: this.currentData,
            date: new Date().toISOString()
        };
        
        localStorage.setItem('backup_purchases', JSON.stringify(backup));
        console.log('ðŸ’¾ Backup crÃ©Ã©');
    }

    restoreBackup() {
        try {
            const backup = JSON.parse(localStorage.getItem('backup_purchases'));
            if (backup && backup.purchases) {
                this.purchases = backup.purchases;
                this.savePurchases();
                this.rebuildIndex();
                return true;
            }
        } catch (e) {
            console.error('Erreur restauration:', e);
        }
        return false;
    }

    // === DÃ‰TECTION DU TYPE D'ACTIF ===
    getAssetType(ticker) {
        const purchase = this.purchases.find(p => 
            p.ticker.toUpperCase() === ticker.toUpperCase()
        );
        return purchase?.assetType || 'Stock';
    }

    // === VÃ‰RIFIER SI LE MARCHÃ‰ EST OUVERT ===
    isMarketOpen() {
        const now = new Date();
        const day = now.getDay(); // 0 = Dimanche, 6 = Samedi
        const hours = now.getHours();
        const minutes = now.getMinutes();
        
        // Weekend
        if (day === 0 || day === 6) {
            return false;
        }
        
        // Horaires de bourse (approximatif) : 9h30 - 16h00 (heure locale)
        const currentTime = hours * 60 + minutes;
        const marketOpen = 9 * 60 + 30; // 9h30
        const marketClose = 16 * 60; // 16h00
        
        return currentTime >= marketOpen && currentTime <= marketClose;
    }

    // === OBTENIR L'Ã‚GE DU PRIX ===
    getPriceAge(ticker) {
        const ts = this.priceTimestamps[ticker.toUpperCase()];
        if (!ts) return null;
        
        const ageMs = Date.now() - ts;
        const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
        const ageDays = Math.floor(ageHours / 24);
        
        if (ageDays > 0) {
            return `${ageDays} jour${ageDays > 1 ? 's' : ''}`;
        }
        
        if (ageHours > 0) {
            return `${ageHours}h`;
        }
        
        const ageMinutes = Math.floor(ageMs / (1000 * 60));
        return `${ageMinutes}min`;
    }
}