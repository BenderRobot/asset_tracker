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
            cash: 0,
            source: null,      // 'graph' or null
            timestamp: null,
            snapshotStartedAt: null, // voir garde anti-race ci-dessous
            // Invariant H (audit SSOT) : identifiant du PortfolioSnapshot canonique
            // (dataManager.buildPortfolioSnapshot) dont TOUS les champs ci-dessus
            // proviennent pour ce rendu — jamais un mélange de deux instants.
            snapshotId: null,
            period: null       // '1d', '1w', etc.
        };

        this.listeners = [];
        console.log('[PortfolioKPIs] Initialized');
    }

    updateFromSnapshot(snapshot, { period = '1d', snapshotStartedAt = null } = {}) {
        if (!snapshot || snapshot.status !== 'valid') return;
        const startedAt = snapshotStartedAt ?? snapshot.snapshotStartedAt ?? snapshot.generatedAt ?? null;
        if (startedAt != null && this.kpis.snapshotStartedAt != null && startedAt < this.kpis.snapshotStartedAt) return;
        this.kpis = {
            totalValue: snapshot.totalValue,
            totalReturn: snapshot.totalReturn,
            totalReturnPct: snapshot.totalReturnPct,
            varToday: snapshot.dayPnl,
            varTodayPct: snapshot.dayPnlPct,
            invested: snapshot.invested,
            cash: snapshot.cash,
            source: 'snapshot',
            timestamp: Date.now(),
            snapshotStartedAt: startedAt,
            snapshotId: snapshot.snapshotId,
            period
        };
        this.notifyListeners();
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
        return this.kpis.source === 'snapshot';
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
            cash: 0,
            source: null,
            timestamp: null,
            snapshotStartedAt: null,
            snapshotId: null,
            period: null
        };
        console.log('[PortfolioKPIs] Reset');
    }
}

// Global singleton instance
export const portfolioKPIs = new PortfolioKPIs();
