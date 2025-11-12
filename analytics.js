// ========================================
// analytics.js - Analyses avancées du portfolio
// ========================================

import { USD_TO_EUR_RATE } from './config.js';

export class PortfolioAnalytics {
    constructor(storage) {
        this.storage = storage;
    }

    // === MÉTRIQUES PRINCIPALES ===
    calculateMetrics(purchases) {
        const assets = this.aggregateByAsset(purchases);
        
        let totalInvestedEUR = 0;
        let totalValueEUR = 0;
        let totalDayChangeEUR = 0;

        const assetMetrics = assets.map(asset => {
            const price = this.storage.getCurrentPrice(asset.ticker);
            const currency = price?.currency || 'EUR';
            const rate = currency === 'USD' ? USD_TO_EUR_RATE : 1;

            const investedEUR = asset.totalInvested * rate;
            const currentValueEUR = price?.price 
                ? price.price * asset.totalQty * rate 
                : 0;
            const gainEUR = currentValueEUR - investedEUR;
            const gainPct = investedEUR > 0 ? (gainEUR / investedEUR) * 100 : 0;

            const dayChangeEUR = price?.previousClose
                ? (price.price - price.previousClose) * asset.totalQty * rate
                : 0;

            totalInvestedEUR += investedEUR;
            totalValueEUR += currentValueEUR;
            totalDayChangeEUR += dayChangeEUR;

            return {
                ...asset,
                investedEUR,
                currentValueEUR,
                gainEUR,
                gainPct,
                dayChangeEUR,
                weight: 0 // Calculé après
            };
        });

        // Calculer le poids de chaque actif
        assetMetrics.forEach(asset => {
            asset.weight = totalValueEUR > 0 
                ? (asset.currentValueEUR / totalValueEUR) * 100 
                : 0;
        });

        const totalGainEUR = totalValueEUR - totalInvestedEUR;
        const totalGainPct = totalInvestedEUR > 0 
            ? (totalGainEUR / totalInvestedEUR) * 100 
            : 0;
        const dayChangePct = totalValueEUR > 0
            ? (totalDayChangeEUR / totalValueEUR) * 100
            : 0;

        return {
            totalInvestedEUR,
            totalValueEUR,
            totalGainEUR,
            totalGainPct,
            totalDayChangeEUR,
            dayChangePct,
            assets: assetMetrics
        };
    }

    // === DIVERSIFICATION ===
    calculateDiversification(metrics) {
        const { assets } = metrics;

        // Indice de Herfindahl (concentration)
        const herfindahl = assets.reduce((sum, asset) => 
            sum + Math.pow(asset.weight / 100, 2), 0
        );

        // Nombre d'actifs équivalents
        const effectiveAssets = herfindahl > 0 ? 1 / herfindahl : 0;

        // Score de diversification (0-100)
        const maxDiversity = assets.length;
        const diversityScore = maxDiversity > 0
            ? (effectiveAssets / maxDiversity) * 100
            : 0;

        return {
            herfindahl: herfindahl.toFixed(4),
            effectiveAssets: effectiveAssets.toFixed(2),
            diversityScore: diversityScore.toFixed(1),
            totalAssets: assets.length,
            recommendation: this.getDiversificationAdvice(diversityScore, assets.length)
        };
    }

    getDiversificationAdvice(score, assetCount) {
        if (assetCount < 5) return 'Portfolio très concentré. Envisagez plus de diversification.';
        if (score < 30) return 'Diversification faible. Quelques actifs dominent.';
        if (score < 60) return 'Diversification moyenne. Peut être améliorée.';
        if (score < 80) return 'Bonne diversification du portfolio.';
        return 'Excellente diversification du portfolio.';
    }

    // === ANALYSE DE PERFORMANCE ===
    analyzePerformance(metrics) {
        const { assets } = metrics;
        
        const sorted = [...assets].sort((a, b) => b.gainPct - a.gainPct);
        
        const winners = sorted.filter(a => a.gainPct > 0);
        const losers = sorted.filter(a => a.gainPct < 0);
        
        const avgGain = assets.length > 0
            ? assets.reduce((sum, a) => sum + a.gainPct, 0) / assets.length
            : 0;

        const winRate = assets.length > 0
            ? (winners.length / assets.length) * 100
            : 0;

        return {
            topPerformers: sorted.slice(0, 3),
            worstPerformers: sorted.slice(-3).reverse(),
            winners: winners.length,
            losers: losers.length,
            avgGain: avgGain.toFixed(2),
            winRate: winRate.toFixed(1),
            summary: this.getPerformanceSummary(avgGain, winRate)
        };
    }

    getPerformanceSummary(avgGain, winRate) {
        if (avgGain > 10 && winRate > 70) return 'Performance exceptionnelle 🚀';
        if (avgGain > 5 && winRate > 60) return 'Très bonne performance 📈';
        if (avgGain > 0 && winRate > 50) return 'Performance positive ✅';
        if (avgGain > -5) return 'Performance stable ⚖️';
        return 'Performance en difficulté 📉';
    }

    // === ANALYSE DE RISQUE ===
    calculateRisk(metrics) {
        const { assets } = metrics;
        
        // Volatilité (écart-type des rendements)
        const returns = assets.map(a => a.gainPct);
        const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
        const variance = returns.reduce((sum, r) => 
            sum + Math.pow(r - avgReturn, 2), 0
        ) / returns.length;
        const volatility = Math.sqrt(variance);

        // Maximum drawdown (actif le plus en perte)
        const maxDrawdown = Math.min(...returns.map(r => Math.min(r, 0)));

        // Ratio de Sharpe simplifié (rendement / volatilité)
        const sharpeRatio = volatility > 0 ? avgReturn / volatility : 0;

        return {
            volatility: volatility.toFixed(2),
            maxDrawdown: maxDrawdown.toFixed(2),
            sharpeRatio: sharpeRatio.toFixed(2),
            riskLevel: this.getRiskLevel(volatility),
            recommendation: this.getRiskAdvice(volatility, maxDrawdown)
        };
    }

    getRiskLevel(volatility) {
        if (volatility < 5) return 'Faible';
        if (volatility < 15) return 'Modéré';
        if (volatility < 30) return 'Élevé';
        return 'Très élevé';
    }

    getRiskAdvice(volatility, maxDrawdown) {
        if (volatility > 30) {
            return 'Volatilité élevée. Considérez des actifs plus stables.';
        }
        if (maxDrawdown < -20) {
            return 'Certains actifs en forte perte. Réévaluez votre stratégie.';
        }
        return 'Profil de risque acceptable pour un portfolio diversifié.';
    }

    // === ALLOCATION SECTORIELLE (à implémenter) ===
    analyzeSectorAllocation() {
        // À implémenter avec mapping ticker -> secteur
        return {
            message: 'Analyse sectorielle à venir'
        };
    }

    // === AGRÉGATION PAR ACTIF ===
    aggregateByAsset(purchases) {
        const map = new Map();

        purchases.forEach(p => {
            const ticker = p.ticker.toUpperCase();
            if (!map.has(ticker)) {
                map.set(ticker, {
                    ticker,
                    name: p.name,
                    totalQty: 0,
                    totalInvested: 0,
                    purchases: []
                });
            }

            const asset = map.get(ticker);
            asset.totalQty += p.quantity;
            asset.totalInvested += p.price * p.quantity;
            asset.purchases.push(p);
        });

        return Array.from(map.values());
    }

    // === RAPPORT COMPLET ===
    generateReport() {
        const purchases = this.storage.getPurchases();
        const metrics = this.calculateMetrics(purchases);
        const diversification = this.calculateDiversification(metrics);
        const performance = this.analyzePerformance(metrics);
        const risk = this.calculateRisk(metrics);

        return {
            summary: {
                totalValue: metrics.totalValueEUR,
                totalInvested: metrics.totalInvestedEUR,
                totalGain: metrics.totalGainEUR,
                totalGainPct: metrics.totalGainPct,
                dayChange: metrics.totalDayChangeEUR,
                dayChangePct: metrics.dayChangePct
            },
            diversification,
            performance,
            risk,
            assets: metrics.assets,
            generatedAt: new Date().toISOString()
        };
    }

    // === EXPORT DU RAPPORT ===
    exportReport() {
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
}