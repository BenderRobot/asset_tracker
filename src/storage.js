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
import { MarketDataSync } from './marketDataSync.js?v=2'; // NEW: Market data sync module

// On importe l'eventBus pour notifier l'app qu'un autre onglet a changé les données
import { eventBus } from './eventBus.js';

export class Storage {
    constructor() {
        this.purchases = this.loadPurchases();
        this.watchlist = this.loadWatchlist();
        this.watchlistGroups = this.loadWatchlistGroups();
        this.currentData = this.loadCurrentData();
        this.priceTimestamps = this.loadTimestamps();

        // Index pour recherche rapide
        this.purchaseIndex = this.buildIndex();
        this.conversionRates = this.loadConversionRates();

        // NEW: Initialize market data synchronization
        this.marketDataSync = new MarketDataSync(this);
        console.log('[Storage] MarketDataSync initialized');

        // === FIRESTORE SYNC ===
        this.unsubscribeFirestore = null;
        this.unsubscribeWatchlistFirestore = null;

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
                if (this.unsubscribeWatchlistFirestore) {
                    this.unsubscribeWatchlistFirestore();
                    this.unsubscribeWatchlistFirestore = null;
                }
                if (this.unsubscribeGroupsFirestore) {
                    this.unsubscribeGroupsFirestore();
                    this.unsubscribeGroupsFirestore = null;
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
            if (e.key === 'watchlist' && e.newValue) {
                console.log('🔄 Sync: Watchlist mise à jour par un autre onglet');
                this.watchlist = JSON.parse(e.newValue);
                window.dispatchEvent(new Event('watchlist-updated'));
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

        // Écoute temps réel Watchlist
        this.unsubscribeWatchlistFirestore = db.collection('users').doc(user.uid).collection('watchlist')
            .onSnapshot(snapshot => {
                const remoteWatchlist = [];
                snapshot.forEach(doc => {
                    remoteWatchlist.push({ ...doc.data(), firestoreId: doc.id });
                });
                this.watchlist = remoteWatchlist;
                this.saveWatchlist();
                console.log(`🔄 Firestore: ${remoteWatchlist.length} actions suivies chargées.`);
                window.dispatchEvent(new Event('watchlist-updated'));
            }, error => console.error("Erreur sync Firestore Watchlist:", error));

        // Écoute temps réel Watchlist Groups
        this.unsubscribeGroupsFirestore = db.collection('users').doc(user.uid).collection('watchlistGroups')
            .onSnapshot(snapshot => {
                const remoteGroups = [];
                snapshot.forEach(doc => {
                    remoteGroups.push({ ...doc.data(), firestoreId: doc.id });
                });
                this.watchlistGroups = remoteGroups;
                this.saveWatchlistGroups();
                console.log(`🔄 Firestore: ${remoteGroups.length} groupes watchlist chargés.`);
                window.dispatchEvent(new Event('watchlist-groups-updated'));
            }, error => console.error("Erreur sync Firestore Groups:", error));
    }

    // === CHARGEMENT OPTIMISÉ ===
    loadWatchlist() {
        try {
            const data = localStorage.getItem('watchlist');
            return data ? JSON.parse(data) : [];
        } catch (e) { return []; }
    }
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

    // === GESTION CACHE MARKET DATA (Firestore) ===
    async getMarketData(ticker, interval, year = null) {
        const user = auth.currentUser;
        if (!user) return null;

        const docId = year ? `${ticker}_${interval}_${year}` : `${ticker}_${interval}`;

        // 1. Essai Cache Privé User
        try {
            const userDoc = await db.collection('users').doc(user.uid).collection('market_cache').doc(docId).get();

            if (userDoc.exists) {
                const data = userDoc.data();
                // FIX: Support des objets {t,p} pour contourner "Nested Arrays"
                if (data.data && data.data.length > 0 && !Array.isArray(data.data[0])) {
                    data.data = data.data.map(item => [item.t, item.p]);
                }
                return data;
            }
            return null;
        } catch (e) {
            console.warn(`[Storage] Cache miss/error for ${docId}:`, e);
            return null;
        }
    }

    async saveMarketData(ticker, interval, data, year = null) {
        const user = auth.currentUser;
        if (!user) return;

        const docId = year ? `${ticker}_${interval}_${year}` : `${ticker}_${interval}`;

        // FIX: Flatten Nested Arrays to Objects {t, p}
        const formattedData = data.map(point => ({ t: point[0], p: point[1] }));

        const payload = {
            ticker,
            interval,
            year,
            lastUpdated: Math.floor(Date.now() / 1000),
            data: formattedData
        };

        try {
            await db.collection('users').doc(user.uid).collection('market_cache').doc(docId).set(payload);
            console.log(`[Storage] Market data cached: ${docId} (${formattedData.length} points)`);
        } catch (e) {
            console.error(`[Storage] Failed to cache market data ${docId}:`, e);
        }
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
            batch.commit()
                .then(() => console.log("Batch delete successful"))
                .catch(err => console.error('[Storage] Batch delete failed:', err));
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
                try {
                    localStorage.setItem('purchases', JSON.stringify(this.purchases));
                } catch {
                    console.error('[storage] Quota localStorage dépassé — synchronisation Firestore requise');
                    this.showStorageWarning?.();
                }
            }
        }
    }

    // === GESTION DE LA WATCHLIST ===
    saveWatchlist() {
        try {
            localStorage.setItem('watchlist', JSON.stringify(this.watchlist));
        } catch (e) {
            console.error('Erreur sauvegarde watchlist:', e);
        }
    }

    getWatchlist() {
        return this.watchlist;
    }

    isInWatchlist(ticker) {
        return this.watchlist.some(item => item.ticker === ticker.toUpperCase());
    }

    async addToWatchlist(item) {
        if (!item.ticker || !item.name) throw new Error('Données incomplètes pour la watchlist');

        const ticker = item.ticker.toUpperCase();
        if (this.isInWatchlist(ticker)) return null;

        const newItem = {
            ...item,
            ticker: ticker,
            addedAt: Date.now()
        };

        // 1. Optimiste Local
        this.watchlist.push(newItem);
        this.saveWatchlist();

        // 2. Firestore
        const user = auth.currentUser;
        if (user) {
            try {
                // Use ticker as the Document ID so it's easy to delete or query!
                await db.collection('users').doc(user.uid).collection('watchlist').doc(ticker).set(newItem);
                console.log(`[Storage] Watchlist item ${ticker} added to Firestore`);
                return true;
            } catch (error) {
                console.error("Error adding to watchlist: ", error);
                this.watchlist = this.watchlist.filter(w => w.ticker !== ticker);
                this.saveWatchlist();
                throw error;
            }
        }
        return false;
    }

    async removeFromWatchlist(ticker) {
        const upperTicker = ticker.toUpperCase();
        if (!this.isInWatchlist(upperTicker)) return false;

        // 1. Suppression Locale
        this.watchlist = this.watchlist.filter(item => item.ticker !== upperTicker);
        this.saveWatchlist();

        // 2. Suppression Firestore
        const user = auth.currentUser;
        if (user) {
            try {
                await db.collection('users').doc(user.uid).collection('watchlist').doc(upperTicker).delete();
                console.log(`[Storage] Watchlist item ${upperTicker} removed from Firestore`);
                return true;
            } catch (error) {
                console.error("Error removing from watchlist: ", error);
            }
        }
        return false;
    }


    async updateWatchlistData(ticker, data) {
        const upperTicker = ticker.toUpperCase();
        if (!this.isInWatchlist(upperTicker)) return false;

        // 1. Update Locally
        const idx = this.watchlist.findIndex(i => i.ticker === upperTicker);
        if (idx !== -1) {
            this.watchlist[idx] = { ...this.watchlist[idx], ...data };
            this.saveWatchlist();
            // Dispatch locally to trigger UI updates without waiting for firestore roundtrip sometimes
            window.dispatchEvent(new CustomEvent('watchlist-updated'));
        }

        // 2. Update Firestore
        const user = auth.currentUser;
        if (user) {
            const item = this.watchlist.find(i => i.ticker === upperTicker);
            try {
                await db.collection('users').doc(user.uid).collection('watchlist').doc(upperTicker).update(data);
                console.log(`[Storage] Watchlist item ${upperTicker} updated in Firestore`);
                return true;
            } catch (error) {
                // If it doesn't exist, we fallback to set
                if (item) {
                    try {
                        await db.collection('users').doc(user.uid).collection('watchlist').doc(upperTicker).set(item);
                        return true;
                    } catch (e) { }
                }
                console.error("Error updating watchlist data: ", error);
            }
        }
        return false;
    }

    // === GESTION DES PRIX AVEC CACHE INTELLIGENT ===
    getCurrentPrice(ticker) {
        // On retourne directement la donnée mémoire (qui est maintenant synchro)
        return this.currentData[ticker.toUpperCase()];
    }

    setCurrentPrice(ticker, data) {
        const upperTicker = ticker.toUpperCase();
        const existingData = this.currentData[upperTicker];

        const parsedPrice = Number(data?.price);
        const parsedPreviousClose = Number(data?.previousClose);
        const parsedLastTradingDayClose = Number(data?.lastTradingDayClose);

        // Vérifier si le nouveau prix est valide (nombre > 0)
        const isNewPriceValid = data && !Number.isNaN(parsedPrice) && parsedPrice > 0;

        if (isNewPriceValid) {
            data = {
                ...data,
                price: parsedPrice,
                previousClose: !Number.isNaN(parsedPreviousClose) ? parsedPreviousClose : null,
                lastTradingDayClose: !Number.isNaN(parsedLastTradingDayClose) ? parsedLastTradingDayClose : null
            };

            // CONVERSION USD → EUR À LA SOURCE
            // Les indices (^GSPC), futures (GC=F), et forex (EURUSD=X) ne doivent PAS être convertis
            const isIndex = upperTicker.startsWith('^');
            const isFuture = upperTicker.endsWith('=F');
            const isForex = upperTicker.endsWith('=X');
            const shouldNotConvert = isIndex || isFuture || isForex;

            if (data.currency === 'USD' && !shouldNotConvert) {
                const rate = this.getConversionRate('USD_TO_EUR') || 0.925;
                data = {
                    ...data,
                    price: data.price * rate,
                    previousClose: data.previousClose ? data.previousClose * rate : null,
                    lastTradingDayClose: data.lastTradingDayClose ? data.lastTradingDayClose * rate : null,
                    originalCurrency: 'USD',
                    currency: 'EUR'
                };
            }

            // Cas 1 : Nouveau prix valide. On écrase l'ancienne donnée.
            this.currentData[upperTicker] = data;
        } else if (existingData) {
            // Cas 2 : Nouveau prix invalide (API down), mais on a un prix en cache.
            // On conserve l'ancienne donnée existante, mais on met à jour le timestamp 
            // pour ne pas tenter un nouveau rafraîchissement immédiat.
            this.priceTimestamps[upperTicker] = Date.now();
            this.savePricesCache();
            return;
        } else {
            // Cas 3 : Ni données existantes ni nouveau prix. On ne fait rien.
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
        const trimmed = this.purchases.filter(p => new Date(p.date).getTime() > twoYearsAgo);
        try {
            localStorage.setItem('purchases', JSON.stringify(trimmed));
        } catch (e) {
            console.warn('[Storage] cleanOldData: localStorage save failed', e);
        }
    }

    // === UTILITAIRES ===
    getRowKey(purchase) {
        // On utilise l'ID Firestore s'il existe pour une identification unique
        if (purchase.firestoreId) return purchase.firestoreId;

        // Fallback : inclure addedAt pour différencier deux DCA identiques le même jour
        const ts = purchase.addedAt || '';
        return `${purchase.ticker.toUpperCase()}|${purchase.date}|${purchase.price}|${purchase.quantity}|${ts}`;
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
        const purchase = this.purchases.find(p => p.ticker.toUpperCase() === upperTicker);
        if (assetType === 'Crypto') return 'CRYPTO';
        if (!assetType) {
            if (purchase?.assetType === 'Crypto') return 'CRYPTO';
        }
        const yahooSymbol = YAHOO_MAP[upperTicker] || upperTicker;
        if (purchase?.currency === 'EUR' && assetType !== 'Crypto') return 'EUR';
        if (purchase?.currency === 'USD') return 'USA';
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
        // Garde-fou : un taux USD/EUR hors [0.5, 1.5] est forcément corrompu (ex: mauvaise réponse API)
        if (rateData && rateData.rate > 0.5 && rateData.rate < 1.5) return rateData.rate;
        return null;
    }

    setConversionRate(pair, rate) {
        if (!(rate > 0.5 && rate < 1.5)) return; // Rejette un taux implausible avant qu'il ne pollue le cache
        this.conversionRates[pair.toUpperCase()] = { rate: rate, timestamp: Date.now() };
        try {
            localStorage.setItem('conversionRates', JSON.stringify(this.conversionRates));
        } catch (e) { }
    }

    // === MARKET DATA SYNC (Firestore) ===

    /**
     * Load current market prices from Firestore
     * Wrapper for marketDataSync.loadCurrentPrices()
     * @returns {Promise<Map<string, Object>|null>}
     */
    async loadCurrentPrices() {
        return await this.marketDataSync.loadCurrentPrices();
    }

    /**
     * Apply cached prices from Firestore to local storage
     * @param {Map<string, Object>} pricesMap - Map of ticker → price data
     */
    applyCachedPrices(pricesMap) {
        if (!pricesMap || pricesMap.size === 0) return;

        pricesMap.forEach((data, ticker) => {
            this.setCurrentPrice(ticker, data);
        });

        console.log(`[Storage] Applied ${pricesMap.size} cached prices from Firestore`);
    }

    // === GESTION RÉSIDENCE PRINCIPALE (NOUVEAU) ===

    /**
     * Sauvegarde la résidence principale
     * @param {Object} residence - { id, name, purchasePrice, currentValue, purchaseDate, credits: [...] }
     */
    async savePrimaryResidence(residence) {
        // Ajout ID unique si pas déjà présent
        if (!residence.id) {
            residence.id = `residence_${Date.now()}`;
        }

        // 1. Sauvegarde Locale
        localStorage.setItem('assetTracker_primaryResidence', JSON.stringify(residence));

        // 2. Sauvegarde Firestore
        const user = auth.currentUser;
        if (user) {
            try {
                await db.collection('users').doc(user.uid).collection('settings')
                    .doc('primaryResidence').set(residence);
                console.log('[Storage] Primary residence saved to Firestore');
            } catch (error) {
                console.error('[Storage] Error saving primary residence to Firestore:', error);
            }
        }

        // 3. Notifier les autres onglets
        window.dispatchEvent(new Event('residence-updated'));
    }

    /**
     * Récupère la résidence principale
     * @returns {Object|null} Résidence principale ou null
     */
    getPrimaryResidence() {
        try {
            const data = localStorage.getItem('assetTracker_primaryResidence');
            return data ? JSON.parse(data) : null;
        } catch (e) {
            console.error('[Storage] Error loading primary residence:', e);
            return null;
        }
    }

    /**
     * Supprime la résidence principale
     */
    async deletePrimaryResidence() {
        // 1. Suppression Locale
        localStorage.removeItem('assetTracker_primaryResidence');

        // 2. Suppression Firestore
        const user = auth.currentUser;
        if (user) {
            try {
                await db.collection('users').doc(user.uid).collection('settings')
                    .doc('primaryResidence').delete();
                console.log('[Storage] Primary residence deleted from Firestore');
            } catch (error) {
                console.error('[Storage] Error deleting primary residence from Firestore:', error);
            }
        }

        // 3. Notifier les autres onglets
        window.dispatchEvent(new Event('residence-updated'));
    }

    /**
     * Charge la résidence depuis Firestore (au démarrage)
     */
    async loadPrimaryResidenceFromFirestore() {
        const user = await new Promise(resolve => {
            const unsub = auth.onAuthStateChanged(u => { unsub(); resolve(u); });
        });
        if (!user) return null;

        try {
            const doc = await db.collection('users').doc(user.uid).collection('settings')
                .doc('primaryResidence').get();

            if (doc.exists) {
                const residence = doc.data();
                // Sauvegarder en local pour cache
                localStorage.setItem('assetTracker_primaryResidence', JSON.stringify(residence));
                return residence;
            }
            return null;
        } catch (error) {
            console.error('[Storage] Error loading primary residence from Firestore:', error);
            return null;
        }
    }

    // === GESTION DES GROUPES DE WATCHLIST ===
    loadWatchlistGroups() {
        try {
            const data = localStorage.getItem('watchlistGroups');
            return data ? JSON.parse(data) : [];
        } catch (e) {
            console.error('Erreur chargement groupes watchlist:', e);
            return [];
        }
    }

    saveWatchlistGroups() {
        try {
            localStorage.setItem('watchlistGroups', JSON.stringify(this.watchlistGroups || []));
        } catch (e) {
            console.error('Erreur sauvegarde groupes watchlist:', e);
        }
    }

    getWatchlistGroups() {
        if (!this.watchlistGroups) {
            this.watchlistGroups = this.loadWatchlistGroups();
        }
        return this.watchlistGroups;
    }

    async addWatchlistGroup(groupName) {
        if (!this.watchlistGroups) {
            this.watchlistGroups = this.loadWatchlistGroups();
        }

        const newGroup = {
            id: Date.now().toString(),
            name: groupName,
            tickers: [],
            createdAt: Date.now()
        };

        this.watchlistGroups.push(newGroup);
        this.saveWatchlistGroups();

        // Sauvegarder dans Firestore si utilisateur connecté
        const user = auth.currentUser;
        if (user) {
            try {
                await db.collection('users').doc(user.uid).collection('watchlistGroups').doc(newGroup.id).set(newGroup);
            } catch (e) {
                console.error('Erreur sauvegarde groupe Firestore:', e);
            }
        }

        window.dispatchEvent(new Event('watchlist-groups-updated'));
        return newGroup;
    }

    async updateWatchlistGroup(groupId, updates) {
        if (!this.watchlistGroups) {
            this.watchlistGroups = this.loadWatchlistGroups();
        }

        const groupIdx = this.watchlistGroups.findIndex(g => g.id === groupId);
        if (groupIdx === -1) return false;

        this.watchlistGroups[groupIdx] = {
            ...this.watchlistGroups[groupIdx],
            ...updates,
            updatedAt: Date.now()
        };

        this.saveWatchlistGroups();

        // Sauvegarder dans Firestore si utilisateur connecté
        const user = auth.currentUser;
        if (user) {
            try {
                await db.collection('users').doc(user.uid).collection('watchlistGroups').doc(groupId).set(this.watchlistGroups[groupIdx]);
            } catch (e) {
                console.error('Erreur update groupe Firestore:', e);
            }
        }

        window.dispatchEvent(new Event('watchlist-groups-updated'));
        return true;
    }

    async deleteWatchlistGroup(groupId) {
        if (!this.watchlistGroups) {
            this.watchlistGroups = this.loadWatchlistGroups();
        }

        this.watchlistGroups = this.watchlistGroups.filter(g => g.id !== groupId);
        this.saveWatchlistGroups();

        // Supprimer de Firestore si utilisateur connecté
        const user = auth.currentUser;
        if (user) {
            try {
                await db.collection('users').doc(user.uid).collection('watchlistGroups').doc(groupId).delete();
            } catch (e) {
                console.error('Erreur suppression groupe Firestore:', e);
            }
        }

        window.dispatchEvent(new Event('watchlist-groups-updated'));
        return true;
    }

    async addTickerToGroup(groupId, ticker) {
        if (!this.watchlistGroups) {
            this.watchlistGroups = this.loadWatchlistGroups();
        }

        const group = this.watchlistGroups.find(g => g.id === groupId);
        if (!group) return false;

        if (!group.tickers.includes(ticker)) {
            group.tickers.push(ticker);
            this.saveWatchlistGroups();

            // Sauvegarder dans Firestore
            const user = auth.currentUser;
            if (user) {
                try {
                    await db.collection('users').doc(user.uid).collection('watchlistGroups').doc(groupId).set(group);
                } catch (e) {
                    console.error('Erreur update groupe Firestore:', e);
                }
            }

            window.dispatchEvent(new Event('watchlist-groups-updated'));
        }
        return true;
    }

    async removeTickerFromGroup(groupId, ticker) {
        if (!this.watchlistGroups) {
            this.watchlistGroups = this.loadWatchlistGroups();
        }

        const group = this.watchlistGroups.find(g => g.id === groupId);
        if (!group) return false;

        group.tickers = group.tickers.filter(t => t !== ticker);
        this.saveWatchlistGroups();

        // Sauvegarder dans Firestore
        const user = auth.currentUser;
        if (user) {
            try {
                await db.collection('users').doc(user.uid).collection('watchlistGroups').doc(groupId).set(group);
            } catch (e) {
                console.error('Erreur update groupe Firestore:', e);
            }
        }

        window.dispatchEvent(new Event('watchlist-groups-updated'));
        return true;
    }
}