
const corsProxies = [
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url=',
    'https://thingproxy.freeboard.io/fetch/'
];

async function fetchYahooHistory(ticker) {
    const range = '5d';
    const corsProxies = [
        'https://corsproxy.io/?',
        'https://api.allorigins.win/raw?url=',
        'https://thingproxy.freeboard.io/fetch/'
    ];

    async function fetchYahooHistory(ticker) {
        const range = '5d';
        const interval = '5m';
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;
        console.log(`Fetching ${yahooUrl}`);

        for (let proxy of corsProxies) {
            try {
                const url = `${proxy}${encodeURIComponent(yahooUrl)}`;
                console.log(`Trying proxy: ${proxy}`);
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                const result = data.chart.result[0];
                const timestamps = result.timestamp;
                const quotes = result.indicators.quote[0].close;

                console.log(`Success! Received ${timestamps.length} candles.`);
                if (timestamps.length > 0) {
                    const first = timestamps[0];
                    const last = timestamps[timestamps.length - 1];
                    console.log(`First candle: ${new Date(first * 1000).toISOString()} (${first})`);
                    console.log(`Last candle: ${new Date(last * 1000).toISOString()} (${last})`);

                    // Check for today's data
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const todayTs = today.getTime() / 1000;

                    let firstValidToday = null;
                    for (let i = 0; i < timestamps.length; i++) {
                        if (timestamps[i] >= todayTs) {
                            if (quotes[i] !== null) {
                                firstValidToday = timestamps[i];
                                break;
                            }
                        }
                    }

                    if (firstValidToday) {
                        console.log(`First VALID candle of TODAY: ${new Date(firstValidToday * 1000).toISOString()}`);
                    } else {
                        console.log("No valid candles for today yet.");
                    }
                }
                return;
            } catch (e) {
                console.error(`Proxy failed: ${e.message}`);
            }
        }
    }

    fetchYahooHistory('BTC-EUR');
