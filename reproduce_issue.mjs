import { PRICE_PROXY_URL } from './config.js';

async function checkExchanges() {
    const tickers = [
        'AP2.F', 'AP2.DE',
        'TL0.F', 'TL0.DE',
        'TLO.F', 'TLO.DE' // Check generic TLO just in case
    ];

    console.log("| Ticker | Price | Change % | Market |");
    console.log("|---|---|---|---|");

    for (const t of tickers) {
        const url = `${PRICE_PROXY_URL}?symbol=${t}&type=STOCK&range=1d&interval=1d`;
        try {
            const res = await fetch(url);
            const data = await res.json();
            const meta = data.chart.result[0].meta;
            const price = meta.regularMarketPrice;
            const prev = meta.chartPreviousClose;
            const chg = ((price - prev) / prev) * 100;
            console.log(`| ${t} | ${price} | ${chg.toFixed(2)}% | ${meta.exchangeName} |`);
        } catch (e) {
            console.log(`| ${t} | ERROR | - | - |`);
        }
    }
}

checkExchanges();
