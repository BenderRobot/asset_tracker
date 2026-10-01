// ============================================================
// screenerApp.js — Stock Screener & Analysis Page
// ============================================================
import { Storage } from './storage.js';
import { PRICE_PROXY_URL } from './config.js';
import logger from '../utils/logger.js';
import {
    YEAR_MS, normalizeCurrency, fxSymbol, currencyContext, valueAt, commonSessions, dailyCloseAt, monthlyCloses, normalizePair,
    cagr, annualSeriesStats, median, averageCost, fundamentalRows, historicalMultiples, forwardEstimates,
    hasFundamentalProfile, historicalShareBasis, radarDimensions, quantScore, fairPriceModel, simpleDcf,
} from './screenerMetrics.js';

const PROXY = PRICE_PROXY_URL;
const SP500_SYMBOL = '^GSPC'; // Used for S&P 500 comparison
const isNum = v => typeof v === 'number' && Number.isFinite(v);
// A 1-year weekly window spans slightly less than 365 days: annualise from ~11 months.
const MIN_ANNUALISED_YEARS = 0.9;

// SECURITY FIX (audit XSS, P1) : les résultats de recherche Yahoo (symbol/
// shortname/longname) sont une donnée externe non maîtrisée par l'app et
// étaient injectés tels quels dans innerHTML — même convention d'échappement
// que dashboardApp.js/ui.js.
function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
}

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
        this.currentPeriod = '1y';
        this._cachedBenchmarkData = {};
        this._fxCache = new Map();
        this._loadToken = 0;
        this._modalToken = 0;
        this._searchToken = 0;
        this.quantCharts = [];
        this.dividendCharts = [];
        this.valGridCharts = [];
    }

    async init() {
        this.setupSearch();
        this.renderPopularAssets();
        this.setupTabs();
        this.setupWatchlistButton();
        // Bound once: render() runs on every search and used to stack a new
        // listener per load, so one click triggered N modal loads.
        this.setupPeriodButtons();
        this.setupKpiModals();
        this.setupModalPeriodButtons();

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
            this._searchToken++;
            suggestions.innerHTML = '';
            input.removeAttribute('aria-activedescendant');
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

        input.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                clearTimeout(this.searchDebounce);
                const query = input.value.trim();
                let ticker = suggestions.classList.contains('open')
                    ? suggestions.querySelector('.suggestion-item[aria-selected="true"]')?.dataset.ticker : null;
                if (!ticker && query) {
                    const quotes = await this.fetchSuggestions(query);
                    if (!quotes || query !== input.value.trim()) return;
                    ticker = (quotes.find(q => q.symbol.toUpperCase() === query.toUpperCase()) || quotes[0])?.symbol;
                }
                if (ticker) {
                    ++this._searchToken;
                    suggestions.classList.remove('open');
                    input.setAttribute('aria-expanded', 'false');
                    input.value = ticker;
                    this.loadStock(ticker);
                    input.blur();
                }
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const items = [...suggestions.querySelectorAll('.suggestion-item')];
                if (!items.length) return;
                const previous = items.findIndex(item => item.getAttribute('aria-selected') === 'true');
                const index = previous < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1)
                    : (previous + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                items.forEach((item, i) => item.setAttribute('aria-selected', String(i === index)));
                input.setAttribute('aria-activedescendant', items[index].id);
            }
            if (e.key === 'Escape') {
                ++this._searchToken;
                clearTimeout(this.searchDebounce);
                suggestions.classList.remove('open');
                input.setAttribute('aria-expanded', 'false');
            }
        });

        clear.addEventListener('click', () => {
            ++this._searchToken;
            clearTimeout(this.searchDebounce);
            input.value = '';
            clear.style.display = 'none';
            suggestions.innerHTML = '';
            suggestions.classList.remove('open');
            input.setAttribute('aria-expanded', 'false');
            input.focus();
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.screener-search-section')) {
                ++this._searchToken;
                clearTimeout(this.searchDebounce);
                suggestions.classList.remove('open');
                input.setAttribute('aria-expanded', 'false');
            }
        });
    }

    async fetchSuggestions(query) {
        const suggestions = document.getElementById('screener-suggestions');
        const token = ++this._searchToken;
        suggestions.innerHTML = '';
        document.getElementById('screener-search-input').setAttribute('aria-expanded', 'false');
        try {
            const url = `${PROXY}?symbol=${encodeURIComponent(query)}&type=SEARCH`;
            const data = await this.safeFetchJson(url);
            if (token !== this._searchToken) return;
            // Same instrument families as the popular grid (indices and crypto included).
            const allowedTypes = ['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX', 'CRYPTOCURRENCY'];
            const quotes = (data.quotes || []).filter(q => allowedTypes.includes(q.quoteType)).slice(0, 7);

            if (!quotes.length) {
                suggestions.classList.remove('open');
                return [];
            }

            suggestions.innerHTML = quotes.map((q, i) => `
                <div class="suggestion-item" id="suggestion-${i}" role="option" aria-selected="false" data-ticker="${escHtml(q.symbol).replace(/"/g, '&quot;')}">
                    <span class="suggestion-ticker">${escHtml(q.symbol)}</span>
                    <span class="suggestion-name">${escHtml(q.shortname || q.longname || '—')}</span>
                    <span class="suggestion-type">${escHtml(q.quoteType || '')}</span>
                </div>
            `).join('');
            suggestions.classList.add('open');
            document.getElementById('screener-search-input').setAttribute('aria-expanded', 'true');

            suggestions.querySelectorAll('.suggestion-item').forEach(item => {
                item.addEventListener('click', () => {
                    ++this._searchToken;
                    clearTimeout(this.searchDebounce);
                    const ticker = item.dataset.ticker;
                    document.getElementById('screener-search-input').value = ticker;
                    suggestions.classList.remove('open');
                    document.getElementById('screener-search-input').setAttribute('aria-expanded', 'false');
                    this.loadStock(ticker);
                });
            });
            return quotes;
        } catch {
            if (token !== this._searchToken) return;
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
        // A slower response for a previous symbol must never overwrite the current one.
        const token = ++this._loadToken;
        this.currentSymbol = symbol;
        this.showState('loading');

        try {
            const [quoteSummary, priceHistory, sp500History, fundamentals] = await Promise.all([
                this.fetchQuoteSummary(symbol),
                // The page stays usable without the chart: render() skips an empty series.
                this.fetchPriceHistory(symbol, this.currentPeriod).catch(() => null),
                this.fetchPriceHistory(SP500_SYMBOL, this.currentPeriod).catch(() => null),
                this.fetchFundamentals(symbol),
            ]);
            if (token !== this._loadToken) return;

            if (!quoteSummary || quoteSummary.error) {
                throw new Error(`Aucune donnée trouvée pour "${symbol}"`);
            }

            const currency = currencyContext(quoteSummary, fundamentals);
            const hasFundamentals = hasFundamentalProfile(quoteSummary);
            const shareBasis = historicalShareBasis(quoteSummary, currency);
            const rows = hasFundamentals
                ? fundamentalRows(fundamentals, { ordinaryPerQuoted: shareBasis })
                : [];
            // Statements in another currency (ADR, dual listing) are converted with
            // the real FX series; without it the cross ratios are not shown at all.
            const [finFx, eurFx, pru] = await Promise.all([
                hasFundamentals ? this.fetchFxSeries(currency.finIso, currency.priceIso, '10y') : null,
                this.fetchFxSeries(currency.quote, 'EUR', '1mo'),
                this.computePru(symbol, currency),
            ]);
            if (token !== this._loadToken) return;

            this.currentData = {
                quoteSummary, priceHistory, sp500History, fundamentals,
                currency, hasFundamentals, rows, finFx, eurFx, pru, shareBasis,
                priceHistoryLong: null,
            };
            this.render();
            this.showState('panel');

            // Update URL without reload
            const url = new URL(window.location);
            url.searchParams.set('ticker', symbol);
            window.history.replaceState({}, '', url);

        } catch (err) {
            if (token !== this._loadToken) return;
            logger.error('[Screener] Error:', err);
            this.showError(err.message);
        }
    }

    // ─── Currency helpers ────────────────────────────────────────────────────
    // Returns { at(t), latest } quoting `toCode` per one `fromCode`, or null
    // when the FX series is unavailable (callers then hide the value; a rate
    // of 1 is never assumed). Minor units (GBp) are handled by their factor.
    async fetchFxSeries(fromCode, toCode, period = '10y') {
        const from = normalizeCurrency(fromCode), to = normalizeCurrency(toCode);
        if (!from.iso || !to.iso) return null;
        const scale = from.factor / to.factor;
        if (from.iso === to.iso) {
            return {
                at: () => scale, latest: scale, marketRate: 1,
                latestAt: null, stale: false, fromIso: from.iso, toIso: to.iso,
            };
        }

        const key = `${from.iso}${to.iso}:${period}`;
        const now = Date.now();
        const ttlMs = 15 * 60 * 1000;
        let cached = this._fxCache.get(key);
        if (!cached || now - cached.cachedAt >= ttlMs) {
            cached = {
                cachedAt: now,
                promise: this.fetchPriceHistory(fxSymbol(from.iso, to.iso), period, { daily: true }).catch(() => null),
            };
            this._fxCache.set(key, cached);
        }
        const series = await cached.promise;
        if (!series?.length) {
            if (this._fxCache.get(key) === cached) this._fxCache.delete(key);
            return null;
        }
        const last = [...series].reverse().find(point => isNum(point.c) && point.c > 0);
        if (!last) {
            if (this._fxCache.get(key) === cached) this._fxCache.delete(key);
            return null;
        }
        const latestAt = isNum(last.t) ? last.t : null;
        return {
            // Before the first FX point the rate is unknown: null, not the current rate.
            at: t => { const r = dailyCloseAt(series, t); return isNum(r) ? r * scale : null; },
            latest: last.c * scale,
            marketRate: last.c,
            latestAt,
            stale: latestAt != null && now - latestAt > 4 * 24 * 3600 * 1000,
            fromIso: from.iso,
            toIso: to.iso,
        };
    }

    // financial currency → price currency (major units), for a timestamp or now.
    finToPrice(t = null) {
        const fx = this.currentData?.finFx;
        if (!fx) return null;
        return t == null ? fx.latest : fx.at(t);
    }

    // Rate converting an amount expressed in `code` into the price currency (major units).
    rateToPrice(code) {
        const { priceIso, finIso } = this.currentData.currency;
        const iso = normalizeCurrency(code).iso || priceIso;
        if (iso === priceIso) return 1;
        if (iso === finIso) return this.finToPrice();
        return null;
    }

    // Average cost of the user's position, converted to the quote currency of the chart.
    async computePru(symbol, currency) {
        const position = averageCost(this.storage.getPurchases(), symbol);
        if (!position) return null;
        const fx = await this.fetchFxSeries(position.currency, currency.quote, '1mo');
        if (!fx) return null;
        return { value: position.avgPrice * fx.latest, quantity: position.quantity };
    }

    // Quote-currency price → major units (GBp → GBP).
    toMajor(price) {
        return isNum(price) ? price * this.currentData.currency.priceFactor : null;
    }

    // Daily closes avoid using a month-end price after the fiscal closing date.
    async getLongHistory() {
        if (!this.currentData.priceHistoryLong) {
            this.currentData.priceHistoryLong = await this.fetchPriceHistory(this.currentSymbol, '10y', { daily: true }).catch(() => null) || [];
        }
        return this.currentData.priceHistoryLong;
    }

    // ─── Tabs ──────────────────────────────────────────────────────────────
    setupTabs() {
        const tabs = document.querySelectorAll('.screener-tab');
        const contents = document.querySelectorAll('.screener-tab-content');
        tabs.forEach(tab => {
            tab.addEventListener('click', async () => {
                if (tab.classList.contains('disabled')) {
                    this.showTempMessage(tab.dataset.disabledReason || 'Fonctionnalité bientôt disponible', 2200);
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
        // The Worker owns the allow-listed module set. Keeping it server-side
        // avoids a misleading client parameter and lets all callers benefit
        // from the same lightweight Yahoo request.
        const url = `${PROXY}?symbol=${encodeURIComponent(symbol)}&type=QUOTE_SUMMARY`;
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

    async fetchPriceHistory(symbol, period, { daily = false } = {}) {
        const rangeMap = {
            '1mo': { range: '1mo', interval: '1d' },
            '3mo': { range: '3mo', interval: '1d' },
            '6mo': { range: '6mo', interval: '1d' },
            'ytd': { range: 'ytd', interval: '1d' },
            '1y': { range: '1y', interval: '1d' },
            // Yahoo has no 3y range: request the exact window instead of 2y.
            '3y': { years: 3, interval: '1d' },
            '5y': { range: '5y', interval: '1d' },
            '10y': { range: '10y', interval: '1mo' },
            '10ywk': { range: '10y', interval: '1wk' }, // ~520 pts for MA buffer
            'max': { range: 'max', interval: '1mo' },
        };
        const { range, years, interval: defaultInterval } = rangeMap[period] || rangeMap['1y'];
        const interval = daily ? '1d' : defaultInterval;
        let window = `range=${range}`;
        if (years) {
            const now = Math.floor(Date.now() / 1000);
            window = `period1=${now - Math.round(years * YEAR_MS / 1000)}&period2=${now}`;
        }
        const url = `${PROXY}?symbol=${encodeURIComponent(symbol)}&${window}&interval=${interval}`;
        const data = await this.safeFetchJson(url);
        const chart = data?.chart?.result?.[0];
        if (!chart) return null;
        const timestamps = chart.timestamp || [];
        const closes = chart.indicators?.quote?.[0]?.close || [];
        const adjcloses = chart.indicators?.adjclose?.[0]?.adjclose || closes;

        const dayFormatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: chart.meta?.exchangeTimezoneName || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
        });
        const sessionDay = t => {
            const parts = Object.fromEntries(dayFormatter.formatToParts(new Date(t)).map(p => [p.type, p.value]));
            return `${parts.year}-${parts.month}-${parts.day}`;
        };
        const today = sessionDay(Date.now());
        const regularEnd = chart.meta?.currentTradingPeriod?.regular?.end;
        return timestamps.map((ts, i) => ({
            t: ts * 1000,
            session: sessionDay(ts * 1000),
            closed: sessionDay(ts * 1000) < today || (isNum(regularEnd) && Date.now() >= regularEnd * 1000),
            c: closes[i],
            a: adjcloses[i] ?? closes[i]
        })).filter(d => d.c != null);
    }

    // Wrapper fetch that logs non-OK responses and returns parsed JSON. Yahoo
    // answers intermittent 502/503 through the Worker: one delayed retry absorbs
    // them before the page gives up.
    async safeFetchJson(url, opts = {}, attempt = 0) {
        try {
            const res = await fetch(url, opts);
            const text = await res.text();
            if (!res.ok) {
                if ([502, 503, 504].includes(res.status) && attempt < 1) {
                    await new Promise(resolve => setTimeout(resolve, 900));
                    return this.safeFetchJson(url, opts, attempt + 1);
                }
                // Try to parse JSON body if possible
                let parsed = text;
                try { parsed = JSON.parse(text); } catch (e) { /* keep raw text */ }
                logger.error('[Fetch] Non-OK response', { url, status: res.status, body: parsed });
                const error = new Error(res.status === 429
                    ? 'Trop de requêtes vers le fournisseur de données. Réessayez dans une minute.'
                    : 'Le fournisseur de données (Yahoo Finance) ne répond pas pour le moment. Réessayez dans quelques instants.');
                error.status = res.status;
                throw error;
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
        this.updateTabAvailability();
        this.resetCalculatorInputs();
        this.updateWatchlistButtonState();
    }

    // Statements, valuation and the quantitative profile only exist for
    // operating companies: for ETFs, indices and crypto they stay disabled
    // instead of showing charts computed from empty fields.
    updateTabAvailability() {
        const { hasFundamentals, quoteSummary } = this.currentData;
        const type = quoteSummary.price?.quoteType || '';
        const reason = `Non disponible pour ce type d'actif (${type || 'inconnu'}) : aucun état financier publié.`;
        ['quantitatif', 'finances', 'valorisation'].forEach(name => {
            const tab = document.querySelector(`.screener-tab[data-tab="${name}"]`);
            if (!tab) return;
            tab.classList.toggle('disabled', !hasFundamentals);
            if (hasFundamentals) delete tab.dataset.disabledReason;
            else tab.dataset.disabledReason = reason;
        });
        document.querySelectorAll('.kpi-expand-btn[data-kpi="radar"], .kpi-expand-btn[data-kpi="valuation"]')
            .forEach(btn => { btn.style.display = hasFundamentals ? '' : 'none'; });
    }

    renderHeader(profile, stats, financial, detail, price) {
        const symbol = this.currentSymbol;
        const name = price.longName || price.shortName || symbol;
        const currentPrice = price.regularMarketPrice?.raw ?? null;
        const change = price.regularMarketChange?.raw ?? null;
        const changePct = price.regularMarketChangePercent?.raw ?? null;
        const currency = price.currency || detail.currency || '';
        const exchange = price.exchangeName || '';

        document.getElementById('stock-name').textContent = name;
        document.getElementById('stock-ticker-badge').textContent = symbol;
        document.getElementById('stock-exchange').textContent = exchange;
        document.getElementById('stock-currency').textContent = currency;

        document.getElementById('stock-price').textContent =
            currentPrice != null ? this.formatNativeQuote(currentPrice, currency, price.quoteType) : '—';
        this.renderEurCountervalue(
            document.getElementById('stock-price-eur'),
            document.getElementById('stock-fx-meta'),
            currentPrice,
            currency,
            price.quoteType,
        );

        const changeEl = document.getElementById('stock-change');
        const up = (change ?? 0) >= 0;
        const sign = up ? '+' : '';
        const pctText = changePct != null ? `${sign}${(changePct * 100).toFixed(2)}%` : '—';
        changeEl.textContent = change != null ? `${sign}${this.fmt(change, 2)} (${pctText})` : '—';
        changeEl.className = 'stock-change ' + (up ? 'positive' : 'negative');

        this.renderLogo(document.getElementById('stock-logo'), profile, name);

        document.getElementById('price-chart-label').textContent =
            currentPrice != null ? `${this.fmt(currentPrice, 2)} ${currency}  ${pctText}` : '—';

        // Source and quote time: Yahoo quotes are delayed on most venues.
        const sourceEl = document.getElementById('stock-data-source');
        if (sourceEl) {
            const time = price.regularMarketTime?.raw ?? price.regularMarketTime;
            const when = isNum(time)
                ? new Date(time * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                : null;
            sourceEl.textContent = `Source : Yahoo Finance${when ? ` · cours du ${when}` : ''} · données différées`;
        }
    }

    priceDecimals(value) {
        const abs = Math.abs(value);
        if (abs === 0 || abs >= 1) return 2;
        if (abs >= 0.01) return 4;
        if (abs >= 0.0001) return 6;
        return 8;
    }

    formatNativeQuote(value, currency, quoteType = '') {
        if (!isNum(value)) return '—';
        const unit = String(quoteType).toUpperCase() === 'INDEX' ? 'points' : currency;
        return `${this.fmt(value, this.priceDecimals(value))} ${unit || ''}`.trim();
    }

    renderEurCountervalue(valueEl, metaEl, currentPrice, currency, quoteType = '') {
        if (!valueEl || !metaEl) return;
        valueEl.classList.remove('is-unavailable');
        metaEl.classList.remove('is-stale');

        const normalized = normalizeCurrency(currency);
        if (!isNum(currentPrice) || normalized.iso === 'EUR') {
            valueEl.hidden = true;
            metaEl.hidden = true;
            valueEl.textContent = '';
            metaEl.textContent = '';
            return;
        }

        valueEl.hidden = false;
        const fx = this.currentData?.eurFx;
        if (!normalized.iso || !isNum(fx?.latest) || fx.latest <= 0) {
            valueEl.textContent = 'Conversion EUR indisponible';
            valueEl.classList.add('is-unavailable');
            metaEl.hidden = true;
            metaEl.textContent = '';
            return;
        }

        const eurPrice = currentPrice * fx.latest;
        const indicative = String(quoteType).toUpperCase() === 'INDEX' ? ' (indicatif)' : '';
        valueEl.textContent = `≈ ${this.fmt(eurPrice, this.priceDecimals(eurPrice))} €${indicative}`;

        const fromIso = fx.fromIso || normalized.iso;
        const marketRate = isNum(fx.marketRate) ? fx.marketRate : fx.latest / normalized.factor;
        const rateText = this.fmt(marketRate, marketRate < 0.1 ? 6 : 4);
        const dateText = isNum(fx.latestAt)
            ? new Date(fx.latestAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
            : null;
        metaEl.hidden = false;
        metaEl.textContent = `1 ${fromIso} = ${rateText} EUR${dateText ? ` · change du ${dateText}` : ''}${fx.stale ? ' · taux ancien' : ''}`;
        metaEl.classList.toggle('is-stale', !!fx.stale);
    }

    // Favicon from the company website, initial letter otherwise. Yahoo strings
    // are escaped: they are external data.
    renderLogo(el, profile, name) {
        if (!el) return;
        const domain = this.safeWebsite(profile.website)?.hostname.replace(/^www\./, '');
        el.textContent = '';
        if (!domain) {
            el.textContent = this.currentSymbol.charAt(0);
            return;
        }
        const img = document.createElement('img');
        img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
        img.alt = name || this.currentSymbol;
        img.onerror = () => { el.textContent = this.currentSymbol.charAt(0); };
        el.appendChild(img);
    }

    safeWebsite(website) {
        try {
            const url = new URL(website);
            return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
        } catch {
            return null;
        }
    }

    renderCompanyInfo(profile, stats, detail, price) {
        const mktCap = price.marketCap?.raw ?? detail.marketCap?.raw;
        const currency = price.currency || '';
        const website = this.safeWebsite(profile.website);
        const exchange = price.exchangeName || '';

        document.getElementById('info-ticker').textContent = this.currentSymbol;
        // Market cap is in major units even for pence-quoted lines (GBp → GBP)
        document.getElementById('info-mktcap').textContent = mktCap ? this.fmtBig(mktCap, this.currentData.currency.priceIso || currency) : '—';
        document.getElementById('info-exchange').textContent = exchange || '—';
        document.getElementById('info-website').innerHTML = website
            ? `<a href="${escHtml(website.href)}" target="_blank" rel="noopener">${escHtml(website.host + website.pathname.replace(/\/$/, ''))}</a>`
            : '—';
        document.getElementById('info-type').textContent = this.quoteTypeLabel(price.quoteType);
        document.getElementById('info-sector').textContent = profile.sector || '—';
        document.getElementById('info-country').textContent = profile.country || '—';
        document.getElementById('info-industry').textContent = profile.industry || '—';
        document.getElementById('info-currency').textContent = currency || '—';

        // Dividend badge (dividendYield first: the trailing yield mixes currencies for ADRs)
        const hasDiv = (detail.dividendYield?.raw ?? detail.trailingAnnualDividendYield?.raw ?? 0) > 0;
        const divBadge = document.getElementById('info-div-badge');
        if (hasDiv) {
            divBadge.className = 'info-badge badge-green';
            divBadge.innerHTML = '<i class="fas fa-check-circle"></i> Dividende : Oui';
        } else {
            divBadge.className = 'info-badge badge-red';
            divBadge.innerHTML = '<i class="fas fa-times-circle"></i> Dividende : Non';
        }
    }

    quoteTypeLabel(type) {
        const labels = { EQUITY: 'Action', ETF: 'ETF', MUTUALFUND: 'Fonds', INDEX: 'Indice', CRYPTOCURRENCY: 'Crypto-monnaie', FUTURE: 'Contrat à terme', CURRENCY: 'Devise' };
        return labels[type] || type || '—';
    }

    // ─── Price Chart ──────────────────────────────────────────────────────────
    renderPriceChart() {
        const data = this.currentData.priceHistory;
        const canvas = document.getElementById('price-chart');
        // Never leave the previous symbol's chart on screen
        if (this.priceChart) { this.priceChart.destroy(); this.priceChart = null; }
        if (!data || !data.length) {
            ['cs-perf', 'cs-cagr', 'cs-vol'].forEach(id => { const el = document.getElementById(id); if (el) { el.textContent = '—'; el.className = 'cs-value'; } });
            return;
        }

        const labels = data.map(d => new Date(d.t).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' }));
        const values = data.map(d => d.c);

        const first = values[0], last = values[values.length - 1];
        const isUp = last >= first;
        const color = isUp ? '#10b981' : '#ef4444';

        // PRU of the position still held, already converted to the quote currency
        const avgPrice = this.currentData.pru?.value ?? null;
        const currency = this.currentData.currency.quote || '';

        // Chart stats — an annualised rate over less than a year is not meaningful
        const perfPct = ((last - first) / first) * 100;
        const years = (data[data.length - 1].t - data[0].t) / YEAR_MS;
        const annualised = years >= MIN_ANNUALISED_YEARS ? cagr(first, last, years) : null;
        const volatility = this.calcVolatility(values, this.calcPeriodsPerYear(data));

        const el = (id) => document.getElementById(id);
        this.setColorValue(el('cs-perf'), `${perfPct >= 0 ? '+' : ''}${perfPct.toFixed(1)}%`, perfPct >= 0);
        if (annualised != null) this.setColorValue(el('cs-cagr'), `${annualised >= 0 ? '+' : ''}${annualised.toFixed(1)}%/an`, annualised >= 0);
        else { el('cs-cagr').textContent = '—'; el('cs-cagr').className = 'cs-value'; }
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
                label: `PRU : ${this.fmt(avgPrice, 2)} ${currency}`,
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
        const canvas = document.getElementById('regression-chart');
        if (this.regressionChart) { this.regressionChart.destroy(); this.regressionChart = null; }
        if (!data || data.length < 4) {
            ['reg-current', 'reg-value', 'reg-slope'].forEach(id => { const el = document.getElementById(id); if (el) { el.textContent = '—'; el.className = 'cs-value'; } });
            return;
        }

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
        const canvas = document.getElementById('sp500-chart');
        if (this.sp500Chart) { this.sp500Chart.destroy(); this.sp500Chart = null; }
        ['sp-diff', 'sp-cagr-stock', 'sp-cagr-sp'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.textContent = '—'; el.className = 'cs-value'; }
        });

        const stock = this.currentData.priceHistory || [];
        const sp500 = this.currentData.sp500History || [];
        if (!stock.length || !sp500.length) return;

        // Same local session dates on both exchanges; skip holidays and open
        // sessions rather than pairing today's stock with yesterday's index.
        const sessions = commonSessions(stock, sp500);
        const pair = normalizePair(sessions.map(d => d.base), sessions.map(d => d.other));
        if (!pair) return;
        const stockNorm = pair.base, sp500Norm = pair.other;

        const lastIdx = stockNorm.length - 1;
        const stockLast = stockNorm[lastIdx], spLast = sp500Norm[lastIdx];
        const years = (sessions[lastIdx].t - sessions[pair.start].t) / YEAR_MS;
        const diff = stockLast - spLast; // points of the base-100 index
        const stockCAGR = years >= MIN_ANNUALISED_YEARS ? cagr(100, stockLast, years) : null;
        const spCAGR = years >= MIN_ANNUALISED_YEARS ? cagr(100, spLast, years) : null;

        const periodLabels = { '1mo': '1M', '3mo': '3M', '6mo': '6M', '1y': '1A', '5y': '5A' };
        const diffLabel = document.getElementById('sp-diff-label');
        if (diffLabel) diffLabel.textContent = `Écart ${periodLabels[this.currentPeriod] || ''}`.trim();

        const pctText = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%/an`;
        this.setColorValue(document.getElementById('sp-diff'), `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} pts`, diff >= 0);
        if (stockCAGR != null) this.setColorValue(document.getElementById('sp-cagr-stock'), pctText(stockCAGR), stockCAGR >= 0);
        if (spCAGR != null) this.setColorValue(document.getElementById('sp-cagr-sp'), pctText(spCAGR), spCAGR >= 0);

        const spLabels = sessions.map(d => new Date(d.session + 'T12:00:00Z').toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' }));
        const stockDataPoints = stockNorm;

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
        const scoreBadge = document.getElementById('stock-score-badge');
        const scoreValue = document.getElementById('stock-score-value');
        const legendEl = document.getElementById('radar-legend');
        if (this.radarChart) { this.radarChart.destroy(); this.radarChart = null; }

        const dimensions = this.currentData.hasFundamentals ? radarDimensions(financial, detail) : null;
        const totalScore = dimensions ? quantScore(dimensions) : null;

        if (totalScore == null) {
            // No statements (ETF, index, crypto) or too few fields: no score at all.
            scoreBadge.style.display = 'none';
            document.getElementById('radar-score-badge').textContent = '—/20';
            canvas.style.display = 'none';
            legendEl.innerHTML = `<div class="valuation-skeleton">Profil quantitatif non applicable : ${this.currentData.hasFundamentals ? 'données fondamentales insuffisantes' : 'cet actif ne publie pas d\'états financiers'}.</div>`;
            return;
        }
        scoreBadge.style.display = '';
        canvas.style.display = '';

        const axes = Object.keys(dimensions);
        const vals = Object.values(dimensions);

        scoreValue.textContent = totalScore.toFixed(1);
        document.getElementById('radar-score-badge').textContent = `${totalScore.toFixed(1)}/20`;
        scoreBadge.style.background = totalScore >= 14
            ? 'linear-gradient(135deg, rgba(16,185,129,0.2), rgba(5,150,105,0.2))'
            : totalScore >= 10
                ? 'linear-gradient(135deg, rgba(245,158,11,0.2), rgba(217,119,6,0.2))'
                : 'linear-gradient(135deg, rgba(239,68,68,0.2), rgba(185,28,28,0.2))';
        scoreValue.style.color = totalScore >= 14 ? '#10b981' : totalScore >= 10 ? '#f59e0b' : '#ef4444';

        legendEl.innerHTML = axes.map((name, i) => `
            <div class="radar-legend-item">
                <span class="radar-legend-name">${name}</span>
                <span class="radar-legend-score">${vals[i] == null ? 'n/d' : `${vals[i].toFixed(1)}/5`}</span>
            </div>
        `).join('');

        this.radarChart = new Chart(canvas.getContext('2d'), {
            type: 'radar',
            data: {
                labels: axes,
                datasets: [{
                    label: this.currentSymbol,
                    data: vals,
                    spanGaps: true,
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
    // Valuation inputs expressed per quoted share, in the price currency (major
    // units). Statement amounts are converted with the real FX rate; anything
    // that cannot be derived from real data is null.
    valuationInputs() {
        const qs = this.currentData.quoteSummary;
        const stats = qs.defaultKeyStatistics || {};
        const fin = qs.financialData || {};
        const detail = qs.summaryDetail || {};
        const { currency, rows } = this.currentData;
        const val = v => (isNum(v?.raw) ? v.raw : null);
        const shares = val(stats.sharesOutstanding);
        const fx = this.finToPrice();
        const perShare = amount => (isNum(amount) && isNum(shares) && shares > 0 && isNum(fx) ? (amount * fx) / shares : null);
        const lastBook = [...rows].reverse().find(r => isNum(r.bookPerShare));

        return {
            currency: currency.priceIso || '',
            price: this.toMajor(val(qs.price?.regularMarketPrice)),
            shares,
            trailingEps: val(stats.trailingEps),
            forwardEps: val(stats.forwardEps),
            trailingPE: val(detail.trailingPE),
            forwardPE: val(detail.forwardPE),
            // Yahoo's bookValue is unreliable when statements use another currency.
            bookPerShare: lastBook && isNum(fx) ? lastBook.bookPerShare * fx : (!currency.needsFx ? val(stats.bookValue) : null),
            fcfPerShare: perShare(val(fin.freeCashflow)),
            ocfPerShare: perShare(val(fin.operatingCashflow)),
            salesPerShare: perShare(val(fin.totalRevenue)),
            revenueGrowth: val(fin.revenueGrowth),
            dividendRate: val(detail.dividendRate),
            fxMissing: currency.needsFx && !isNum(fx),
        };
    }

    renderValuation() {
        const listEl = document.getElementById('valuation-list');
        const valuationDiffEl = document.getElementById('valuation-diff');
        valuationDiffEl.textContent = '—';
        valuationDiffEl.className = 'valuation-diff';

        if (!this.currentData.hasFundamentals) {
            listEl.innerHTML = '<div class="valuation-skeleton">Valorisation non applicable : cet actif ne publie pas d\'états financiers.</div>';
            return;
        }

        const inp = this.valuationInputs();
        const currency = inp.currency;
        const currentPrice = inp.price;
        const items = [];

        // Fixed multiples are explicit hypotheses, not market data: each label says so.
        if (inp.trailingEps > 0) {
            items.push({ label: 'BPA × 18 (hyp.)', value: inp.trailingEps * 18, tooltip: 'BPA des 12 derniers mois × P/E hypothétique de 18' });
        }
        if (inp.forwardEps > 0) {
            items.push({ label: 'BPA estimé × 15 (hyp.)', value: inp.forwardEps * 15, tooltip: 'BPA estimé par les analystes × P/E hypothétique de 15' });
        }
        if (inp.bookPerShare > 0) {
            items.push({ label: 'Val. comptable × 2,5 (hyp.)', value: inp.bookPerShare * 2.5, tooltip: 'Capitaux propres par action × P/B hypothétique de 2,5' });
        }
        if (inp.trailingEps > 0 && inp.bookPerShare > 0) {
            items.push({ label: 'Nombre de Graham', value: Math.sqrt(22.5 * inp.trailingEps * inp.bookPerShare), tooltip: '√(22,5 × BPA × valeur comptable par action)' });
        }
        const dcf = simpleDcf(inp.fcfPerShare, inp.revenueGrowth);
        if (dcf) {
            items.push({
                label: 'DCF simplifié', value: dcf.value,
                tooltip: `Hypothèses : croissance du FCF ${(dcf.growth * 100).toFixed(1)} %/an sur 10 ans (croissance du CA, plafonnée à 20 %), actualisation ${(dcf.discountRate * 100).toFixed(0)} %, croissance terminale ${(dcf.terminalGrowth * 100).toFixed(1)} %`,
            });
        }

        if (!items.length || !isNum(currentPrice)) {
            listEl.innerHTML = `<div class="valuation-skeleton">${inp.fxMissing ? 'Conversion de devise indisponible : valorisation non calculée.' : 'Données insuffisantes pour calculer la valorisation.'}</div>`;
            return;
        }
        items.forEach(i => { i.currency = currency; });

        // Median of the estimates vs current price
        const medianFV = median(items.map(i => i.value).filter(v => v > 0));
        const diffPct = medianFV > 0 ? ((currentPrice - medianFV) / medianFV) * 100 : null;
        if (diffPct != null) {
            valuationDiffEl.textContent = `${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%`;
            valuationDiffEl.className = 'valuation-diff ' + (diffPct <= -10 ? 'positive' : diffPct >= 10 ? 'negative' : '');
            valuationDiffEl.title = 'Écart du cours à la médiane des estimations';
        }

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

        listEl.innerHTML = html + '<p class="valuation-disclaimer">Estimations indicatives fondées sur des hypothèses fixes. Elles ne constituent pas un conseil en investissement.</p>';
    }

    // ─── Period Buttons ───────────────────────────────────────────────────────
    setupPeriodButtons() {
        document.querySelectorAll('.period-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!this.currentData || btn.dataset.period === this.currentPeriod) return;
                document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentPeriod = btn.dataset.period;

                const token = this._loadToken;
                const period = this.currentPeriod;
                const [priceHistory, sp500History] = await Promise.all([
                    this.fetchPriceHistory(this.currentSymbol, period).catch(() => null),
                    this.fetchPriceHistory(SP500_SYMBOL, period).catch(() => null),
                ]);
                // Ignore a response that arrives after another period or symbol was chosen.
                if (token !== this._loadToken || period !== this.currentPeriod || !priceHistory) return;
                this.currentData.priceHistory = priceHistory;
                this.currentData.sp500History = sp500History;
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

    fmt(n, decimals = 0) {
        if (n == null || isNaN(n)) return '—';
        return n.toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }

    // Sign-aware amount with French magnitudes (M = 10⁶, Md = 10⁹). Amounts of
    // 10¹² and more stay in Md ("2 374 Md") to avoid the English/French "billion" ambiguity.
    fmtBig(n, currency = '') {
        if (!isNum(n)) return '—';
        const abs = Math.abs(n);
        let text;
        if (abs >= 1e12) text = this.fmt(n / 1e9, 0) + ' Md';
        else if (abs >= 1e9) text = this.fmt(n / 1e9, 2) + ' Md';
        else if (abs >= 1e6) text = this.fmt(n / 1e6, 2) + ' M';
        else text = this.fmt(n, 0);
        return `${text} ${currency}`.trim();
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
    }

    // Conversion factors, point by point, from the quote currency to `target`.
    // NATIVE keeps the quote currency. XAU goes through USD and the gold future
    // (USD per troy ounce). Returns null when a series is missing: the caller
    // shows the native values and says so, a rate of 1 is never assumed.
    async getConversionArray(target, dataPoints) {
        const quote = this.currentData.currency.quote;
        if (!dataPoints?.length || target === 'NATIVE' || target === quote) return dataPoints.map(() => 1);

        const span = (dataPoints[dataPoints.length - 1].t - dataPoints[0].t) / 86400000;
        const period = span > 3600 ? 'max' : span > 1800 ? '10y' : span > 355 ? '5y' : span > 170 ? '1y' : span > 80 ? '6mo' : span > 25 ? '3mo' : '1mo';

        if (target === 'XAU') {
            const [toUsd, gold] = await Promise.all([
                this.fetchFxSeries(quote, 'USD', period),
                this.fetchPriceHistory('GC=F', period).catch(() => null),
            ]);
            if (!toUsd || !gold?.length) return null;
            const rates = dataPoints.map(d => {
                const usd = toUsd.at(d.t), oz = valueAt(gold, d.t);
                return isNum(usd) && isNum(oz) && oz > 0 ? usd / oz : null;
            });
            return rates.some(r => r == null) ? null : rates;
        }

        const fx = await this.fetchFxSeries(quote, target, period);
        if (!fx) return null;
        const rates = dataPoints.map(d => fx.at(d.t));
        return rates.some(r => r == null) ? null : rates;
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
                    label.textContent = val === 'NATIVE' ? (this.currentData?.currency.quote || 'Native') : val;
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
        if ((kpiType === 'radar' || kpiType === 'valuation') && !this.currentData.hasFundamentals) return;

        // ── CLEAN SWEEP : Reset absolute avant ouverture ───────
        const modalContent = modal.querySelector('.kpi-modal-content');
        if (modalContent) modalContent.classList.remove('radar-mode-layout');

        // Supprimer les résidus du mode radar
        document.querySelector('.radar-analysis-container')?.remove();
        const sidebarContent = document.querySelector('.kpi-modal-sidebar-content');
        if (sidebarContent) sidebarContent.style.display = '';
        document.querySelectorAll('.header-score-badge').forEach(b => b.style.display = 'none');

        this.trendPrice = null;
        this.modalHistory = null;
        this.masterHistoryBuffer = null;

        document.getElementById('kpi-modal-stats').innerHTML = '';
        if (this.modalChart) {
            this.modalChart.destroy();
            this.modalChart = null;
        }

        const qs = this.currentData.quoteSummary;
        const price = qs.price || {};
        const profile = qs.assetProfile || {};
        const currentPrice = price.regularMarketPrice?.raw ?? null;
        const changePct = price.regularMarketChangePercent?.raw ?? null;
        const currency = price.currency || '';

        this.renderLogo(document.getElementById('kpi-modal-logo'), profile, price.longName || price.shortName);

        document.getElementById('kpi-modal-price').textContent = currentPrice != null
            ? this.formatNativeQuote(currentPrice, currency, price.quoteType) : '—';
        this.renderEurCountervalue(
            document.getElementById('kpi-modal-price-eur'),
            document.getElementById('kpi-modal-fx-meta'),
            currentPrice,
            currency,
            price.quoteType,
        );
        const changeEl = document.getElementById('kpi-modal-change');
        const up = (changePct ?? 0) >= 0;
        changeEl.innerHTML = changePct != null
            ? `<i class="fas fa-arrow-${up ? 'up' : 'down'}"></i> ${up ? '+' : ''}${(changePct * 100).toFixed(2)}%`
            : '—';
        changeEl.className = 'kpi-modal-change ' + (up ? 'positive' : 'negative');
        document.getElementById('kpi-modal-ticker').textContent = price.exchangeName
            ? `${price.exchangeName} · ${this.currentSymbol}`
            : this.currentSymbol;

        // The currency selector always starts on the quote currency.
        const nativeOption = document.querySelector('#kpi-currency-options .custom-select-option[data-value="NATIVE"]');
        if (nativeOption) nativeOption.textContent = `${currency} — Devise de cotation`;
        document.getElementById('kpi-currency-select').value = 'NATIVE';
        document.getElementById('kpi-currency-label').textContent = currency || 'Native';
        document.querySelectorAll('#kpi-currency-options .custom-select-option')
            .forEach(o => o.classList.toggle('selected', o.dataset.value === 'NATIVE'));

        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';

        this.currentModalKpi = kpiType;
        this.currentModalPeriod = '10y';
        const token = ++this._modalToken;

        // - 10y weekly buffer for EMA50/EMA200 (50 weeks ≈ 1yr, 200 weeks ≈ 4yr)
        // - max monthly for the long-term trend line
        // - 10y monthly for the initial chart
        const [buffer10ywk, bufferMax, history10y] = await Promise.all([
            this.fetchPriceHistory(this.currentSymbol, '10ywk').catch(() => null),
            this.fetchPriceHistory(this.currentSymbol, 'max').catch(() => null),
            this.fetchPriceHistory(this.currentSymbol, '10y').catch(() => null),
        ]);
        if (token !== this._modalToken) return;

        this.masterHistoryBuffer = buffer10ywk;
        // The modal keeps its own series: the Résumé charts keep their period.
        this.modalHistory = history10y;

        // Long-term trend: semi-log regression of the full monthly history, at the last date.
        if (bufferMax && bufferMax.length > 10) {
            const vals = bufferMax.map(d => d.c);
            const indices = vals.map((_, i) => i);
            const { slope, intercept } = this.linearRegression(indices, vals.map(v => Math.log(v)));
            this.trendPrice = Math.exp(intercept + slope * (indices.length - 1));
        }

        document.querySelectorAll('.kpi-period-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.kpi-period-btn[data-period="10y"]')?.classList.add('active');

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

        const renderToken = ++this._modalToken;
        const targetCurrency = document.getElementById('kpi-currency-select')?.value || 'NATIVE';
        const data = this.modalHistory;
        const usesCurrency = kpiType === 'price' || kpiType === 'regression';

        // Per-point conversion; null when the FX series is missing (values stay native).
        let historicalRates = data && usesCurrency ? await this.getConversionArray(targetCurrency, data) : null;
        if (renderToken !== this._modalToken) return;
        let displayCurrency = targetCurrency === 'NATIVE' ? this.currentData.currency.quote : targetCurrency;
        this.modalConversionFailed = usesCurrency && !!data && historicalRates == null;
        if (this.modalConversionFailed) {
            historicalRates = data.map(() => 1);
            displayCurrency = this.currentData.currency.quote;
        }
        const currentRate = historicalRates ? historicalRates[historicalRates.length - 1] : 1;

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
        if (deviseWrapper) deviseWrapper.style.display = (isPriceMode || isRegression) ? '' : 'none';
        if (divWrapper) divWrapper.style.display = (isPriceMode || isRegression) ? '' : 'none';

        // Render based on type
        switch (kpiType) {
            case 'price':
                this.renderPriceModal(canvas, statsContainer, historicalRates, currentRate, displayCurrency);
                break;
            case 'regression':
                this.renderRegressionModal(canvas, statsContainer, historicalRates, currentRate, displayCurrency);
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
        if (this.modalConversionFailed && usesCurrency) {
            statsContainer.insertAdjacentHTML('beforeend',
                '<div style="width:100%;text-align:right;color:#f59e0b;font-size:12px;padding-top:6px;">Taux de change indisponible : valeurs affichées dans la devise de cotation.</div>');
        }
    }

    renderPriceModal(canvas, statsContainer, historicalRates = null, currentRate = 1, currency = '') {
        const data = this.modalHistory;
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

        if (showFairPrice && this.trendPrice) {
            const trendConverted = this.trendPrice * currentRate;
            const fairPriceLine = new Array(values.length).fill(trendConverted);
            datasets.push({
                label: `Tendance long terme : ${this.fmt(trendConverted, 2)} ${currency}`,
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

        // Values in the displayed currency for the performance summary
        this._modalRawValues = values;
    }

    renderRegressionModal(canvas, statsContainer, historicalRates = null, currentRate = 1, currency = '') {
        const data = this.modalHistory;
        if (!data || data.length < 4) return;

        const model = document.getElementById('kpi-reg-model')?.value || 'semilog';
        const projYears = parseInt(document.getElementById('kpi-proj-years')?.value ?? '2');
        const showBands = document.getElementById('kpi-show-bands');
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
            const ptsPerYear = (n - 1) / spanYears;
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
        const benchmarkTicker = document.getElementById('kpi-comp-benchmark')?.value || '^GSPC';
        const benchmarkLabel = document.getElementById('kpi-comp-benchmark-label')?.textContent || 'S&P 500';
        const period = this.currentModalPeriod;
        const token = this._modalToken;
        const stockData = await this.fetchPriceHistory(this.currentSymbol, period, { daily: true }).catch(() => null);
        if (token !== this._modalToken) return;

        let benchmarkData = this._cachedBenchmarkData?.[benchmarkTicker]?.[period];
        if (!benchmarkData) {
            benchmarkData = await this.fetchPriceHistory(benchmarkTicker, period, { daily: true }).catch(() => null);
            if (token !== this._modalToken) return;
            if (benchmarkData) {
                if (!this._cachedBenchmarkData[benchmarkTicker]) this._cachedBenchmarkData[benchmarkTicker] = {};
                this._cachedBenchmarkData[benchmarkTicker][period] = benchmarkData;
            }
        }

        if (!stockData?.length || !benchmarkData?.length) {
            statsContainer.innerHTML = '<p style="color:#64748b;padding:16px">Données de comparaison indisponibles.</p>';
            return;
        }

        // The offered benchmarks are price indices/futures, not total-return
        // series. Compare unadjusted closes on common completed session dates.
        const sessions = commonSessions(stockData, benchmarkData);
        const pair = normalizePair(sessions.map(d => d.base), sessions.map(d => d.other));
        if (!pair) {
            statsContainer.innerHTML = '<p style="color:#64748b;padding:16px">Aucune date commune entre les deux séries.</p>';
            return;
        }
        const stockNorm = pair.base;
        const benchmarkNorm = pair.other;
        const labels = sessions.map(d => new Date(d.session + 'T12:00:00Z').toLocaleDateString('fr-FR'));

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
                            callback: v => v.toFixed(0)
                        }
                    }
                }
            }
        });

        // Comparison stats over the common window (both series share the stock's dates).
        const last = stockNorm.length - 1;
        const stockPerf = stockNorm[last] - 100;
        const benchmarkPerf = benchmarkNorm[last] - 100;
        const diff = stockPerf - benchmarkPerf;
        const years = (sessions[last].t - sessions[pair.start].t) / YEAR_MS;
        const stockCAGR = years >= MIN_ANNUALISED_YEARS ? cagr(100, stockNorm[last], years) : null;
        const benchmarkCAGR = years >= MIN_ANNUALISED_YEARS ? cagr(100, benchmarkNorm[last], years) : null;
        const fmtCagr = v => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

        if (statsContainer) {
            const diffColor = diff >= 0 ? '#10b981' : '#ef4444';
            statsContainer.style.cssText = 'display:flex;justify-content:flex-end;padding:8px 4px 0;width:100%;box-sizing:border-box;';
            statsContainer.innerHTML = `
                <div style="display:inline-flex;align-items:center;gap:10px;padding:6px 14px;border-radius:8px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);font-size:13px;font-weight:600;white-space:nowrap;max-width:100%;overflow:hidden;">
                    <span style="color:${diffColor}">Écart ${diff >= 0 ? '+' : ''}${diff.toFixed(2)} pts</span>
                    <span style="color:#334155">|</span>
                    <span style="color:#e2e8f0">CAGR ${escHtml(this.currentSymbol)} ${fmtCagr(stockCAGR)}</span>
                    <span style="color:#334155">|</span>
                    <span style="color:#94a3b8">CAGR ${escHtml(benchmarkLabel)} ${fmtCagr(benchmarkCAGR)}</span>
                    <span style="color:#334155">|</span>
                    <span style="color:#64748b">Base 100 · hors dividendes · devises de cotation</span>
                </div>
            `;
        }
    }

    renderRadarModal(canvas, statsContainer) {
        const qs = this.currentData.quoteSummary;
        if (!qs) return;

        const financial = qs.financialData || {};
        const detail = qs.summaryDetail || {};

        const dimensions = radarDimensions(financial, detail);
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
        const domain = this.safeWebsite(qs.assetProfile?.website)?.hostname.replace(/^www\./, '');

        if (logoEl) {
            logoEl.setAttribute('style', 'display: flex !important; align-items: center !important; gap: 20px !important; width: 100% !important; justify-content: center !important; margin-bottom: 32px !important; z-index: 2; position: relative;');
            logoEl.innerHTML = `
                ${domain ? `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128"
                     style="width: 72px; height: 72px; border-radius: 20px; background: rgba(255,255,255,0.04); padding: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08);">` : ''}
                <div style="display: flex; flex-direction: column; align-items: flex-start; justify-content: center;">
                    <span style="font-size: 26px; font-weight: 800; color: #f8fafc; line-height: 1.1; letter-spacing: 0.5px;">${escHtml(this.currentSymbol)}</span>
                    <span style="font-size: 15px; color: #94a3b8; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; margin-top: 4px;">
                        ${escHtml(assetName)}
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
                    spanGaps: true,
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

        const score = quantScore(dimensions);

        // ── Injection du score et titre dans le header sidebar ──
        const sidebarHeader = document.querySelector('.kpi-modal-sidebar-header');
        if (sidebarHeader) {
            const titleEl = sidebarHeader.querySelector('h3');
            if (titleEl) titleEl.textContent = 'Diagnostic Fondamental';

            let badge = sidebarHeader.querySelector('.header-score-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'header-score-badge';
                const closeBtn = sidebarHeader.querySelector('.kpi-modal-close');
                if (closeBtn) sidebarHeader.insertBefore(badge, closeBtn);
                else sidebarHeader.appendChild(badge);
            }
            badge.innerHTML = `${score == null ? '—' : score.toFixed(1)} <span>/20</span>`;
            badge.style.display = 'flex';
        }

        const sidebar = document.querySelector('.kpi-modal-sidebar');
        let analysisEl = sidebar?.querySelector('.radar-analysis-container');
        if (!analysisEl && sidebar) {
            analysisEl = document.createElement('div');
            analysisEl.className = 'radar-analysis-container';
            sidebar.appendChild(analysisEl);
        }
        if (!analysisEl) return;

        // Every row is a Yahoo field shown as is; the bar is derived from that
        // value against a reference level (null → no bar colouring).
        const v = x => (isNum(x?.raw) ? x.raw : null);
        const pct = x => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
        const dec = (x, d = 2) => (x == null ? '—' : x.toFixed(d));
        const against = (x, reference) => (x == null ? null : (x / reference) * 5);
        const lowerIsBetter = (x, worst) => (x == null ? null : 5 - (x / worst) * 5);
        const finCur = this.currentData.currency.finIso || '';
        const fcf = v(financial.freeCashflow), revenue = v(financial.totalRevenue);
        const fcfMargin = isNum(fcf) && isNum(revenue) && revenue > 0 ? fcf / revenue : null;
        const payout = v(detail.payoutRatio);
        const fiveYearYield = v(detail.fiveYearAvgDividendYield); // already in %
        const dividendYield = v(detail.dividendYield);

        const cards = [
            ['Retours', [
                ['ROE', pct(v(financial.returnOnEquity)), against(v(financial.returnOnEquity), 0.25)],
                ['ROA', pct(v(financial.returnOnAssets)), against(v(financial.returnOnAssets), 0.12)],
            ]],
            ['Marges', [
                ['Marge brute', pct(v(financial.grossMargins)), against(v(financial.grossMargins), 0.6)],
                ['Marge opé.', pct(v(financial.operatingMargins)), against(v(financial.operatingMargins), 0.3)],
                ['Marge nette', pct(v(financial.profitMargins)), against(v(financial.profitMargins), 0.2)],
            ]],
            ['Croissance', [
                ['CA (sur 1 an)', pct(v(financial.revenueGrowth)), against(v(financial.revenueGrowth), 0.2)],
                ['Bénéfices (sur 1 an)', pct(v(financial.earningsGrowth)), against(v(financial.earningsGrowth), 0.25)],
                ['BPA estimé', dec(v(qs.defaultKeyStatistics?.forwardEps)), null],
            ]],
            ['Rentabilité', [
                ['Marge nette', pct(v(financial.profitMargins)), against(v(financial.profitMargins), 0.2)],
                ['Marge opé.', pct(v(financial.operatingMargins)), against(v(financial.operatingMargins), 0.3)],
                ['ROE', pct(v(financial.returnOnEquity)), against(v(financial.returnOnEquity), 0.25)],
            ]],
            ['Dividende', [
                ['Rendement', pct(dividendYield), against(dividendYield, 0.04)],
                ['Payout', pct(payout), payout == null ? null : payout <= 0.7 ? 4.5 : payout <= 1 ? 3 : 1],
                ['Moyenne 5 ans', fiveYearYield == null ? '—' : `${fiveYearYield.toFixed(2)}%`, against(fiveYearYield, 4)],
            ]],
            ['Santé', [
                ['Liquidité (ratio courant)', dec(v(financial.currentRatio)), against(v(financial.currentRatio), 2)],
                ['Dette / capitaux propres', v(financial.debtToEquity) == null ? '—' : `${v(financial.debtToEquity).toFixed(0)}%`, lowerIsBetter(v(financial.debtToEquity), 250)],
            ]],
        ];

        const badgeFor = axis => {
            const s = dimensions[axis];
            return `<span style="margin-left: auto; background: rgba(99,102,241,0.15); color: #818cf8; padding: 3px 8px; border-radius: 6px; font-size: 11px;">${s == null ? 'n/d' : `${s.toFixed(1)}/5`}</span>`;
        };
        const cardHtml = (title, rows, badge = '') => `
                <div class="analysis-card">
                    <h5>${title} ${badge}</h5>
                    ${rows.map(([label, value, s]) => this.renderAnalysisRow(label, value, s)).join('')}
                </div>`;

        analysisEl.innerHTML = `
            <div class="analysis-grid">
                ${cards.map(([axis, rows]) => cardHtml(axis, rows, badgeFor(axis))).join('')}
                ${cardHtml('Flux de trésorerie', [
                    ['Flux d\'exploitation', this.fmtBig(v(financial.operatingCashflow), finCur), null],
                    ['Free Cash Flow', this.fmtBig(fcf, finCur), null],
                    ['Marge FCF', pct(fcfMargin), against(fcfMargin, 0.25)],
                ])}
            </div>
        `;
    }

    renderAnalysisRow(label, value, score) {
        const hasScore = isNum(score);
        const barWidth = hasScore ? Math.min(100, Math.max(2, score * 20)) : 0;
        const barColor = !hasScore ? '#94a3b8' : score >= 4 ? '#10b981' : score >= 2.5 ? '#f59e0b' : '#ef4444';
        return `
            <div class="analysis-row">
                <div class="analysis-row-top">
                    <span class="row-label">${label}</span>
                    <span class="row-value" style="color:${hasScore ? barColor : '#e2e8f0'}">${value}</span>
                </div>
                ${hasScore ? `<div class="row-bar-bg"><div class="row-bar-fill" style="width:${barWidth}%; background:${barColor}"></div></div>` : ''}
            </div>
        `;
    }

    // ─── Fair-price calculator (shared by the Valorisation tab and modal) ──────
    // Real inputs only: per-share metric from the last reported period, growth
    // from the reported history, multiple from the historical median. Missing
    // values leave the field empty for the user to fill, never a default.
    calculatorInputs(metricType) {
        const inp = this.valuationInputs();
        const long = this.currentData.priceHistoryLong || [];
        const hist = historicalMultiples(
            this.currentData.rows,
            t => this.toMajor(dailyCloseAt(long, t)),
            t => this.finToPrice(t),
        );
        const isFcf = metricType === 'fcf';
        const histPoints = hist
            .map(h => ({ year: Number(h.year), endTs: h.endTs, value: isFcf ? h.fcfPerShare : h.epsPerShare }))
            .filter(p => isNum(p.value));

        const positive = histPoints.filter(p => p.value > 0);
        let autoGrowth = null;
        if (positive.length >= 2) {
            const first = positive[0], last = positive[positive.length - 1];
            const g = cagr(first.value, last.value, (last.endTs - first.endTs) / YEAR_MS);
            autoGrowth = g == null ? null : g / 100;
        }
        const medianMultiple = median(hist.map(h => (isFcf ? h.pfcf : h.pe)));
        const baseMetric = isFcf ? inp.fcfPerShare : inp.trailingEps;
        const currentMultiple = isFcf
            ? (baseMetric > 0 && isNum(inp.price) ? inp.price / baseMetric : null)
            : inp.trailingPE;

        return {
            ...inp,
            metricType,
            metricLabel: isFcf ? 'FCF/action' : 'BPA',
            multipleLabel: isFcf ? 'P/FCF' : 'P/E',
            baseMetric: baseMetric > 0 ? baseMetric : null,
            histPoints,
            autoGrowth,
            medianMultiple,
            currentMultiple,
            defaultMultiple: medianMultiple ?? currentMultiple,
            historyYears: hist.length,
            shareBasisUnknown: this.currentData.shareBasis === null,
        };
    }

    // Fills the untouched inputs from real data, then reads the parameters.
    readCalculator(prefix, calc) {
        const byId = id => document.getElementById(`${prefix}-${id}`);
        const growthInput = byId('growth'), multipleInput = byId('multiple');
        if (growthInput && !growthInput._userSet) growthInput.value = calc.autoGrowth != null ? (calc.autoGrowth * 100).toFixed(2) : '';
        if (multipleInput && !multipleInput._userSet) multipleInput.value = calc.defaultMultiple != null ? calc.defaultMultiple.toFixed(2) : '';

        const gh = byId('growth-hint'), mh = byId('multiple-hint');
        if (gh) gh.textContent = calc.autoGrowth != null
            ? `${calc.historyYears} exercices publiés : ${(calc.autoGrowth * 100).toFixed(1)} %/an`
            : calc.shareBasisUnknown ? 'Base par titre coté non confirmée : croissance à saisir' : 'Historique insuffisant, à saisir';
        if (mh) mh.textContent = calc.medianMultiple != null
            ? `Médiane historique ${calc.multipleLabel} : ${calc.medianMultiple.toFixed(1)}`
            : calc.currentMultiple != null ? `${calc.multipleLabel} actuel : ${calc.currentMultiple.toFixed(1)}` : 'À saisir';

        const parse = el => { const x = parseFloat(el?.value); return Number.isFinite(x) ? x : null; };
        const growth = parse(growthInput), multiple = parse(multipleInput), target = parse(byId('target-return'));
        const params = {
            baseMetric: calc.baseMetric,
            growthRate: growth == null ? null : growth / 100,
            multiple,
            targetReturn: target == null ? null : target / 100,
            dividendRate: calc.dividendRate,
            includeDividends: byId('include-div')?.checked ?? true,
            currentPrice: calc.price,
        };
        const result = fairPriceModel(params);
        let missing = null;
        if (calc.fxMissing) missing = 'Conversion de devise indisponible.';
        else if (calc.baseMetric == null) missing = `${calc.metricLabel} indisponible ou négatif : prix juste non calculable.`;
        else if (!result) missing = 'Hypothèses invalides : croissance et rendement cible supérieurs à −100 %, métrique et multiple positifs ; résultat fini requis.';
        [growthInput, multipleInput, byId('target-return')].forEach(el => el?.setAttribute('aria-invalid', String(!result)));
        return { params, result, missing, growthInput, multipleInput };
    }

    calculatorHeaderHtml({ result, missing }, currency) {
        if (!result) return `<div class="kpi-val-kpi"><span class="kpi-val-kpi-label">Prix juste</span><span class="kpi-val-kpi-value neutral">—</span><span class="kpi-val-hint">${escHtml(missing || '')}</span></div>`;
        const signed = v => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
        const cls = v => (v == null ? '' : v >= 0 ? 'positive' : 'negative');
        return `
            <div class="kpi-val-kpi">
                <span class="kpi-val-kpi-label">Prix juste</span>
                <span class="kpi-val-kpi-value neutral">${this.fmt(result.fairPrice, 2)} ${currency}</span>
            </div>
            <div class="kpi-val-kpi">
                <span class="kpi-val-kpi-label">Rendement estimé</span>
                <span class="kpi-val-kpi-value ${cls(result.estReturn)}">${signed(result.estReturn)}/an</span>
            </div>
            <div class="kpi-val-kpi">
                <span class="kpi-val-kpi-label">Marge de sécurité</span>
                <span class="kpi-val-kpi-value ${cls(result.safetyMargin)}">${signed(result.safetyMargin)}</span>
            </div>`;
    }

    resetCalculatorInputs() {
        ['val-tab', 'kpi-val'].forEach(prefix => {
            ['growth', 'multiple'].forEach(id => {
                const el = document.getElementById(`${prefix}-${id}`);
                if (el) { el._userSet = false; el.value = ''; }
            });
        });
    }

    async renderValuationModal(canvas, statsContainer) {
        const token = this._modalToken;
        await this.getLongHistory();
        if (token !== this._modalToken) return;

        const metricType = document.getElementById('kpi-val-metric')?.value || 'fcf';
        const calc = this.calculatorInputs(metricType);
        const calcState = this.readCalculator('kpi-val', calc);
        const { growthInput, multipleInput } = calcState;
        const currency = calc.currency;
        this.renderValuationChart(canvas, calc, calcState);
        statsContainer.innerHTML = `<div class="kpi-val-header">${this.calculatorHeaderHtml(calcState, currency)}</div>
            <p class="valuation-disclaimer">Modèle indicatif : ${calc.metricLabel} projeté × multiple final, actualisé au rendement cible. Ne constitue pas un conseil en investissement.</p>`;

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

                const token = this._modalToken;
                const newPriceHistory = await this.fetchPriceHistory(this.currentSymbol, period).catch(() => null);
                if (token !== this._modalToken || period !== this.currentModalPeriod) return;
                if (newPriceHistory) {
                    this.modalHistory = newPriceHistory;
                    await this.renderKpiModalContent(this.currentModalKpi);
                }
            });
        });
    }

    updateModalBottomStats() {
        const statsContainer = document.getElementById('kpi-modal-stats');
        if (!statsContainer) return;

        const values = this._modalRawValues || this.modalHistory?.map(d => d.c);
        const data = this.modalHistory;
        if (!values || values.length === 0 || !data) return;

        const first = values[0];
        const last = values[values.length - 1];
        if (!first || !last) return;

        const perf = ((last - first) / first * 100);
        const years = (data[data.length - 1].t - data[0].t) / YEAR_MS;
        // Annualised only over at least one year
        const annualised = years >= MIN_ANNUALISED_YEARS ? cagr(first, last, years) : null;

        const indices = values.map((_, i) => i);
        const logVals = values.map(v => Math.log(Math.max(v, 0.0001)));
        const { r2 } = this.linearRegression(indices, logVals);

        const sign = perf >= 0 ? '+' : '';
        const perfColor = perf >= 0 ? '#10b981' : '#ef4444';
        const cagrText = annualised == null ? '—' : `${annualised >= 0 ? '+' : ''}${annualised.toFixed(2)}%`;
        const cagrColor = annualised == null ? '#94a3b8' : annualised >= 0 ? '#10b981' : '#ef4444';

        statsContainer.style.cssText = 'display:flex;justify-content:flex-end;padding:8px 4px 0;width:100%;box-sizing:border-box;';
        statsContainer.innerHTML = `
            <div style="display:inline-flex;align-items:center;gap:10px;padding:6px 14px;border-radius:8px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);font-size:13px;font-weight:600;white-space:nowrap;max-width:100%;overflow:hidden;">
                <span style="color:${perfColor}">${sign}${perf.toFixed(2)}%</span>
                <span style="color:#334155">|</span>
                <span style="color:${cagrColor}">CAGR ${cagrText}</span>
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
        if (!canvas || !header || !this.currentData?.hasFundamentals) return;

        const token = this._loadToken;
        await this.getLongHistory();
        if (token !== this._loadToken) return;

        const metricType = document.getElementById('val-tab-metric')?.value || 'fcf';
        const calc = this.calculatorInputs(metricType);
        const calcState = this.readCalculator('val-tab', calc);
        const currency = calc.currency;
        this.renderValuationChart(canvas, calc, calcState);
        header.innerHTML = this.calculatorHeaderHtml(calcState, currency);
        this.renderValuationDashboard(calc);
    }

    getMonthName(index) {
        const months = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
        return months[index % 12];
    }

    // One timeline shared by the modal and tab: discounted value is at today;
    // the undiscounted terminal price is at today + ten years, not January 1.
    renderValuationChart(canvas, calc, state) {
        const now = Date.now();
        const start = new Date(now);
        const years = 10;
        const { result, params } = state;
        const currency = calc.currency;
        const future = Array.from({ length: years + 1 }, (_, i) => {
            const date = new Date(start);
            date.setUTCFullYear(start.getUTCFullYear() + i);
            return date.getTime();
        });
        const point = (x, y) => ({ x, y });
        const history = monthlyCloses(this.currentData.priceHistoryLong || [])
            .filter(p => p.t >= now - 5 * YEAR_MS)
            .map(p => point(p.t, this.toMajor(p.c)));
        const projected = result ? future.map((t, i) => point(t, calc.baseMetric * Math.pow(1 + params.growthRate, i))) : [];
        const datasets = [
            { label: `${calc.metricLabel} publié`, data: calc.histPoints.map(p => point(p.endTs, p.value)), borderColor: '#eab308', yAxisID: 'metric', pointRadius: 4 },
            { label: `${calc.metricLabel} projeté`, data: projected, borderColor: '#eab308', borderDash: [5, 5], yAxisID: 'metric' },
            { label: 'Cours', data: history, borderColor: '#3b82f6', yAxisID: 'price', pointRadius: 0 },
            { label: 'Prix actuel', data: isNum(calc.price) ? [point(now, calc.price)] : [], backgroundColor: '#60a5fa', yAxisID: 'price', pointRadius: 6 },
            { label: 'Prix juste actuel (actualisé)', data: result ? [point(now, result.fairPrice)] : [], backgroundColor: '#10b981', yAxisID: 'price', pointRadius: 8 },
            { label: 'Prix terminal à 10 ans (non actualisé)', data: result ? [point(future[years], result.terminalPrice)] : [], backgroundColor: '#f97316', yAxisID: 'price', pointRadius: 8 },
        ];
        const property = canvas.id === 'valuation-tab-chart' ? 'valuationTabChart' : 'modalChart';
        this[property]?.destroy();
        this[property] = new Chart(canvas.getContext('2d'), {
            type: 'line', data: { datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { display: true, labels: { color: '#94a3b8', font: { size: 11 } } },
                    tooltip: { callbacks: {
                        title: items => items.length ? new Date(items[0].parsed.x).toLocaleDateString('fr-FR') : '',
                        label: item => `${item.dataset.label} : ${this.fmt(item.parsed.y, 2)} ${currency}`,
                    } },
                },
                scales: {
                    x: { type: 'linear', ticks: { color: '#94a3b8', maxTicksLimit: 10, callback: t => new Date(t).getUTCFullYear() } },
                    price: { position: 'left', title: { display: true, text: `Prix (${currency})`, color: '#94a3b8' }, ticks: { color: '#94a3b8' } },
                    metric: { position: 'right', title: { display: true, text: `${calc.metricLabel} (${currency})`, color: '#eab308' }, grid: { drawOnChartArea: false }, ticks: { color: '#eab308' } },
                },
            },
        });
    }

    // Lower grid of the Valorisation tab — every series comes from the reported
    // statements and the real closing prices.
    renderValuationDashboard(calc) {
        const qs = this.currentData.quoteSummary;
        if (!qs) return;

        if (this.valGridCharts) this.valGridCharts.forEach(c => c.destroy());
        this.valGridCharts = [];

        const currency = calc.currency;
        const long = this.currentData.priceHistoryLong || [];
        const hist = historicalMultiples(this.currentData.rows, t => this.toMajor(dailyCloseAt(long, t)), t => this.finToPrice(t));
        const years = hist.map(h => h.year);
        const ratio = (price, perShare) => (isNum(price) && isNum(perShare) && perShare > 0 ? price / perShare : null);
        const stats = qs.defaultKeyStatistics || {};

        // 1. Métriques clés (TTM, price currency)
        const metricsList = document.getElementById('val-metrics-list');
        if (metricsList) {
            const medianPe = median(hist.map(h => h.pe));
            const metrics = [
                { label: 'P/E', val: calc.trailingPE, sub: medianPe != null ? `Médiane ${hist.length} ans : ${medianPe.toFixed(1)}` : 'BPA 12 mois' },
                { label: 'Forward P/E', val: calc.forwardPE, sub: 'BPA estimé' },
                { label: 'PEG Ratio', val: stats.pegRatio?.raw ?? null, sub: 'Yahoo Finance' },
                { label: 'P/FCF', val: ratio(calc.price, calc.fcfPerShare), sub: 'FCF 12 mois' },
                { label: 'P/OCF', val: ratio(calc.price, calc.ocfPerShare), sub: 'Flux d\'exploitation 12 mois' },
                { label: 'P/S', val: ratio(calc.price, calc.salesPerShare), sub: 'CA 12 mois' },
                { label: 'P/B', val: ratio(calc.price, calc.bookPerShare), sub: 'Dernier bilan annuel' },
                { label: 'Rendement', val: isNum(qs.summaryDetail?.dividendYield?.raw) ? qs.summaryDetail.dividendYield.raw * 100 : 0, sub: 'Dividende annuel / cours', isPercent: true },
            ];
            metricsList.innerHTML = metrics.map(m => {
                const value = !isNum(m.val) ? '—' : m.isPercent ? `${m.val.toFixed(2)}%` : m.val.toFixed(2);
                return `
                    <div class="val-metric-item">
                        <span class="val-metric-label">${m.label}</span>
                        <span class="val-metric-value${isNum(m.val) && m.val < 0 ? ' negative' : ''}">${value}</span>
                        <span class="val-metric-sub">${m.sub}</span>
                    </div>
                `;
            }).join('');
        }

        // 2. FCF / action publié, par exercice
        this.renderQuantBarChart('chart-val-fcf-ps', 'FCF/action', years, hist.map(h => h.fcfPerShare), '#eab308', null, currency);

        // 3. Régression semi-log sur les clôtures mensuelles des 5 dernières années
        const since = Date.now() - 5 * YEAR_MS;
        const monthly = monthlyCloses(long).filter(d => d.t >= since && d.c > 0);
        if (monthly.length >= 4) {
            const idx = monthly.map((_, i) => i);
            const { slope, intercept } = this.linearRegression(idx, monthly.map(d => Math.log(d.c)));
            this.renderQuantLineChart('chart-val-regression', [
                { label: 'Cours', data: monthly.map(d => this.toMajor(d.c)), color: '#3b82f6' },
                { label: 'Régression', data: idx.map(i => this.toMajor(Math.exp(intercept + slope * i))), color: '#fbbf24' },
            ], monthly.map(d => new Date(d.t).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' })), null, ' ' + currency, { pointRadius: 0 });
        } else {
            this.renderQuantLineChart('chart-val-regression', [], [], null, '');
        }

        // 4. P/E sur les BPA estimés par les analystes
        const estimates = forwardEstimates(qs, calc.price, code => this.rateToPrice(code));
        this.renderQuantBarChart('chart-val-forward-pe', 'P/E estimé', estimates.map(e => e.label), estimates.map(e => e.pe), ['#f97316', '#3b82f6'], null, 'x');

        // 5–8. Multiples historiques à la clôture de chaque exercice
        this.renderQuantLineChart('chart-val-pe', [{ label: 'P/E', data: hist.map(h => h.pe), color: '#3b82f6' }], years, null, 'x');
        this.renderQuantLineChart('chart-val-pfcf', [{ label: 'P/FCF', data: hist.map(h => h.pfcf), color: '#3b82f6' }], years, null, 'x');
        this.renderQuantLineChart('chart-val-pocf', [{ label: 'P/OCF', data: hist.map(h => h.pocf), color: '#3b82f6' }], years, null, 'x');
        this.renderQuantLineChart('chart-val-ps', [{ label: 'P/S', data: hist.map(h => h.ps), color: '#3b82f6' }], years, null, 'x');

    }

    async renderQuantitativeTab() {
        const qs = this.currentData.quoteSummary;
        if (!qs) return;

        if (this.quantCharts) this.quantCharts.forEach(c => c.destroy());
        this.quantCharts = [];

        const fundamentals = this.currentData.fundamentals || [];
        const hasHistory = this.currentData.hasFundamentals && fundamentals.length >= 2;
        const emptyEl = document.getElementById('quant-empty');
        const gridEl = document.getElementById('quant-grid');
        if (emptyEl) emptyEl.style.display = hasHistory ? 'none' : 'block';
        if (gridEl) gridEl.style.display = hasHistory ? '' : 'none';
        if (!hasHistory) return;

        // Statements are shown in their reporting currency.
        const currency = this.currentData.currency.finIso || '';
        const years = fundamentals.map(y => y.year);
        const field = key => fundamentals.map(y => (isNum(y[key]) ? y[key] : null));
        const ratio = (num, den) => fundamentals.map(y => (isNum(y[num]) && isNum(y[den]) && y[den] !== 0 ? (y[num] / y[den]) * 100 : null));
        this.setQuantCurrencyNote(currency);

        this.renderQuantBarChart('chart-revenue', 'Revenus', years, field('annualTotalRevenue'), '#3b82f6', 'footer-revenue', currency);
        this.renderQuantBarChart('chart-earnings', 'Bénéfices', years, field('annualNetIncome'), '#fbbf24', 'footer-earnings', currency);
        this.renderQuantGroupedBarChart('chart-fcf', years, [
            { label: 'Opérationnel', data: field('annualOperatingCashFlow'), color: '#f97316' },
            { label: 'Free Cash Flow', data: field('annualFreeCashFlow'), color: '#fbbf24' }
        ], 'footer-fcf', currency, 1);

        // Margins: null when revenue is missing or zero for a year
        this.renderQuantLineChart('chart-margins', [
            { label: 'Brute', data: ratio('annualGrossProfit', 'annualTotalRevenue'), color: '#3b82f6' },
            { label: 'Opé.', data: ratio('annualOperatingIncome', 'annualTotalRevenue'), color: '#fbbf24' },
            { label: 'Nette', data: ratio('annualNetIncome', 'annualTotalRevenue'), color: '#ef4444' }
        ], years, 'footer-margins', '%');

        this.renderQuantGroupedBarChart('chart-returns', years, [
            { label: 'ROE', data: ratio('annualNetIncome', 'annualStockholdersEquity'), color: '#8b5cf6' },
            { label: 'ROA', data: ratio('annualNetIncome', 'annualTotalAssets'), color: '#10b981' }
        ], null, '%');

        this.renderQuantGroupedBarChart('chart-cash-debt', years, [
            { label: 'Trésorerie', data: field('annualCashAndCashEquivalents'), color: '#10b981' },
            { label: 'Dette', data: field('annualTotalDebt'), color: '#ef4444' }
        ], null, currency);

        // Dividend per share: dividends paid ÷ average shares (per quoted share)
        const dps = this.currentData.rows.map(r => r.dividendPerShare);
        this.renderQuantBarChart('chart-dividend', 'Dividende / action (estimé)', years, dps.some(v => v > 0) ? dps : [], '#14b8a6', 'footer-dividend', currency);

        this.renderQuantGroupedBarChart('chart-shares', years, [
            { label: 'De base', data: field('annualBasicAverageShares'), color: '#8b5cf6' },
            { label: 'Diluées', data: field('annualDilutedAverageShares'), color: '#a78bfa' }
        ], 'footer-shares', '', 0);

        this.renderQuantBarChart('chart-capex', 'CAPEX', years,
            fundamentals.map(y => (isNum(y.annualCapitalExpenditure) ? Math.abs(y.annualCapitalExpenditure) : null)),
            '#ec4899', 'footer-capex', currency);
    }

    setQuantCurrencyNote(currency) {
        const note = document.getElementById('quant-currency-note');
        if (note) note.textContent = (currency ? `Montants publiés en ${currency}, par exercice fiscal (source : Yahoo Finance).` : '')
            + (this.currentData.shareBasis === null ? ' Base par titre coté non confirmée : les historiques par action cotée sont indisponibles.' : '');
    }

    // ─── Dividende Tab ────────────────────────────────────────────────────────
    async renderDividendeTab() {
        this.dividendCharts.forEach(chart => chart.destroy());
        this.dividendCharts = [];
        const qs = this.currentData.quoteSummary;
        if (!qs) return;

        const quoteCurrency = this.currentData.currency.quote || '';
        const priceCurrency = this.currentData.currency.priceIso || '';
        const finCurrency = this.currentData.currency.finIso || '';
        const detail = qs.summaryDetail || {};
        const fundamentals = this.currentData.fundamentals || [];
        const hasFundamentals = this.currentData.hasFundamentals && fundamentals.length >= 2;

        // dividendYield first: the trailing yield mixes currencies for ADRs
        const divYield = (detail.dividendYield?.raw ?? detail.trailingAnnualDividendYield?.raw ?? 0) * 100;
        const divRate = detail.dividendRate?.raw
            ?? (!this.currentData.currency.needsFx ? detail.trailingAnnualDividendRate?.raw : null)
            ?? null;
        const payoutRatioCurrent = detail.payoutRatio?.raw ?? null;

        const dpsSeries = hasFundamentals ? this.currentData.rows.map(r => r.dividendPerShare) : [];
        const hasDividendHistory = dpsSeries.some(v => v > 0);
        const hasAnyDividend = hasDividendHistory || divYield > 0 || divRate > 0;

        const emptyEl = document.getElementById('dividende-empty');
        const contentEl = document.getElementById('dividende-content');
        if (emptyEl) emptyEl.style.display = hasAnyDividend ? 'none' : 'block';
        if (contentEl) contentEl.style.display = hasAnyDividend ? '' : 'none';
        if (!hasAnyDividend) return;

        const el = (id) => document.getElementById(id);
        if (el('div-kpi-yield')) el('div-kpi-yield').textContent = divYield ? `${divYield.toFixed(2)}%` : '—';
        if (el('div-kpi-rate')) el('div-kpi-rate').textContent = divRate ? `${this.fmt(divRate, 2)} ${priceCurrency}` : '—';
        if (el('div-kpi-payout')) el('div-kpi-payout').textContent = payoutRatioCurrent != null ? `${(payoutRatioCurrent * 100).toFixed(1)}%` : '—';

        // Dividend growth: from the first paying fiscal year to the last one
        let cagrText = '—';
        if (hasDividendHistory) {
            const firstIdx = dpsSeries.findIndex(v => v > 0);
            const lastIdx = dpsSeries.length - 1;
            const years = (this.currentData.rows[lastIdx].endTs - this.currentData.rows[firstIdx].endTs) / YEAR_MS;
            const growth = cagr(dpsSeries[firstIdx], dpsSeries[lastIdx], Math.round(years));
            if (growth != null) cagrText = `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%/an`;
        }
        if (el('div-kpi-cagr')) el('div-kpi-cagr').textContent = cagrText;

        // Chart 1: real per-payment history via events=div (same technique as DividendManager)
        const token = this._loadToken;
        let payments = [];
        try {
            const payHistUrl = `${PROXY}?symbol=${encodeURIComponent(this.currentSymbol)}&type=STOCK&range=10y&interval=1d&events=div`;
            const payData = await this.safeFetchJson(payHistUrl);
            if (token !== this._loadToken) return;
            const events = payData?.chart?.result?.[0]?.events?.dividends;
            payments = events
                ? Object.keys(events).map(ts => ({ ts: parseInt(ts, 10), amount: events[ts].amount })).sort((a, b) => a.ts - b.ts)
                : [];
        } catch (err) {
            if (token !== this._loadToken) return;
            logger.error('[Dividende] payment history failed:', err);
        }
        const payLabels = payments.map(p => new Date(p.ts * 1000).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }));
        this.renderQuantBarChart('chart-dividend-payments', 'Versement / action', payLabels, payments.map(p => p.amount), '#14b8a6', null, quoteCurrency);

        // Chart 2: annual dividend per share (dividends paid ÷ average shares)
        this.renderQuantBarChart('chart-dividend-annual', 'Dividende / action (estimé)',
            fundamentals.map(y => y.year), hasDividendHistory ? dpsSeries : [], '#14b8a6', 'footer-dividend-annual', finCurrency);

        // Chart 3: payout ratio history (dividends paid ÷ net income); null when net income <= 0
        const payoutSeries = hasFundamentals
            ? fundamentals.map(y => (y.annualNetIncome > 0 && isNum(y.annualCommonStockDividendPaid) ? (Math.abs(y.annualCommonStockDividendPaid) / y.annualNetIncome) * 100 : null))
            : [];
        this.renderQuantLineChart('chart-payout-ratio', [{ label: 'Payout Ratio', data: payoutSeries, color: '#14b8a6' }], fundamentals.map(y => y.year), null, '%');
    }

    // ─── Finances Tab ─────────────────────────────────────────────────────────
    setupFinanceTabButtons() {
        document.querySelectorAll('.fin-statement-tab').forEach(btn => {
            btn.addEventListener('click', () => this.renderFinancesStatement(btn.dataset.statement));
        });
    }

    async renderFinancesTab() {
        const fundamentals = this.currentData.fundamentals || [];
        const hasFundamentals = this.currentData.hasFundamentals && fundamentals.length >= 1;
        // Statements are in their reporting currency, not the quote currency (ADRs).
        const currency = this.currentData.currency.finIso || '';

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
        const currency = this._finCurrency || '';
        const table = document.getElementById('fin-table');
        if (!table) return;

        const thead = table.querySelector('thead tr');
        const tbody = table.querySelector('tbody');
        thead.innerHTML = `<th>Ligne${currency ? ` (${escHtml(currency)})` : ''}</th>` + fundamentals.map(y => `<th>${escHtml(y.year)}</th>`).join('');
        tbody.innerHTML = def.rows.map(row => {
            const cells = fundamentals.map(y => {
                const val = y[row.key];
                if (!isNum(val)) return '<td>—</td>';
                const formatted = row.decimals ? this.fmt(val, 2) : this.fmtBig(val);
                return `<td${val < 0 ? ' class="fin-negative"' : ''}>${formatted}</td>`;
            }).join('');
            return `<tr><td>${row.label}</td>${cells}</tr>`;
        }).join('');
    }

    // ─── Chart helpers ────────────────────────────────────────────────────────
    // A chart without any real value shows a message instead of empty axes.
    prepareChartCanvas(id, datasets) {
        const canvas = document.getElementById(id);
        if (!canvas) return null;
        Chart.getChart(canvas)?.destroy(); // avoid "Canvas is already in use" on re-render
        const container = canvas.parentElement;
        let msg = container?.querySelector('.quant-empty-msg');
        const hasData = datasets.some(ds => (ds || []).some(isNum));
        if (!hasData) {
            canvas.style.display = 'none';
            if (container && !msg) {
                msg = document.createElement('div');
                msg.className = 'quant-empty-msg';
                container.appendChild(msg);
            }
            if (msg) msg.textContent = 'Données indisponibles';
            return null;
        }
        canvas.style.display = '';
        msg?.remove();
        return canvas;
    }

    renderQuantBarChart(id, label, labels, data, color, footerId, currency = '') {
        const footer = footerId ? document.getElementById(footerId) : null;
        if (footer) footer.innerHTML = '';
        const canvas = this.prepareChartCanvas(id, [data]);
        if (!canvas) return;

        const chart = new Chart(canvas.getContext('2d'), {
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
        this.trackTabChart(chart, canvas);
        this.renderQuantFooter(footerId, data, labels);
    }

    // Grouped bar chart for several datasets sharing the same year labels (e.g. OCF vs FCF).
    // footerSeriesIndex picks which dataset the Perf/CAGR footer is computed from.
    renderQuantGroupedBarChart(id, labels, datasets, footerId, currency = '', footerSeriesIndex = 0) {
        const footer = footerId ? document.getElementById(footerId) : null;
        if (footer) footer.innerHTML = '';
        const canvas = this.prepareChartCanvas(id, datasets.map(ds => ds.data));
        if (!canvas) return;

        const chart = new Chart(canvas.getContext('2d'), {
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
        this.trackTabChart(chart, canvas);
        this.renderQuantFooter(footerId, datasets[footerSeriesIndex]?.data, labels);
    }

    // Perf/CAGR footer, only when the series has real positive endpoints.
    renderQuantFooter(footerId, series, years) {
        const footer = footerId ? document.getElementById(footerId) : null;
        if (!footer) return;
        const stats = annualSeriesStats(series, years);
        if (!stats) { footer.innerHTML = ''; return; }

        const perfClass = stats.perf >= 0 ? 'perf-positive' : 'perf-negative';
        footer.innerHTML = `
            <span class="perf-label ${perfClass}">Perf: ${stats.perf.toFixed(1)}%</span>
            ${stats.cagr != null ? `<span class="perf-label perf-neutral">CAGR: ${stats.cagr.toFixed(1)}%</span>` : ''}
        `;
    }

    renderQuantLineChart(id, datasets, labels, footerId, unit = '', { pointRadius = 3 } = {}) {
        const canvas = this.prepareChartCanvas(id, datasets.map(ds => ds.data));
        if (!canvas) return;

        const chart = new Chart(canvas.getContext('2d'), {
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
                    spanGaps: true,
                    pointRadius,
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
                    },
                    tooltip: {
                        callbacks: { label: ctx => `${ctx.dataset.label}: ${isNum(ctx.parsed.y) ? ctx.parsed.y.toFixed(2) : '—'}${unit}` }
                    }
                },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 10 } } },
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8', font: { size: 10 }, callback: (v) => v.toFixed(1) + unit } }
                }
            }
        });
        this.trackTabChart(chart, canvas);
    }

    trackTabChart(chart, canvas) {
        const tab = canvas.closest('.screener-tab-content')?.id;
        const group = tab === 'tab-dividende' ? this.dividendCharts
            : tab === 'tab-valorisation' ? this.valGridCharts : this.quantCharts;
        group.push(chart);
    }

    // Axis ticks, same magnitudes as fmtBig()
    fmtSmall(val) {
        const abs = Math.abs(val);
        if (abs >= 1e12) return (val / 1e9).toFixed(0) + 'Md';
        if (abs >= 1e9) return (val / 1e9).toFixed(1) + 'Md';
        if (abs >= 1e6) return (val / 1e6).toFixed(1) + 'M';
        if (abs >= 1e3) return (val / 1e3).toFixed(1) + 'k';
        return val.toFixed(1);
    }

    // Tooltip amounts: small values (per-share, ratios) keep two decimals.
    nfmt(val, curr) {
        if (!isNum(val)) return '—';
        if (Math.abs(val) >= 1e6) return this.fmtBig(val, curr);
        return `${this.fmt(val, Math.abs(val) >= 1000 ? 0 : 2)} ${curr}`.trim();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const app = new ScreenerApp();
    app.init();
});
