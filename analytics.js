// ========================================
// analytics.js - (SIMPLIFIÉ - DÉLÈGUE À DATAMANAGER)
// ========================================

// Note: Ce fichier n'a plus besoin de USD_TO_EUR_RATE
// import { USD_TO_EUR_RATE } from './config.js';

export class PortfolioAnalytics {
    
    // === CHANGEMENT 1 : Accepter dataManager au lieu de storage ===
    constructor(dataManager) {
        this.dataManager = dataManager;
        this.storage = dataManager.storage; // Accès si nécessaire
    }

    // === CHANGEMENT 2 : generateReport délègue tout ===
    generateReport() {
        const purchases = this.storage.getPurchases();
        
        // Le dataManager fait tout le travail !
        return this.dataManager.generateFullReport(purchases);
    }

    // === CHANGEMENT 3 : Export utilise aussi le dataManager ===
    exportReport() {
        // Pas besoin de recalculer, on génère juste le rapport
        const report = this.generateReport();
        
        const blob = new Blob([JSON.stringify(report, null, 2)], { 
            type: 'application/json' 
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `portfolio_report_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }