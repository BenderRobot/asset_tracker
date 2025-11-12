// ========================================
// storage.js - Stockage optimisé (Cache INTELLIGENT)
// ========================================

// MODIFICATION: Import des configs de mapping
import { 
    CACHE_EXPIRY_STOCKS_MARKET_OPEN, 
    CACHE_EXPIRY_STOCKS_MARKET_CLOSED, 
    CACHE_EXPIRY_CRYPTO,
    YAHOO_MAP,
    USD_TICKERS
} from './config.js';

export class Storage {
    constructor() {
        this.purchases = this.loadPurchases();
        this.currentData = this.loadCurrentData();
        this.priceTimestamps = this.loadTimestamps();
        
        // Index pour recherche rapide
        this.purchaseIndex = this.buildIndex();
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
        if (idx === undefined) {
            console.warn('Achat non trouvé:', key);
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
        
        // Si on a déjà un prix et que le nouveau est null, on garde l'ancien
        if (this.currentData[upperTicker] && (!data || !data.price)) {
            console.log(` conserving... Conservation du prix en cache pour ${upperTicker}`);
            // MAIS on met à jour le timestamp pour qu'il ne soit pas "périmé"
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

    // ==========================================================
    // === MODIFICATION : isCacheValid (Logique "Smart")
    // ==========================================================
    // (Conserve la signature `assetType` pour la compatibilité avec api.js)
    isCacheValid(ticker, assetType = 'Stock') {
        const upperTicker = ticker.toUpperCase();
        const ts = this.priceTimestamps[upperTicker];
        
        if (!ts) return false;
        
        const age = Date.now() - ts;
        
        if (assetType === 'Crypto') {
            return age < CACHE_EXPIRY_CRYPTO; // 5 min
        }
        
        // Actions/ETF : on vérifie le marché spécifique
        const category = this.getAssetCategory(upperTicker, assetType);
        const marketIsOpen = this.isMarketOpen(category); // Appel de la fonction modifiée

        if (marketIsOpen) {
            // Marché ouvert : cache court (10 min)
            return age < CACHE_EXPIRY_STOCKS_MARKET_OPEN;
        } else {
            // Marché fermé/weekend : cache long (7 jours)
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
            
            // On utilise la nouvelle logique de validation
            // (on récupère le type d'asset depuis l'objet prix, ou on devine)
            const assetType = this.currentData[ticker]?.source === 'CoinGecko' ? 'Crypto' : 'Stock';
            
            if (!this.isCacheValid(ticker, assetType)) {
                 // Si le cache n'est PAS valide (selon la nouvelle logique), on supprime
                 delete this.currentData[ticker];
                 delete this.priceTimestamps[ticker];
                 cleaned++;
            }
        });
        
        if (cleaned > 0) {
            console.log(`... ${cleaned} prix expirés nettoyés`);
            this.savePricesCache();
        }
    }

    cleanOldPrices() {
        // Garder seulement les 100 prix les plus récents
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
        console.log('... Cache des prix nettoyé (gardé top 100)');
    }

    cleanOldData() {
        // Supprimer les achats de plus de 2 ans si localStorage est plein
        const twoYearsAgo = Date.now() - (2 * 365 * 24 * 60 * 60 * 1000);
        const oldCount = this.purchases.length;
        
        this.purchases = this.purchases.filter(p => {
            const date = new Date(p.date);
            return date.getTime() > twoYearsAgo;
        });
        
        console.log(`... ${oldCount - this.purchases.length} vieux achats supprimés`);
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
            throw new Error('Données invalides détectées');
        }

        this.purchases = data.purchases;
        this.savePurchases();
        this.rebuildIndex();
    }

    // === UTILITAIRES ===
    getRowKey(purchase) {
        // Clé unique basée sur ticker, date et prix
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
        console.log('... Backup créé');
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

    // === DÉTECTION DU TYPE D'ACTIF ===
    getAssetType(ticker) {
        const purchase = this.purchases.find(p => 
            p.ticker.toUpperCase() === ticker.toUpperCase()
        );
        return purchase?.assetType || 'Stock';
    }

    // ==========================================================
    // === MODIFICATION : isMarketOpen (Logique "Smart")
    // ==========================================================
    // Prend une catégorie ('EUR', 'USA', 'CRYPTO')
    isMarketOpen(category = 'EUR') {
        const now = new Date(); // Heure locale (CET, car l'utilisateur est en France)
        const day = now.getDay(); // 0 = Dimanche, 6 = Samedi
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const currentTime = hours * 60 + minutes;

        // Weekend
        if (day === 0 || day === 6) {
            return false;
        }
        
        if (category === 'CRYPTO') {
            return true; // Crypto est toujours ouvert
        }

        if (category === 'EUR') {
            const marketOpen = 9 * 60; // 9:00 CET
            const marketClose = 17 * 60 + 30; // 17:30 CET
            return (currentTime >= marketOpen && currentTime <= marketClose);
        }

        if (category === 'USA') {
            // Heures de NYC (9:30-16:00 ET) converties en CET
            // Prise en compte de l'heure d'été/hiver (simple)
            // CET = ET + 6 (Hiver) / CET = ET + 5 (Été)
            // On prend 15:30 - 22:00 CET
            const marketOpen = 15 * 60 + 30; // 15:30 CET
            const marketClose = 22 * 60; // 22:00 CET
            return (currentTime >= marketOpen && currentTime <= marketClose);
        }
        
        // Catégorie inconnue, on suppose fermé par sécurité
        return false;
    }

    // ==========================================================
    // === NOUVELLE FONCTION : getAssetCategory
    // ==========================================================
    // Détermine la catégorie de marché (EUR, USA, CRYPTO) d'un ticker
    getAssetCategory(ticker, assetType) {
        const upperTicker = ticker.toUpperCase();

        if (assetType === 'Crypto') {
            return 'CRYPTO';
        }
        
        // Si 'assetType' n'est pas fourni, on le cherche
        if (!assetType) {
             const purchase = this.purchases.find(p => p.ticker.toUpperCase() === upperTicker);
             if (purchase?.assetType === 'Crypto') return 'CRYPTO';
        }

        // Si c'est un Stock/ETF, on devine le marché
        const yahooSymbol = YAHOO_MAP[upperTicker] || upperTicker;
        
        if (USD_TICKERS.has(upperTicker)) {
             return 'USA';
        }

        // Tickers US (ex: AAPL, GOOG) n'ont pas d'extension
        if (!yahooSymbol.includes('.') && 
             !yahooSymbol.endsWith('-EUR') &&
             yahooSymbol !== 'BTC' // Exclure BTC au cas où
            ) {
            return 'USA';
        }
        
        // Tout le reste (.PA, .F, .AS, etc.) est EUR
        return 'EUR';
    }


    // === OBTENIR L'ÂGE DU PRIX ===
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