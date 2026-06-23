// NOUVELLE MÉTHODE SPÉCIFIQUE DASHBOARD: Récupère les données d'indices avec previousClose et lastTradingDayClose
async function fetchIndexDataForDashboard(ticker) {
    const symbol = this.formatTicker(ticker);
    const type = 'STOCK'; // Les indices sont toujours de type STOCK

    try {
        // Déterminer l'intervalle selon le type d'actif
        const isBitcoin = ticker.includes('BTC');
        const interval = isBitcoin ? '5m' : '1d';
        const url = `${PRICE_PROXY_URL}?symbol=${symbol}&type=${type}&range=5d&interval=${interval}`;

        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);

        const data = await res.json();

        // Parser les données Yahoo
        if (!data.chart || !data.chart.result || data.chart.result.length === 0) {
            throw new Error('Invalid Yahoo format from proxy');
        }

        const chartData = data.chart.result[0];
        const meta = chartData.meta || {};
        const quote = chartData.indicators?.quote?.[0] || {};
        const timestamps = chartData.timestamp || [];
        const closes = quote.close || [];

        // Prix actuel
        let currentPrice = meta.regularMarketPrice || closes[closes.length - 1];
        if (!currentPrice || currentPrice <= 0) {
            throw new Error('No valid current price');
        }

        // previousClose de base
        let previousClose = meta.chartPreviousClose || meta.previousClose;
        if (!previousClose || previousClose <= 0) {
            previousClose = currentPrice;
        }

        const currency = meta.currency || 'EUR';

        // LOGIQUE SPÉCIFIQUE INDICES : Récupérer previousClose et lastTradingDayClose via historique
        let truePreviousClose = null;
        let lastTradingDayClose = null;

        try {
            const yesterday = new Date();
            yesterday.setUTCHours(0, 0, 0, 0);
            const yesterdayEndTs = Math.floor(yesterday.getTime() / 1000);

            let histInterval, histRange;

            if (isBitcoin) {
                // Bitcoin : récupérer les 2 derniers jours avec intervalle 1h
                histInterval = '1h';
                histRange = yesterdayEndTs - (2 * 24 * 60 * 60);
            } else {
                // Indices : récupérer 5 jours avec intervalle 1d
                histInterval = '1d';
                histRange = yesterdayEndTs - (5 * 24 * 60 * 60);
            }

            const hist = await this.getHistoricalPricesWithRetry(
                ticker,
                histRange,
                yesterdayEndTs,
                histInterval
            );

            if (hist && Object.keys(hist).length > 0) {
                const histTimestamps = Object.keys(hist).map(Number).sort((a, b) => b - a);

                if (isBitcoin) {
                    // Pour Bitcoin : trouver le dernier prix avant minuit (00:00 aujourd'hui)
                    const midnightToday = new Date();
                    midnightToday.setHours(0, 0, 0, 0);
                    const midnightMs = midnightToday.getTime();

                    const pricesBeforeMidnight = histTimestamps.filter(ts => ts < midnightMs);
                    if (pricesBeforeMidnight.length > 0) {
                        truePreviousClose = hist[pricesBeforeMidnight[0]];
                    }

                    // lastTradingDayClose = minuit d'hier
                    const midnightYesterday = new Date(midnightToday);
                    midnightYesterday.setDate(midnightYesterday.getDate() - 1);
                    const midnightYesterdayMs = midnightYesterday.getTime();
                    const pricesBeforeYesterday = histTimestamps.filter(ts => ts < midnightYesterdayMs);
                    if (pricesBeforeYesterday.length > 0) {
                        lastTradingDayClose = hist[pricesBeforeYesterday[0]];
                    }
                } else {
                    // Pour les indices : utiliser la logique existante (1d interval)
                    truePreviousClose = hist[histTimestamps[0]];
                    if (histTimestamps.length > 1) {
                        lastTradingDayClose = hist[histTimestamps[1]];
                    }
                }

                console.log(`[IndexDashboard ${ticker}] previousClose (J): ${truePreviousClose?.toFixed(4)}, lastTradingDayClose (J-1): ${lastTradingDayClose?.toFixed(4)}`);
            }
        } catch (err) {
            console.warn(`Could not fetch historical close for ${ticker}:`, err.message);
        }

        // Convertir en EUR si nécessaire
        if (currency === 'USD') {
            currentPrice = currentPrice / this.storage.getEurUsdRate();
            if (truePreviousClose) truePreviousClose = truePreviousClose / this.storage.getEurUsdRate();
            if (lastTradingDayClose) lastTradingDayClose = lastTradingDayClose / this.storage.getEurUsdRate();
        }

        return {
            price: currentPrice,
            previousClose: truePreviousClose || previousClose,
            lastTradingDayClose: lastTradingDayClose || truePreviousClose || previousClose,
            currency: 'EUR',
            marketState: meta.marketState || 'CLOSED'
        };

    } catch (err) {
        console.error(`[IndexDashboard] Error fetching ${ticker}:`, err.message);
        return null;
    }
}
