// ========================================
// marketDataSync.js - Firestore Market Data Synchronization
// ========================================

/**
 * Manages synchronization of market data (prices, daily changes) between devices via Firestore.
 * Implements a "Leader-Follower" strategy where one device refreshes from API and others sync.
 */

import { db, auth } from './firebaseConfig.js';

export class MarketDataSync {
    constructor(storage) {
        this.storage = storage;
        this.db = db;
        this.auth = auth;
        this.userId = null;
        this.unsubscribe = null;

        // Initialize userId from storage auth
        this.auth.onAuthStateChanged((user) => {
            this.userId = user?.uid || null;
            this._read = null;
            this._cachedDocument = null;
            if (user) {
                this.userId = user.uid;
                console.log(`[MarketDataSync] Initialized for user: ${this.userId}`);
            }
        });
    }

    /**
     * Save current market prices to Firestore (batch write)
     * @param {Map<string, Object>} pricesMap - Map of ticker → {price, previousClose, dayChange, dayChangePct, currency}
     * @param {Object} summary - Optional summary KPIs to save alongside prices
     */
    /**
     * Save current market prices to Firestore (Single Document Optimization)
     * @param {Map<string, Object>} pricesMap - Map of ticker → {price, ...}
     * @param {Object} summary - Optional summary KPIs
     */
    async getSnapshotDocument() {
        const uid = this.userId;
        if (!uid) return null;
        if (this._cachedDocument?.uid === uid && Date.now() - this._cachedDocument.at < 30000) return this._cachedDocument.doc;
        if (this._read?.uid === uid) return this._read.promise;
        const promise = this.db.collection('users').doc(uid).collection('marketData').doc('snapshot').get()
            .then(doc => { if (this.userId === uid) this._cachedDocument = { uid, doc, at: Date.now() }; return doc; })
            .finally(() => { if (this._read?.promise === promise) this._read = null; });
        this._read = { uid, promise };
        return promise;
    }

    async loadCanonicalSnapshot() {
        if (!this.userId) return null;
        const doc = await this.db.collection('users').doc(this.userId).collection('cache').doc('canonicalSnapshotV2').get();
        return doc.exists ? doc.data().payload : null;
    }
    async saveCanonicalSnapshot(payload) {
        if (!this.userId || payload.userId !== this.userId) return;
        // Store one serialized envelope: Map encoding and all dependency versions
        // travel atomically. Keep large graph payloads local when over the budget.
        const serialized = JSON.stringify(payload);
        if (new TextEncoder().encode(serialized).length > 700000) return;
        await this.db.collection('users').doc(this.userId).collection('cache').doc('canonicalSnapshotV2').set({ payload: serialized });
    }

    async saveCurrentPrices(pricesMap, summary = null) {
        if (!this.userId) return;

        try {
            // Convert Map to Object for Firestore
            const pricesObj = {};
            pricesMap.forEach((data, ticker) => {
                pricesObj[ticker] = {
                    price: data.price || 0,
                    previousClose: data.previousClose ?? null,
                    dayChange: data.dayChange ?? null,
                    dayChangePct: data.dayChangePct ?? null,
                    currency: data.currency || 'EUR',
                    source: data.source || 'API',
                    lastUpdated: data.lastUpdate || data.lastUpdated || 0
                };
            });

            // Create single payload
            const payload = {
                prices: pricesObj,
                metadata: {
                    lastRefreshTimestamp: Date.now(),
                    lastRefreshDevice: this.getDeviceType(),
                    tickerCount: pricesMap.size
                },
                summary: summary || null
            };

            // Write to a SINGLE document
            await this.db.collection('users').doc(this.userId)
                .collection('marketData').doc('snapshot').set(payload);

            this._cachedDocument = null;
            console.log(`[MarketDataSync] Saved snapshot (${pricesMap.size} tickers) to Firestore (1 Write)`);
        } catch (error) {
            console.error('[MarketDataSync] Error saving snapshot:', error);
        }
    }

    /**
     * Save calculated summary KPIs to Firestore
     * (Merged into saveCurrentPrices, but kept for compatibility if called separately)
     */
    async saveSummaryKPIs(summary) {
        if (!this.userId) return;
        // In the new optimized flow, summary is usually saved with prices.
        // If called separately, we merge it into the snapshot.
        try {
            await this.db.collection('users').doc(this.userId)
                .collection('marketData').doc('snapshot').set({
                    summary: summary
                }, { merge: true });
        } catch (error) {
            console.error('[MarketDataSync] Error saving summary:', error);
        }
    }

    /**
     * Load summary KPIs
     */
    async loadSummaryKPIs() {
        if (!this.userId) return null;
        try {
            const doc = await this.getSnapshotDocument();
            if (doc?.exists && doc.data().summary) {
                return doc.data().summary;
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Load current market prices from Firestore
     * @returns {Map<string, Object>|null} Map of ticker → price data
     */
    async loadCurrentPrices() {
        if (!this.userId) return null;

        try {
            const doc = await this.getSnapshotDocument();

            if (!doc?.exists || !doc.data().prices) {
                console.log('[MarketDataSync] No snapshot found');
                return null;
            }

            const data = doc.data();
            const pricesMap = new Map();
            Object.entries(data.prices).forEach(([ticker, priceData]) => {
                pricesMap.set(ticker, priceData);
            });

            console.log(`[MarketDataSync] Loaded ${pricesMap.size} prices from snapshot`);
            return pricesMap;
        } catch (error) {
            console.error('[MarketDataSync] Error loading prices:', error);
            return null;
        }
    }

    /**
     * Check if should refresh (Leader election)
     */
    async shouldRefreshPrices() {
        if (!this.userId) return true;

        try {
            const doc = await this.getSnapshotDocument();

            if (!doc?.exists || !doc.data().metadata) {
                console.log('[MarketDataSync] No metadata - becoming leader');
                return true;
            }

            const meta = doc.data().metadata;
            const age = Date.now() - meta.lastRefreshTimestamp;

            if (age >= 30000) { // 30s
                return true;
            }

            return false;
        } catch (error) {
            return true;
        }
    }

    /**
     * Realtime Sync Listener
     */
    setupRealtimeSync(onRefreshCallback) {
        if (!this.userId) return () => { };

        console.log('[MarketDataSync] Listening to snapshot updates...');
        this.unsubscribe = this.db.collection('users').doc(this.userId)
            .collection('marketData').doc('snapshot')
            .onSnapshot(doc => {
                if (doc?.exists) {
                    const data = doc.data();
                    if (!data.metadata) return;

                    const device = data.metadata.lastRefreshDevice;
                    const currentDevice = this.getDeviceType();

                    if (device !== currentDevice) {
                        console.log(`[MarketDataSync] 🔄 Sync triggered by ${device}`);
                        if (data.prices) {
                            const pricesMap = new Map(Object.entries(data.prices));
                            this.storage.applyCachedPrices(pricesMap);
                        }
                        onRefreshCallback();
                    }
                }
            });

        return this.unsubscribe;
    }

    stopRealtimeSync() {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
    }

    getDeviceType() {
        return navigator.userAgent.includes('Mobile') ? 'mobile' : 'desktop';
    }

    isCacheTooOld(pricesMap) {
        if (!pricesMap || pricesMap.size === 0) return true;
        // In this new model, we can trust the 'lastUpdated' of the first item
        // or just rely on shouldRefreshPrices logic.
        // But for safety:
        const firstEntry = pricesMap.values().next().value;
        if (!firstEntry) return true;

        // Use global timestamp if available, else item timestamp
        const ts = firstEntry.lastUpdated || firstEntry.timestamp || 0;
        return (Date.now() - ts) > 120000; // 2 mins
    }
}
