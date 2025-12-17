
// Native fetch is available in Node 18+

const PROXIES = [
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url='
];

async function fetchDividends(ticker) {
    // Yahoo Chart API with events=div
    // Range 2y to get recent dividends
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=2y&interval=1d&events=div`;

    console.log(`Checking dividends for ${ticker}...`);

    for (const proxy of PROXIES) {
        try {
            const target = `${proxy}${encodeURIComponent(url)}`;
            // console.log(`Trying proxy: ${proxy}`); 
            const res = await fetch(target);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const data = await res.json();
            const result = data.chart.result?.[0];

            if (!result) {
                console.log(`No result for ${ticker}`);
                return;
            }

            const events = result.events?.dividends; // Dividends are here
            if (events) {
                console.log(`✅ Dividends found for ${ticker}:`);
                const dates = Object.keys(events).sort();
                dates.forEach(ts => {
                    const date = new Date(parseInt(ts) * 1000).toISOString().split('T')[0];
                    const div = events[ts];
                    console.log(`- Date: ${date}, Amount: ${div.amount}`);
                });
                return; // Success
            } else {
                console.log(`❌ No dividend events returned for ${ticker} in this range.`);
            }
            return;

        } catch (e) {
            console.error(`Proxy ${proxy} failed: ${e.message}`);
        }
    }
}

// Test with a Dividend Aristocrat (TTE.PA) and US Stock (AAPL)
(async () => {
    await fetchDividends('TTE.PA');
    await fetchDividends('AAPL');
})();
