// ========================================
// analyticsApp.js - Application Analytics
// ========================================

import { Storage } from './storage.js';
import { PortfolioAnalytics } from './analytics.js';
import { formatCurrency, formatPercent } from './utils.js';

class AnalyticsApp {
    constructor() {
        this.storage = new Storage();
        this.analytics = new PortfolioAnalytics(this.storage);
        this.allocationChart = null;
    }

    async init() {
        console.log('📊 Initialisation Analytics...');
        
        await this.render();
        this.setupEventListeners();
        
        console.log('✅ Analytics prêt');
    }

    async render() {
        const report = this.analytics.generateReport();
        
        console.log('📊 Rapport:', report);

        // Résumé
        this.updateSummary(report.summary);

        // Performance
        this.updatePerformance(report.performance);

        // Diversification
        this.updateDiversification(report.diversification);

        // Risque
        this.updateRisk(report.risk);

        // Top/Worst performers
        this.updatePerformers(report.performance);

        // Graphique d'allocation
        this.renderAllocationChart(report.assets);
    }

    updateSummary(summary) {
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        setValue('total-value', this.formatEUR(summary.totalValue));
        
        const returnEl = document.getElementById('total-return');
        if (returnEl) {
            returnEl.textContent = this.formatEUR(summary.totalGain);
            returnEl.style.color = summary.totalGain >= 0 ? '#10b981' : '#ef4444';
        }

        const pctEl = document.getElementById('return-pct');
        if (pctEl) {
            pctEl.textContent = this.formatPct(summary.totalGainPct);
            pctEl.style.color = summary.totalGainPct >= 0 ? '#10b981' : '#ef4444';
        }
    }

    updatePerformance(performance) {
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        setValue('avg-gain', performance.avgGain + '%');
        setValue('winners-count', performance.winners);
        setValue('losers-count', performance.losers);
        setValue('win-rate', performance.winRate + '%');
        setValue('performance-summary', performance.summary);
    }

    updateDiversification(diversification) {
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        setValue('diversity-score', diversification.diversityScore + '/100');
        setValue('effective-assets', diversification.effectiveAssets);
        setValue('total-assets', diversification.totalAssets);
        setValue('diversity-recommendation', diversification.recommendation);
    }

    updateRisk(risk) {
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        setValue('volatility', risk.volatility + '%');
        setValue('max-drawdown', risk.maxDrawdown + '%');
        
        const levelEl = document.getElementById('risk-level');
        if (levelEl) {
            levelEl.textContent = risk.riskLevel;
            levelEl.className = 'metric-value risk-badge';
            
            if (risk.riskLevel === 'Faible') {
                levelEl.classList.add('risk-low');
            } else if (risk.riskLevel === 'Modéré') {
                levelEl.classList.add('risk-moderate');
            } else {
                levelEl.classList.add('risk-high');
            }
        }

        setValue('risk-recommendation', risk.recommendation);
    }

    updatePerformers(performance) {
        // Top performers
        const topEl = document.getElementById('top-performers');
        if (topEl && performance.topPerformers.length > 0) {
            topEl.innerHTML = performance.topPerformers.map(asset => `
                <div class="performer-item">
                    <div>
                        <div class="performer-ticker">${asset.ticker}</div>
                        <div style="font-size: 12px; color: var(--text-muted);">${asset.name}</div>
                    </div>
                    <div class="performer-gain" style="color: #10b981;">
                        +${asset.gainPct.toFixed(2)}%
                    </div>
                </div>
            `).join('');
        } else if (topEl) {
            topEl.innerHTML = '<p style="color: var(--text-muted); text-align: center;">Aucune donnée</p>';
        }

        // Worst performers
        const worstEl = document.getElementById('worst-performers');
        if (worstEl && performance.worstPerformers.length > 0) {
            worstEl.innerHTML = performance.worstPerformers.map(asset => `
                <div class="performer-item">
                    <div>
                        <div class="performer-ticker">${asset.ticker}</div>
                        <div style="font-size: 12px; color: var(--text-muted);">${asset.name}</div>
                    </div>
                    <div class="performer-gain" style="color: #ef4444;">
                        ${asset.gainPct.toFixed(2)}%
                    </div>
                </div>
            `).join('');
        } else if (worstEl) {
            worstEl.innerHTML = '<p style="color: var(--text-muted); text-align: center;">Aucune donnée</p>';
        }
    }

    renderAllocationChart(assets) {
        const canvas = document.getElementById('allocation-chart');
        if (!canvas) return;

        // Nettoyer ancien graphique
        if (this.allocationChart) {
            this.allocationChart.destroy();
        }

        // Trier par valeur
        const sorted = [...assets].sort((a, b) => b.currentValueEUR - a.currentValueEUR);
        
        // Top 10
        const top10 = sorted.slice(0, 10);
        const others = sorted.slice(10);
        
        const labels = top10.map(a => a.ticker);
        const data = top10.map(a => a.currentValueEUR);
        
        // Ajouter "Autres" si nécessaire
        if (others.length > 0) {
            const othersTotal = others.reduce((sum, a) => sum + a.currentValueEUR, 0);
            labels.push('Autres');
            data.push(othersTotal);
        }

        const ctx = canvas.getContext('2d');
        
        this.allocationChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: [
                        '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
                        '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
                        '#64748b'
                    ],
                    borderWidth: 2,
                    borderColor: '#1a2238'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            color: '#ffffff',
                            font: { size: 12 },
                            padding: 15
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        padding: 12,
                        callbacks: {
                            label: (context) => {
                                const label = context.label || '';
                                const value = context.parsed;
                                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = ((value / total) * 100).toFixed(1);
                                return `${label}: ${value.toLocaleString('fr-FR', {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2
                                })} € (${pct}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    setupEventListeners() {
        // Export report
        const exportBtn = document.getElementById('export-report');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                this.analytics.exportReport();
                this.showNotification('✅ Rapport exporté', 'success');
            });
        }

        // Refresh
        const refreshBtn = document.getElementById('refresh-analytics');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                refreshBtn.disabled = true;
                refreshBtn.textContent = '🔄 Rafraîchissement...';
                
                try {
                    await this.render();
                    this.showNotification('✅ Analytics mis à jour', 'success');
                } catch (error) {
                    console.error('Erreur refresh:', error);
                    this.showNotification('❌ Erreur lors du rafraîchissement', 'error');
                } finally {
                    refreshBtn.disabled = false;
                    refreshBtn.textContent = 'Refresh Analytics';
                }
            });
        }
    }

    // Formatage
    formatEUR(value) {
        if (value === null || isNaN(value)) return '-';
        return value.toLocaleString('fr-FR', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }) + ' €';
    }

    formatPct(value) {
        if (value === null || isNaN(value)) return '-';
        const sign = value >= 0 ? '+' : '';
        return sign + value.toFixed(2) + '%';
    }

    // Notifications
    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 20px;
            background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
            color: white;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 10000;
            animation: slideIn 0.3s ease;
        `;

        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
}

// Initialisation
(async () => {
    const app = new AnalyticsApp();
    window.analyticsApp = app;
    
    try {
        await app.init();
    } catch (error) {
        console.error('❌ Erreur fatale:', error);
        alert('Erreur lors du chargement des analytics');
    }
})();