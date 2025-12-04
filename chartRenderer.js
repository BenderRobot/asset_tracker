// ========================================
// chartRenderer.js - Gestion de l'Affichage Graphique
// ========================================
import { Chart, registerables } from 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/+esm';
Chart.register(...registerables);

export class ChartManager {
    constructor(storage, dataManager, portfolioCalculator, investmentsPageInterface) {
        this.storage = storage;
        this.dataManager = dataManager;
        this.portfolioCalculator = portfolioCalculator;
        this.investmentsPage = investmentsPageInterface; // Interface pour mettre à jour les KPIs

        this.chart = null;
        this.currentPeriod = 1; // 1 jour par défaut
        this.currentBenchmark = null;

        // Cache pour les KPIs "figés" (Logique 1D vs autres)
        this.cachedLiveSummary = null;
        this.cachedLiveHoldings = null;
        this.cachedLiveCash = 0;
    }

    async update(forceRefresh = false, forceApi = false) {
        const canvas = document.getElementById('portfolioChart');
        if (!canvas) return;

        // 1. Récupération des données brutes
        const purchases = this.storage.getPurchases();
        const assetPurchases = purchases.filter(p => p.assetType !== 'Cash');
        const cashPurchases = purchases.filter(p => p.assetType === 'Cash');

        // 2. Calcul des Holdings & Summary (Snapshot Actuel)
        const holdings = this.portfolioCalculator.calculateHoldings(assetPurchases);
        const summary = this.portfolioCalculator.calculateSummary(holdings);
        const cashReserve = this.portfolioCalculator.calculateCashReserve(cashPurchases);

        // 3. Gestion du Cache KPI (Frozen 1D)
        if (this.currentPeriod === 1) {
            // En 1D, on est en "Live", on met à jour le cache
            this.cachedLiveSummary = summary;
            this.cachedLiveHoldings = holdings;
            this.cachedLiveCash = cashReserve.total;
        }

        // Déterminer quelles données afficher dans les cartes KPI
        let summaryForKPI = summary;
        let holdingsForKPI = holdings;
        let cashForKPI = cashReserve.total;

        if (this.currentPeriod !== 1 && this.cachedLiveSummary) {
            // Si on n'est pas en 1D, on utilise le cache (les KPIs ne bougent pas)
            summaryForKPI = this.cachedLiveSummary;
            holdingsForKPI = this.cachedLiveHoldings;
            cashForKPI = this.cachedLiveCash;
        }

        // 4. Calcul de l'Historique (Pour le Graphique)
        const history = await this.portfolioCalculator.calculateHistory(purchases, this.currentPeriod);

        // 5. Alignement Atomique (Pour le Graphique 1D uniquement)
        if (this.currentPeriod === 1 && summary.totalDayChangeEUR !== undefined) {
            // On force la ligne "Yesterday Close" du graph pour qu'elle matche exactement la variation du jour
            // Variation = Current - Previous
            // Donc Previous = Current - Variation
            const atomicYesterdayClose = summary.totalCurrentEUR - summary.totalDayChangeEUR;
            history.yesterdayClose = atomicYesterdayClose;
        }

        // 6. Rendu du Graphique
        this.renderChart(canvas, history, summary.totalCurrentEUR);

        // 7. Mise à jour des KPIs (via l'interface injectée)
        if (this.investmentsPage && this.investmentsPage.renderData) {
            // On passe null pour 'chartStats' car on veut que les KPIs utilisent summaryForKPI
            // (Sauf si on voulait afficher des stats spécifiques au graph, mais ici on veut la cohérence)
            this.investmentsPage.renderData(holdingsForKPI, summaryForKPI, cashForKPI, null);
        }
    }

    renderChart(canvas, history, currentTotalValue) {
        const ctx = canvas.getContext('2d');

        if (this.chart) {
            this.chart.destroy();
        }

        const labels = history.labels.map(ts => this.dataManager.getLabelFormat(this.currentPeriod)(ts));
        const dataValues = history.values;

        // Couleur dynamique (Vert si > YesterdayClose, Rouge sinon)
        const startValue = history.yesterdayClose || dataValues[0];
        const endValue = dataValues[dataValues.length - 1];
        const isPositive = endValue >= startValue;
        const color = isPositive ? '#10b981' : '#ef4444';

        // Gradient
        const gradient = ctx.createLinearGradient(0, 0, 0, 400);
        gradient.addColorStop(0, isPositive ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)');
        gradient.addColorStop(1, 'rgba(16, 185, 129, 0)');

        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Portfolio Value',
                    data: dataValues,
                    borderColor: color,
                    backgroundColor: gradient,
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        callbacks: {
                            label: (context) => {
                                return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(context.raw);
                            }
                        }
                    }
                },
                scales: {
                    x: { display: false },
                    y: {
                        display: true,
                        position: 'right',
                        grid: { color: '#334155' }
                    }
                }
            }
        });
    }
}
