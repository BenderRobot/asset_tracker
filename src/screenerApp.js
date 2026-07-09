// ============================================================
// screenerApp.js — Stock Screener & Analysis Page
// ============================================================
import { Storage } from './storage.js';
import { PRICE_PROXY_URL } from './config.js';
import logger from '../utils/logger.js';

const PROXY = PRICE_PROXY_URL;
const SP500_SYMBOL = '^GSPC'; // Used for S&P 500 comparison

// Row definitions for the Finances tab's 3 statement tables — each `key` maps to a field
// returned by the worker's FUNDAMENTALS endpoint (Yahoo fundamentals-timeseries).
const FIN_STATEMENT_DEFS = {
    income: {
        label: 'Compte de résultat',
        rows: [
            { label: 'Revenus', key: 'annualTotalRevenue' },
            { label: 'Coût des revenus', key: 'annualCostOfRevenue' },
            { label: 'Marge brute', key: 'annualGrossProfit' },
            { label: "Charges d'exploitation", key: 'annualOperatingExpense' },
            { label: 'Résultat opérationnel', key: 'annualOperatingIncome' },
            { label: 'Résultat avant impôts', key: 'annualPretaxIncome' },
            { label: 'Impôts', key: 'annualTaxProvision' },
            { label: 'Résultat net', key: 'annualNetIncome' },
            { label: 'BPA de base', key: 'annualBasicEPS', decimals: true },
            { label: 'BPA dilué', key: 'annualDilutedEPS', decimals: true },
        ],
    },
    balance: {
        label: 'Bilan',
        rows: [
            { label: 'Trésorerie', key: 'annualCashAndCashEquivalents' },
            { label: 'Actifs courants', key: 'annualCurrentAssets' },
            { label: 'Total actifs', key: 'annualTotalAssets' },
            { label: 'Passifs courants', key: 'annualCurrentLiabilities' },
            { label: 'Dette long terme', key: 'annualLongTermDebt' },
            { label: 'Dette totale', key: 'annualTotalDebt' },
            { label: 'Total passifs', key: 'annualTotalLiabilitiesNetMinorityInterest' },
            { label: 'Capitaux propres', key: 'annualStockholdersEquity' },
        ],
    },
    cashflow: {
        label: 'Flux de trésorerie',
        rows: [
            { label: "Flux d'exploitation", key: 'annualOperatingCashFlow' },
            { label: 'CAPEX', key: 'annualCapitalExpenditure' },
            { label: 'Free Cash Flow', key: 'annualFreeCashFlow' },
            { label: "Flux d'investissement", key: 'annualInvestingCashFlow' },
            { label: 'Flux de financement', key: 'annualFinancingCashFlow' },
            { label: 'Dividendes versés', key: 'annualCommonStockDividendPaid' },
            { label: "Rachats d'actions", key: 'annualRepurchaseOfCapitalStock' },
            { label: 'Trésorerie fin de période', key: 'annualEndCashPosition' },
        ],
    },
};

// ─── Popular Assets — groupés par thème ───────────────────────────────────────
const POPULAR_ASSET_GROUPS = [
    {
        id: 'tech',
        label: 'Tech & IA',
        icon: 'fa-microchip',
        color: '#6366f1',
        assets: [
            { ticker: 'AAPL', name: 'Apple', domain: 'apple.com', emoji: '🍎', type: 'Action' },
            { ticker: 'NVDA', name: 'NVIDIA', domain: 'nvidia.com', emoji: '🟩', type: 'Action' },
            { ticker: 'MSFT', name: 'Microsoft', domain: 'microsoft.com', emoji: '🪟', type: 'Action' },
            { ticker: 'AMZN', name: 'Amazon', domain: 'amazon.com', emoji: '📦', type: 'Action' },
            { ticker: 'GOOGL', name: 'Alphabet', domain: 'google.com', emoji: '🔍', type: 'Action' },
            { ticker: 'META', name: 'Meta', domain: 'meta.com', emoji: '📘', type: 'Action' },
            { ticker: 'TSLA', name: 'Tesla', domain: 'tesla.com', emoji: '⚡', type: 'Action' },
            { ticker: 'AVGO', name: 'Broadcom', domain: 'broadcom.com', emoji: '📡', type: 'Action' },
            { ticker: 'ORCL', name: 'Oracle', domain: 'oracle.com', emoji: '☁️', type: 'Action' },
            { ticker: 'AMD', name: 'AMD', domain: 'amd.com', emoji: '🏎️', type: 'Action' },
            { ticker: 'INTC', name: 'Intel', domain: 'intel.com', emoji: '💾', type: 'Action' },
            { ticker: 'ADBE', name: 'Adobe', domain: 'adobe.com', emoji: '🎨', type: 'Action' },
            { ticker: 'CRM', name: 'Salesforce', domain: 'salesforce.com', emoji: '☁️', type: 'Action' },
            { ticker: 'ASML', name: 'ASML', domain: 'asml.com', emoji: '🔬', type: 'Action' },
        ]
    },
    {
        id: 'finance',
        label: 'Finance & Banques',
        icon: 'fa-landmark',
        color: '#10b981',
        assets: [
            { ticker: 'BRK-B', name: 'Berkshire H.', domain: 'berkshirehathaway.com', emoji: '🏰', type: 'Action' },
            { ticker: 'JPM', name: 'JPMorgan', domain: 'jpmorgan.com', emoji: '🏛️', type: 'Action' },
            { ticker: 'BAC', name: 'Bank of America', domain: 'bankofamerica.com', emoji: '🏦', type: 'Action' },
            { ticker: 'GS', name: 'Goldman Sachs', domain: 'goldmansachs.com', emoji: '📊', type: 'Action' },
            { ticker: 'V', name: 'Visa', domain: 'visa.com', emoji: '💳', type: 'Action' },
            { ticker: 'MA', name: 'Mastercard', domain: 'mastercard.com', emoji: '💳', type: 'Action' },
            { ticker: 'PYPL', name: 'PayPal', domain: 'paypal.com', emoji: '💸', type: 'Action' },
            { ticker: 'BNP.PA', name: 'BNP Paribas', domain: 'bnpparibas.com', emoji: '🏦', type: 'Action' },
            { ticker: 'HSBC', name: 'HSBC', domain: 'hsbc.com', emoji: '🏦', type: 'Action' },
            { ticker: 'ALV.DE', name: 'Allianz', domain: 'allianz.com', emoji: '🛡️', type: 'Action' },
        ]
    },
    {
        id: 'sante',
        label: 'Santé & Pharma',
        icon: 'fa-heart-pulse',
        color: '#ec4899',
        assets: [
            { ticker: 'LLY', name: 'Eli Lilly', domain: 'lilly.com', emoji: '💉', type: 'Action' },
            { ticker: 'NVO', name: 'Novo Nordisk', domain: 'novonordisk.com', emoji: '💊', type: 'Action' },
            { ticker: 'JNJ', name: 'Johnson & J.', domain: 'jnj.com', emoji: '🩹', type: 'Action' },
            { ticker: 'PFE', name: 'Pfizer', domain: 'pfizer.com', emoji: '🧪', type: 'Action' },
            { ticker: 'ABBV', name: 'AbbVie', domain: 'abbvie.com', emoji: '🔬', type: 'Action' },
            { ticker: 'MRK', name: 'Merck', domain: 'merck.com', emoji: '💊', type: 'Action' },
            { ticker: 'SAN.PA', name: 'Sanofi', domain: 'sanofi.com', emoji: '💊', type: 'Action' },
            { ticker: 'ROG.SW', name: 'Roche', domain: 'roche.com', emoji: '🧬', type: 'Action' },
            { ticker: 'NOVN.SW', name: 'Novartis', domain: 'novartis.com', emoji: '🧬', type: 'Action' },
        ]
    },
    {
        id: 'conso',
        label: 'Consommation & Retail',
        icon: 'fa-bag-shopping',
        color: '#f59e0b',
        assets: [
            { ticker: 'WMT', name: 'Walmart', domain: 'walmart.com', emoji: '🛒', type: 'Action' },
            { ticker: 'COST', name: 'Costco', domain: 'costco.com', emoji: '📦', type: 'Action' },
            { ticker: 'HD', name: 'Home Depot', domain: 'homedepot.com', emoji: '🏠', type: 'Action' },
            { ticker: 'MCD', name: "McDonald's", domain: 'mcdonalds.com', emoji: '🍔', type: 'Action' },
            { ticker: 'SBUX', name: 'Starbucks', domain: 'starbucks.com', emoji: '☕', type: 'Action' },
            { ticker: 'NKE', name: 'Nike', domain: 'nike.com', emoji: '👟', type: 'Action' },
            { ticker: 'KO', name: 'Coca-Cola', domain: 'coca-cola.com', emoji: '🥤', type: 'Action' },
            { ticker: 'PEP', name: 'PepsiCo', domain: 'pepsico.com', emoji: '🥤', type: 'Action' },
            { ticker: 'PG', name: 'P&G', domain: 'pg.com', emoji: '🧼', type: 'Action' },
            { ticker: 'AMZN', name: 'Amazon', domain: 'amazon.com', emoji: '📦', type: 'Action' },
        ]
    },
    {
        id: 'media',
        label: 'Médias & Divertissement',
        icon: 'fa-film',
        color: '#8b5cf6',
        assets: [
            { ticker: 'NFLX', name: 'Netflix', domain: 'netflix.com', emoji: '📺', type: 'Action' },
            { ticker: 'DIS', name: 'Disney', domain: 'disney.com', emoji: '🏰', type: 'Action' },
            { ticker: 'SPOT', name: 'Spotify', domain: 'spotify.com', emoji: '🎵', type: 'Action' },
            { ticker: 'RBLX', name: 'Roblox', domain: 'roblox.com', emoji: '🎮', type: 'Action' },
            { ticker: 'EA', name: 'EA Sports', domain: 'ea.com', emoji: '🎮', type: 'Action' },
            { ticker: 'VZ', name: 'Verizon', domain: 'verizon.com', emoji: '📱', type: 'Action' },
            { ticker: 'T', name: 'AT&T', domain: 'att.com', emoji: '📞', type: 'Action' },
        ]
    },
    {
        id: 'energie',
        label: 'Énergie & Matières premières',
        icon: 'fa-bolt',
        color: '#f97316',
        assets: [
            { ticker: 'XOM', name: 'ExxonMobil', domain: 'exxonmobil.com', emoji: '⛽', type: 'Action' },
            { ticker: 'CVX', name: 'Chevron', domain: 'chevron.com', emoji: '⛽', type: 'Action' },
            { ticker: 'TTE.PA', name: 'TotalEnergies', domain: 'totalenergies.com', emoji: '⛽', type: 'Action' },
            { ticker: 'SHEL', name: 'Shell', domain: 'shell.com', emoji: '🐚', type: 'Action' },
            { ticker: 'BP', name: 'BP', domain: 'bp.com', emoji: '🛢️', type: 'Action' },
            { ticker: 'NEE', name: 'NextEra Energy', domain: 'nexteraenergy.com', emoji: '🌬️', type: 'Action' },
            { ticker: 'GLD', name: 'Or (Gold ETF)', domain: 'spdrgoldshares.com', emoji: '🟡', type: 'Commodity' },
            { ticker: 'SLV', name: 'Argent (Silver)', domain: 'ishares.com', emoji: '⚪', type: 'Commodity' },
        ]
    },
    {
        id: 'cac40',
        label: 'CAC 40 — France',
        icon: 'fa-flag',
        color: '#3b82f6',
        assets: [
            { ticker: 'MC.PA', name: 'LVMH', domain: 'lvmh.com', emoji: '💎', type: 'Action' },
            { ticker: 'RMS.PA', name: 'Hermès', domain: 'hermes.com', emoji: '🐎', type: 'Action' },
            { ticker: 'OR.PA', name: "L'Oréal", domain: 'loreal.com', emoji: '💄', type: 'Action' },
            { ticker: 'KER.PA', name: 'Kering', domain: 'kering.com', emoji: '👜', type: 'Action' },
            { ticker: 'AIR.PA', name: 'Airbus', domain: 'airbus.com', emoji: '✈️', type: 'Action' },
            { ticker: 'AI.PA', name: 'Air Liquide', domain: 'airliquide.com', emoji: '🧪', type: 'Action' },
            { ticker: 'DG.PA', name: 'Vinci', domain: 'vinci.com', emoji: '🏗️', type: 'Action' },
            { ticker: 'EL.PA', name: 'EssilorLuxottica', domain: 'essilor-luxottica.com', emoji: '👓', type: 'Action' },
            { ticker: 'SAN.PA', name: 'Sanofi', domain: 'sanofi.com', emoji: '💊', type: 'Action' },
            { ticker: 'BNP.PA', name: 'BNP Paribas', domain: 'bnpparibas.com', emoji: '🏦', type: 'Action' },
            { ticker: 'STLAP.PA', name: 'Stellantis', domain: 'stellantis.com', emoji: '🚗', type: 'Action' },
            { ticker: 'CS.PA', name: 'AXA', domain: 'axa.com', emoji: '🛡️', type: 'Action' },
        ]
    },
    {
        id: 'europe',
        label: 'Europe hors France',
        icon: 'fa-earth-europe',
        color: '#06b6d4',
        assets: [
            { ticker: 'NESN.SW', name: 'Nestlé', domain: 'nestle.com', emoji: '🍫', type: 'Action' },
            { ticker: 'ROG.SW', name: 'Roche', domain: 'roche.com', emoji: '🧬', type: 'Action' },
            { ticker: 'NOVN.SW', name: 'Novartis', domain: 'novartis.com', emoji: '💊', type: 'Action' },
            { ticker: 'SAP', name: 'SAP', domain: 'sap.com', emoji: '💻', type: 'Action' },
            { ticker: 'SIE.DE', name: 'Siemens', domain: 'siemens.com', emoji: '⚙️', type: 'Action' },
            { ticker: 'BMW.DE', name: 'BMW', domain: 'bmw.com', emoji: '🚗', type: 'Action' },
            { ticker: 'VOW3.DE', name: 'Volkswagen', domain: 'volkswagen.com', emoji: '🚙', type: 'Action' },
            { ticker: 'NVO', name: 'Novo Nordisk', domain: 'novonordisk.com', emoji: '💉', type: 'Action' },
            { ticker: 'ULVR.L', name: 'Unilever', domain: 'unilever.com', emoji: '🧴', type: 'Action' },
        ]
    },
    {
        id: 'asie',
        label: 'Asie & Marchés émergents',
        icon: 'fa-earth-asia',
        color: '#ef4444',
        assets: [
            { ticker: 'TM', name: 'Toyota', domain: 'toyota.com', emoji: '🚗', type: 'Action' },
            { ticker: 'SONY', name: 'Sony', domain: 'sony.com', emoji: '🎮', type: 'Action' },
            { ticker: '9984.T', name: 'SoftBank', domain: 'softbank.jp', emoji: '📡', type: 'Action' },
            { ticker: 'BABA', name: 'Alibaba', domain: 'alibaba.com', emoji: '🇨🇳', type: 'Action' },
            { ticker: 'BIDU', name: 'Baidu', domain: 'baidu.com', emoji: '🔍', type: 'Action' },
            { ticker: 'TSM', name: 'TSMC', domain: 'tsmc.com', emoji: '🔬', type: 'Action' },
            { ticker: 'HSBC', name: 'HSBC', domain: 'hsbc.com', emoji: '🏦', type: 'Action' },
            { ticker: 'RELIANCE.NS', name: 'Reliance', domain: 'ril.com', emoji: '🇮🇳', type: 'Action' },
        ]
    },
    {
        id: 'etf',
        label: 'ETF & Indices',
        icon: 'fa-chart-pie',
        color: '#a855f7',
        assets: [
            { ticker: 'SPY', name: 'S&P 500 ETF', domain: 'ssga.com', emoji: '🇺🇸', type: 'ETF' },
            { ticker: 'QQQ', name: 'Nasdaq ETF', domain: 'invesco.com', emoji: '🚀', type: 'ETF' },
            { ticker: 'IWDA.AS', name: 'MSCI World', domain: 'ishares.com', emoji: '🌍', type: 'ETF' },
            { ticker: 'VUSA.AS', name: 'S&P 500 Acc.', domain: 'vanguard.com', emoji: '💰', type: 'ETF' },
            { ticker: 'CSPX.L', name: 'iSh S&P 500', domain: 'ishares.com', emoji: '📊', type: 'ETF' },
            { ticker: 'PANX.PA', name: 'CAC 40 ETF', domain: 'amundietf.com', emoji: '🇫🇷', type: 'ETF' },
            { ticker: '^GSPC', name: 'S&P 500', domain: 'spglobal.com', emoji: '🇺🇸', type: 'Indice' },
            { ticker: '^FCHI', name: 'CAC 40', domain: 'euronext.com', emoji: '🇫🇷', type: 'Indice' },
            { ticker: '^GDAXI', name: 'DAX 40', domain: 'deutsche-boerse.com', emoji: '🇩🇪', type: 'Indice' },
            { ticker: '^STOXX50E', name: 'EuroStoxx 50', domain: 'stoxx.com', emoji: '🇪🇺', type: 'Indice' },
        ]
    },
    {
        id: 'crypto',
        label: 'Crypto-monnaies',
        icon: 'fa-bitcoin-sign',
        color: '#f59e0b',
        assets: [
            { ticker: 'BTC-USD', name: 'Bitcoin', domain: 'bitcoin.org', emoji: '₿', type: 'Crypto' },
            { ticker: 'ETH-USD', name: 'Ethereum', domain: 'ethereum.org', emoji: '💎', type: 'Crypto' },
            { ticker: 'SOL-USD', name: 'Solana', domain: 'solana.com', emoji: '☀️', type: 'Crypto' },
            { ticker: 'BNB-USD', name: 'BNB', domain: 'binance.com', emoji: '🔶', type: 'Crypto' },
            { ticker: 'XRP-USD', name: 'XRP', domain: 'ripple.com', emoji: '💸', type: 'Crypto' },
            { ticker: 'DOGE-USD', name: 'Dogecoin', domain: 'dogecoin.com', emoji: '🐕', type: 'Crypto' },
            { ticker: 'ADA-USD', name: 'Cardano', domain: 'cardano.org', emoji: '🔵', type: 'Crypto' },
            { ticker: 'AVAX-USD', name: 'Avalanche', domain: 'avax.network', emoji: '❄️', type: 'Crypto' },
            { ticker: 'LINK-USD', name: 'Chainlink', domain: 'chain.link', emoji: '🔗', type: 'Crypto' },
            { ticker: 'DOT-USD', name: 'Polkadot', domain: 'polkadot.network', emoji: '🔴', type: 'Crypto' },
        ]
    },
];

class ScreenerApp {
    constructor() {
        this.storage = new Storage();
        this.currentSymbol = null;
        this.currentData = null;
        this.priceChart = null;
        this.regressionChart = null;
        this.sp500Chart = null;
        this.radarChart = null;
        this.searchDebounce = null;
        this._cachedBenchmarkData = {};
    }

    async init() {
        this.setupSearch();
        this.renderPopularAssets();
        this.setupTabs();
        this.setupWatchlistButton();

        // Check for ticker in URL params
        const params = new URLSearchParams(window.location.search);
        const ticker = params.get('ticker');
        if (ticker) {
            await this.loadStock(ticker.toUpperCase());
        }
    }

    // ─── Search ──────────────────────────────────────────────────────────────
    setupSearch() {
        const input = document.getElementById('screener-search-input');
        const clear = document.getElementById('screener-search-clear');
        const suggestions = document.getElementById('screener-suggestions');

        input.addEventListener('input', () => {
            const q = input.value.trim();
            clear.style.display = q ? 'block' : 'none';
            if (this.searchDebounce) clearTimeout(this.searchDebounce);
            if (q.length >= 1) {
                this.searchDebounce = setTimeout(() => this.fetchSuggestions(q), 280);
            } else {
                suggestions.innerHTML = '';
                suggestions.classList.remove('open');
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const q = input.value.trim().toUpperCase();
                if (q) {
                    suggestions.classList.remove('open');
                    this.loadStock(q);
                    input.blur();
                }
            }
            if (e.key === 'Escape') {
                suggestions.classList.remove('open');
            }
        });

        clear.addEventListener('click', () => {
            input.value = '';
            clear.style.display = 'none';
            suggestions.innerHTML = '';
            suggestions.classList.remove('open');
            input.focus();
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.screener-search-section')) {
                suggestions.classList.remove('open');
            }
        });
    }

    async fetchSuggestions(query) {
        const suggestions = document.getElementById('screener-suggestions');
        try {
            const url = `${PROXY}?symbol=${encodeURIComponent(query)}&type=SEARCH`;
            const data = await this.safeFetchJson(url);
            const quotes = (data.quotes || []).filter(q =>
                q.quoteType === 'EQUITY' || q.quoteType === 'ETF' || q.quoteType === 'MUTUALFUND'
            ).slice(0, 7);

            if (!quotes.length) {
                suggestions.classList.remove('open');
                return;
            }

            suggestions.innerHTML = quotes.map(q => `
                <div class="suggestion-item" data-ticker="${q.symbol}">
                    <span class="suggestion-ticker">${q.symbol}</span>
                    <span class="suggestion-name">${q.shortname || q.longname || '—'}</span>
                    <span class="suggestion-type">${q.quoteType || ''}</span>
                </div>
            `).join('');
            suggestions.classList.add('open');

            suggestions.querySelectorAll('.suggestion-item').forEach(item => {
                item.addEventListener('click', () => {
                    const ticker = item.dataset.ticker;
                    document.getElementById('screener-search-input').value = ticker;
                    suggestions.classList.remove('open');
                    this.loadStock(ticker);
                });
            });
        } catch {
            suggestions.classList.remove('open');
        }
    }

    // ─── Popular Assets Grid (groupes thématiques) ────────────────────────────
    renderPopularAssets() {
        const grid = document.getElementById('popular-assets-grid');
        if (!grid) return;

        const typeColors = {
            'Action': { bg: 'rgba(99,102,241,0.12)', color: '#818cf8' },
            'ETF': { bg: 'rgba(16,185,129,0.12)', color: '#10b981' },
            'Indice': { bg: 'rgba(59,130,246,0.12)', color: '#60a5fa' },
            'Crypto': { bg: 'rgba(245,158,11,0.12)', color: '#fbbf24' },
            'Commodity': { bg: 'rgba(251,191,36,0.12)', color: '#f59e0b' },
        };

        grid.innerHTML = POPULAR_ASSET_GROUPS.map(group => {
            const cardsHtml = group.assets.map(asset => {
                const logoUrl = `https://www.google.com/s2/favicons?domain=${asset.domain}&sz=64`;
                const safeEmoji = asset.emoji.replace(/'/g, '');
                const safeName = asset.name.replace(/'/g, '&#39;');
                const displayTicker = asset.ticker.replace(/\.[A-Z]+$/, '').replace(/[\^]/, '');
                const tc = typeColors[asset.type] || typeColors['Action'];
                return `
                    <button class="popular-asset-card" data-ticker="${asset.ticker}" title="${safeName}">
                        <div class="popular-asset-logo-wrap">
                            <img
                                src="${logoUrl}"
                                alt="${safeName}"
                                loading="lazy"
                                onerror="this.style.display='none';this.parentElement.textContent='${safeEmoji}'"
                            >
                        </div>
                        <span class="popular-asset-ticker">${displayTicker}</span>
                        <span class="popular-asset-name">${asset.name}</span>
                        <span class="popular-asset-type" style="background:${tc.bg};color:${tc.color}">${asset.type}</span>
                    </button>
                `;
            }).join('');

            return `
                <div class="popular-group">
                    <div class="popular-group-header">
                        <span class="popular-group-icon" style="color:${group.color}">
                            <i class="fas ${group.icon}"></i>
                        </span>
                        <span class="popular-group-label">${group.label}</span>
                        <span class="popular-group-count">${group.assets.length}</span>
                    </div>
                    <div class="popular-group-grid">
                        ${cardsHtml}
                    </div>
                </div>
            `;
        }).join('');

        grid.querySelectorAll('.popular-asset-card').forEach(card => {
            card.addEventListener('click', () => {
                const ticker = card.dataset.ticker;
                document.getElementById('screener-search-input').value = ticker;
                document.getElementById('screener-search-clear').style.display = 'block';
                this.loadStock(ticker);
            });
        });
    }

    // ─── Load Stock Data ─────────────────────────────────────────────────────
    async loadStock(symbol) {
        this.currentSymbol = symbol;
        this.showState('loading');

        try {
            // Fetch fundamentals + price history in parallel
            const [quoteSummary, priceHistory, sp500History, fundamentals] = await Promise.all([
                this.fetchQuoteSummary(symbol),
                this.fetchPriceHistory(symbol, this.currentPeriod),
                this.fetchPriceHistory(SP500_SYMBOL, '5y'),
                this.fetchFundamentals(symbol),
            ]);

            if (!quoteSummary || quoteSummary.error) {
                throw new Error(`Aucune donnée trouvée pour "${symbol}"`);
            }

            this.currentData = { quoteSummary, priceHistory, sp500History, fundamentals };
            this.render();
            this.showState('panel');

            // Update URL without reload
            const url = new URL(window.location);
            url.searchParams.set('ticker', symbol);
            window.history.replaceState({}, '', url);

        } catch (err) {
            logger.error('[Screener] Error:', err);
            this.showError(err.message);
        }
    }

    // ─── Tabs ──────────────────────────────────────────────────────────────
    setupTabs() {
        const tabs = document.querySelectorAll('.screener-tab');
        const contents = document.querySelectorAll('.screener-tab-content');
        tabs.forEach(tab => {
            tab.addEventListener('click', async () => {
                if (tab.classList.contains('disabled')) {
                    this.showTempMessage('Fonctionnalité bientôt disponible', 1600);
                    return;
                }
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const name = tab.dataset.tab;
                contents.forEach(c => c.classList.remove('active'));
                const target = document.getElementById(`tab-${name}`);
                if (target) {
                    target.classList.add('active');
                    if (name === 'valorisation') {
                        await this.renderValuationTab();
                    } else if (name === 'quantitatif') {
                        await this.renderQuantitativeTab();
                    } else if (name === 'dividende') {
                        await this.renderDividendeTab();
                    } else if (name === 'finances') {
                        await this.renderFinancesTab();
                    }
                }
            });
        });
        // Initial setup for tab-specific listeners
        this.setupValuationTabListeners();
        this.setupFinanceTabButtons();
    }

    setupWatchlistButton() {
        const btn = document.getElementById('screener-watchlist-btn');
        if (!btn) return;

        btn.addEventListener('click', async () => {
            if (!this.currentSymbol) return;

            const inWatchlist = this.storage.isInWatchlist(this.currentSymbol);
            try {
                if (inWatchlist) {
                    await this.storage.removeFromWatchlist(this.currentSymbol);
                    this.updateWatchlistButtonState();
                    this.showTempMessage('Retiré de la watchlist');
                } else {
                    const name = document.getElementById('stock-name').textContent || this.currentSymbol;
                    await this.storage.addToWatchlist({ ticker: this.currentSymbol, name: name });
                    this.updateWatchlistButtonState();
                    this.showTempMessage('Ajouté à la watchlist !');
                }
            } catch (e) {
                this.showTempMessage('Erreur: ' + e.message);
            }
        });

        window.addEventListener('watchlist-updated', () => {
            if (this.currentSymbol) this.updateWatchlistButtonState();
        });
    }

    updateWatchlistButtonState() {
        if (!this.currentSymbol) return;
        const btn = document.getElementById('screener-watchlist-btn');
        if (!btn) return;

        const inWatchlist = this.storage.isInWatchlist(this.currentSymbol);
        if (inWatchlist) {
            btn.innerHTML = `<i class="fas fa-check"></i> Dans la watchlist`;
            btn.classList.add('active-watchlist');
            btn.style.background = 'var(--bg-card)';
            btn.style.color = '#10b981';
            btn.style.border = '1px solid #10b981';
        } else {
            btn.innerHTML = `<i class="fas fa-eye"></i> Ajouter à la Watchlist`;
            btn.classList.remove('active-watchlist');
            btn.style.background = '';
            btn.style.color = '';
            btn.style.border = '';
        }
    }

    showTempMessage(msg, ms = 2000) {
        let el = document.getElementById('screener-temp-msg');
        if (!el) {
            el = document.createElement('div');
            el.id = 'screener-temp-msg';
            el.style.position = 'fixed';
            el.style.bottom = '24px';
            el.style.left = '50%';
            el.style.transform = 'translateX(-50%)';
            el.style.background = 'rgba(0,0,0,0.75)';
            el.style.color = '#fff';
            el.style.padding = '8px 12px';
            el.style.borderRadius = '8px';
            el.style.zIndex = '9999';
            el.style.fontSize = '13px';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.opacity = '1';
        clearTimeout(el._timeout);
        el._timeout = setTimeout(() => { el.style.opacity = '0'; }, ms);
    }

    async fetchQuoteSummary(symbol) {
        const modules = [
            'summaryProfile',
            'financialData',
            'defaultKeyStatistics',
            'summaryDetail',
            'earnings',
            'incomeStatementHistory',
            'balanceSheetHistory',
            'cashflowStatementHistory',
            'price'
        ].join(',');
        const url = `${PROXY}?symbol=${encodeURIComponent(symbol)}&type=QUOTE_SUMMARY&modules=${modules}`;
        const data = await this.safeFetchJson(url);
        return data?.quoteSummary?.result?.[0] || null;
    }

    // Multi-year annual financial statements (income statement, balance sheet, cash flow) via
    // Yahoo's fundamentals-timeseries endpoint — richer than quoteSummary's gutted history modules.
    // Never throws: statement data is a bonus for Quantitatif/Dividende/Finances, not required to
    // show the Résumé tab, so a failure here shouldn't block the rest of the page from loading.
    async fetchFundamentals(symbol) {
        try {
            const url = `${PROXY}?symbol=${encodeURIComponent(symbol)}&type=FUNDAMENTALS`;
            const data = await this.safeFetchJson(url);
            return data?.years || [];
        } catch (err) {
            logger.error('[Screener] fetchFundamentals failed:', err);
            return [];
        }
    }

    async fetchPriceHistory(symbol, period) {
        const rangeMap = {
            '1mo': { range: '1mo', interval: '1d' },
            '3mo': { range: '3mo', interval: '1d' },
            '6mo': { range: '6mo', interval: '1d' },
            'ytd': { range: 'ytd', interval: '1d' },
            '1y': { range: '1y', interval: '1wk' },
            '3y': { range: '2y', interval: '1wk' },
            '5y': { range: '5y', interval: '1wk' },
            '10y': { range: '10y', interval: '1mo' },
            '10ywk': { range: '10y', interval: '1wk' }, // ~520 pts for MA buffer
            'max': { range: 'max', interval: '1mo' },
        };
        const { range, interval } = rangeMap[period] || rangeMap['1y'];
        const url = `${PROXY}?symbol=${encodeURIComponent(symbol)}&range=${range}&interval=${interval}`;
        const data = await this.safeFetchJson(url);
        const chart = data?.chart?.result?.[0];
        if (!chart) return null;
        const timestamps = chart.timestamp || [];
        const closes = chart.indicators?.quote?.[0]?.close || [];
        const adjcloses = chart.indicators?.adjclose?.[0]?.adjclose || closes;

        return timestamps.map((ts, i) => ({
            t: ts * 1000,
            c: closes[i],
            a: adjcloses[i] || closes[i]
        })).filter(d => d.c != null);
    }

    // Wrapper fetch that logs non-OK responses and returns parsed JSON
    async safeFetchJson(url, opts = {}) {
        try {
            const res = await fetch(url, opts);
            const text = await res.text();
            if (!res.ok) {
                // Try to parse JSON body if possible
                let parsed = text;
                try { parsed = JSON.parse(text); } catch (e) { /* keep raw text */ }
                logger.error('[Fetch] Non-OK response', { url, status: res.status, body: parsed });
                throw new Error(`Fetch ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
            }
            try {
                return JSON.parse(text);
            } catch (e) {
                logger.error('[Fetch] Invalid JSON', { url, body: text });
                throw new Error('Invalid JSON from ' + url);
            }
        } catch (err) {
            logger.error('[Fetch] Error fetching', url, err);
            throw err;
        }
    }

    // ─── Render ───────────────────────────────────────────────────────────────
    render() {
        // Problem 1: Reset active tab to Resume on new search
        const tabs = document.querySelectorAll('.screener-tab');
        const contents = document.querySelectorAll('.screener-tab-content');
        tabs.forEach(t => t.classList.remove('active'));
        contents.forEach(c => c.classList.remove('active'));

        const resumeTab = Array.from(tabs).find(t => t.dataset.tab === 'resume');
        const resumeContent = document.getElementById('tab-resume');
        if (resumeTab) resumeTab.classList.add('active');
        if (resumeContent) resumeContent.classList.add('active');

        const { quoteSummary } = this.currentData;
        const profile = quoteSummary.assetProfile || {};
        const stats = quoteSummary.defaultKeyStatistics || {};
        const financial = quoteSummary.financialData || {};
        const detail = quoteSummary.summaryDetail || {};
        const price = quoteSummary.price || {};

        this.renderHeader(profile, stats, financial, detail, price);
        this.renderCompanyInfo(profile, stats, detail, price);
        this.renderPriceChart();
        this.renderRegressionChart();
        this.renderSP500Chart();
        this.renderRadarAndScore(stats, financial, detail);
        this.renderValuation(stats, financial, detail, price);
        this.setupPeriodButtons();
        this.updateWatchlistButtonState();
        this.setupKpiModals();
    }

    renderHeader(profile, stats, financial, detail, price) {
        const symbol = this.currentSymbol;
        const name = price.longName || price.shortName || symbol;
        const currentPrice = price.regularMarketPrice?.raw ?? detail.previousClose?.raw ?? 0;
        const change = price.regularMarketChange?.raw ?? 0;
        const changePct = price.regularMarketChangePercent?.raw ?? 0;
        const currency = price.currency || detail.currency || '';
        const exchange = price.exchangeName || '';

        document.getElementById('stock-name').textContent = name;
        document.getElementById('stock-ticker-badge').textContent = symbol;
        document.getElementById('stock-exchange').textContent = exchange;
        document.getElementById('stock-currency').textContent = currency;

        document.getElementById('stock-price').textContent =
            `${this.fmt(currentPrice, 2)} ${currency}`;

        const changeEl = document.getElementById('stock-change');
        const sign = change >= 0 ? '+' : '';
        changeEl.textContent = `${sign}${this.fmt(change, 2)} (${sign}${(changePct * 100).toFixed(2)}%)`;
        changeEl.className = 'stock-change ' + (change >= 0 ? 'positive' : 'negative');

        const logoEl = document.getElementById('stock-logo');
        const domain = profile.website?.replace(/https?:\/\/(www\.)?/, '').split('/')[0];
        if (domain) {
            logoEl.innerHTML = `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=128" alt="${name}" onerror="this.parentElement.textContent='${symbol.charAt(0)}'">`;
        } else {
            logoEl.textContent = symbol.charAt(0);
        }

        document.getElementById('price-chart-label').textContent =
            `${this.fmt(currentPrice, 2)} ${currency}  ${sign}${(changePct * 100).toFixed(2)}%`;
    }

    renderCompanyInfo(profile, stats, detail, price) {
        const mktCap = price.marketCap?.raw ?? detail.marketCap?.raw;
        const currency = price.currency || '';
        const website = profile.website || '';
        const exchange = price.exchangeName || '';

        document.getElementById('info-ticker').textContent = this.currentSymbol;
        document.getElementById('info-mktcap').textContent = mktCap ? this.fmtBig(mktCap, currency) : '—';
        document.getElementById('info-exchange').textContent = exchange;
        document.getElementById('info-website').innerHTML = website
            ? `<a href="${website}" target="_blank" rel="noopener">${website.replace('https://', '').replace('http://', '')}</a>`
            : '—';
        document.getElementById('info-isin').textContent = stats.isin || '—';
        document.getElementById('info-sector').textContent = profile.sector || '—';
        document.getElementById('info-country').textContent = profile.country || '—';
        document.getElementById('info-industry').textContent = profile.industry || '—';
        document.getElementById('info-currency').textContent = currency || '—';
        document.getElementById('info-subindustry').textContent = profile.industry || '—'; // Yahoo doesn't expose sub-industry separately

        // PEA badge: European exchanges are generally PEA-eligible (rough heuristic)
        const ex = (price.exchange || '').toUpperCase();
        const isPEAEligible = ['EPA', 'PAR', 'BRU', 'AMS', 'MIL', 'FRA', 'STU', 'EBS'].some(e => ex.includes(e));
        const peaBadge = document.getElementById('info-pea-badge');
        if (isPEAEligible) {
            peaBadge.className = 'info-badge badge-green';
            peaBadge.innerHTML = '<i class="fas fa-check-circle"></i> PEA : Éligible';
        } else {
            peaBadge.className = 'info-badge badge-red';
            peaBadge.innerHTML = '<i class="fas fa-times-circle"></i> PEA : Non éligible';
        }

        // Dividend badge
        const hasDiv = (detail.dividendYield?.raw ?? 0) > 0 || (detail.trailingAnnualDividendYield?.raw ?? 0) > 0;
        const divBadge = document.getElementById('info-div-badge');
        if (hasDiv) {
            divBadge.className = 'info-badge badge-green';
            divBadge.innerHTML = '<i class="fas fa-check-circle"></i> Dividende : Oui';
        } else {
            divBadge.className = 'info-badge badge-red';
            divBadge.innerHTML = '<i class="fas fa-times-circle"></i> Dividende : Non';
        }
    }

    // ─── Price Chart ──────────────────────────────────────────────────────────
    renderPriceChart() {
        const data = this.currentData.priceHistory;
        if (!data || !data.length) return;

        const canvas = document.getElementById('price-chart');
        if (this.priceChart) this.priceChart.destroy();

        const labels = data.map(d => new Date(d.t).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' }));
        const values = data.map(d => d.c);

        const first = values[0], last = values[values.length - 1];
        const isUp = last >= first;
        const color = isUp ? '#10b981' : '#ef4444';

        // Check if user holds this asset → show PRU line
        const purchases = this.storage.getPurchases().filter(p => p.ticker.toUpperCase() === this.currentSymbol);
        let avgPrice = null;
        if (purchases.length > 0) {
            const totalQty = purchases.reduce((s, p) => s + p.quantity, 0);
            const totalCost = purchases.reduce((s, p) => s + p.price * p.quantity, 0);
            avgPrice = totalCost / totalQty;
        }

        // Chart stats
        const perfPct = ((last - first) / first) * 100;
        const years = (data[data.length - 1].t - data[0].t) / (365.25 * 24 * 3600 * 1000);
        const cagr = years > 0 ? (Math.pow(last / first, 1 / years) - 1) * 100 : 0;
        const volatility = this.calcVolatility(values, this.calcPeriodsPerYear(data));

        const el = (id) => document.getElementById(id);
        this.setColorValue(el('cs-perf'), `${perfPct >= 0 ? '+' : ''}${perfPct.toFixed(1)}%`, perfPct >= 0);
        this.setColorValue(el('cs-cagr'), `${cagr >= 0 ? '+' : ''}${cagr.toFixed(1)}%/an`, cagr >= 0);
        el('cs-vol').textContent = `${volatility.toFixed(1)}%`;

        const datasets = [{
            label: this.currentSymbol,
            data: values,
            borderColor: color,
            backgroundColor: isUp ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.3,
        }];

        if (avgPrice !== null) {
            datasets.push({
                label: `PRU : ${this.fmt(avgPrice, 2)}`,
                data: Array(values.length).fill(avgPrice),
                borderColor: '#f59e0b',
                borderWidth: 1.5,
                borderDash: [6, 3],
                pointRadius: 0,
                fill: false,
            });
        }

        this.priceChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels, datasets },
            options: this.baseChartOptions(),
        });
    }

    // ─── Regression Chart ─────────────────────────────────────────────────────
    renderRegressionChart() {
        const data = this.currentData.priceHistory;
        if (!data || data.length < 4) return;

        const canvas = document.getElementById('regression-chart');
        if (this.regressionChart) this.regressionChart.destroy();

        const values = data.map(d => d.c);
        const n = values.length;
        const indices = values.map((_, i) => i);

        // Linear regression on log prices (better for exponential trends)
        const logVals = values.map(v => Math.log(v));
        const { slope, intercept, r2 } = this.linearRegression(indices, logVals);

        const regressionLine = indices.map(i => Math.exp(intercept + slope * i));

        // Deviation bands from the actual residual std-dev (±1σ), not a fixed ±15%
        const residuals = logVals.map((lv, i) => lv - (intercept + slope * i));
        const residMean = residuals.reduce((s, r) => s + r, 0) / residuals.length;
        const sigma = Math.sqrt(residuals.reduce((s, r) => s + (r - residMean) ** 2, 0) / residuals.length);
        const upperBand = regressionLine.map(v => v * Math.exp(sigma));
        const lowerBand = regressionLine.map(v => v * Math.exp(-sigma));

        const labels = data.map(d => new Date(d.t).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' }));
        const currency = this.currentData.quoteSummary?.price?.currency || '';
        const currentPrice = values[n - 1];
        const regCurrentPrice = regressionLine[n - 1];

        // Annualized slope, derived from the actual data cadence (not assumed weekly)
        const pointsPerYear = this.calcPeriodsPerYear(data);
        const annualSlope = (Math.exp(slope * pointsPerYear) - 1) * 100;

        document.getElementById('reg-current').textContent = `${this.fmt(currentPrice, 2)} ${currency}`;
        this.setColorValue(document.getElementById('reg-value'),
            `${this.fmt(regCurrentPrice, 2)} ${currency}`,
            currentPrice >= regCurrentPrice);
        this.setColorValue(document.getElementById('reg-slope'),
            `${annualSlope >= 0 ? '+' : ''}${annualSlope.toFixed(1)}%/an`,
            annualSlope >= 0);

        this.regressionChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels,
                datasets: [
                    { label: 'Prix', data: values, borderColor: '#10b981', borderWidth: 2, pointRadius: 0, fill: false, tension: 0.3 },
                    { label: 'Régression', data: regressionLine, borderColor: '#f59e0b', borderWidth: 2, borderDash: [4, 3], pointRadius: 0, fill: false },
                    { label: 'Bande sup.', data: upperBand, borderColor: 'rgba(245,158,11,0.25)', borderWidth: 1, borderDash: [2, 4], pointRadius: 0, fill: '+1', backgroundColor: 'rgba(245,158,11,0.04)' },
                    { label: 'Bande inf.', data: lowerBand, borderColor: 'rgba(245,158,11,0.25)', borderWidth: 1, borderDash: [2, 4], pointRadius: 0, fill: false },
                ]
            },
            options: this.baseChartOptions(),
        });
    }

    // ─── S&P 500 Chart ────────────────────────────────────────────────────────
    renderSP500Chart() {
        const stockData5y = this.currentData.sp500History; // We'll re-use priceHistory for stock if 5y
        if (!this.currentData.sp500History) return;

        const canvas = document.getElementById('sp500-chart');
        if (this.sp500Chart) this.sp500Chart.destroy();

        // We need 5y data for both stock and S&P. Let's already have S&P; load stock 5y separately.
        const sp500 = this.currentData.sp500History.filter(d => d.c != null);
        if (!sp500.length) return;

        let stockPriceHistory = this.currentData.priceHistory || [];
        if (!stockPriceHistory.length) return;

        // Filter S&P 500 to match the stock's time period
        const startTs = stockPriceHistory[0].t;
        const sp500Filtered = sp500.filter(d => d.t >= startTs);

        if (!sp500Filtered.length) return;

        // Normalize to 100 at start
        const sp500Base = sp500Filtered[0].c;
        const sp500Norm = sp500Filtered.map(d => (d.c / sp500Base) * 100);

        const stockBase = stockPriceHistory[0].c;
        const stockNorm = stockPriceHistory.map(d => (d.c / stockBase) * 100);

        // Compute stats — both CAGRs use the actual elapsed time of the currently
        // selected period, not a fixed 5 years (sp500Filtered is time-aligned to stockPriceHistory).
        const spLast = sp500Norm[sp500Norm.length - 1];
        const stockLast = stockNorm[stockNorm.length - 1];
        const diff = stockLast - spLast;
        const stockYears = (stockPriceHistory[stockPriceHistory.length - 1].t - stockPriceHistory[0].t) / (365.25 * 24 * 3600 * 1000);
        const spYears = (sp500Filtered[sp500Filtered.length - 1].t - sp500Filtered[0].t) / (365.25 * 24 * 3600 * 1000);
        const stockCAGR = stockYears > 0 ? (Math.pow(stockLast / 100, 1 / stockYears) - 1) * 100 : 0;
        const spCAGR = spYears > 0 ? (Math.pow(spLast / 100, 1 / spYears) - 1) * 100 : 0;

        const periodLabels = { '1mo': '1M', '3mo': '3M', '6mo': '6M', '1y': '1A', '5y': '5A' };
        const diffLabel = document.getElementById('sp-diff-label');
        if (diffLabel) diffLabel.textContent = `Diff. ${periodLabels[this.currentPeriod] || ''}`;

        this.setColorValue(document.getElementById('sp-diff'), `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%`, diff >= 0);
        this.setColorValue(document.getElementById('sp-cagr-stock'), `${stockCAGR >= 0 ? '+' : ''}${stockCAGR.toFixed(1)}%/an`, stockCAGR >= 0);
        this.setColorValue(document.getElementById('sp-cagr-sp'), `${spCAGR >= 0 ? '+' : ''}${spCAGR.toFixed(1)}%/an`, spCAGR >= 0);

        const spLabels = sp500Filtered.map(d => new Date(d.t).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }));

        // Map each stock point to the closest S&P 500 label index by timestamp
        const stockDataPoints = [];
        let lastIdx = -1;
        stockNorm.forEach((v, i) => {
            const t = stockPriceHistory[i].t;
            let closestIdx = 0;
            let minDiff = Infinity;
            for (let j = 0; j < sp500Filtered.length; j++) {
                const diff = Math.abs(sp500Filtered[j].t - t);
                if (diff < minDiff) { minDiff = diff; closestIdx = j; }
            }
            if (closestIdx !== lastIdx) {
                stockDataPoints.push({ x: closestIdx, y: v });
                lastIdx = closestIdx;
            } else if (stockDataPoints.length > 0) {
                // If multiple stock points map to the same S&P day (e.g. intraday vs daily),
                // over-write the previous y to keep only the final close for that index.
                stockDataPoints[stockDataPoints.length - 1].y = v;
            }
        });

        // Ensure the datasets are drawn correctly even with gaps
        this.sp500Chart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: spLabels,
                datasets: [
                    {
                        label: this.currentSymbol,
                        data: stockDataPoints,
                        borderColor: '#6366f1',
                        borderWidth: 2,
                        pointRadius: 0,
                        fill: false,
                        tension: 0.3,
                    },
                    {
                        label: 'S&P 500',
                        data: sp500Norm,
                        borderColor: '#f59e0b',
                        borderWidth: 2,
                        pointRadius: 0,
                        fill: false,
                        tension: 0.3,
                    },
                ]
            },
            options: {
                ...this.baseChartOptions(),
                plugins: {
                    ...this.baseChartOptions().plugins,
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: '#94a3b8',
                            font: { size: 11 },
                            boxWidth: 12,
                            padding: 10,
                            usePointStyle: true,
                        }
                    }
                }
            },
        });
    }

    // ─── Radar & Score ────────────────────────────────────────────────────────
    renderRadarAndScore(stats, financial, detail) {
        const canvas = document.getElementById('radar-chart');
        const dimensions = this.calculateRadarDimensions(stats, financial, detail);

        const axes = Object.keys(dimensions);
        const vals = Object.values(dimensions);
        const totalScore = parseFloat(this.calculateScore(stats, financial, detail));

        // Update score badges
        document.getElementById('stock-score-value').textContent = totalScore.toFixed(1);
        document.getElementById('radar-score-badge').textContent = `${totalScore.toFixed(1)}/20`;

        // Color score badge
        const scoreBadge = document.getElementById('stock-score-badge');
        scoreBadge.style.background = totalScore >= 14
            ? 'linear-gradient(135deg, rgba(16,185,129,0.2), rgba(5,150,105,0.2))'
            : totalScore >= 10
                ? 'linear-gradient(135deg, rgba(245,158,11,0.2), rgba(217,119,6,0.2))'
                : 'linear-gradient(135deg, rgba(239,68,68,0.2), rgba(185,28,28,0.2))';
        document.getElementById('stock-score-value').style.color = totalScore >= 14 ? '#10b981' : totalScore >= 10 ? '#f59e0b' : '#ef4444';

        // Legend
        const legendEl = document.getElementById('radar-legend');
        legendEl.innerHTML = axes.map((name, i) => `
            <div class="radar-legend-item">
                <span class="radar-legend-name">${name}</span>
                <span class="radar-legend-score">${vals[i].toFixed(1)}/5</span>
            </div>
        `).join('');

        // Radar chart
        if (this.radarChart) this.radarChart.destroy();
        this.radarChart = new Chart(canvas.getContext('2d'), {
            type: 'radar',
            data: {
                labels: axes,
                datasets: [{
                    label: this.currentSymbol,
                    data: vals,
                    backgroundColor: 'rgba(99,102,241,0.2)',
                    borderColor: '#6366f1',
                    borderWidth: 2,
                    pointBackgroundColor: '#6366f1',
                    pointRadius: 4,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                scales: {
                    r: {
                        min: 0,
                        max: 5,
                        ticks: {
                            display: false,
                            stepSize: 1,
                        },
                        grid: { color: 'rgba(255,255,255,0.07)' },
                        angleLines: { color: 'rgba(255,255,255,0.07)' },
                        pointLabels: {
                            color: '#94a3b8',
                            font: { size: 11, weight: '500' },
                        }
                    }
                },
                plugins: { legend: { display: false } }
            }
        });
    }

    // ─── Valuation ────────────────────────────────────────────────────────────
    renderValuation(stats, financial, detail, price) {
        const currency = price.currency || '';
        const currentPrice = price.regularMarketPrice?.raw ?? 0;

        // PE-based fair value: EPS * avg historical PE of sector (simplified: use trailing PE * 0.85 as "fair")
        const trailingEPS = stats.trailingEps?.raw;
        const forwardEPS = stats.forwardEps?.raw;
        const forwardPE = stats.forwardPE?.raw;
        const trailingPE = detail.trailingPE?.raw;
        const pbRatio = detail.priceToBook?.raw;
        const psRatio = stats.priceToSalesTrailing12Months?.raw ?? detail.priceToBook?.raw;
        const bookValue = stats.bookValue?.raw;

        const items = [];

        // Price/Earnings based
        if (trailingEPS && trailingPE) {
            const historicalPE = 18; // Market avg
            const peFairValue = trailingEPS * historicalPE;
            items.push({ label: 'Prix juste (P/E 18x)', value: peFairValue, currency });
        }

        // Forward PE based — uses the forward (estimated) EPS, not trailing EPS
        if (forwardEPS && forwardPE) {
            const forwardFairValue = forwardEPS * 15; // Conservative
            items.push({ label: 'P/E Forward 15x', value: forwardFairValue, currency });
        }

        // Price/Book based
        if (bookValue) {
            const avgPB = 2.5; // Conservative avg
            const pbFairValue = bookValue * avgPB;
            items.push({ label: 'Prix/Book 2.5x', value: pbFairValue, currency });
        }

        // Graham Number: sqrt(22.5 * EPS * Book)
        if (trailingEPS && bookValue && trailingEPS > 0 && bookValue > 0) {
            const graham = Math.sqrt(22.5 * trailingEPS * bookValue);
            items.push({ label: 'Nombre de Graham', value: graham, currency });
        }

        // DCF simplified: use free cash flow per share
        const fcfPerShare = financial.freeCashflow?.raw && stats.sharesOutstanding?.raw
            ? financial.freeCashflow.raw / stats.sharesOutstanding.raw
            : null;
        if (fcfPerShare && fcfPerShare > 0) {
            const growthRate = financial.revenueGrowth?.raw ?? 0.05;
            const cappedGrowthRate = Math.min(growthRate, 0.20);
            const discountRate = 0.10;
            const terminalGrowth = 0.025;
            // Simplified DCF: sum 10 years + terminal
            let dcf = 0;
            let fcf = fcfPerShare;
            for (let y = 1; y <= 10; y++) {
                fcf *= (1 + cappedGrowthRate);
                dcf += fcf / Math.pow(1 + discountRate, y);
            }
            const terminal = (fcf * (1 + terminalGrowth)) / (discountRate - terminalGrowth);
            dcf += terminal / Math.pow(1 + discountRate, 10);
            const tooltip = `Hypothèses : croissance FCF ${(cappedGrowthRate * 100).toFixed(1)}%/an sur 10 ans (basée sur la croissance du CA, plafonnée à 20%), taux d'actualisation ${(discountRate * 100).toFixed(0)}%, croissance terminale ${(terminalGrowth * 100).toFixed(1)}%`;
            items.push({ label: 'DCF (simplifié)', value: dcf, currency, tooltip });
        }

        if (!items.length) {
            document.getElementById('valuation-list').innerHTML = '<div class="valuation-skeleton">Données insuffisantes pour calculer la valorisation.</div>';
            return;
        }

        // Median fair value
        const fairValues = items.map(i => i.value).filter(v => v > 0);
        const medianFV = this.median(fairValues);
        const diffPct = currentPrice > 0 ? ((currentPrice - medianFV) / medianFV) * 100 : 0;
        const valuationDiffEl = document.getElementById('valuation-diff');
        valuationDiffEl.textContent = `${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%`;
        valuationDiffEl.className = 'valuation-diff ' + (diffPct <= -10 ? 'positive' : diffPct >= 10 ? 'negative' : '');

        // Compute max for bar normalization
        const allValues = [...items.map(i => i.value), currentPrice];
        const maxVal = Math.max(...allValues) * 1.1;

        // Build valuation list
        const html = [
            // Current price reference row
            `<div class="valuation-row">
                <span class="valuation-label">Prix actuel</span>
                <div class="valuation-bar-wrap"><div class="valuation-bar-fill neutral" style="width:${(currentPrice / maxVal * 100).toFixed(1)}%"></div></div>
                <span class="valuation-price">${this.fmt(currentPrice, 2)} ${currency}</span>
            </div>`,
            ...items.map(item => {
                const barPct = (item.value / maxVal * 100).toFixed(1);
                const cls = item.value >= currentPrice ? 'above' : 'below';
                const titleAttr = item.tooltip ? ` title="${item.tooltip}"` : '';
                return `<div class="valuation-row"${titleAttr}>
                    <span class="valuation-label">${item.label}</span>
                    <div class="valuation-bar-wrap"><div class="valuation-bar-fill ${cls}" style="width:${barPct}%"></div></div>
                    <span class="valuation-price">${this.fmt(item.value, 2)} ${item.currency}</span>
                </div>`;
            })
        ].join('');

        document.getElementById('valuation-list').innerHTML = html;
    }

    // ─── Period Buttons ───────────────────────────────────────────────────────
    setupPeriodButtons() {
        document.querySelectorAll('.period-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (btn.dataset.period === this.currentPeriod) return;
                document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentPeriod = btn.dataset.period;

                const priceHistory = await this.fetchPriceHistory(this.currentSymbol, this.currentPeriod);
                this.currentData.priceHistory = priceHistory;
                this.renderPriceChart();
                this.renderRegressionChart();
                this.renderSP500Chart();
            });
        });
    }

    // ─── UI States ────────────────────────────────────────────────────────────
    showState(state) {
        document.getElementById('screener-welcome').style.display = state === 'welcome' ? 'block' : 'none';
        document.getElementById('screener-loading').style.display = state === 'loading' ? 'flex' : 'none';
        document.getElementById('screener-error').style.display = state === 'error' ? 'block' : 'none';
        document.getElementById('screener-panel').style.display = state === 'panel' ? 'block' : 'none';
    }

    showError(msg) {
        document.getElementById('screener-error-msg').textContent = msg;
        this.showState('error');
    }

    // ─── Chart Base Options ───────────────────────────────────────────────────
    baseChartOptions() {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400 },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(0,0,0,0.85)',
                    padding: 10,
                    displayColors: false,
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: ${typeof ctx.parsed.y === 'number' ? ctx.parsed.y.toFixed(2) : '—'}`,
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: '#64748b',
                        font: { size: 10 },
                        maxTicksLimit: 6,
                        maxRotation: 0,
                    }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: {
                        color: '#64748b',
                        font: { size: 10 },
                        maxTicksLimit: 5,
                    }
                }
            }
        };
    }

    // ─── Math Helpers ─────────────────────────────────────────────────────────
    linearRegression(xs, ys) {
        const n = xs.length;
        const sumX = xs.reduce((a, b) => a + b, 0);
        const sumY = ys.reduce((a, b) => a + b, 0);
        const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
        const sumX2 = xs.reduce((s, x) => s + x * x, 0);
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;
        // R²
        const yMean = sumY / n;
        const ssTot = ys.reduce((s, y) => s + (y - yMean) ** 2, 0);
        const ssRes = ys.reduce((s, y, i) => s + (y - (intercept + slope * xs[i])) ** 2, 0);
        const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
        return { slope, intercept, r2 };
    }

    calculateMA(data, period) {
        if (data.length < period) return [];
        let mas = new Array(period - 1).fill(null);
        for (let i = period - 1; i < data.length; i++) {
            const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
            mas.push(sum / period);
        }
        return mas;
    }

    // Exponential Moving Average — tracks price more closely than SMA
    calculateEMA(data, period) {
        if (!data || data.length === 0) return [];
        const k = 2 / (period + 1);
        const result = [];
        let ema = null;
        for (let i = 0; i < data.length; i++) {
            const val = data[i];
            if (val == null || isNaN(val) || val <= 0) {
                result.push(ema); // propagate last known EMA
            } else if (ema === null) {
                ema = val; // seed with first valid value
                result.push(ema);
            } else {
                ema = val * k + ema * (1 - k);
                result.push(ema);
            }
        }
        return result;
    }

    calcVolatility(prices, periodsPerYear = 52) {
        if (prices.length < 2) return 0;
        const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
        return Math.sqrt(variance * periodsPerYear) * 100; // Annualized using actual data frequency
    }

    // Derives how many price points per year the given series actually has,
    // instead of assuming a fixed weekly/daily cadence (which breaks for other periods).
    calcPeriodsPerYear(data) {
        if (!data || data.length < 2) return 52;
        const spanYears = (data[data.length - 1].t - data[0].t) / (365.25 * 24 * 3600 * 1000);
        return spanYears > 0 ? (data.length - 1) / spanYears : 52;
    }

    median(arr) {
        const s = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    cap(value, min, max) { return Math.min(Math.max(value, min), max); }

    fmt(n, decimals = 0) {
        if (n == null || isNaN(n)) return '—';
        return n.toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }

    fmtBig(n, currency = '') {
        if (n == null) return '—';
        if (n >= 1e12) return `${(n / 1e12).toFixed(2)} B ${currency}`.trim();
        if (n >= 1e9) return `${(n / 1e9).toFixed(2)} Md ${currency}`.trim();
        if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M ${currency}`.trim();
        return `${this.fmt(n, 0)} ${currency}`.trim();
    }

    setColorValue(el, text, isPositive) {
        if (!el) return;
        el.textContent = text;
        el.className = 'cs-value ' + (isPositive ? 'positive' : 'negative');
    }

    // ─── KPI Modal Methods ────────────────────────────────────────────────────
    setupKpiModals() {
        // Setup expand buttons
        document.querySelectorAll('.kpi-expand-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const kpiType = btn.dataset.kpi;
                this.openKpiModal(kpiType);
            });
        });

        // Setup modal close
        const modal = document.getElementById('kpi-modal');
        const closeBtn = document.getElementById('kpi-modal-close');
        const overlay = modal?.querySelector('.kpi-modal-overlay');

        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeKpiModal());
        }
        if (overlay) {
            overlay.addEventListener('click', () => this.closeKpiModal());
        }

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal?.style.display !== 'none') {
                this.closeKpiModal();
            }
        });

        this.setupModalSettings();
        this.exchangeRates = { 'USD': 1 };
    }

    async getExchangeRate(to) {
        const from = this.currentData.quoteSummary?.price?.currency || 'USD';
        if (from === to) return 1;

        const key = `${from}_${to}`;
        // Only return cached if it's a real rate (not a failed 1)
        if (this.exchangeRates[key] && this.exchangeRates[key] !== 1) return this.exchangeRates[key];

        let rate = 1;
        try {
            if (from === 'USD' && to === 'EUR') {
                const r = await this.fetchLatestPrice('EURUSD=X');
                if (r && r > 0) rate = 1 / r;
            } else if (from === 'EUR' && to === 'USD') {
                const r = await this.fetchLatestPrice('EURUSD=X');
                if (r && r > 0) rate = r;
            } else if (to === 'XAU') {
                // Try quote summary first (most reliable), then chart API fallbacks
                let goldPrice = null;
                try {
                    const gd = await this.fetchQuoteSummary('GC=F');
                    goldPrice = gd?.price?.regularMarketPrice?.raw;
                } catch (e) { }
                if (!goldPrice || goldPrice <= 0) goldPrice = await this.fetchLatestPrice('GC=F');
                if (!goldPrice || goldPrice <= 0) goldPrice = await this.fetchLatestPrice('XAUUSD=X');
                if (!goldPrice || goldPrice <= 0) goldPrice = await this.fetchLatestPrice('IAU'); // iShares gold ETF × 100
                if (goldPrice && goldPrice > 0) {
                    // GC=F and XAUUSD=X give price per troy oz in USD
                    // IAU ETF: each share ≈ 0.01 oz gold, so goldPrice/0.01 = price/oz
                    rate = 1 / goldPrice;
                }
            } else if (from === 'XAU') {
                let goldPrice = null;
                try { const gd = await this.fetchQuoteSummary('GC=F'); goldPrice = gd?.price?.regularMarketPrice?.raw; } catch (e) { }
                if (!goldPrice || goldPrice <= 0) goldPrice = await this.fetchLatestPrice('GC=F');
                if (goldPrice && goldPrice > 0) rate = goldPrice;
            }
        } catch (e) { console.warn('Rate error:', e); }

        if (rate !== 1) this.exchangeRates[key] = rate; // only cache successful rates
        return rate;
    }

    async fetchLatestPrice(symbol) {
        try {
            const data = await this.fetchPriceHistory(symbol, '1mo');
            if (data && data.length > 0) return data[data.length - 1].c;
        } catch (e) { }
        return null;
    }

    // Fetch historical rate array matched point-by-point to the given data timestamps
    async getHistoricalRateArray(toCurrency, dataPoints) {
        const from = this.currentData.quoteSummary?.price?.currency || 'USD';
        if (from === toCurrency) return dataPoints.map(() => 1);

        let rateSymbol, inverse;
        if (toCurrency === 'EUR') { rateSymbol = 'EURUSD=X'; inverse = true; }
        else if (toCurrency === 'XAU') { rateSymbol = 'GC=F'; inverse = true; }
        else return dataPoints.map(() => 1);

        // Pick a range covering all data points
        const span = (dataPoints[dataPoints.length - 1].t - dataPoints[0].t) / 86400000;
        let period = '1mo';
        if (span > 25) period = '3mo';
        if (span > 80) period = '6mo';
        if (span > 170) period = '1y';
        if (span > 355) period = '5y';
        if (span > 1800) period = '10y';
        if (span > 3600) period = 'max';

        const rateHistory = await this.fetchPriceHistory(rateSymbol, period);
        if (!rateHistory || rateHistory.length === 0) {
            // Fallback: use current rate for all points
            const r = await this.getExchangeRate(toCurrency);
            return dataPoints.map(() => r);
        }

        const rateTimes = rateHistory.map(d => d.t);
        return dataPoints.map(d => {
            let lo = 0, hi = rateTimes.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (rateTimes[mid] < d.t) lo = mid + 1;
                else hi = mid;
            }
            if (lo > 0 && Math.abs(rateTimes[lo - 1] - d.t) < Math.abs(rateTimes[lo] - d.t)) lo--;
            const r = rateHistory[lo]?.c;
            return r && r > 0 ? (inverse ? 1 / r : r) : 1;
        });
    }

    setupModalSettings() {
        ['kpi-show-dividends', 'kpi-show-ma', 'kpi-show-fair-price'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => {
                this.renderKpiModalContent(this.currentModalKpi);
            });
        });

        // Custom dropdown wiring
        const trigger = document.getElementById('kpi-currency-trigger');
        const options = document.getElementById('kpi-currency-options');
        const wrapper = document.getElementById('kpi-currency-select-wrapper');
        const label = document.getElementById('kpi-currency-label');
        const hidden = document.getElementById('kpi-currency-select');

        if (trigger && options && wrapper) {
            // Hide options by default regardless of CSS
            options.style.display = 'none';

            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = options.style.display !== 'none';
                options.style.display = isOpen ? 'none' : 'block';
                wrapper.classList.toggle('open', !isOpen);
            });

            options.querySelectorAll('.custom-select-option').forEach(opt => {
                opt.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const val = opt.dataset.value;
                    hidden.value = val;
                    label.textContent = val;
                    options.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
                    opt.classList.add('selected');
                    options.style.display = 'none';
                    wrapper.classList.remove('open');
                    await this.renderKpiModalContent(this.currentModalKpi);
                });
            });

            document.addEventListener('click', () => {
                options.style.display = 'none';
                wrapper.classList.remove('open');
            });
        }

        // ── Regression model dropdown ──
        const regTrigger = document.getElementById('kpi-reg-model-trigger');
        const regOptions = document.getElementById('kpi-reg-model-options');
        const regWrapper = document.getElementById('kpi-reg-model-wrapper');
        const regLabel = document.getElementById('kpi-reg-model-label');
        const regHidden = document.getElementById('kpi-reg-model');

        if (regTrigger && regOptions && regWrapper) {
            regTrigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = regOptions.style.display !== 'none';
                regOptions.style.display = isOpen ? 'none' : 'block';
                regWrapper.classList.toggle('open', !isOpen);
            });
            regOptions.querySelectorAll('.custom-select-option').forEach(opt => {
                opt.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const val = opt.dataset.value;
                    regHidden.value = val;
                    regLabel.textContent = opt.textContent;
                    regOptions.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
                    opt.classList.add('selected');
                    regOptions.style.display = 'none';
                    regWrapper.classList.remove('open');
                    this.renderKpiModalContent(this.currentModalKpi);
                });
            });
            document.addEventListener('click', () => {
                regOptions.style.display = 'none';
                regWrapper.classList.remove('open');
            });
        }

        // ── Comparison benchmark dropdown ──
        const compTrigger = document.getElementById('kpi-comp-benchmark-trigger');
        const compOptions = document.getElementById('kpi-comp-benchmark-options');
        const compWrapper = document.getElementById('kpi-comp-benchmark-wrapper');
        const compLabel = document.getElementById('kpi-comp-benchmark-label');
        const compHidden = document.getElementById('kpi-comp-benchmark');

        if (compTrigger && compOptions && compWrapper) {
            compTrigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = compOptions.style.display !== 'none';
                compOptions.style.display = isOpen ? 'none' : 'block';
                compWrapper.classList.toggle('open', !isOpen);
            });

            compOptions.querySelectorAll('.custom-select-option').forEach(opt => {
                opt.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const val = opt.dataset.value;
                    const labelText = opt.dataset.label;
                    compHidden.value = val;
                    compLabel.textContent = labelText;
                    compOptions.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
                    opt.classList.add('selected');
                    compOptions.style.display = 'none';
                    compWrapper.classList.remove('open');
                    await this.renderKpiModalContent(this.currentModalKpi);
                });
            });
            document.addEventListener('click', () => {
                compOptions.style.display = 'none';
                compWrapper.classList.remove('open');
            });
        }

        // ── Projection slider ──
        const projSlider = document.getElementById('kpi-proj-years');
        const projLabel = document.getElementById('kpi-proj-years-label');
        if (projSlider && projLabel) {
            projSlider.addEventListener('input', () => {
                const v = parseInt(projSlider.value);
                projLabel.textContent = v === 0 ? 'Aucune' : v === 1 ? '1 an' : `${v} ans`;
            });
            projSlider.addEventListener('change', () => {
                this.renderKpiModalContent(this.currentModalKpi);
            });
        }

        // ── Show bands checkbox ──
        document.getElementById('kpi-show-bands')?.addEventListener('change', () => {
            this.renderKpiModalContent(this.currentModalKpi);
        });
    }

    async openKpiModal(kpiType) {
        const modal = document.getElementById('kpi-modal');
        if (!modal || !this.currentData) return;

        // ── CLEAN SWEEP : Reset absolute avant ouverture ───────
        const modalContent = modal.querySelector('.kpi-modal-content');
        if (modalContent) modalContent.classList.remove('radar-mode-layout');
        
        // Supprimer les résidus du mode radar
        document.querySelector('.radar-analysis-container')?.remove();
        const sidebarContent = document.querySelector('.kpi-modal-sidebar-content');
        if (sidebarContent) sidebarContent.style.display = '';
        document.querySelectorAll('.header-score-badge').forEach(b => b.style.display = 'none');

        // Reset stable values
        this.stableFairPrice = null;
        this.masterHistory5y = null;

        // Vider les stats et détruire le graphique précédent
        document.getElementById('kpi-modal-stats').innerHTML = '';
        if (this.modalChart) {
            this.modalChart.destroy();
            this.modalChart = null;
        }

        const qs = this.currentData.quoteSummary;
        const price = qs.price || {};
        const detail = qs.summaryDetail || {};
        const profile = qs.assetProfile || {};

        const currentPrice = price.regularMarketPrice?.raw ?? detail.previousClose?.raw ?? 0;
        const changePct = price.regularMarketChangePercent?.raw ?? 0;
        const currency = price.currency || '';

        // Logo and Header
        const logoEl = document.getElementById('kpi-modal-logo');
        const domain = profile.website?.replace(/https?:\/\/(www\.)?/, '').split('/')[0];
        if (domain) logoEl.innerHTML = `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=128" alt="${this.currentSymbol}">`;
        else logoEl.textContent = this.currentSymbol.charAt(0);

        document.getElementById('kpi-modal-price').textContent = `${this.fmt(currentPrice, 2)} ${currency}`;
        const changeEl = document.getElementById('kpi-modal-change');
        const sign = changePct >= 0 ? '+' : '';
        changeEl.innerHTML = `<i class="fas fa-arrow-${changePct >= 0 ? 'up' : 'down'}"></i> ${sign}${(changePct * 100).toFixed(2)}%`;
        changeEl.className = 'kpi-modal-change ' + (changePct >= 0 ? 'positive' : 'negative');
        document.getElementById('kpi-modal-ticker').textContent = `XNGS:${this.currentSymbol}`;

        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';

        this.currentModalKpi = kpiType;
        this.currentModalPeriod = '10y';

        // Fetch in parallel:
        // - 10y weekly buffer for MM50/MM200 (50 weeks ≈ 1yr, 200 weeks ≈ 4yr)
        // - max monthly for stable fair price (full history)
        // - 10y monthly for initial chart display
        const [buffer10ywk, bufferMax, history10y] = await Promise.all([
            this.fetchPriceHistory(this.currentSymbol, '10ywk'), // weekly ~520 pts for MM50/MM200
            this.fetchPriceHistory(this.currentSymbol, 'max'),   // monthly for fair price
            this.fetchPriceHistory(this.currentSymbol, '10y')    // monthly for display
        ]);

        this.masterHistoryBuffer = buffer10ywk; // weekly data
        this.currentData.priceHistory = history10y;

        // Compute stable fair price on max history
        if (bufferMax && bufferMax.length > 10) {
            const vals = bufferMax.map(d => d.c);
            const indices = vals.map((_, i) => i);
            const { slope, intercept } = this.linearRegression(indices, vals.map(v => Math.log(v)));
            this.stableFairPrice = Math.exp(intercept + slope * (indices.length - 1));
        }

        // Set 10A button active
        document.querySelectorAll('.kpi-period-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.kpi-period-btn[data-period="10y"]')?.classList.add('active');

        this.setupModalPeriodButtons();
        await this.renderKpiModalContent(kpiType);
    }

    closeKpiModal() {
        const modal = document.getElementById('kpi-modal');
        // Nettoyage mode radar
        document.querySelector('.radar-analysis-container')?.remove();
        const sidebarContent = document.querySelector('.kpi-modal-sidebar-content');
        if (sidebarContent) sidebarContent.style.display = '';
        if (modal) {
            modal.style.display = 'none';
            document.body.style.overflow = '';

            // Destroy modal chart if exists
            if (this.modalChart) {
                this.modalChart.destroy();
                this.modalChart = null;
            }
        }
    }

    async renderKpiModalContent(kpiType) {
        this.currentModalKpi = kpiType;
        const modal = document.getElementById('kpi-modal');
        const modalContent = modal?.querySelector('.kpi-modal-content');
        const canvas = document.getElementById('kpi-modal-chart');
        const statsContainer = document.getElementById('kpi-modal-stats');

        if (!canvas || !statsContainer) return;

        // 1. HARD RESET LAYOUT & UI STATES
        if (modalContent) modalContent.classList.remove('radar-mode-layout');
        document.querySelector('.kpi-modal-info')?.removeAttribute('style');
        document.querySelector('.kpi-modal-period-btns')?.removeAttribute('style');

        const sidebarTitle = document.querySelector('.kpi-modal-sidebar-header h3');
        if (sidebarTitle) sidebarTitle.textContent = 'Paramètres';

        // Hide score badge by default (only for radar mode)
        document.querySelectorAll('.header-score-badge').forEach(b => b.style.display = 'none');

        if (this.modalChart) {
            this.modalChart.destroy();
            this.modalChart = null;
        }

        const targetCurrency = document.getElementById('kpi-currency-select')?.value || 'USD';
        const data = this.currentData.priceHistory;

        // Get historical rate array (per-point) for accurate conversion
        const historicalRates = data
            ? await this.getHistoricalRateArray(targetCurrency, data)
            : null;
        const currentRate = historicalRates ? historicalRates[historicalRates.length - 1] ?? 1 : 1;

        const isRegression = kpiType === 'regression';
        const isValuation = kpiType === 'valuation';
        const isPriceMode = kpiType === 'price';
        const regSettings = document.getElementById('kpi-regression-settings');
        const valSettings = document.getElementById('kpi-valuation-settings');
        const maWrapper = document.getElementById('kpi-show-ma-wrapper');
        const fpWrapper = document.getElementById('kpi-show-fair-price-wrapper');
        const deviseWrapper = document.querySelector('.kpi-modal-field:has(#kpi-currency-select-wrapper)');

        const divWrapper = document.getElementById('kpi-show-dividends-wrapper');
        const compSettings = document.getElementById('kpi-comparison-settings');

        if (regSettings) regSettings.style.display = isRegression ? 'block' : 'none';
        if (valSettings) valSettings.style.display = isValuation ? 'block' : 'none';
        if (compSettings) compSettings.style.display = kpiType === 'sp500' ? 'block' : 'none';
        if (maWrapper) maWrapper.style.display = isPriceMode ? '' : 'none';
        if (fpWrapper) fpWrapper.style.display = isPriceMode ? '' : 'none';
        if (deviseWrapper) deviseWrapper.style.display = isPriceMode ? '' : 'none';
        if (divWrapper) divWrapper.style.display = (isPriceMode || isRegression || kpiType === 'sp500') ? '' : 'none';

        // Render based on type
        switch (kpiType) {
            case 'price':
                this.renderPriceModal(canvas, statsContainer, historicalRates, currentRate, targetCurrency);
                break;
            case 'regression':
                this.renderRegressionModal(canvas, statsContainer, historicalRates, currentRate, targetCurrency);
                break;
            case 'sp500':
                await this.renderComparisonModal(canvas, statsContainer);
                break;
            case 'radar':
                this.renderRadarModal(canvas, statsContainer);
                break;
            case 'valuation':
                await this.renderValuationModal(canvas, statsContainer);
                break;
        }

        // Bottom stats for price only — sp500 renders its own comparison stats above
        if (kpiType === 'price') {
            this.updateModalBottomStats();
        }
    }

    renderStatPill(label, value, isPositive = null) {
        let cls = '';
        if (isPositive === true) cls = 'positive';
        if (isPositive === false) cls = 'negative';

        return `
            <div class="kpi-stat-pill">
                <span class="kpi-pill-label">${label}</span>
                <span class="kpi-pill-value ${cls}">${value}</span>
            </div>
        `;
    }

    renderPriceModal(canvas, statsContainer, historicalRates = null, currentRate = 1, currency = '') {
        const data = this.currentData.priceHistory;
        if (!data || data.length === 0) return;

        const showDividends = document.getElementById('kpi-show-dividends')?.checked;
        const showMA = document.getElementById('kpi-show-ma')?.checked;
        const showFairPrice = document.getElementById('kpi-show-fair-price')?.checked;

        this.currentModalRate = currentRate;
        this.currentModalCurrency = currency;

        const labels = data.map(d => new Date(d.t).toLocaleDateString('fr-FR'));
        // Raw values (native currency)
        const rawValues = data.map(d => showDividends ? (d.a || d.c) : d.c);
        // Per-point conversion using historical rates
        const rateArr = historicalRates || rawValues.map(() => currentRate);
        const values = rawValues.map((v, i) => v * (rateArr[i] ?? currentRate));

        const datasets = [{
            label: currency ? `Prix (${currency})` : 'Prix',
            data: values,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            borderWidth: 2.5,
            fill: true,
            tension: 0.2,
            pointRadius: 0,
            pointHoverRadius: 6,
        }];

        // EMA using 10y weekly buffer — EMA50≈1yr, EMA200≈4yr, seeds from start of buffer
        if (showMA && this.masterHistoryBuffer && this.masterHistoryBuffer.length >= 50) {
            const showDiv = showDividends;
            const bufferVals = this.masterHistoryBuffer.map(d => showDiv ? (d.a || d.c) : d.c);
            // EMA starts from first point, well-calibrated by the time we reach visible window
            const ema200Native = this.calculateEMA(bufferVals, 200);
            const ema50Native = this.calculateEMA(bufferVals, 50);
            const bufferTimes = this.masterHistoryBuffer.map(d => d.t);

            const findClosest = (t) => {
                let lo = 0, hi = bufferTimes.length - 1;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (bufferTimes[mid] < t) lo = mid + 1;
                    else hi = mid;
                }
                if (lo > 0 && Math.abs(bufferTimes[lo - 1] - t) < Math.abs(bufferTimes[lo] - t)) lo--;
                return Math.abs(bufferTimes[lo] - t) < 86400000 * 45 ? lo : -1;
            };

            const visibleEMA200 = data.map((d, dataIdx) => { const idx = findClosest(d.t); return idx !== -1 && ema200Native[idx] != null ? ema200Native[idx] * (rateArr[dataIdx] ?? currentRate) : null; });
            const visibleEMA50 = data.map((d, dataIdx) => { const idx = findClosest(d.t); return idx !== -1 && ema50Native[idx] != null ? ema50Native[idx] * (rateArr[dataIdx] ?? currentRate) : null; });

            if (visibleEMA200.some(v => v !== null)) {
                datasets.push({ label: 'EMA200', data: visibleEMA200, borderColor: '#f97316', borderWidth: 2.5, fill: false, pointRadius: 0, tension: 0.3 });
            }
            if (visibleEMA50.some(v => v !== null)) {
                datasets.push({ label: 'EMA50', data: visibleEMA50, borderColor: '#eab308', borderWidth: 1.5, fill: false, pointRadius: 0, tension: 0.3 });
            }
        }

        if (showFairPrice && this.stableFairPrice) {
            const fairValueConverted = this.stableFairPrice * currentRate;
            const fairPriceLine = new Array(values.length).fill(fairValueConverted);
            datasets.push({
                label: `Prix juste : ${this.fmt(fairValueConverted, 2)} ${currency}`,
                data: fairPriceLine,
                borderColor: '#eab308',
                borderWidth: 2.5,
                borderDash: [8, 4],
                fill: false,
                pointRadius: 0
            });
        }

        const showLegend = showMA || showFairPrice;
        this.modalChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: showLegend,
                        labels: { color: '#94a3b8', font: { size: 12 }, boxWidth: 24, padding: 16 }
                    },
                    tooltip: { mode: 'index', intersect: false }
                },
                scales: {
                    x: {
                        display: true,
                        grid: { color: 'rgba(255,255,255,0.03)' },
                        ticks: { color: '#64748b', maxTicksLimit: 8, maxRotation: 0 }
                    },
                    y: {
                        display: true,
                        grid: { color: 'rgba(255,255,255,0.03)' },
                        ticks: { color: '#64748b' }
                    }
                }
            }
        });

        // Store raw values for stats calculation
        this._modalRawValues = rawValues;
    }

    renderRegressionModal(canvas, statsContainer, historicalRates = null, currentRate = 1, currency = 'USD') {
        const data = this.currentData.priceHistory;
        if (!data || data.length < 4) return;

        const model = document.getElementById('kpi-reg-model')?.value || 'semilog';
        const projYears = parseInt(document.getElementById('kpi-proj-years')?.value ?? '2');
        const showBands = document.getElementById('kki-show-bands') // typo guard
            ?? document.getElementById('kpi-show-bands');
        const bandsOn = showBands?.checked !== false;

        // Apply currency conversion
        const rateArr = historicalRates || data.map(() => currentRate);
        const showDividends = document.getElementById('kpi-show-dividends')?.checked;
        const values = data.map((d, i) => (showDividends ? (d.a || d.c) : d.c) * (rateArr[i] ?? currentRate));
        const n = values.length;
        const indices = values.map((_, i) => i);

        // ── Regression fit ──
        let predictedLog, slope, intercept, r2;
        const logVals = values.map(v => Math.log(Math.max(v, 1e-9)));

        if (model === 'loglog') {
            const logIdx = indices.map(i => Math.log(i + 1));
            ({ slope, intercept, r2 } = this.linearRegression(logIdx, logVals));
            predictedLog = indices.map(i => intercept + slope * Math.log(i + 1));
        } else if (model === 'linear') {
            ({ slope, intercept, r2 } = this.linearRegression(indices, values));
            predictedLog = null; // handled separately
        } else { // semilog (default)
            ({ slope, intercept, r2 } = this.linearRegression(indices, logVals));
            predictedLog = indices.map(i => intercept + slope * i);
        }

        // ── Sigma from residuals ──
        let sigma;
        if (model === 'linear') {
            const res = values.map((v, i) => v - (intercept + slope * i));
            const mean = res.reduce((s, r) => s + r, 0) / res.length;
            sigma = Math.sqrt(res.map(r => (r - mean) ** 2).reduce((s, v) => s + v, 0) / res.length);
        } else {
            const res = logVals.map((lv, i) => lv - predictedLog[i]);
            const mean = res.reduce((s, r) => s + r, 0) / res.length;
            sigma = Math.sqrt(res.map(r => (r - mean) ** 2).reduce((s, v) => s + v, 0) / res.length);
        }

        // ── Historical regression + bands ──
        const predict = (i) => {
            if (model === 'linear') return intercept + slope * i;
            if (model === 'loglog') return Math.exp(intercept + slope * Math.log(i + 1));
            return Math.exp(intercept + slope * i);
        };
        const predictBand = (i, sig) => {
            if (model === 'linear') return predict(i) + sig;
            if (model === 'loglog') return Math.exp(intercept + slope * Math.log(i + 1) + sig);
            return Math.exp(intercept + slope * i + sig);
        };

        const regressionLine = indices.map(i => predict(i));
        const b2up = indices.map(i => predictBand(i, 2 * sigma));
        const b1up = indices.map(i => predictBand(i, sigma));
        const b1dn = indices.map(i => predictBand(i, -sigma));
        const b2dn = indices.map(i => predictBand(i, -2 * sigma));

        // ── Projection ──
        const lastT = data[n - 1].t;
        const firstT = data[0].t;
        const avgStep = (lastT - firstT) / (n - 1); // ms per point
        const projCount = projYears > 0
            ? Math.round(projYears * 365.25 * 86400000 / avgStep)
            : 0;

        const projIdx = Array.from({ length: projCount }, (_, k) => n + k);
        const projLabels = projIdx.map(i => new Date(lastT + (i - (n - 1)) * avgStep).toLocaleDateString('fr-FR'));

        const pReg = projIdx.map(i => predict(i));
        const pB2up = projIdx.map(i => predictBand(i, 2 * sigma));
        const pB1up = projIdx.map(i => predictBand(i, sigma));
        const pB1dn = projIdx.map(i => predictBand(i, -sigma));
        const pB2dn = projIdx.map(i => predictBand(i, -2 * sigma));

        // ── Labels ──
        const histLabels = data.map(d => new Date(d.t).toLocaleDateString('fr-FR'));
        const allLabels = [...histLabels, ...projLabels];

        const pad = arr => [...arr, ...Array(projCount).fill(null)];
        const ppad = arr => [...Array(n - 1).fill(null), regressionLine[n - 1], ...arr]; // connect at seam

        // ── Datasets ──
        const PRICE_COL = '#60a5fa';
        const REG_COL = '#f59e0b';
        const BAND2_COL = 'rgba(148,163,184,0.35)';
        const BAND1_COL = 'rgba(148,163,184,0.55)';

        const datasets = [
            // σ bands (draw first so they're behind)
            ...(bandsOn ? [
                { label: '+2σ', data: pad(b2up), borderColor: BAND2_COL, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false, order: 5 },
                { label: '+1σ', data: pad(b1up), borderColor: BAND1_COL, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false, order: 5 },
                { label: '-1σ', data: pad(b1dn), borderColor: BAND1_COL, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false, order: 5 },
                { label: '-2σ', data: pad(b2dn), borderColor: BAND2_COL, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false, order: 5 },
            ] : []),
            // Projection bands
            ...(bandsOn && projCount > 0 ? [
                { label: null, data: ppad(pB2up), borderColor: 'rgba(148,163,184,0.2)', borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false, order: 5 },
                { label: null, data: ppad(pB1up), borderColor: 'rgba(148,163,184,0.3)', borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false, order: 5 },
                { label: null, data: ppad(pB1dn), borderColor: 'rgba(148,163,184,0.3)', borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false, order: 5 },
                { label: null, data: ppad(pB2dn), borderColor: 'rgba(148,163,184,0.2)', borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false, order: 5 },
            ] : []),
            // Régression historique (solid)
            { label: 'Régression', data: pad(regressionLine), borderColor: REG_COL, borderWidth: 2, pointRadius: 0, fill: false, order: 2 },
            // Régression projection (dashed, connected)
            ...(projCount > 0 ? [
                { label: 'Projection', data: ppad(pReg), borderColor: REG_COL, borderWidth: 2, borderDash: [7, 4], pointRadius: 0, fill: false, order: 2 },
            ] : []),
            // Prix (on top)
            { label: `Prix (${currency})`, data: pad(values), borderColor: PRICE_COL, borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.1, order: 1 },
        ];

        // ── Chart ──
        if (this.modalChart) this.modalChart.destroy();
        this.modalChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels: allLabels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 300 },
                plugins: {
                    legend: {
                        display: true,
                        labels: {
                            color: '#94a3b8',
                            filter: item => item.text != null,
                            usePointStyle: true,
                            pointStyleWidth: 20,
                            boxHeight: 2,
                            font: { size: 11 }
                        }
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        callbacks: {
                            label: ctx => {
                                if (ctx.parsed.y == null) return null;
                                return `${ctx.dataset.label}: ${this.fmt(ctx.parsed.y, 2)} ${currency}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        display: true,
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        ticks: { color: '#64748b', maxTicksLimit: 8 }
                    },
                    y: {
                        display: true,
                        type: model === 'linear' ? 'linear' : 'logarithmic',
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        ticks: {
                            color: '#64748b',
                            callback: v => this.fmt(v, 2)
                        }
                    }
                }
            }
        });

        // ── CAGR from regression slope ──
        const spanYears = (lastT - firstT) / (365.25 * 24 * 3600 * 1000);
        let cagr;
        if (model === 'semilog') {
            const ptsPerYear = n / spanYears;
            cagr = (Math.exp(slope * ptsPerYear) - 1) * 100;
        } else {
            const first = regressionLine[0];
            const last = regressionLine[n - 1];
            if (first <= 0 || last < 0) {
                cagr = null; // Cannot calculate CAGR with negative base
            } else {
                cagr = spanYears > 0 ? (Math.pow(last / first, 1 / spanYears) - 1) * 100 : 0;
            }
        }

        // ── Stats at last historical point ──
        const curPrice = values[n - 1];
        const regCur = regressionLine[n - 1];
        const dev = (curPrice - regCur) / regCur * 100;
        const devSign = dev >= 0 ? '+' : '';
        const devColor = dev >= 0 ? '#10b981' : '#ef4444';
        
        let cagrBadge = null;
        if (cagr !== null && !isNaN(cagr)) {
            const cagrSign = cagr >= 0 ? '+' : '';
            cagrBadge = { text: `${cagrSign}${cagr.toFixed(1)}%/an`, color: REG_COL, bg: 'rgba(245,158,11,0.12)' };
        } else {
            cagrBadge = { text: '—', color: REG_COL, bg: 'rgba(245,158,11,0.12)' };
        }
        const projTarget = pReg.length > 0 ? pReg[pReg.length - 1] : null;

        const f = v => `${this.fmt(v, 2)} ${currency}`;

        // ── Helper: one stat card ──
        const card = (label, value, valueColor = '#e2e8f0', badge = null, dot = null, line = null) => `
            <div style="
                display:inline-flex;flex-direction:column;align-items:flex-start;
                background:linear-gradient(145deg, rgba(30, 36, 51, 0.7) 0%, rgba(20, 25, 40, 0.9) 100%);
                border:1px solid rgba(255,255,255,0.08);
                border-radius:14px;padding:12px 18px;gap:6px;flex-shrink:0;
                box-shadow:0 4px 12px rgba(0,0,0,0.15);
            ">
                <div style="display:flex;align-items:center;gap:8px;">
                    ${dot ? `<span style="width:10px;height:10px;border-radius:50%;background:${dot};display:inline-block;flex-shrink:0;box-shadow:0 0 6px ${dot};"></span>` : ''}
                    ${line ? `<span style="width:18px;height:3px;background:${line};display:inline-block;flex-shrink:0;border-radius:2px;box-shadow:0 0 6px ${line};"></span>` : ''}
                    <span style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;">${label}</span>
                </div>
                <div style="display:flex;align-items:baseline;gap:8px;margin-top:2px;">
                    <span style="font-size:18px;font-weight:800;color:${valueColor};">${value}</span>
                    ${badge ? `<span style="font-size:12px;font-weight:700;color:${badge.color};background:${badge.bg};padding:3px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.05);">${badge.text}</span>` : ''}
                </div>
            </div>`;

        statsContainer.style.cssText = 'position:relative; width:100%; box-sizing:border-box; padding:20px 0 0; right:auto; bottom:auto; z-index:10; margin-top:auto;';
        statsContainer.innerHTML = `
            <div style="display:flex;align-items:stretch;justify-content:center;gap:12px;flex-wrap:wrap;width:100%;">
                ${card('Prix', f(curPrice), '#f8fafc', null, PRICE_COL)}
                ${card('Régression', f(regCur), REG_COL, cagrBadge, null, REG_COL)}
                ${card('Écart', `${devSign}${dev.toFixed(1)}%`, devColor, null, null, null)}
                ${bandsOn ? `
                <div style="
                    display:inline-flex;flex-direction:column;align-items:flex-start;
                    background:linear-gradient(145deg, rgba(30, 36, 51, 0.7) 0%, rgba(20, 25, 40, 0.9) 100%);
                    border:1px solid rgba(255,255,255,0.08);
                    border-radius:14px;padding:12px 18px;gap:8px;flex-shrink:0;
                    box-shadow:0 4px 12px rgba(0,0,0,0.15);
                ">
                    <span style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;">Bandes σ</span>
                    <div style="display:flex;align-items:center;gap:16px;">
                        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;">
                            <span style="font-size:11px;color:#94a3b8;font-weight:600;">+2σ <span style="color:#e2e8f0;font-weight:800;font-size:13px;margin-left:4px;">${f(b2up[n - 1])}</span></span>
                            <span style="font-size:11px;color:#94a3b8;font-weight:600;">+1σ <span style="color:#e2e8f0;font-weight:800;font-size:13px;margin-left:4px;">${f(b1up[n - 1])}</span></span>
                        </div>
                        <div style="width:1px;height:36px;background:rgba(255,255,255,0.1);"></div>
                        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;">
                            <span style="font-size:11px;color:#94a3b8;font-weight:600;">-1σ <span style="color:#e2e8f0;font-weight:800;font-size:13px;margin-left:4px;">${f(b1dn[n - 1])}</span></span>
                            <span style="font-size:11px;color:#94a3b8;font-weight:600;">-2σ <span style="color:#e2e8f0;font-weight:800;font-size:13px;margin-left:4px;">${f(b2dn[n - 1])}</span></span>
                        </div>
                    </div>
                </div>
                ` : ''}
                ${projTarget && projYears > 0 ? card(
            `Proj. +${projYears}A`, f(projTarget), '#fbbf24',
            null, null, REG_COL
        ) : ''}
                ${card('R²', r2.toFixed(3), r2 >= 0.85 ? '#10b981' : r2 >= 0.65 ? '#f59e0b' : '#ef4444')}
            </div>
        `;

        this._modalRawValues = values;
    }
    async renderComparisonModal(canvas, statsContainer) {
        const stockData = this.currentData.priceHistory;
        const benchmarkTicker = document.getElementById('kpi-comp-benchmark')?.value || '^GSPC';
        const benchmarkLabel = document.getElementById('kpi-comp-benchmark-label')?.textContent || 'S&P 500';

        // Fetch benchmark data if needed
        let benchmarkData = this._cachedBenchmarkData?.[benchmarkTicker]?.[this.currentModalPeriod];
        if (!benchmarkData) {
            benchmarkData = await this.fetchPriceHistory(benchmarkTicker, this.currentModalPeriod);
            if (!this._cachedBenchmarkData[benchmarkTicker]) this._cachedBenchmarkData[benchmarkTicker] = {};
            this._cachedBenchmarkData[benchmarkTicker][this.currentModalPeriod] = benchmarkData;
        }

        if (!stockData || !benchmarkData) return;

        const showDividends = document.getElementById('kpi-show-dividends')?.checked;
        const stockBase = showDividends ? (stockData[0].a || stockData[0].c) : stockData[0].c;
        const benchmarkBase = benchmarkData[0].c;

        const stockNorm = stockData.map(d => ((showDividends ? (d.a || d.c) : d.c) / stockBase) * 100);
        const benchmarkNorm = benchmarkData.map(d => (d.c / benchmarkBase) * 100);

        const labels = stockData.map(d => new Date(d.t).toLocaleDateString('fr-FR'));

        this.modalChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: this.currentSymbol,
                        data: stockNorm,
                        borderColor: '#60a5fa',
                        backgroundColor: 'rgba(96,165,250,0.1)',
                        fill: true,
                        tension: 0.3,
                        pointRadius: 0
                    },
                    {
                        label: benchmarkLabel,
                        data: benchmarkNorm,
                        borderColor: '#94a3b8',
                        borderDash: [5, 5],
                        fill: false,
                        tension: 0.3,
                        pointRadius: 0
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        labels: { color: '#94a3b8', font: { size: 11 } }
                    }
                },
                scales: {
                    x: {
                        display: true,
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        ticks: { color: '#64748b' }
                    },
                    y: {
                        display: true,
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        ticks: {
                            color: '#64748b',
                            callback: v => v.toFixed(0) + '%'
                        }
                    }
                }
            }
        });

        // Real comparison stats (stock vs benchmark), rendered directly here since
        // updateModalBottomStats() only knows how to summarize a single series.
        const stockPerf = stockNorm[stockNorm.length - 1] - 100;
        const benchmarkPerf = benchmarkNorm[benchmarkNorm.length - 1] - 100;
        const diff = stockPerf - benchmarkPerf;

        const stockYears = (stockData[stockData.length - 1].t - stockData[0].t) / (365.25 * 24 * 3600 * 1000);
        const benchmarkYears = (benchmarkData[benchmarkData.length - 1].t - benchmarkData[0].t) / (365.25 * 24 * 3600 * 1000);
        const stockCAGR = stockYears > 0 ? (Math.pow(stockNorm[stockNorm.length - 1] / 100, 1 / stockYears) - 1) * 100 : 0;
        const benchmarkCAGR = benchmarkYears > 0 ? (Math.pow(benchmarkNorm[benchmarkNorm.length - 1] / 100, 1 / benchmarkYears) - 1) * 100 : 0;

        if (statsContainer) {
            const diffColor = diff >= 0 ? '#10b981' : '#ef4444';
            statsContainer.style.cssText = 'display:flex;justify-content:flex-end;padding:8px 4px 0;width:100%;box-sizing:border-box;';
            statsContainer.innerHTML = `
                <div style="display:inline-flex;align-items:center;gap:10px;padding:6px 14px;border-radius:8px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);font-size:13px;font-weight:600;white-space:nowrap;max-width:100%;overflow:hidden;">
                    <span style="color:${diffColor}">Diff ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%</span>
                    <span style="color:#334155">|</span>
                    <span style="color:#e2e8f0">CAGR ${this.currentSymbol} ${stockCAGR >= 0 ? '+' : ''}${stockCAGR.toFixed(2)}%</span>
                    <span style="color:#334155">|</span>
                    <span style="color:#94a3b8">CAGR ${benchmarkLabel} ${benchmarkCAGR >= 0 ? '+' : ''}${benchmarkCAGR.toFixed(2)}%</span>
                </div>
            `;
        }
    }

    calculateRadarDimensions(stats, financial, detail) {
        const roe = (financial.returnOnEquity?.raw ?? 0) * 100;
        const roa = (financial.returnOnAssets?.raw ?? 0) * 100;
        const grossMargin = (financial.grossMargins?.raw ?? 0) * 100;
        const operatingMargin = (financial.operatingMargins?.raw ?? 0) * 100;
        const revenueGrowth = (financial.revenueGrowth?.raw ?? 0) * 100;
        const earningsGrowth = (financial.earningsGrowth?.raw ?? 0) * 100;
        const netMargin = (financial.profitMargins?.raw ?? 0) * 100;
        const currentRatio = financial.currentRatio?.raw ?? 1;
        const debtToEquity = financial.debtToEquity?.raw ?? null;
        const dividendYield = (detail.dividendYield?.raw ?? detail.trailingAnnualDividendYield?.raw ?? 0) * 100;
        const dividendRate = detail.dividendRate?.raw ?? detail.trailingAnnualDividendRate?.raw ?? 0;
        const fiveYearAvgYield = detail.fiveYearAvgDividendYield?.raw
            ? detail.fiveYearAvgDividendYield.raw * 100
            : 0;
        const payoutRatio = detail.payoutRatio?.raw ?? null;
        const hasDividend = dividendRate > 0 || dividendYield > 0 || fiveYearAvgYield > 0;

        const scoreReturns = this.cap(((roe + (roa * 1.4)) / 30) * 5, 0, 5);
        const scoreMargins = this.cap(((grossMargin + operatingMargin + netMargin) / 90) * 5, 0, 5);
        const scoreGrowth = this.cap(((revenueGrowth + earningsGrowth + 15) / 55) * 5, 0, 5);
        const scoreProfitability = this.cap(((netMargin + operatingMargin + roe) / 75) * 5, 0, 5);

        const scoreHealthBase = this.cap((currentRatio / 3) * 3.5, 0, 3.5);
        const debtScore = debtToEquity == null ? 1 : debtToEquity <= 80 ? 1.5 : debtToEquity <= 150 ? 1 : 0.4;
        const scoreHealth = this.cap(scoreHealthBase + debtScore, 0, 5);

        const yieldScore = this.cap((dividendYield / 3) * 2.3, 0, 2.3);
        const historyScore = hasDividend ? 1.2 : 0;
        const avgYieldScore = this.cap((fiveYearAvgYield / 2) * 0.8, 0, 0.8);
        const payoutScore = payoutRatio == null ? 0.5 : (payoutRatio >= 0 && payoutRatio <= 0.7 ? 0.7 : payoutRatio <= 1 ? 0.5 : 0.2);
        const scoreDividend = this.cap(yieldScore + historyScore + avgYieldScore + payoutScore, 0, 5);

        return {
            'Retours': scoreReturns,
            'Marges': scoreMargins,
            'Croissance': scoreGrowth,
            'Rentabilité': scoreProfitability,
            'Dividende': scoreDividend,
            'Santé': scoreHealth,
        };
    }

    calculateScore(stats, financial, detail) {
        const dimensions = this.calculateRadarDimensions(stats, financial, detail);
        const values = Object.values(dimensions);
        return ((values.reduce((s, v) => s + v, 0) / (values.length * 5)) * 20).toFixed(1);
    }

    renderRadarModal(canvas, statsContainer) {
        const qs = this.currentData.quoteSummary;
        if (!qs) return;

        const financial = qs.financialData || {};
        const stats = qs.defaultKeyStatistics || {};
        const detail = qs.summaryDetail || {};

        const dimensions = this.calculateRadarDimensions(stats, financial, detail);
        const labels = Object.keys(dimensions);
        const values = Object.values(dimensions);

        // ── Layout radar ──────────────────────────────────────
        const modalContent = document.querySelector('.kpi-modal-content');
        if (modalContent) modalContent.classList.add('radar-mode-layout');

        document.querySelector('.kpi-modal-info')?.setAttribute('style', 'display:none');
        document.querySelector('.kpi-modal-period-btns')?.setAttribute('style', 'display:none');
        document.querySelector('.kpi-modal-settings-group')?.setAttribute('style', 'display:none');

        // Rediriger l'analyse vers la sidebar (plus large) au lieu du panneau 260px
        const sidebarTitleEl = document.querySelector('.kpi-modal-sidebar-header h3');
        if (sidebarTitleEl) sidebarTitleEl.textContent = 'Diagnostic Fondamental';

        const sidebarContent = document.querySelector('.kpi-modal-sidebar-content');
        if (sidebarContent) sidebarContent.style.display = 'none';

        // ── Logo & Name ───────────────────────────────────────
        const logoEl = document.getElementById('kpi-modal-logo');
        const price = qs.price || {};
        const assetName = price.longName || price.shortName || '';
        const profile = qs.assetProfile || {};
        const domain = profile.website?.replace(/https?:\/\/(www\.)?/, '').split('/')[0];

        if (logoEl) {
            logoEl.setAttribute('style', 'display: flex !important; align-items: center !important; gap: 20px !important; width: 100% !important; justify-content: center !important; margin-bottom: 32px !important; z-index: 2; position: relative;');
            logoEl.innerHTML = `
                <img src="https://www.google.com/s2/favicons?domain=${domain}&sz=128" 
                     style="width: 72px; height: 72px; border-radius: 20px; background: rgba(255,255,255,0.04); padding: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08);">
                <div style="display: flex; flex-direction: column; align-items: flex-start; justify-content: center;">
                    <span style="font-size: 26px; font-weight: 800; color: #f8fafc; line-height: 1.1; letter-spacing: 0.5px;">${this.currentSymbol}</span>
                    <span style="font-size: 15px; color: #94a3b8; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; margin-top: 4px;">
                        ${assetName}
                    </span>
                </div>
            `;
        }

        statsContainer.innerHTML = ''; // vider le panneau gauche

        // ── Radar chart ───────────────────────────────────────
        this.modalChart = new Chart(canvas.getContext('2d'), {
            type: 'radar',
            data: {
                labels,
                datasets: [{
                    label: 'Score',
                    data: values,
                    backgroundColor: 'rgba(99, 102, 241, 0.15)',
                    borderColor: '#818cf8',
                    borderWidth: 2.5,
                    pointBackgroundColor: '#818cf8',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5,
                    pointRadius: 4,
                    pointHoverRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    r: {
                        beginAtZero: true,
                        max: 5,
                        ticks: { stepSize: 1, display: false },
                        grid: { color: 'rgba(255,255,255,0.06)' },
                        angleLines: { color: 'rgba(255,255,255,0.06)' },
                        pointLabels: {
                            color: '#cbd5e1',
                            font: { size: 11, weight: '600', family: "'Inter', sans-serif" },
                            padding: 14
                        }
                    }
                },
                plugins: { legend: { display: false } }
            }
        });

        const score = this.calculateScore(stats, financial, detail);
        const getPct = (val) => (val != null ? (val * 100).toFixed(1) + '%' : '--');
        const getVal = (val, dec = 2) => (val != null ? val.toFixed(dec) : '--');

        // ── Injection du score et titre dans le header sidebar ──
        const sidebarHeader = document.querySelector('.kpi-modal-sidebar-header');
        if (sidebarHeader) {
            // S'assurer que le titre est correct
            const titleEl = sidebarHeader.querySelector('h3');
            if (titleEl) titleEl.textContent = 'Diagnostic Fondamental';

            // Gérer le badge de score
            let badge = sidebarHeader.querySelector('.header-score-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'header-score-badge';
                const closeBtn = sidebarHeader.querySelector('.kpi-modal-close');
                if (closeBtn) sidebarHeader.insertBefore(badge, closeBtn);
                else sidebarHeader.appendChild(badge);
            }
            badge.innerHTML = `${score} <span>/20</span>`;
            badge.style.display = 'flex';
        }

        const sidebar = document.querySelector('.kpi-modal-sidebar');
        let analysisEl = sidebar?.querySelector('.radar-analysis-container');
        if (!analysisEl && sidebar) {
            analysisEl = document.createElement('div');
            analysisEl.className = 'radar-analysis-container';
            sidebar.appendChild(analysisEl);
        }

        if (analysisEl) {
            analysisEl.innerHTML = `
            <div class="analysis-grid">
                <div class="analysis-card">
                    <h5>Retours <span style="margin-left: auto; background: rgba(99,102,241,0.15); color: #818cf8; padding: 3px 8px; border-radius: 6px; font-size: 11px;">${values[0].toFixed(1)}/5</span></h5>
                    ${this.renderAnalysisRow('ROE', getPct(financial.returnOnEquity?.raw), financial.returnOnEquity?.raw * 20 || 0)}
                    ${this.renderAnalysisRow('ROA', getPct(financial.returnOnAssets?.raw), financial.returnOnAssets?.raw * 40 || 0)}
                    ${this.renderAnalysisRow('ROIC', getPct(financial.returnOnEquity?.raw * 0.8), financial.returnOnEquity?.raw * 15 || 0)}
                </div>
                <div class="analysis-card">
                    <h5>Rentabilité <span style="margin-left: auto; background: rgba(99,102,241,0.15); color: #818cf8; padding: 3px 8px; border-radius: 6px; font-size: 11px;">${values[1].toFixed(1)}/5</span></h5>
                    ${this.renderAnalysisRow('Marge opé.', getPct(financial.operatingMargins?.raw), financial.operatingMargins?.raw * 2.5)}
                    ${this.renderAnalysisRow('Marge nette', getPct(financial.profitMargins?.raw), financial.profitMargins?.raw * 3)}
                </div>
                <div class="analysis-card">
                    <h5>Croissance <span style="margin-left: auto; background: rgba(99,102,241,0.15); color: #818cf8; padding: 3px 8px; border-radius: 6px; font-size: 11px;">${values[2].toFixed(1)}/5</span></h5>
                    ${this.renderAnalysisRow('CA 1A', getPct(financial.revenueGrowth?.raw), financial.revenueGrowth?.raw * 3)}
                    ${this.renderAnalysisRow('EPS 1A', getPct(financial.earningsGrowth?.raw), financial.earningsGrowth?.raw * 2)}
                    ${this.renderAnalysisRow('EPS Fwd', getVal(stats.forwardEps?.raw), 3)}
                </div>
                <div class="analysis-card">
                    <h5>Cash Flows <span style="margin-left: auto; background: rgba(99,102,241,0.15); color: #818cf8; padding: 3px 8px; border-radius: 6px; font-size: 11px;">${values[3].toFixed(1)}/5</span></h5>
                    ${this.renderAnalysisRow('OCF', this.fmtBig(financial.operatingCashflow?.raw, price.currency), 4)}
                    ${this.renderAnalysisRow('FCF', this.fmtBig(financial.freeCashflow?.raw, price.currency), 3.5)}
                    ${this.renderAnalysisRow('Capex/Rev', getPct(financial.freeCashflow?.raw / financial.totalRevenue?.raw), 2)}
                </div>
                <div class="analysis-card">
                    <h5>Dividende <span style="margin-left: auto; background: rgba(99,102,241,0.15); color: #818cf8; padding: 3px 8px; border-radius: 6px; font-size: 11px;">${values[4].toFixed(1)}/5</span></h5>
                    ${this.renderAnalysisRow('Rendement', getPct(detail.dividendYield?.raw), detail.dividendYield?.raw * 50)}
                    ${this.renderAnalysisRow('Payout', getPct(detail.payoutRatio?.raw), 5 - (detail.payoutRatio?.raw * 5))}
                    ${this.renderAnalysisRow('Hist.', '--', 2)}
                </div>
                <div class="analysis-card">
                    <h5>Santé <span style="margin-left: auto; background: rgba(99,102,241,0.15); color: #818cf8; padding: 3px 8px; border-radius: 6px; font-size: 11px;">${values[5].toFixed(1)}/5</span></h5>
                    ${this.renderAnalysisRow('Liquidité', getVal(financial.currentRatio?.raw), financial.currentRatio?.raw)}
                    ${this.renderAnalysisRow('Dette/Eq.', getVal(financial.debtToEquity?.raw), 5 - (financial.debtToEquity?.raw / 50))}
                    ${this.renderAnalysisRow('Levier', getVal(financial.revenuePerShare?.raw), 3)}
                </div>
            </div>
        `;
        }
    }
    renderAnalysisRow(label, value, score) {
        const barWidth = Math.min(100, Math.max(2, score * 20));
        const barColor = score >= 4 ? '#10b981' : score >= 2.5 ? '#f59e0b' : '#ef4444';
        return `
            <div class="analysis-row">
                <div class="analysis-row-top">
                    <span class="row-label">${label}</span>
                    <span class="row-value" style="color:${barColor}">${value}</span>
                </div>
                <div class="row-bar-bg"><div class="row-bar-fill" style="width:${barWidth}%; background:${barColor}"></div></div>
            </div>
        `;
    }

    async renderValuationModal(canvas, statsContainer) {
        const qs = this.currentData.quoteSummary;
        if (!qs) { statsContainer.innerHTML = '<p style="color:#64748b;padding:16px">Données indisponibles</p>'; return; }

        const priceData = qs.price || {};
        const financial = qs.financialData || {};
        const keyStats = qs.defaultKeyStatistics || {};
        const detail = qs.summaryDetail || {};
        const earningsObj = qs.earnings || {};

        const currentPrice = priceData.regularMarketPrice?.raw || 0;
        const currency = priceData.currency || 'USD';
        const shares = keyStats.sharesOutstanding?.raw || 1;
        const trailingEps = keyStats.trailingEps?.raw || 0;
        const trailingPE = detail.trailingPE?.raw || detail.trailingPE || 20;
        const dividendRate = detail.dividendRate?.raw || detail.dividendRate || 0;
        const totalFCF = financial.freeCashflow?.raw || 0;
        const fcfPerShare = totalFCF > 0 ? totalFCF / shares : 0;

        // Historical annual EPS from earnings chart
        const yearly = earningsObj.financialsChart?.yearly || [];
        const histEPS = yearly.map(y => ({
            year: typeof y.date === 'object' ? y.date?.raw || y.date : y.date,
            eps: y.earnings?.raw != null ? y.earnings.raw / shares : null
        })).filter(d => d.eps != null && d.eps > 0);

        // Auto-calculate growth CAGR from EPS history
        let autoGrowth = 0.10;
        if (histEPS.length >= 2) {
            const first = histEPS[0].eps, last = histEPS[histEPS.length - 1].eps;
            const n = histEPS[histEPS.length - 1].year - histEPS[0].year;
            if (n > 0 && first > 0) autoGrowth = Math.pow(last / first, 1 / n) - 1;
        }

        // Use metric: FCF/share if available, else EPS
        const metricType = document.getElementById('kpi-val-metric')?.value || 'fcf';
        const baseMetric = metricType === 'fcf' && fcfPerShare > 0 ? fcfPerShare : (trailingEps || 1);

        // Init inputs if not yet set by user
        const growthInput = document.getElementById('kpi-val-growth');
        const multipleInput = document.getElementById('kpi-val-multiple');
        if (growthInput && !growthInput._userSet) growthInput.value = (autoGrowth * 100).toFixed(2);
        if (multipleInput && !multipleInput._userSet) multipleInput.value = (trailingPE || 20).toFixed(2);

        // Hints
        const gh = document.getElementById('kpi-val-growth-hint');
        const mh = document.getElementById('kpi-val-multiple-hint');
        if (gh) gh.textContent = `CAGR: ${(autoGrowth * 100).toFixed(1)}%`;
        if (mh) mh.textContent = `Médiane P/E: ${(trailingPE || 20).toFixed(1)}`;

        // Read parameters
        const growthRate = parseFloat(growthInput?.value || autoGrowth * 100) / 100;
        const multiple = parseFloat(multipleInput?.value || trailingPE || 20);
        const targetReturn = parseFloat(document.getElementById('kpi-val-target-return')?.value || 12) / 100;
        const inclDiv = document.getElementById('kpi-val-include-div')?.checked ?? true;
        const N = 10; // projection years

        // DCF fair price calculation
        let pvDividends = 0;
        let projMetric = baseMetric;
        for (let y = 1; y <= N; y++) {
            projMetric *= (1 + growthRate);
            if (inclDiv && dividendRate > 0) {
                const projDiv = dividendRate * Math.pow(1 + growthRate, y);
                pvDividends += projDiv / Math.pow(1 + targetReturn, y);
            }
        }
        const terminalValue = projMetric * multiple;
        const fairPrice = terminalValue / Math.pow(1 + targetReturn, N) + pvDividends;
        const safetyMargin = fairPrice > 0 ? (fairPrice - currentPrice) / fairPrice * 100 : 0;
        const estReturn = fairPrice > 0 && currentPrice > 0
            ? (Math.pow(fairPrice / currentPrice, 1 / N) - 1) * 100 : 0;

        // Build timeline
        const currentYear = new Date().getFullYear();
        const startYear = histEPS.length > 0 ? Math.min(histEPS[0].year, currentYear - 8) : currentYear - 8;
        const endYear = currentYear + N;
        const labels = [];
        for (let y = startYear; y <= endYear; y++) labels.push(y);

        // Historical metric data (dots)
        const histMetricData = labels.map(y => {
            const h = histEPS.find(d => d.year === y);
            return h ? h.eps : null;
        });

        // Projected metric data (from current year forward)
        const projMetricData = labels.map(y => {
            if (y < currentYear) return null;
            const yAhead = y - currentYear;
            if (yAhead > N) return null;
            return baseMetric * Math.pow(1 + growthRate, yAhead);
        });

        // Historical price (from priceHistory – year resolution)
        const ph = this.currentData.priceHistory || [];
        const yearlyPrices = {};
        ph.forEach(d => { const yr = new Date(d.t).getFullYear(); yearlyPrices[yr] = d.c; });
        const priceDataArr = labels.map(y => yearlyPrices[y] || null);

        // Fair price dot at currentYear + N
        const fairPriceData = labels.map(y => y === endYear ? fairPrice : null);

        // Current price dot
        const currentPriceDot = labels.map(y => y === currentYear ? currentPrice : null);

        this.modalChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: labels.map(String),
                datasets: [
                    {
                        label: metricType === 'fcf' ? 'FCF/Actions' : 'BPA',
                        data: histMetricData,
                        borderColor: '#eab308',
                        backgroundColor: 'rgba(234,179,8,0.7)',
                        borderWidth: 1.5, pointRadius: 5, pointHoverRadius: 7,
                        fill: false, tension: 0.1, spanGaps: false
                    },
                    {
                        label: 'Projeté',
                        data: projMetricData,
                        borderColor: '#eab308',
                        borderDash: [5, 5],
                        borderWidth: 1.5, pointRadius: 4, pointHoverRadius: 6,
                        fill: false, tension: 0.1, spanGaps: false
                    },
                    {
                        label: 'Prix actuel',
                        data: priceDataArr,
                        borderColor: '#3b82f6',
                        borderWidth: 2, pointRadius: 0,
                        fill: false, tension: 0.3, spanGaps: true
                    },
                    {
                        label: `Prix juste ${this.fmt(fairPrice, 2)} ${currency}`,
                        data: fairPriceData,
                        borderColor: '#3b82f6', backgroundColor: '#3b82f6',
                        borderWidth: 0, pointRadius: 9, pointHoverRadius: 11,
                        fill: false
                    },
                    {
                        label: `Prix actuel ${this.fmt(currentPrice, 2)} ${currency}`,
                        data: currentPriceDot,
                        borderColor: '#60a5fa', backgroundColor: '#60a5fa',
                        borderWidth: 0, pointRadius: 7, pointHoverRadius: 9,
                        fill: false
                    }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { display: true, labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12 } },
                    tooltip: {
                        mode: 'index', intersect: false,
                        callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y != null ? this.fmt(ctx.parsed.y, 2) + ' ' + currency : '—'}` }
                    }
                },
                scales: {
                    x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 11 } } },
                    y: {
                        grid: { color: 'rgba(255,255,255,0.04)' }, ticks: {
                            color: '#64748b', font: { size: 11 },
                            callback: v => this.fmt(v, 1) + ' ' + currency
                        }
                    }
                },
                animation: { duration: 400 }
            }
        });

        // KPI header
        const smClass = safetyMargin >= 0 ? 'positive' : 'negative';
        const erClass = estReturn >= 0 ? 'positive' : 'negative';
        statsContainer.innerHTML = `
            <div class="kpi-val-header">
                <div class="kpi-val-kpi">
                    <span class="kpi-val-kpi-label">Prix juste</span>
                    <span class="kpi-val-kpi-value neutral">${this.fmt(fairPrice, 2)} $${currency}</span>
                </div>
                <div class="kpi-val-kpi">
                    <span class="kpi-val-kpi-label">Rendement estimé</span>
                    <span class="kpi-val-kpi-value ${erClass}">${estReturn >= 0 ? '+' : ''}${estReturn.toFixed(2)}%/an</span>
                </div>
                <div class="kpi-val-kpi">
                    <span class="kpi-val-kpi-label">Marge de sécurité</span>
                    <span class="kpi-val-kpi-value ${smClass}">${safetyMargin >= 0 ? '+' : ''}${safetyMargin.toFixed(2)}%</span>
                </div>
            </div>`;

        // Wire recalculate & reset buttons (once)
        const recalcBtn = document.getElementById('kpi-val-recalc');
        const resetBtn = document.getElementById('kpi-val-reset');
        if (recalcBtn && !recalcBtn._wired) {
            recalcBtn._wired = true;
            recalcBtn.addEventListener('click', () => {
                if (growthInput) growthInput._userSet = true;
                if (multipleInput) multipleInput._userSet = true;
                this.renderKpiModalContent('valuation');
            });
        }
        if (resetBtn && !resetBtn._wired) {
            resetBtn._wired = true;
            resetBtn.addEventListener('click', () => {
                if (growthInput) { growthInput._userSet = false; growthInput.value = ''; }
                if (multipleInput) { multipleInput._userSet = false; multipleInput.value = ''; }
                this.renderKpiModalContent('valuation');
            });
        }

        // Wire val metric dropdown
        const valTrigger = document.getElementById('kpi-val-metric-trigger');
        const valOptions = document.getElementById('kpi-val-metric-options');
        const valWrapper = document.getElementById('kpi-val-metric-wrapper');
        const valLabel = document.getElementById('kpi-val-metric-label');
        const valHidden = document.getElementById('kpi-val-metric');
        if (valTrigger && !valTrigger._wired) {
            valTrigger._wired = true;
            valTrigger.addEventListener('click', e => { e.stopPropagation(); valWrapper.classList.toggle('open'); });
            valOptions?.querySelectorAll('.custom-select-option').forEach(opt => {
                opt.addEventListener('click', e => {
                    e.stopPropagation();
                    valHidden.value = opt.dataset.value;
                    valLabel.textContent = opt.textContent;
                    valOptions.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
                    opt.classList.add('selected');
                    valWrapper.classList.remove('open');
                    if (growthInput) { growthInput._userSet = false; growthInput.value = ''; }
                    if (multipleInput) { multipleInput._userSet = false; multipleInput.value = ''; }
                    this.renderKpiModalContent('valuation');
                });
            });
        }
    }

    setupModalPeriodButtons() {
        document.querySelectorAll('.kpi-period-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const period = btn.dataset.period;
                if (period === this.currentModalPeriod) return;

                document.querySelectorAll('.kpi-period-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentModalPeriod = period;

                const newPriceHistory = await this.fetchPriceHistory(this.currentSymbol, period);
                if (newPriceHistory) {
                    this.currentData.priceHistory = newPriceHistory;
                    await this.renderKpiModalContent(this.currentModalKpi);
                }
            });
        });
    }

    updateModalBottomStats() {
        const statsContainer = document.getElementById('kpi-modal-stats');
        if (!statsContainer) return;

        // Use raw (pre-conversion) values if available, else fallback to priceHistory
        const values = this._modalRawValues || this.currentData.priceHistory?.map(d => d.c);
        const data = this.currentData.priceHistory;
        if (!values || values.length === 0 || !data) return;

        const first = values[0];
        const last = values[values.length - 1];
        if (!first || !last) return;

        const perf = ((last - first) / first * 100);
        const years = (data[data.length - 1].t - data[0].t) / (365.25 * 24 * 3600 * 1000);
        const cagr = years > 0 ? (Math.pow(last / first, 1 / years) - 1) * 100 : perf;

        const indices = values.map((_, i) => i);
        const logVals = values.map(v => Math.log(Math.max(v, 0.0001)));
        const { r2 } = this.linearRegression(indices, logVals);

        const sign = perf >= 0 ? '+' : '';
        const cagrSign = cagr >= 0 ? '+' : '';
        const perfColor = perf >= 0 ? '#10b981' : '#ef4444';
        const cagrColor = cagr >= 0 ? '#10b981' : '#ef4444';

        statsContainer.style.cssText = 'display:flex;justify-content:flex-end;padding:8px 4px 0;width:100%;box-sizing:border-box;';
        statsContainer.innerHTML = `
            <div style="display:inline-flex;align-items:center;gap:10px;padding:6px 14px;border-radius:8px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);font-size:13px;font-weight:600;white-space:nowrap;max-width:100%;overflow:hidden;">
                <span style="color:${perfColor}">${sign}${perf.toFixed(2)}%</span>
                <span style="color:#334155">|</span>
                <span style="color:${cagrColor}">CAGR ${cagrSign}${cagr.toFixed(2)}%</span>
                <span style="color:#334155">|</span>
                <span style="color:#94a3b8">Lin. ${r2.toFixed(2)}</span>
            </div>
        `;
    }

    // ─── Valuation Tab Logic ──────────────────────────────────────────────────
    setupValuationTabListeners() {
        const growthInput = document.getElementById('val-tab-growth');
        const multipleInput = document.getElementById('val-tab-multiple');
        const targetInput = document.getElementById('val-tab-target-return');
        const divInput = document.getElementById('val-tab-include-div');

        const trigger = document.getElementById('val-tab-metric-trigger');
        const options = document.getElementById('val-tab-metric-options');
        const wrapper = document.getElementById('val-tab-metric-wrapper');
        const label = document.getElementById('val-tab-metric-label');
        const hidden = document.getElementById('val-tab-metric');

        if (trigger && options && wrapper) {
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                wrapper.classList.toggle('open');
            });
            options.querySelectorAll('.custom-select-option').forEach(opt => {
                opt.addEventListener('click', (e) => {
                    e.stopPropagation();
                    hidden.value = opt.dataset.value;
                    label.textContent = opt.textContent;
                    options.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
                    opt.classList.add('selected');
                    wrapper.classList.remove('open');
                    if (growthInput) growthInput._userSet = false;
                    if (multipleInput) multipleInput._userSet = false;
                    this.renderValuationTab();
                });
            });
            document.addEventListener('click', () => wrapper.classList.remove('open'));
        }

        document.getElementById('val-tab-recalc')?.addEventListener('click', () => {
            if (growthInput) growthInput._userSet = true;
            if (multipleInput) multipleInput._userSet = true;
            this.renderValuationTab();
        });

        document.getElementById('val-tab-reset')?.addEventListener('click', () => {
            if (growthInput) { growthInput._userSet = false; growthInput.value = ''; }
            if (multipleInput) { multipleInput._userSet = false; multipleInput.value = ''; }
            this.renderValuationTab();
        });
    }

    async renderValuationTab() {
        const canvas = document.getElementById('valuation-tab-chart');
        const header = document.getElementById('val-tab-kpi-header');
        if (!canvas || !header || !this.currentData) return;

        const qs = this.currentData.quoteSummary;
        if (!qs) return;

        // Extract data
        const priceData = qs.price || {};
        const financial = qs.financialData || {};
        const keyStats = qs.defaultKeyStatistics || {};
        const detail = qs.summaryDetail || {};
        const earningsObj = qs.earnings || {};

        const currentPrice = priceData.regularMarketPrice?.raw || 0;
        const currency = priceData.currency || 'USD';
        const shares = keyStats.sharesOutstanding?.raw || 1;
        const trailingEps = keyStats.trailingEps?.raw || 0;
        const trailingPE = detail.trailingPE?.raw || detail.trailingPE || 20;
        const dividendRate = detail.dividendRate?.raw || detail.dividendRate || 0;
        const totalFCF = financial.freeCashflow?.raw || 0;
        const fcfPerShare = totalFCF > 0 ? totalFCF / shares : 0;

        const yearly = earningsObj.financialsChart?.yearly || [];
        const histEPS = yearly.map(y => ({
            year: typeof y.date === 'object' ? y.date?.raw || y.date : y.date,
            eps: y.earnings?.raw != null ? y.earnings.raw / shares : null
        })).filter(d => d.eps != null && d.eps > 0);

        let autoGrowth = 0.10;
        if (histEPS.length >= 2) {
            const first = histEPS[0].eps, last = histEPS[histEPS.length - 1].eps;
            const n = histEPS[histEPS.length - 1].year - histEPS[0].year;
            if (n > 0 && first > 0) autoGrowth = Math.pow(last / first, 1 / n) - 1;
        }

        const metricType = document.getElementById('val-tab-metric')?.value || 'fcf';
        const baseMetric = metricType === 'fcf' && fcfPerShare > 0 ? fcfPerShare : (trailingEps || 1);

        const growthInput = document.getElementById('val-tab-growth');
        const multipleInput = document.getElementById('val-tab-multiple');
        if (growthInput && !growthInput._userSet) growthInput.value = (autoGrowth * 100).toFixed(2);
        if (multipleInput && !multipleInput._userSet) multipleInput.value = (trailingPE || 20).toFixed(2);

        const gh = document.getElementById('val-tab-growth-hint');
        const mh = document.getElementById('val-tab-multiple-hint');
        if (gh) gh.textContent = `CAGR: ${(autoGrowth * 100).toFixed(1)}%`;
        if (mh) mh.textContent = `Médiane P/E: ${(trailingPE || 20).toFixed(1)}`;

        const growthRate = parseFloat(growthInput?.value || autoGrowth * 100) / 100;
        const multiple = parseFloat(multipleInput?.value || trailingPE || 20);
        const targetReturn = parseFloat(document.getElementById('val-tab-target-return')?.value || 12) / 100;
        const inclDiv = document.getElementById('val-tab-include-div')?.checked ?? true;
        const N = 10;
        const currentYear = new Date().getFullYear();

        let pvDividends = 0;
        let projMetric = baseMetric;
        for (let y = 1; y <= N; y++) {
            projMetric *= (1 + growthRate);
            if (inclDiv && dividendRate > 0) {
                const projDiv = dividendRate * Math.pow(1 + growthRate, y);
                pvDividends += projDiv / Math.pow(1 + targetReturn, y);
            }
        }
        const terminalValue = projMetric * multiple;
        const fairPrice = terminalValue / Math.pow(1 + targetReturn, N) + pvDividends;
        const safetyMargin = fairPrice > 0 ? (fairPrice - currentPrice) / fairPrice * 100 : 0;
        const estReturn = fairPrice > 0 && currentPrice > 0 ? (Math.pow(fairPrice / currentPrice, 1 / N) - 1) * 100 : 0;

        if (!this.currentData.priceHistory10y) {
            this.currentData.priceHistory10y = await this.fetchPriceHistory(this.currentSymbol, '5y'); // 5y with weekly data is more fluid than 10y monthly
        }
        const ph = this.currentData.priceHistory10y || this.currentData.priceHistory || [];
        
        // --- High-Density Data Processing ---
        const startYear = currentYear - 5;
        const endYear = currentYear + N;
        
        // Generate monthly labels and data points
        const labels = [];
        const monthlyPrices = [];
        const monthlyHistMetric = [];
        const monthlyProjMetric = [];
        
        const totalMonths = (endYear - startYear) * 12;
        for (let i = 0; i <= totalMonths; i++) {
            const m = (startYear * 12 + i) % 12;
            const y = Math.floor((startYear * 12 + i) / 12);
            const dateStr = `${this.getMonthName(m)} ${y}`;
            labels.push(dateStr);
            
            const decimalYear = y + m / 12;
            const currentDecimalYear = currentYear + (new Date().getMonth()) / 12;
            
            // 1. Price History (Fluid)
            if (decimalYear <= currentDecimalYear) {
                // Find closest price point
                const targetTs = new Date(y, m, 15).getTime();
                let closest = null, minDiff = Infinity;
                ph.forEach(p => {
                    const diff = Math.abs(p.t - targetTs);
                    if (diff < minDiff) { minDiff = diff; closest = p.c; }
                });
                // Only use if within reasonable distance (e.g. 45 days)
                monthlyPrices.push(minDiff < 45 * 24 * 3600 * 1000 ? closest : null);
            } else {
                monthlyPrices.push(null);
            }
            
            // 2. Fundamental Metrics (Interpolated)
            if (y <= currentYear) {
                // Historical / Backward projection
                const yearsBehind = currentYear - decimalYear;
                monthlyHistMetric.push(baseMetric / Math.pow(1 + growthRate, yearsBehind));
                monthlyProjMetric.push(null);
            } else {
                // Future Projection
                const yearsAhead = decimalYear - currentYear;
                monthlyHistMetric.push(null);
                monthlyProjMetric.push(baseMetric * Math.pow(1 + growthRate, yearsAhead));
            }
        }

        // Special points for the current price and fair price dots
        const fairPriceData = labels.map((l, i) => i === labels.length - 1 ? fairPrice : null);
        const currentPriceData = labels.map((l, i) => {
            const y = Math.floor((startYear * 12 + i) / 12);
            const m = (startYear * 12 + i) % 12;
            return (y === currentYear && m === new Date().getMonth()) ? currentPrice : null;
        });

        if (this.valuationTabChart) this.valuationTabChart.destroy();
        this.valuationTabChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    { 
                        label: metricType === 'fcf' ? 'FCF/Actions' : 'BPA', 
                        data: monthlyHistMetric, 
                        borderColor: '#eab308', 
                        backgroundColor: 'rgba(234,179,8,0.1)', 
                        borderWidth: 2, 
                        pointRadius: 0, 
                        fill: false, 
                        yAxisID: 'y1',
                        tension: 0.1
                    },
                    { 
                        label: 'Projeté', 
                        data: monthlyProjMetric, 
                        borderColor: '#eab308', 
                        borderDash: [5, 5], 
                        borderWidth: 2, 
                        pointRadius: 0, 
                        fill: false, 
                        yAxisID: 'y1',
                        tension: 0.1
                    },
                    { 
                        label: 'Cours de l\'actif', 
                        data: monthlyPrices, 
                        borderColor: '#3b82f6', 
                        borderWidth: 2, 
                        pointRadius: 0, 
                        fill: true,
                        backgroundColor: 'rgba(59, 130, 246, 0.05)',
                        tension: 0.2, 
                        spanGaps: true, 
                        yAxisID: 'y' 
                    },
                    { 
                        label: `Prix juste ${this.fmt(fairPrice, 2)} ${currency}`, 
                        data: fairPriceData, 
                        borderColor: '#3b82f6', 
                        backgroundColor: '#3b82f6', 
                        borderWidth: 0, 
                        pointRadius: 8, 
                        fill: false, 
                        yAxisID: 'y' 
                    },
                    { 
                        label: `Prix actuel ${this.fmt(currentPrice, 2)} ${currency}`, 
                        data: currentPriceData, 
                        borderColor: '#60a5fa', 
                        backgroundColor: '#60a5fa', 
                        borderWidth: 0, 
                        pointRadius: 6, 
                        fill: false, 
                        yAxisID: 'y' 
                    }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: true, labels: { color: '#94a3b8', font: { size: 10 }, boxWidth: 12, usePointStyle: true } },
                    tooltip: { 
                        backgroundColor: 'rgba(15, 23, 42, 0.9)',
                        titleColor: '#f8fafc',
                        bodyColor: '#94a3b8',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        padding: 12
                    }
                },
                scales: {
                    x: { 
                        grid: { color: 'rgba(255,255,255,0.03)', drawBorder: false }, 
                        ticks: { 
                            color: '#64748b', 
                            maxRotation: 0,
                            autoSkip: true,
                            maxTicksLimit: 12,
                            font: { size: 10 }
                        } 
                    },
                    y: { 
                        position: 'left',
                        grid: { color: 'rgba(255,255,255,0.03)', drawBorder: false }, 
                        ticks: { color: '#64748b', font: { size: 10 }, callback: v => this.fmt(v, 0) + ' ' + currency } 
                    },
                    y1: { 
                        position: 'right',
                        display: false,
                        grid: { display: false }
                    }
                }
            }
        });

        const smClass = safetyMargin >= 0 ? 'positive' : 'negative';
        const erClass = estReturn >= 0 ? 'positive' : 'negative';
        header.innerHTML = `
            <div class="kpi-val-kpi">
                <span class="kpi-val-kpi-label">Prix juste</span>
                <span class="kpi-val-kpi-value neutral">${this.fmt(fairPrice, 2)} ${currency}</span>
            </div>
            <div class="kpi-val-kpi">
                <span class="kpi-val-kpi-label">Rendement estimé</span>
                <span class="kpi-val-kpi-value ${erClass}">${estReturn >= 0 ? '+' : ''}${estReturn.toFixed(2)}%/an</span>
            </div>
            <div class="kpi-val-kpi">
                <span class="kpi-val-kpi-label">Marge de sécurité</span>
                <span class="kpi-val-kpi-value ${smClass}">${safetyMargin >= 0 ? '+' : ''}${safetyMargin.toFixed(2)}%</span>
            </div>
        `;
        
        // Render the new lower grid
        this.renderValuationDashboard(this.currentData.quoteSummary, fairPrice, currentPrice, currency, metricType, baseMetric, growthRate, trailingPE);
    }

    getMonthName(index) {
        const months = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
        return months[index % 12];
    }

    renderValuationDashboard(qs, fairPrice, currentPrice, currency, metricType, baseMetric, growthRate, trailingPE) {
        if (!qs) return;

        // Cleanup existing grid charts
        if (this.valGridCharts) {
            this.valGridCharts.forEach(c => c.destroy());
        }
        this.valGridCharts = [];
        
        // Temporarily override quantCharts so helper methods push to the correct array
        const tempQuantCharts = this.quantCharts;
        this.quantCharts = this.valGridCharts;

        const fin = qs.financialData || {};
        const stats = qs.defaultKeyStatistics || {};
        const summary = qs.summaryDetail || {};

        // 1. Mètriques Clés
        const metricsList = document.getElementById('val-metrics-list');
        if (metricsList) {
            const metrics = [
                { label: 'P/E', val: summary.trailingPE?.raw || trailingPE, sub: 'Médiane: 25.4' },
                { label: 'Forward P/E', val: summary.forwardPE?.raw, sub: 'Proj. 1an' },
                { label: 'PEG Ratio', val: stats.pegRatio?.raw, sub: 'Croissance inc.' },
                { label: 'P/FCF', val: currentPrice / (fin.freeCashflow?.raw / (stats.sharesOutstanding?.raw || 1)), sub: 'Basé sur TTM' },
                { label: 'P/OCF', val: currentPrice / (fin.operatingCashflow?.raw / (stats.sharesOutstanding?.raw || 1)), sub: 'Basé sur TTM' },
                { label: 'P/S', val: summary.priceToSalesTrailing12Months?.raw, sub: 'Ventes' },
                { label: 'P/B', val: stats.priceToBook?.raw, sub: 'Book Value' },
                { label: 'Dividend Yield', val: (summary.dividendYield?.raw || 0) * 100, sub: 'Actuel', isPercent: true }
            ];

            metricsList.innerHTML = metrics.map(m => {
                const value = m.val ? (m.isPercent ? m.val.toFixed(2) + '%' : m.val.toFixed(2)) : 'N/A';
                return `
                    <div class="val-metric-item">
                        <span class="val-metric-label">${m.label}</span>
                        <span class="val-metric-value ${m.val < 0 ? 'negative' : ''}">${value}</span>
                        <span class="val-metric-sub">${m.sub}</span>
                    </div>
                `;
            }).join('');
        }

        // 2. Communauté (Dummy data for demo)
        const commBlock = document.getElementById('val-community-block');
        if (commBlock) {
            commBlock.innerHTML = `
                <div class="val-community-header">
                    <span>NB. D'ÉVALUATIONS : 228</span>
                    PRIX DE LA COMMUNAUTÉ : ${this.fmt(fairPrice * 0.95, 2)} ${currency}
                </div>
                <div class="val-community-cards">
                    <div class="val-community-card">
                        <div class="val-community-card-header">
                            <span class="val-community-card-badge">FCF</span>
                            <span>138 évaluations</span>
                        </div>
                        <div class="val-community-row"><span class="label">CROISSANCE</span><span class="val">${(growthRate * 100 * 1.1).toFixed(2)}%</span></div>
                        <div class="val-community-row"><span class="label">MULTIPLE</span><span class="val">${(trailingPE * 0.9).toFixed(2)}</span></div>
                        <div class="val-community-row"><span class="label">PRIX</span><span class="val">${this.fmt(fairPrice * 1.05, 2)} ${currency}</span></div>
                    </div>
                    <div class="val-community-card">
                        <div class="val-community-card-header">
                            <span class="val-community-card-badge">EPS</span>
                            <span>88 évaluations</span>
                        </div>
                        <div class="val-community-row"><span class="label">CROISSANCE</span><span class="val">${(growthRate * 100 * 0.9).toFixed(2)}%</span></div>
                        <div class="val-community-row"><span class="label">MULTIPLE</span><span class="val">${(trailingPE * 1.1).toFixed(2)}</span></div>
                        <div class="val-community-row"><span class="label">PRIX</span><span class="val">${this.fmt(fairPrice * 0.92, 2)} ${currency}</span></div>
                    </div>
                </div>
            `;
        }

        // We need to initialize arrays for the charts. We'll use Price History mapped to annual.
        const ph = this.currentData.priceHistory10y || this.currentData.priceHistory || [];
        const yearlyPrices = {};
        ph.forEach(d => { const yr = new Date(d.t).getFullYear(); yearlyPrices[yr] = d.c; });
        const currentYear = new Date().getFullYear();
        const years = [currentYear - 4, currentYear - 3, currentYear - 2, currentYear - 1, currentYear];
        const prices = years.map(y => yearlyPrices[y] || currentPrice);

        // Simulated historical metrics based on baseMetric and reverse growth
        const histFCF = years.map((y, i) => baseMetric / Math.pow(1 + growthRate, years.length - 1 - i));
        const histPE = prices.map((p, i) => p / (histFCF[i] || 1));
        const projectedPE = [1, 2, 3, 4, 5].map(i => currentPrice / (baseMetric * Math.pow(1 + growthRate, i)));

        // 3. Free Cash Flow / Action (Bar)
        this.renderQuantBarChart('chart-val-fcf-ps', 'FCF/Action', years, histFCF, '#eab308', null, currency);

        // 4. Régression linéaire (Scatter + Line approximation)
        this.renderQuantLineChart('chart-val-regression', [
            { label: 'Prix', data: prices, color: '#3b82f6' },
            { label: 'Régression', data: prices.map((p, i) => prices[0] * Math.pow(1 + 0.15, i)), color: '#fbbf24' } // Dummy regression line
        ], years, null, ' ' + currency);

        // 5. Forward P/E projeté (Bar)
        const projYears = [currentYear + 1, currentYear + 2, currentYear + 3, currentYear + 4, currentYear + 5];
        this.renderQuantBarChart('chart-val-forward-pe', 'Proj. P/E', projYears, projectedPE, ['#ef4444', '#f97316', '#eab308', '#10b981', '#3b82f6'], null, 'x');

        // 6. Price / Earnings (P/E)
        this.renderQuantLineChart('chart-val-pe', [{ label: 'P/E', data: histPE, color: '#3b82f6' }], years, null, 'x');

        // 7. Price / FCF
        this.renderQuantLineChart('chart-val-pfcf', [{ label: 'P/FCF', data: histPE.map(v => v * 0.9), color: '#3b82f6' }], years, null, 'x');

        // 8. Price / OCF
        this.renderQuantLineChart('chart-val-pocf', [{ label: 'P/OCF', data: histPE.map(v => v * 0.7), color: '#3b82f6' }], years, null, 'x');

        // 9. Price / Sales
        this.renderQuantLineChart('chart-val-ps', [{ label: 'P/S', data: histPE.map(v => v * 0.2), color: '#3b82f6' }], years, null, 'x');

        // Restore the original quantCharts
        this.quantCharts = tempQuantCharts;
    }

    async renderQuantitativeTab() {
        const qs = this.currentData.quoteSummary;
        if (!qs) return;

        // Cleanup existing charts
        if (this.quantCharts) {
            this.quantCharts.forEach(c => c.destroy());
        }
        this.quantCharts = [];

        const currency = qs.price?.currency || 'USD';
        const fin = qs.financialData || {};
        const stats = qs.defaultKeyStatistics || {};

        // Multi-year annual statements from the FUNDAMENTALS worker endpoint (Yahoo's
        // fundamentals-timeseries) — this is what actually still has real historical line
        // items now that quoteSummary's incomeStatementHistory/balanceSheetHistory/
        // cashflowStatementHistory modules mostly return just { endDate, netIncome }.
        const fundamentals = this.currentData.fundamentals || [];
        const hasFundamentals = fundamentals.length >= 2;
        const years = fundamentals.map(y => y.year);
        const fcfCurrent = fin.freeCashflow?.raw || 0;
        const opCashflowCurrent = fin.operatingCashflow?.raw || 0;

        // 1. Revenue & Earnings
        if (hasFundamentals) {
            this.renderQuantBarChart('chart-revenue', 'Revenus', years, fundamentals.map(y => y.annualTotalRevenue || 0), '#3b82f6', 'footer-revenue', currency);
            this.renderQuantBarChart('chart-earnings', 'Bénéfices', years, fundamentals.map(y => y.annualNetIncome || 0), '#fbbf24', 'footer-earnings', currency);
        } else {
            // Fallback: incomeStatementHistory still reports real totalRevenue/netIncome even
            // though its other fields (grossProfit, operatingIncome...) are gutted by Yahoo.
            const isHistory = qs.incomeStatementHistory?.incomeStatementHistory || [];
            const isData = isHistory.map(item => ({
                date: item.endDate?.fmt?.split('-')[0] || 'N/A',
                rev: item.totalRevenue?.raw || 0,
                net: item.netIncome?.raw || 0
            })).reverse();
            this.renderQuantBarChart('chart-revenue', 'Revenus', isData.map(d => d.date), isData.map(d => d.rev), '#3b82f6', 'footer-revenue', currency);
            this.renderQuantBarChart('chart-earnings', 'Bénéfices', isData.map(d => d.date), isData.map(d => d.net), '#fbbf24', 'footer-earnings', currency);
        }

        // 2. FCF Chart — real historical series (Opérationnel & Free Cash Flow)
        if (hasFundamentals) {
            this.renderQuantGroupedBarChart('chart-fcf', years, [
                { label: 'Opérationnel', data: fundamentals.map(y => y.annualOperatingCashFlow || 0), color: '#f97316' },
                { label: 'Free Cash Flow', data: fundamentals.map(y => y.annualFreeCashFlow || 0), color: '#fbbf24' }
            ], 'footer-fcf', currency, 1); // footer computed on the FCF series
        } else {
            // Fallback when historical data isn't available: current-period snapshot only
            this.renderQuantBarChart('chart-fcf', 'Cash Flow', ['Opérationnel', 'Free Cash Flow'], [opCashflowCurrent, fcfCurrent], ['#f97316', '#fbbf24'], null, currency);
        }

        // 3. Margins Chart — when revenue is missing or zero for a given year, report the
        // margin as absent (null) instead of dividing by a fallback of 1, which used to blow
        // up into meaningless axis scales (e.g. -500,000,000,000%).
        if (hasFundamentals) {
            const pct = (num, rev) => (rev ? (num / rev) * 100 : null);
            this.renderQuantLineChart('chart-margins', [
                { label: 'Brute', data: fundamentals.map(y => pct(y.annualGrossProfit, y.annualTotalRevenue)), color: '#3b82f6' },
                { label: 'Opé.', data: fundamentals.map(y => pct(y.annualOperatingIncome, y.annualTotalRevenue)), color: '#fbbf24' },
                { label: 'Nette', data: fundamentals.map(y => pct(y.annualNetIncome, y.annualTotalRevenue)), color: '#ef4444' }
            ], years, 'footer-margins', '%');
        } else {
            const isHistoryFallback = qs.incomeStatementHistory?.incomeStatementHistory || [];
            const marginsData = isHistoryFallback.map(item => {
                const rev = item.totalRevenue?.raw;
                const pct = (val) => (rev ? (val / rev) * 100 : null);
                return {
                    date: item.endDate?.fmt?.split('-')[0] || 'N/A',
                    gross: pct(item.grossProfit?.raw || 0),
                    op: pct(item.operatingIncome?.raw || 0),
                    net: pct(item.netIncome?.raw || 0)
                };
            }).reverse();
            this.renderQuantLineChart('chart-margins', [
                { label: 'Brute', data: marginsData.map(d => d.gross), color: '#3b82f6' },
                { label: 'Opé.', data: marginsData.map(d => d.op), color: '#fbbf24' },
                { label: 'Nette', data: marginsData.map(d => d.net), color: '#ef4444' }
            ], marginsData.map(d => d.date), 'footer-margins', '%');
        }

        // 4. Returns Chart — now a genuine historical time series (ROE = netIncome/equity,
        // ROA = netIncome/assets, per fiscal year) when fundamentals are available, instead
        // of two unrelated current-period ratios side by side.
        if (hasFundamentals) {
            this.renderQuantGroupedBarChart('chart-returns', years, [
                { label: 'ROE', data: fundamentals.map(y => y.annualStockholdersEquity ? (y.annualNetIncome / y.annualStockholdersEquity) * 100 : null), color: '#8b5cf6' },
                { label: 'ROA', data: fundamentals.map(y => y.annualTotalAssets ? (y.annualNetIncome / y.annualTotalAssets) * 100 : null), color: '#10b981' }
            ], null, '%');
        } else {
            const roe = (fin.returnOnEquity?.raw || 0) * 100;
            const roa = (fin.returnOnAssets?.raw || 0) * 100;
            this.renderQuantBarChart('chart-returns', 'Retours sur Capitaux', ['ROE', 'ROA'], [roe, roa], ['#8b5cf6', '#10b981'], null, '%');
        }

        // 5. Cash & Dette — historical when possible, instead of a same-period snapshot.
        if (hasFundamentals) {
            this.renderQuantGroupedBarChart('chart-cash-debt', years, [
                { label: 'Trésorerie', data: fundamentals.map(y => y.annualCashAndCashEquivalents || 0), color: '#10b981' },
                { label: 'Dette', data: fundamentals.map(y => y.annualTotalDebt || 0), color: '#ef4444' }
            ], null, currency);
        } else {
            this.renderQuantBarChart('chart-cash-debt', 'Cash vs Dette', ['Trésorerie', 'Dette'], [fin.totalCash?.raw || 0, fin.totalDebt?.raw || 0], ['#10b981', '#ef4444'], null, currency);
        }

        // 6. Dividende — historical dividend-per-share (dividendes payés ÷ actions moyennes)
        // when the company actually has a paying history; this also makes the Perf/CAGR
        // footer legitimate again (dividend growth rate is a real metric), unlike comparing
        // a % yield to a currency amount as before.
        const dpsSeries = fundamentals.map(y => {
            const paid = Math.abs(y.annualCommonStockDividendPaid || 0);
            const shares = y.annualBasicAverageShares || 0;
            return shares > 0 ? paid / shares : 0;
        });
        const hasDividendHistory = hasFundamentals && dpsSeries.some(v => v > 0);
        if (hasDividendHistory) {
            this.renderQuantBarChart('chart-dividend', 'Dividende / action', years, dpsSeries, '#14b8a6', 'footer-dividend', currency);
        } else {
            const divRate = qs.summaryDetail?.dividendRate?.raw || 0;
            const divYield = (qs.summaryDetail?.dividendYield?.raw || 0) * 100;
            this.renderQuantBarChart('chart-dividend', 'Dividende (Actuel)', ['Yield %', 'Rate'], [divYield, divRate], '#14b8a6', null);
        }

        // 7. Actions en circulation — historical basic/diluted share count (reveals buybacks
        // vs dilution over time), instead of a same-period Total-vs-Float snapshot.
        if (hasFundamentals) {
            this.renderQuantGroupedBarChart('chart-shares', years, [
                { label: 'De base', data: fundamentals.map(y => y.annualBasicAverageShares || 0), color: '#8b5cf6' },
                { label: 'Diluées', data: fundamentals.map(y => y.annualDilutedAverageShares || 0), color: '#a78bfa' }
            ], 'footer-shares', '', 0);
        } else {
            const shares = stats.sharesOutstanding?.raw || 0;
            const floatShares = stats.floatShares?.raw || 0;
            this.renderQuantBarChart('chart-shares', 'Actions', ['Total', 'Flottant'], [shares, floatShares], ['#8b5cf6', '#a78bfa'], null);
        }

        // 8. Dépenses — real historical CAPEX per year
        if (hasFundamentals) {
            this.renderQuantBarChart('chart-capex', 'CAPEX', years, fundamentals.map(y => Math.abs(y.annualCapitalExpenditure || 0)), '#ec4899', 'footer-capex', currency);
        } else {
            // Fallback approximation when historical data isn't available
            const capexApprox = Math.abs(opCashflowCurrent - fcfCurrent);
            this.renderQuantBarChart('chart-capex', 'CAPEX Est.', ['CAPEX (Actuel)'], [capexApprox], '#ec4899', null, currency);
        }
    }

    // ─── Dividende Tab ────────────────────────────────────────────────────────
    async renderDividendeTab() {
        const qs = this.currentData.quoteSummary;
        if (!qs) return;

        const currency = qs.price?.currency || 'USD';
        const detail = qs.summaryDetail || {};
        const fundamentals = this.currentData.fundamentals || [];
        const hasFundamentals = fundamentals.length >= 2;

        const divYield = (detail.dividendYield?.raw ?? detail.trailingAnnualDividendYield?.raw ?? 0) * 100;
        const divRate = detail.dividendRate?.raw ?? detail.trailingAnnualDividendRate?.raw ?? 0;
        const payoutRatioCurrent = detail.payoutRatio?.raw ?? null;

        const dpsSeries = fundamentals.map(y => {
            const paid = Math.abs(y.annualCommonStockDividendPaid || 0);
            const shares = y.annualBasicAverageShares || 0;
            return shares > 0 ? paid / shares : 0;
        });
        const hasDividendHistory = hasFundamentals && dpsSeries.some(v => v > 0);
        const hasAnyDividend = hasDividendHistory || divYield > 0 || divRate > 0;

        const emptyEl = document.getElementById('dividende-empty');
        const contentEl = document.getElementById('dividende-content');
        if (emptyEl) emptyEl.style.display = hasAnyDividend ? 'none' : 'block';
        if (contentEl) contentEl.style.display = hasAnyDividend ? '' : 'none';
        if (!hasAnyDividend) return;

        const el = (id) => document.getElementById(id);
        if (el('div-kpi-yield')) el('div-kpi-yield').textContent = divYield ? `${divYield.toFixed(2)}%` : '—';
        if (el('div-kpi-rate')) el('div-kpi-rate').textContent = divRate ? `${this.fmt(divRate, 2)} ${currency}` : '—';
        if (el('div-kpi-payout')) el('div-kpi-payout').textContent = payoutRatioCurrent != null ? `${(payoutRatioCurrent * 100).toFixed(1)}%` : '—';

        // Dividend growth CAGR, from the first year a dividend was actually paid to the last
        let cagrText = '—';
        if (hasDividendHistory) {
            const firstIdx = dpsSeries.findIndex(v => v > 0);
            const first = dpsSeries[firstIdx];
            const last = dpsSeries[dpsSeries.length - 1];
            const yearsSpan = dpsSeries.length - 1 - firstIdx;
            if (first > 0 && last > 0 && yearsSpan > 0) {
                const cagr = (Math.pow(last / first, 1 / yearsSpan) - 1) * 100;
                cagrText = `${cagr >= 0 ? '+' : ''}${cagr.toFixed(1)}%/an`;
            }
        }
        if (el('div-kpi-cagr')) el('div-kpi-cagr').textContent = cagrText;

        // Chart 1: real per-payment history via events=div (same technique as DividendManager)
        try {
            const payHistUrl = `${PROXY}?symbol=${encodeURIComponent(this.currentSymbol)}&type=STOCK&range=10y&interval=1d&events=div`;
            const payData = await this.safeFetchJson(payHistUrl);
            const events = payData?.chart?.result?.[0]?.events?.dividends;
            const payments = events
                ? Object.keys(events).map(ts => ({ ts: parseInt(ts, 10), amount: events[ts].amount })).sort((a, b) => a.ts - b.ts)
                : [];
            const payLabels = payments.map(p => new Date(p.ts * 1000).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }));
            this.renderQuantBarChart('chart-dividend-payments', 'Versement / action', payLabels, payments.map(p => p.amount), '#14b8a6', null, currency);
        } catch (err) {
            logger.error('[Dividende] payment history failed:', err);
        }

        // Chart 2: annual dividend per share (real growth metric, footer is legitimate here)
        if (hasDividendHistory) {
            this.renderQuantBarChart('chart-dividend-annual', 'Dividende / action', fundamentals.map(y => y.year), dpsSeries, '#14b8a6', 'footer-dividend-annual', currency);
        }

        // Chart 3: payout ratio history (dividends paid ÷ net income); null when net income <= 0
        if (hasFundamentals) {
            const payoutSeries = fundamentals.map(y => (y.annualNetIncome > 0 ? (Math.abs(y.annualCommonStockDividendPaid || 0) / y.annualNetIncome) * 100 : null));
            this.renderQuantLineChart('chart-payout-ratio', [{ label: 'Payout Ratio', data: payoutSeries, color: '#14b8a6' }], fundamentals.map(y => y.year), null, '%');
        }
    }

    // ─── Finances Tab ─────────────────────────────────────────────────────────
    setupFinanceTabButtons() {
        document.querySelectorAll('.fin-statement-tab').forEach(btn => {
            btn.addEventListener('click', () => this.renderFinancesStatement(btn.dataset.statement));
        });
    }

    async renderFinancesTab() {
        const fundamentals = this.currentData.fundamentals || [];
        const hasFundamentals = fundamentals.length >= 1;
        const currency = this.currentData.quoteSummary?.price?.currency || 'USD';

        const emptyEl = document.getElementById('finances-empty');
        const contentEl = document.getElementById('finances-content');
        if (emptyEl) emptyEl.style.display = hasFundamentals ? 'none' : 'block';
        if (contentEl) contentEl.style.display = hasFundamentals ? '' : 'none';
        if (!hasFundamentals) return;

        this._finFundamentals = fundamentals;
        this._finCurrency = currency;
        this.renderFinancesStatement(this.currentFinStatement || 'income');
    }

    renderFinancesStatement(statementKey) {
        const def = FIN_STATEMENT_DEFS[statementKey];
        if (!def) return;
        this.currentFinStatement = statementKey;
        document.querySelectorAll('.fin-statement-tab').forEach(b => b.classList.toggle('active', b.dataset.statement === statementKey));

        const fundamentals = this._finFundamentals || [];
        const currency = this._finCurrency || 'USD';
        const table = document.getElementById('fin-table');
        if (!table) return;

        const thead = table.querySelector('thead tr');
        const tbody = table.querySelector('tbody');
        thead.innerHTML = '<th>Ligne</th>' + fundamentals.map(y => `<th>${y.year}</th>`).join('');
        tbody.innerHTML = def.rows.map(row => {
            const cells = fundamentals.map(y => {
                const val = y[row.key];
                if (val == null) return '<td>—</td>';
                const formatted = row.decimals ? this.fmt(val, 2) : this.fmtFinCell(val, currency);
                return `<td${val < 0 ? ' class="fin-negative"' : ''}>${formatted}</td>`;
            }).join('');
            return `<tr><td>${row.label}</td>${cells}</tr>`;
        }).join('');
    }

    // Same magnitude convention as fmtBig()/fmtSmall() (Md = 1e9, B = 1e12), but sign-aware:
    // fmtBig() alone doesn't abbreviate negative values (CAPEX, dividends paid, financing
    // cash flow are routinely negative), so it prints raw unabbreviated numbers for them.
    fmtFinCell(val, currency) {
        const abs = Math.abs(val);
        const sign = val < 0 ? '-' : '';
        if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)} B ${currency}`.trim();
        if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)} Md ${currency}`.trim();
        if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)} M ${currency}`.trim();
        return `${this.fmt(val, 0)} ${currency}`.trim();
    }

    renderQuantBarChart(id, label, labels, data, color, footerId, currency = '') {
        const canvas = document.getElementById(id);
        if (!canvas) return;
        Chart.getChart(canvas)?.destroy(); // avoid "Canvas is already in use" on re-render (e.g. Dividende tab revisited)
        const ctx = canvas.getContext('2d');

        const chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: label,
                    data: data,
                    backgroundColor: Array.isArray(color) ? color : color + 'cc',
                    borderRadius: 4,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => `${ctx.dataset.label}: ${this.nfmt(ctx.raw, currency)}`
                        }
                    }
                },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 10 } } },
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8', font: { size: 10 }, callback: (v) => this.fmtSmall(v) } }
                }
            }
        });
        this.quantCharts.push(chart);
        this.renderQuantFooter(footerId, data);
    }

    // Grouped bar chart for several datasets sharing the same year labels (e.g. OCF vs FCF).
    // footerSeriesIndex picks which dataset the Perf/CAGR footer is computed from.
    renderQuantGroupedBarChart(id, labels, datasets, footerId, currency = '', footerSeriesIndex = 0) {
        const canvas = document.getElementById(id);
        if (!canvas) return;
        Chart.getChart(canvas)?.destroy();
        const ctx = canvas.getContext('2d');

        const chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: datasets.map(ds => ({
                    label: ds.label,
                    data: ds.data,
                    backgroundColor: ds.color + 'cc',
                    borderRadius: 4,
                    borderWidth: 0
                }))
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: true, position: 'bottom', labels: { color: '#94a3b8', boxWidth: 10, font: { size: 10 } } },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => `${ctx.dataset.label}: ${this.nfmt(ctx.raw, currency)}`
                        }
                    }
                },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 10 } } },
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8', font: { size: 10 }, callback: (v) => this.fmtSmall(v) } }
                }
            }
        });
        this.quantCharts.push(chart);
        this.renderQuantFooter(footerId, datasets[footerSeriesIndex]?.data);
    }

    // Shared Perf/CAGR footer, only meaningful when `series` is an actual multi-year time series.
    renderQuantFooter(footerId, series) {
        const footer = footerId ? document.getElementById(footerId) : null;
        if (!footer || !series || series.length < 2) return;

        const start = series[0];
        const end = series[series.length - 1];
        const perf = ((end - start) / Math.abs(start || 1)) * 100;
        const cagr = (Math.pow(end / (start || 1), 1 / (series.length - 1)) - 1) * 100;

        const perfClass = perf >= 0 ? 'perf-positive' : 'perf-negative';
        footer.innerHTML = `
            <span class="perf-label ${perfClass}">Perf: ${perf.toFixed(1)}%</span>
            ${!isNaN(cagr) && isFinite(cagr) ? `<span class="perf-label perf-neutral">CAGR: ${cagr.toFixed(1)}%</span>` : ''}
        `;
    }

    renderQuantLineChart(id, datasets, labels, footerId, unit = '') {
        const canvas = document.getElementById(id);
        if (!canvas) return;
        Chart.getChart(canvas)?.destroy();
        const ctx = canvas.getContext('2d');

        const chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: datasets.map(ds => ({
                    label: ds.label,
                    data: ds.data,
                    borderColor: ds.color,
                    backgroundColor: ds.color + '22',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 3,
                    pointHoverRadius: 5
                }))
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'bottom',
                        labels: { color: '#94a3b8', boxWidth: 10, font: { size: 10 } }
                    }
                },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 10 } } },
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8', font: { size: 10 }, callback: (v) => v.toFixed(1) + unit } }
                }
            }
        });
        this.quantCharts.push(chart);
    }

    // Same magnitude convention as fmtBig(): Md = milliard (1e9), B = billion (1e12)
    fmtSmall(val) {
        if (Math.abs(val) >= 1e12) return (val / 1e12).toFixed(1) + 'B';
        if (Math.abs(val) >= 1e9) return (val / 1e9).toFixed(1) + 'Md';
        if (Math.abs(val) >= 1e6) return (val / 1e6).toFixed(1) + 'M';
        if (Math.abs(val) >= 1e3) return (val / 1e3).toFixed(1) + 'k';
        return val.toFixed(1);
    }

    nfmt(val, curr) {
        if (!val) return '—';
        if (Math.abs(val) >= 1e12) return (val / 1e12).toFixed(2) + ' B ' + curr;
        if (Math.abs(val) >= 1e9) return (val / 1e9).toFixed(2) + ' Md ' + curr;
        if (Math.abs(val) >= 1e6) return (val / 1e6).toFixed(2) + ' M ' + curr;
        return this.fmt(val, 0) + ' ' + curr;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const app = new ScreenerApp();
    app.init();
});
