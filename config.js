// ========================================
// config.js - Configuration et constantes
// ========================================

export const RAPIDAPI_KEY = '900cd83ff7msh970062bff547634p1d444bjsn67326eb30d74';

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

export const YAHOO_MAP = {
  'APC': 'APC.F', 'AMZ': 'AMZ.F', 'NVD': 'NVD.F', 'AP2': 'AP2.F', 'MSF': 'MSF.F',
  'TL0': 'TL0.F', 'TKE': 'TKE.F', 'M4I': 'M4I.F', 'ABEA': 'ABEA.F',
  'CSPX': 'CSPX.AS', 'CNDX': 'CNDX.AS', '3ZU0': '3ZU0.F', '1170': '1170.F',
  '9D5': '9D5.F', 'GXG': 'GXG.F', 'BKSY': 'BKSY',
  'GOLD-ETFP': 'GOLD.PA',
  'AL2SI': 'AL2SI.PA', 'SU': 'SU.PA', 'ESE': 'ESE.PA', 'EUEA': 'EUEA.AS', 'STEC': 'STEC.AS',
  'CSPXUS': 'CSPX.AS', 'S&P500': 'CSPX.AS', 'SPY': 'SPY', 'VOO': 'VOO', 'CSPX.F': 'CSPX.AS',
  'BTC': 'BTC-EUR'
};

// Types d'actifs (SIMPLIFIÉ)
export const ASSET_TYPES = [
  'Stock',
  'ETF',
  'Crypto',
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