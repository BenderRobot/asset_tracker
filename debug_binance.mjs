
const corsProxies = [
    'https://thingproxy.freeboard.io/fetch/',
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url='
];

async function fetchBinanceHistory(ticker) {
    let symbol = ticker.toUpperCase().replace('-', '');
    if (!symbol.endsWith('EUR')) symbol += 'EUR';

    const endTs = Date.now();
    const startTs = endTs - (24 * 60 * 60 * 1000); // 24h ago

    const binanceUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&startTime=${startTs}&endTime=${endTs}&limit=1000`;
    console.log(`Fetching ${binanceUrl}`);

    for (let proxy of corsProxies) {
        try {
            const url = `${proxy}${encodeURIComponent(binanceUrl)}`;
            console.log(`Trying proxy: ${proxy}`);
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            console.log(`Success! Data type: ${typeof data}`);
            if (Array.isArray(data)) {
                console.log(`Received ${data.length} candles.`);
                if (data.length > 0) {
                    const first = data[0];
                    const last = data[data.length - 1];
                    console.log(`First candle: ${new Date(first[0]).toISOString()} (${first[0]})`);
                    console.log(`Last candle: ${new Date(last[0]).toISOString()} (${last[0]})`);
                }
            } else {
                console.log("Data is not an array:", JSON.stringify(data).substring(0, 200));
            }
            return;
        } catch (e) {
            console.error(`Proxy failed: ${e.message}`);
        }
    }
}

fetchBinanceHistory('BTC-EUR');
