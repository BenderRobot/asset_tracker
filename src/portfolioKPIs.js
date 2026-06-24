/**
 * PortfolioKPIs - Single Source of Truth for Portfolio KPIs
 * 
 * This class manages all portfolio-level KPIs (Total Value, Total Return, Var Today, etc.)
 * and ensures consistency across all pages (Dashboard, Investments).
 * 
 * CRITICAL RULE: Only the historicalChart can update these KPIs.
 * All other components (Dashboard, Investments) must READ ONLY.
 */

// NOTE: On utilise firebase global (v8 compat CDN) directement dans syncToBender()
// pour éviter les problèmes d'import ES module avec un fichier non-module.

export class PortfolioKPIs {
    constructor() {
        this.kpis = {
            totalValue: 0,
            totalReturn: 0,
            totalReturnPct: 0,
            varToday: 0,
            varTodayPct: 0,
            invested: 0,
            source: null,      // 'graph' or null
            timestamp: null,
            period: null       // '1d', '1w', etc.
        };

        this.listeners = [];
        console.log('[PortfolioKPIs] Initialized');
    }

    /**
     * Update KPIs from graph data
     * CRITICAL: This should ONLY be called by historicalChart.js
     * 
     * @param {Object} graphData - Data from the graph
     * @param {Array} graphData.values - Array of portfolio values over time
     * @param {Number} graphData.invested - Total amount invested
     * @param {Number} graphData.vsYesterdayAbs - Absolute variation vs yesterday
     * @param {Number} graphData.vsYesterdayPct - Percentage variation vs yesterday
     * @param {String} graphData.period - Period ('1d', '1w', etc.)
     */
    updateFromGraph(graphData) {
        const lastValue = this.getLastValidValue(graphData.values);
        if (lastValue === null) {
            console.warn('[PortfolioKPIs] No valid last value in graph data');
            return;
        }

        let finalCash = 0;
        if (graphData.cashDetails) {
            finalCash = graphData.cashDetails.total || 0;
        }
        
        let finalTotalValue = graphData.liveTotalValue !== undefined && graphData.liveTotalValue !== null 
            ? graphData.liveTotalValue 
            : lastValue + finalCash;
            
        const assetValueOnly = finalTotalValue - finalCash;
        
        let totalReturn = graphData.liveTotalReturn !== undefined && graphData.liveTotalReturn !== null
            ? graphData.liveTotalReturn
            : assetValueOnly - graphData.invested;
            
        let totalReturnPct = graphData.liveTotalReturnPct !== undefined && graphData.liveTotalReturnPct !== null
            ? graphData.liveTotalReturnPct
            : (graphData.invested > 0 ? (totalReturn / graphData.invested) * 100 : 0);

        this.kpis = {
            totalValue: finalTotalValue,  // Assets + Cash (Matches Investments Page Snapshot)
            totalReturn: totalReturn,     // Assets Only (Matches Investments Page Snapshot)
            totalReturnPct: totalReturnPct,
            varToday: graphData.vsYesterdayAbs || 0,
            varTodayPct: graphData.vsYesterdayPct || 0,
            invested: graphData.invested,
            source: 'graph',
            timestamp: Date.now(),
            period: graphData.period || 'unknown'
        };

        console.log(`[PortfolioKPIs] ✅ Updated from graph (${this.kpis.period}):`, {
            totalValue: this.kpis.totalValue.toFixed(2),
            totalReturn: this.kpis.totalReturn.toFixed(2),
            varToday: this.kpis.varToday.toFixed(2),
            invested: this.kpis.invested.toFixed(2)
        });

        // Notify all listeners (Dashboard, Investments, etc.)
        this.notifyListeners();

        // Sync to Firestore for Bender Assistant
        this.syncToBender();
    }

    /**
     * Sync KPIs to Firestore for Bender (Voice Assistant)
     * Fire-and-forget : n'attend pas la réponse, ne bloque pas l'UI.
     * Utilise firebase global (v8 compat CDN) pour être sûr que l'instance
     * est toujours disponible quelle que soit l'ordre de chargement des modules.
     */
    syncToBender() {
        try {
            // Accès direct au global Firebase v8 (chargé via CDN avant les modules)
            const fbAuth = (typeof firebase !== 'undefined') ? firebase.auth() : null;
            const fbDb   = (typeof firebase !== 'undefined') ? firebase.firestore() : null;

            if (!fbAuth || !fbDb || !fbAuth.currentUser) {
                console.warn('[PortfolioKPIs] syncToBender: Firebase non disponible ou utilisateur non connecté');
                return;
            }

            const uid = fbAuth.currentUser.uid;
            const metricsRef = fbDb.collection('users').doc(uid)
                                   .collection('liveMetrics').doc('current');

            metricsRef.set({
                totalValue:  Number(this.kpis.totalValue)  || 0,
                totalReturn: Number(this.kpis.totalReturn) || 0,
                varToday:    Number(this.kpis.varToday)    || 0,
                lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true })
            .then(() => {
                console.log('[PortfolioKPIs] ☁️ Metrics synced to Firestore for Bender');
            })
            .catch(err => {
                console.error('[PortfolioKPIs] ❌ Erreur sync Bender:', err);
            });

        } catch (error) {
            console.error('[PortfolioKPIs] ❌ Exception sync Bender:', error);
        }
    }

    /**
     * Get last valid (non-null, non-NaN) value from array
     */
    getLastValidValue(values) {
        if (!values || values.length === 0) return null;

        for (let i = values.length - 1; i >= 0; i--) {
            if (values[i] !== null && !isNaN(values[i])) {
                return values[i];
            }
        }
        return null;
    }

    /**
     * Get current KPIs
     * @returns {Object} Copy of current KPIs
     */
    getKPIs() {
        return { ...this.kpis };
    }

    /**
     * Check if KPIs are available from graph
     * @returns {Boolean}
     */
    isReady() {
        return this.kpis.source === 'graph';
    }

    /**
     * Subscribe to KPI updates
     * @param {Function} callback - Called when KPIs are updated
     */
    addListener(callback) {
        this.listeners.push(callback);
        console.log(`[PortfolioKPIs] Listener added (${this.listeners.length} total)`);

        // If KPIs are already available, notify immediately
        if (this.isReady()) {
            callback(this.getKPIs());
        }
    }

    /**
     * Unsubscribe from KPI updates
     */
    removeListener(callback) {
        const index = this.listeners.indexOf(callback);
        if (index > -1) {
            this.listeners.splice(index, 1);
            console.log(`[PortfolioKPIs] Listener removed (${this.listeners.length} remaining)`);
        }
    }

    /**
     * Notify all listeners of KPI update
     */
    notifyListeners() {
        console.log(`[PortfolioKPIs] Notifying ${this.listeners.length} listeners`);
        const kpis = this.getKPIs();
        // Use requestAnimationFrame so the browser paints KPI DOM updates
        // in the next render frame, BEFORE Chart.js blocks the main thread
        // with heavy canvas drawing. This eliminates the visual delay.
        requestAnimationFrame(() => {
            this.listeners.forEach(callback => {
                try {
                    callback(kpis);
                } catch (error) {
                    console.error('[PortfolioKPIs] Error in listener callback:', error);
                }
            });
        });
    }

    /**
     * Reset KPIs (for testing/debugging)
     */
    reset() {
        this.kpis = {
            totalValue: 0,
            totalReturn: 0,
            totalReturnPct: 0,
            varToday: 0,
            varTodayPct: 0,
            invested: 0,
            source: null,
            timestamp: null,
            period: null
        };
        console.log('[PortfolioKPIs] Reset');
    }
}

// Global singleton instance
export const portfolioKPIs = new PortfolioKPIs();
