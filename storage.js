// ========================================
// storage.js - (v6 - Firestore Integration)
// ========================================

import {
    CACHE_EXPIRY_STOCKS_MARKET_OPEN,
    CACHE_EXPIRY_STOCKS_MARKET_CLOSED,
    CACHE_EXPIRY_CRYPTO,
    YAHOO_MAP,
    USD_TICKERS
} from './config.js';

import { db, auth } from './firebaseConfig.js';

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

        // === FIRESTORE SYNC ===
        this.unsubscribeFirestore = null;

        auth.onAuthStateChanged(user => {
            if (user) {
                console.log("Storage: User logged in, syncing with Firestore...");
                this.initFirestoreSync(user);
            } else {
                console.log("Storage: User logged out.");
                if (this.unsubscribeFirestore) {
                    this.unsubscribeFirestore();
                    this.unsubscribeFirestore = null;
                }
                // Optionnel : Vider les données locales à la déconnexion pour sécurité
                // this.purchases = []; 
                // this.savePurchases();
            }
        });

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

    // === FIRESTORE LOGIC ===
    initFirestoreSync(user) {
        // Écoute temps réel des changements Firestore
        this.unsubscribeFirestore = db.collection('users').doc(user.uid).collection('purchases')
            .onSnapshot(snapshot => {
                const remotePurchases = [];
                snapshot.forEach(doc => {
                    remotePurchases.push({
                        ...doc.data(),
                        firestoreId: doc.id // On garde l'ID Firestore
                    });
                });

                // Mise à jour locale
                this.purchases = remotePurchases;
                this.savePurchases(); // Sauvegarde aussi en localStorage pour cache
                this.rebuildIndex();

                console.log(`🔄 Firestore: ${remotePurchases.length} transactions chargées.`);

                // Notifier l'UI qu'il faut se rafraîchir
                window.dispatchEvent(new Event('purchases-updated'));
            }, error => {
                console.error("Erreur sync Firestore:", error);
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

    async addPurchase(purchase) {
        if (!purchase.ticker || !purchase.name || !purchase.price ||
            !purchase.date || !purchase.quantity) {
            throw new Error('Données incomplètes');
        }

        const newPurchase = {
            ...purchase,
            ticker: purchase.ticker.toUpperCase(),
            price: parseFloat(purchase.price),
            quantity: parseFloat(purchase.quantity),
            addedAt: Date.now()
        };

        // 1. Ajout Optimiste Local
        this.purchases.push(newPurchase);
        this.savePurchases();
        this.rebuildIndex();

        // 2. Ajout Firestore
        const user = auth.currentUser;
        if (user) {
            console.log(`[Storage] Writing to: users/${user.uid}/purchases`);
            try {
                const docRef = await db.collection('users').doc(user.uid).collection('purchases').add(newPurchase);
                console.log("Document written with ID: ", docRef.id);
                return docRef;
            } catch (error) {
                console.error("Error adding document: ", error);
                // ROLLBACK: On annule l'ajout local si ça échoue en ligne
                this.removePurchase(this.getRowKey(newPurchase));
                throw error; // Propager l'erreur pour que l'appelant sache
            }
        } else {
            console.warn("Utilisateur non connecté, sauvegarde locale uniquement.");
            return null;
        }
    }

    updatePurchase(key, updates) {
        const idx = this.purchaseIndex.get(key);
        if (idx === undefined) return false;

        const purchaseToUpdate = this.purchases[idx];
        const updatedPurchase = {
            ...purchaseToUpdate,
            ...updates,
            updatedAt: Date.now()
        };

        // 1. Mise à jour Locale
        this.purchases[idx] = updatedPurchase;
        this.savePurchases();
        this.rebuildIndex();

        // 2. Mise à jour Firestore
        const user = auth.currentUser;
        if (user && purchaseToUpdate.firestoreId) {
            db.collection('users').doc(user.uid).collection('purchases').doc(purchaseToUpdate.firestoreId).update(updates)
                .then(() => console.log("Document successfully updated!"))
                .catch(error => console.error("Error updating document: ", error));
        } else {
            console.warn("Impossible de mettre à jour sur Firestore (pas d'ID ou pas connecté)");
        }

        return true;
    }

    removePurchase(key) {
        const idx = this.purchaseIndex.get(key);
        if (idx === undefined) return false;

        const purchaseToRemove = this.purchases[idx];

        // 1. Suppression Locale
        this.purchases.splice(idx, 1);
        this.savePurchases();
        this.rebuildIndex();

        // 2. Suppression Firestore
        const user = auth.currentUser;
        if (user && purchaseToRemove.firestoreId) {
            db.collection('users').doc(user.uid).collection('purchases').doc(purchaseToRemove.firestoreId).delete()
                .then(() => console.log("Document successfully deleted!"))
                .catch(error => console.error("Error removing document: ", error));
        }

        return true;
    }

    removePurchases(keys) {
        const keysArray = Array.from(keys);

        // On récupère les IDs Firestore avant de supprimer localement
        const idsToDelete = [];
        keysArray.forEach(key => {
            const idx = this.purchaseIndex.get(key);
            if (idx !== undefined && this.purchases[idx].firestoreId) {
                idsToDelete.push(this.purchases[idx].firestoreId);
            }
        });

        // 1. Suppression Locale
        this.purchases = this.purchases.filter(p =>
            !keysArray.includes(this.getRowKey(p))
        );
        this.savePurchases();
        this.rebuildIndex();

        // 2. Suppression Firestore (Batch)
        const user = auth.currentUser;
        if (user && idsToDelete.length > 0) {
            const batch = db.batch();
            idsToDelete.forEach(id => {
                const ref = db.collection('users').doc(user.uid).collection('purchases').doc(id);
                batch.delete(ref);
            });
            batch.commit().then(() => console.log("Batch delete successful"));
        }
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
        const existingData = this.currentData[upperTicker];

        // VÃ©rifier si le nouveau prix est valide (non null, non undefined et non zÃ©ro)
        const isNewPriceValid = data &&
            data.price !== null &&
            data.price !== undefined &&
            data.price !== 0;

        if (isNewPriceValid) {
            // Cas 1 : Nouveau prix valide. On Ã©crase l'ancienne donnÃ©e.
            this.currentData[upperTicker] = data;
        } else if (existingData) {
            // Cas 2 : Nouveau prix invalide (API down), mais on a un prix en cache.
            // On conserve l'ancienne donnÃ©e existante, mais on met Ã  jour le timestamp 
            // pour ne pas tenter un nouveau rafraÃ®chissement immÃ©diat.
            this.priceTimestamps[upperTicker] = Date.now();
            this.savePricesCache();
            return;
        } else {
            // Cas 3 : Ni donnÃ©es existantes ni nouveau prix. On ne fait rien.
            return;
        }

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
            .sort(([, a], [, b]) => b - a)
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
        // On utilise l'ID Firestore s'il existe pour une identification unique
        if (purchase.firestoreId) return purchase.firestoreId;

        // Fallback sur l'ancienne méthode pour compatibilité
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
        } catch (e) { }
    }
}