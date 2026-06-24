import { auth } from './firebase.js';
import { MarketDataSync } from './marketDataSync.js';

/**
 * Centralized Portfolio Summary Calculator
 * Single source of truth for all portfolio KPIs
 * Calculates once, saves to Firestore, and serves to all pages
 */
export class PortfolioSummaryService {
    constructor(storage, dataManager) {
        this.storage = storage;
        this.dataManager = dataManager;
        this.marketDataSync = storage.marketDataSync;
        this.cachedSummary = null;
        this.cacheTimestamp = 0;
        this.CACHE_VALIDITY_MS = 5000; // 5 seconds local cache
    }

    /**
     * Get portfolio summary - single source of truth
     * @returns {Promise<Object>} Portfolio summary with all KPIs
     */
    async getPortfolioSummary() {
        // Check local cache first (5sec validity)
        if (this.cachedSummary && (Date.now() - this.cacheTimestamp < this.CACHE_VALIDITY_MS)) {
            console.log('[PortfolioService] Using local cache');
            return this.cachedSummary;
        }

        // Check if we should calculate fresh or use Firestore
        const shouldCalculate = await this.marketDataSync.shouldRefreshPrices();

        if (shouldCalculate) {
            // Calculate fresh summary
            console.log('[PortfolioService] Calculating fresh summary');
            const summary = await this.calculateFreshSummary();

            // Save to Firestore
            await this.marketDataSync.saveSummaryKPIs(summary);

            // Cache locally
            this.cachedSummary = summary;
            this.cacheTimestamp = Date.now();

            return summary;
        } else {
            // Load from Firestore
            console.log('[PortfolioService] Loading summary from Firestore');
            const firestoreSummary = await this.marketDataSync.loadSummaryKPIs();

            if (firestoreSummary && firestoreSummary.timestamp) {
                // Convert Firestore format to summary format
                const summary = {
                    totalCurrentEUR: firestoreSummary.totalValue,
                    gainTotal: firestoreSummary.totalReturn,
                    gainPct: firestoreSummary.totalReturnPct,
                    totalDayChangeEUR: firestoreSummary.varToday,
                    dayChangePct: firestoreSummary.varTodayPct,
                    totalInvestedEUR: firestoreSummary.invested,
                    source: 'firestore',
                    timestamp: firestoreSummary.timestamp,
                    device: firestoreSummary.device
                };

                // Cache locally
                this.cachedSummary = summary;
                this.cacheTimestamp = Date.now();

                return summary;
            } else {
                // Fallback: calculate if no Firestore data
                console.warn('[PortfolioService] No Firestore summary, calculating fresh');
                return await this.calculateFreshSummary();
            }
        }
    }

    /**
     * Calculate fresh portfolio summary
     * @returns {Promise<Object>} Calculated summary
     */
    async calculateFreshSummary() {
        const purchases = this.storage.getPurchases();

        // Filter asset purchases (NO cash, NO dividend, NO real estate)
        const assetPurchases = purchases.filter(p => {
            const type = (p.assetType || 'Stock').toLowerCase();
            return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend' && type !== 'real estate';
        });

        // Calculate yesterday close map
        const yesterdayCloseMap = await this.dataManager.calculateAllAssetsYesterdayClose(assetPurchases);

        // Calculate holdings
        const holdings = this.dataManager.calculateHoldings(assetPurchases, yesterdayCloseMap);

        // Calculate summary
        const summary = this.dataManager.calculateSummary(holdings);
        summary.source = 'calculated';
        summary.timestamp = Date.now();

        console.log('[PortfolioService] Fresh summary calculated:', {
            totalValue: summary.totalCurrentEUR,
            totalReturn: summary.gainTotal,
            varToday: summary.totalDayChangeEUR
        });

        return summary;
    }

    /**
     * Invalidate local cache
     */
    invalidateCache() {
        this.cachedSummary = null;
        this.cacheTimestamp = 0;
    }
}
