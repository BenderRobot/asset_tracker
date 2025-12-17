// ========================================
// indexCardChart.js - Sparklines pour cartes d'indices du dashboard
// ========================================

export class IndexCardChart {
    constructor(api, dataManager, marketStatus) {
        this.api = api;
        this.dataManager = dataManager;
        this.marketStatus = marketStatus;
    }

    /**
     * Génère une sparkline SVG pour une carte d'indice
     * @param {string} ticker - Le ticker de l'indice (ex: ^GSPC)
     * @param {number} currentPrice - Prix actuel
     * @param {number} previousClose - Clôture précédente
     * @returns {Promise<string>} SVG de la sparkline
     */
    async generateSparkline(ticker, currentPrice, previousClose) {
        try {
            // Déterminer la période à afficher en fonction du statut du marché
            const assetStatus = this.marketStatus.getAssetStatus(ticker);
            const isMarketActive = assetStatus && (assetStatus.label === 'LIVE' || assetStatus.label === '24/7' || assetStatus.label === '24/5');

            let displayDay = new Date();

            // Si marché fermé, afficher la dernière journée de trading
            if (!isMarketActive) {
                const yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);
                displayDay = this.dataManager.getLastTradingDay(yesterday);
            }

            // Calcul du début de la journée affichée
            displayDay.setHours(0, 0, 0, 0);
            const startTs = Math.floor(displayDay.getTime() / 1000);
            const startTsMs = displayDay.getTime();

            // Récupérer les données historiques
            const hist = await this.api.getHistoricalPricesWithRetry(
                ticker,
                startTs,
                Math.floor(Date.now() / 1000),
                '5m'
            );

            // Filtrer les points >= startTsMs
            let values = Object.keys(hist)
                .map(Number)
                .filter(ts => ts >= startTsMs)
                .sort((a, b) => a - b)
                .map(ts => hist[ts]);

            // Fallback si pas de données
            if (values.length === 0) {
                let lastTradingDay = this.dataManager.getLastTradingDay(new Date());
                const todayCheck = new Date();
                if (lastTradingDay.toDateString() === todayCheck.toDateString()) {
                    lastTradingDay.setDate(lastTradingDay.getDate() - 1);
                    lastTradingDay = this.dataManager.getLastTradingDay(lastTradingDay);
                }

                lastTradingDay.setHours(0, 0, 0, 0);
                const fallbackStartTs = Math.floor(lastTradingDay.getTime() / 1000);
                const fallbackHist = await this.api.getHistoricalPricesWithRetry(
                    ticker,
                    fallbackStartTs,
                    Math.floor(Date.now() / 1000),
                    '5m'
                );

                values = Object.keys(fallbackHist)
                    .map(Number)
                    .filter(ts => ts >= lastTradingDay.getTime())
                    .sort((a, b) => a - b)
                    .map(ts => fallbackHist[ts]);
            }

            // Générer le SVG
            if (values.length > 1) {
                const min = Math.min(...values);
                const max = Math.max(...values);
                const range = max - min || 1;

                // Générer les points du graphique
                const points = values.map((val, i) => {
                    const x = (i / (values.length - 1)) * 100;
                    const y = 100 - ((val - min) / range) * 100;
                    return `${x},${y}`;
                }).join(' ');

                // Position de la ligne previousClose
                const closeY = 100 - ((previousClose - min) / range) * 100;

                // Couleur du graphique
                const change = currentPrice - previousClose;
                const lineColor = change >= 0 ? '#10b981' : '#ef4444';

                return `
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%; height:100%; position:absolute; top:0; left:0; opacity:0.3;">
                        <defs>
                            <linearGradient id="grad-${ticker}" x1="0%" y1="0%" x2="0%" y2="100%">
                                <stop offset="0%" style="stop-color:${lineColor};stop-opacity:0.3" />
                                <stop offset="100%" style="stop-color:${lineColor};stop-opacity:0" />
                            </linearGradient>
                        </defs>
                        <polyline points="${points}" fill="none" stroke="${lineColor}" stroke-width="2" vector-effect="non-scaling-stroke"/>
                        <polyline points="0,${closeY} ${points} 100,${closeY}" fill="url(#grad-${ticker})" opacity="0.2"/>
                        <line x1="0" y1="${closeY}" x2="100" y2="${closeY}" stroke="#9fa6bc" stroke-width="1" stroke-dasharray="2,2" opacity="0.5"/>
                    </svg>
                `;
            }

            return ''; // Pas de sparkline si pas assez de données
        } catch (error) {
            console.error(`[IndexCardChart] Error generating sparkline for ${ticker}:`, error);
            return '';
        }
    }
}
