// ========================================
// config.js - Configuration et constantes
// ========================================


// CLOUDFLARE WORKERS PROXY (Migration depuis Cloud Run GCP - 0€/mois au lieu de 11€/mois)
export const PRICE_PROXY_URL = 'https://asset-tracker-prices.blaurens31.workers.dev';
export const GEMINI_PROXY_URL = 'https://asset-tracker-gemini.blaurens31.workers.dev';

export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// CACHE : Durées différentes selon type d'actif
export const CACHE_EXPIRY_STOCKS_MARKET_OPEN = 10 * 60 * 1000; // 10 minutes (marché ouvert)
export const CACHE_EXPIRY_STOCKS_MARKET_CLOSED = 7 * 24 * 60 * 60 * 1000; // 7 jours (marché fermé/weekend)
export const CACHE_EXPIRY_CRYPTO = 5 * 60 * 1000; // 5 minutes (marché 24/7)

// REFRESH AUTOMATIQUE
export const AUTO_REFRESH_INTERVAL = 10 * 60 * 1000; // Rafraîchir toutes les 10 minutes
export const AUTO_REFRESH_ENABLED = true; // Activer/désactiver le refresh auto

export const PAGE_SIZE = 25;

// MODIFICATION : Ceci est maintenant un taux de SECOURS
export const USD_TO_EUR_FALLBACK_RATE = 0.925;

export const USD_TICKERS = new Set(['BKSY', 'SPY', 'VOO']);

// Liste des indices du Dashboard pour forcer leur rafraîchissement
export const DASHBOARD_INDICES = ['^GSPC', '^IXIC', '^FCHI', '^STOXX50E', 'BTC-EUR', 'GC=F', 'EURUSD=X'];

export const YAHOO_MAP = {
  'APC': 'APC.F', 'AMZ': 'AMZ.F', 'NVD': 'NVD.F', 'AP2': 'AP2.DE', 'MSF': 'MSF.F',
  'TL0': 'TL0.DE', 'TLO': 'TL0.DE', 'TKE': 'TKE.F', 'M4I': 'M4I.F', 'ABEA': 'ABEA.F',
  'CSPX': 'CSPX.AS', 'CNDX': 'CNDX.AS', '3ZU0': '3ZU0.F', '1170': '1170.F',
  '9D5': '9D5.F', 'GXG': 'GXG.F', 'BKSY': 'BKSY',
  'GOLD-ETFP': 'GOLD-EUR.PA',
  'AL2SI': 'AL2SI.PA', 'SU': 'SU.PA', 'ESE': 'ESE.PA', 'EUEA': 'EUEA.AS', 'STEC': 'STEC.AS', 'ALRIB': 'ALRIB.PA',
  'SOI': 'SOI.PA',
  'CSPXUS': 'CSPX.AS', 'S&P500': 'CSPX.AS', 'SPY': 'SPY', 'VOO': 'VOO', 'CSPX.F': 'CSPX.AS',
  'BTC': 'BTC-EUR',
  'SPCX': 'SPCX'
};

// ACTIONS US (Dividendes en USD) mais potentiellement cotées en EUR (ex: Xetra)
export const US_STOCKS_EUR = [
  'ABEA', // Alphabet
  'MSF',  // Microsoft
  'NVD',  // Nvidia
  'APC',  // Apple
  'AMZ',  // Amazon
  'TSLA', // Tesla
  'META', // Meta
  'NFLX', // Netflix
  'KO',   // Coca Cola
  'PEP',  // Pepsi
  'JNJ',  // Johnson & Johnson
  'PG',   // P&G
  'MCD'   // McDonalds
];

// Types d'actifs (SIMPLIFIÉ)
export const ASSET_TYPES = [
  'Stock',
  'ETF',
  'Crypto',
  'Real Estate',
  'Dividend', // Added for explicit filtering
  'Cash' // <-- AJOUTEZ CETTE LIGNE
];

// Brokers disponibles (SIMPLIFIÉ)
export const BROKERS = [
  { value: 'RV-CT', label: 'Revolut' },
  { value: 'TR-CT', label: 'Trade Republic' },
  { value: 'BB-PEA', label: 'Boursobank PEA' },
  { value: 'Binance', label: 'Binance' },
  { value: 'Bitstack', label: 'Bitstack' }
];

// Devises disponibles (SIMPLIFIÉ)
export const CURRENCIES = [
  { value: 'EUR', label: 'Euro (€)', symbol: '€' },
  { value: 'USD', label: 'Dollar ($)', symbol: '$' }
];