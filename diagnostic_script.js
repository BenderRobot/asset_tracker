// ========================================
// SCRIPT DE DIAGNOSTIC PORTFOLIO TRACKER
// ========================================
// Copier-coller ce script dans la console (F12)

console.clear();
console.log('%c🔍 DIAGNOSTIC PORTFOLIO TRACKER', 'font-size: 20px; font-weight: bold; color: #3b82f6;');
console.log('%c================================\n', 'color: #3b82f6;');

// 1. Vérifier les achats
const purchases = JSON.parse(localStorage.getItem('purchases') || '[]');
console.log('%c✅ ACHATS', 'font-size: 16px; font-weight: bold; color: #10b981;');
console.log(`   Nombre de transactions: ${purchases.length}`);
if (purchases.length > 0) {
    const tickers = [...new Set(purchases.map(p => p.ticker))];
    console.log(`   Tickers uniques: ${tickers.length}`);
    console.log('   Liste:', tickers.join(', '));
    
    // Vérifier si assetType et broker sont définis
    const withoutType = purchases.filter(p => !p.assetType).length;
    const withoutBroker = purchases.filter(p => !p.broker).length;
    if (withoutType > 0) console.warn(`   ⚠️  ${withoutType} transactions sans assetType`);
    if (withoutBroker > 0) console.warn(`   ⚠️  ${withoutBroker} transactions sans broker`);
} else {
    console.log('%c   ❌ Aucune transaction trouvée', 'color: #ef4444;');
}

// 2. Vérifier le cache des prix
console.log('\n%c📊 PRIX EN CACHE', 'font-size: 16px; font-weight: bold; color: #10b981;');
const currentData = JSON.parse(localStorage.getItem('currentData') || '{}');
const cachedTickers = Object.keys(currentData);
console.log(`   Tickers avec prix: ${cachedTickers.length}`);
if (cachedTickers.length > 0) {
    console.log('   Liste:', cachedTickers.join(', '));
    
    // Afficher un exemple
    const example = cachedTickers[0];
    console.log(`   Exemple (${example}):`, currentData[example]);
} else {
    console.log('%c   ❌ Aucun prix en cache', 'color: #ef4444;');
    console.log('%c   → Solution: Cliquez sur "Refresh Prices"', 'color: #f59e0b;');
}

// 3. Vérifier les timestamps (expiration)
console.log('\n%c⏰ EXPIRATION CACHE', 'font-size: 16px; font-weight: bold; color: #10b981;');
const timestamps = JSON.parse(localStorage.getItem('priceTimestamps') || '{}');
const now = Date.now();
const CACHE_EXPIRY = 60 * 60 * 1000; // 1 heure

if (Object.keys(timestamps).length > 0) {
    const expired = Object.entries(timestamps).filter(([t, ts]) => now - ts > CACHE_EXPIRY);
    const valid = Object.keys(timestamps).length - expired.length;
    
    console.log(`   Prix valides: ${valid}`);
    console.log(`   Prix expirés: ${expired.length}`);
    
    if (expired.length > 0) {
        console.warn('   ⚠️  Prix expirés:', expired.map(([t]) => t).join(', '));
        console.log('%c   → Solution: Cliquez sur "Refresh Prices"', 'color: #f59e0b;');
    }
} else {
    console.log('%c   ❌ Aucun timestamp trouvé', 'color: #ef4444;');
}

// 4. Tickers manquants (pas de prix)
console.log('\n%c❓ TICKERS MANQUANTS', 'font-size: 16px; font-weight: bold; color: #10b981;');
if (purchases.length > 0 && cachedTickers.length >= 0) {
    const tickersInPurchases = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
    const tickersInCache = cachedTickers.map(t => t.toUpperCase());
    const missing = tickersInPurchases.filter(t => !tickersInCache.includes(t));
    
    if (missing.length > 0) {
        console.log(`%c   ⚠️  ${missing.length} tickers sans prix`, 'color: #f59e0b;');
        console.log('   Liste:', missing.join(', '));
        console.log('%c   → Solution: Cliquez sur "Refresh Prices"', 'color: #f59e0b;');
    } else {
        console.log('   ✅ Tous les tickers ont des prix');
    }
}

// 5. Vérifier le mapping Yahoo
console.log('\n%c🗺️  MAPPING YAHOO', 'font-size: 16px; font-weight: bold; color: #10b981;');
console.log('   Vérification du fichier config.js...');
// Note: On ne peut pas importer ici car c'est du code module
console.log('   ℹ️  Ouvrez config.js et vérifiez YAHOO_MAP');
console.log('   Exemples de mapping:');
console.log('   • BTC → BTC-EUR');
console.log('   • AAPL → AAPL (US stocks)');
console.log('   • AL2SI → AL2SI.PA (Euronext Paris)');
console.log('   • CSPX → CSPX.AS (Amsterdam)');

// 6. Taille du localStorage
console.log('\n%c💾 LOCALSTORAGE', 'font-size: 16px; font-weight: bold; color: #10b981;');
let totalSize = 0;
for (let key in localStorage) {
    if (localStorage.hasOwnProperty(key)) {
        totalSize += localStorage[key].length + key.length;
    }
}
const sizeKB = (totalSize / 1024).toFixed(2);
console.log(`   Taille utilisée: ${sizeKB} KB`);
if (totalSize > 4 * 1024 * 1024) {
    console.warn('   ⚠️  Proche de la limite (5MB)');
    console.log('%c   → Solution: localStorage.clear() puis réimporter', 'color: #f59e0b;');
}

// 7. Configuration API
console.log('\n%c🔑 API CONFIGURATION', 'font-size: 16px; font-weight: bold; color: #10b981;');
console.log('   Vérification de la clé RapidAPI...');
console.log('   ℹ️  Ouvrez config.js et vérifiez RAPIDAPI_KEY');
console.log('   ⚠️  Ne partagez JAMAIS votre clé publiquement');

// 8. Recommendations finales
console.log('\n%c📋 RECOMMENDATIONS', 'font-size: 18px; font-weight: bold; color: #3b82f6;');
console.log('%c================================', 'color: #3b82f6;');

let hasIssues = false;

if (purchases.length === 0) {
    console.log('%c❗ Ajoutez d\'abord des transactions', 'color: #ef4444; font-weight: bold;');
    hasIssues = true;
}

if (cachedTickers.length === 0 && purchases.length > 0) {
    console.log('%c❗ Aucun prix en cache → Cliquez sur "Refresh Prices"', 'color: #ef4444; font-weight: bold;');
    hasIssues = true;
}

const tickersInPurchases = purchases.length > 0 ? [...new Set(purchases.map(p => p.ticker.toUpperCase()))] : [];
const tickersInCache = cachedTickers.map(t => t.toUpperCase());
const missing = tickersInPurchases.filter(t => !tickersInCache.includes(t));

if (missing.length > 0) {
    console.log(`%c❗ ${missing.length} tickers sans prix → Cliquez sur "Refresh Prices"`, 'color: #ef4444; font-weight: bold;');
    hasIssues = true;
}

const expired = Object.entries(timestamps).filter(([t, ts]) => now - ts > CACHE_EXPIRY);
if (expired.length > 0) {
    console.log(`%c❗ ${expired.length} prix expirés → Cliquez sur "Refresh Prices"`, 'color: #f59e0b; font-weight: bold;');
    hasIssues = true;
}

if (!hasIssues) {
    console.log('%c✅ Tout semble OK !', 'color: #10b981; font-weight: bold; font-size: 16px;');
    console.log('\nSi les prix ne s\'affichent toujours pas:');
    console.log('1. Vérifiez la console "Network" (F12) pour les erreurs API');
    console.log('2. Attendez quelques secondes après "Refresh Prices"');
    console.log('3. Rechargez la page (Ctrl+Shift+R)');
}

console.log('\n%c================================', 'color: #3b82f6;');
console.log('%cDiagnostic terminé\n', 'font-size: 14px; color: #3b82f6;');

// 9. Actions rapides disponibles
console.log('%c🚀 ACTIONS RAPIDES', 'font-size: 16px; font-weight: bold; color: #8b5cf6;');
console.log('\nCommandes disponibles:');
console.log('%c• clearCache()', 'color: #8b5cf6;', '- Vider tout le cache');
console.log('%c• showPrices()', 'color: #8b5cf6;', '- Afficher tous les prix');
console.log('%c• showPurchases()', 'color: #8b5cf6;', '- Afficher toutes les transactions');
console.log('%c• testAPI(ticker)', 'color: #8b5cf6;', '- Tester l\'API pour un ticker (ex: testAPI("BTC"))');

// Définir les fonctions helper
window.clearCache = function() {
    localStorage.removeItem('currentData');
    localStorage.removeItem('priceTimestamps');
    console.log('✅ Cache vidé. Rechargez la page et cliquez sur "Refresh Prices"');
};

window.showPrices = function() {
    const data = JSON.parse(localStorage.getItem('currentData') || '{}');
    console.table(data);
};

window.showPurchases = function() {
    const purchases = JSON.parse(localStorage.getItem('purchases') || '[]');
    console.table(purchases);
};

window.testAPI = async function(ticker = 'BTC') {
    console.log(`🧪 Test API pour ${ticker}...`);
    try {
        const symbol = ticker === 'BTC' ? 'BTC-EUR' : ticker;
        const response = await fetch(
            `https://apidojo-yahoo-finance-v1.p.rapidapi.com/market/v2/get-quotes?symbols=${symbol}&region=US`,
            {
                headers: {
                    'x-rapidapi-key': '900cd83ff7msh970062bff547634p1d444bjsn67326eb30d74',
                    'x-rapidapi-host': 'apidojo-yahoo-finance-v1.p.rapidapi.com'
                }
            }
        );
        
        if (response.ok) {
            const data = await response.json();
            console.log('✅ API répond:', data);
            const quote = data?.quoteResponse?.result?.[0];
            if (quote) {
                console.log(`Prix ${ticker}:`, quote.regularMarketPrice, quote.currency);
            }
        } else {
            console.error('❌ Erreur API:', response.status, response.statusText);
            if (response.status === 429) {
                console.log('⚠️  Rate limit dépassé. Attendez 1 heure.');
            }
        }
    } catch (err) {
        console.error('❌ Erreur:', err);
    }
};

console.log('\n%cExemple: testAPI("BTC") pour tester l\'API\n', 'color: #8b5cf6; font-style: italic;');
