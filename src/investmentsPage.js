// benderrobot/asset_tracker/asset_tracker-d2b20147fdbaa70dfad9c7d62d05505272e63ca2/investmentsPage.js

// ========================================
// investmentsPage.js - (v11 - Chargement Non-Bloquant)
// ========================================

import { PAGE_SIZE } from './config.js';
import { formatCurrency, formatQuantity } from './utils.js';
import { renderCompanyLogo } from './logoUtils.js';
import { portfolioKPIs } from './portfolioKPIs.js'; // NEW: Centralized KPI management
import { mountViewToggle } from './chartViewToggle.js';
import { renderInvestmentInsights } from './investmentsInsights.js';

const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const formatMovementAmount = (price, quantity, currency) =>
  price != null && quantity != null && Number.isFinite(Number(price)) && Number.isFinite(Number(quantity))
    ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency === 'USD' ? 'USD' : 'EUR' }).format(Math.abs(Number(price) * Number(quantity)))
    : '—';
// A change that rounds to 0,00 is shown as zero, in grey (never "-0,00 €" in red).
const settleZero = value => Number.isFinite(value) && Math.abs(value) < 0.005 ? 0 : value;
const toneClass = (value, positive, negative, neutral = '') => value > 0 ? positive : value < 0 ? negative : neutral;
const weightFormatter = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const formatInvestmentPercent = value => Number.isFinite(value)
  ? `<strong>${value > 0 ? '+' : ''}${value.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %</strong>`
  : '—';

// Pour les stocks US cotés en EU (Xetra/Frankfurt), on redirige vers le ticker US primaire
// afin que le screener trouve les données Yahoo Finance correctement.
const SCREENER_TICKER_OVERRIDES = {
  'NVD': 'NVDA', 'MSF': 'MSFT', 'APC': 'AAPL', 'AMZ': 'AMZN',
  'ABEA': 'GOOGL', 'TL0': 'TSLA', 'TLO': 'TSLA', '9D5': 'AMAT',
  'M4I': 'META', 'AP2': 'AMZN',
};

export class InvestmentsPage {
  // MODIF : Ajout de marketStatus dans le constructeur
  constructor(storage, api, ui, filterManager, dataManager, brokersList, marketStatus) {
    this.storage = storage;
    this.api = api;
    this.ui = ui;
    this.filterManager = filterManager;
    this.dataManager = dataManager;
    this.brokersList = brokersList;
    this.marketStatus = marketStatus; // Stockage

    this.historicalChart = null;
    this.currentPage = 1;
    this.sortColumn = 'dayPct';
    this.sortDirection = 'desc';
    this.currentAssetTypeFilter = '';
    this.currentBrokerFilter = '';
    this.currentHoldings = [];
    this.currentSearchQuery = '';

    // Initialisation du toggle controls pour le graphique
    // On attend un peu que le DOM soit prêt si nécessaire, ou on l'appelle après. 
    // Mieux vaut l'appeler explicitement ou dans le constructeur si le DOM est statique.
    setTimeout(() => this.setupChartControls(), 100);

    // CRITICAL: Subscribe to centralized KPIs
    this.subscribeToKPIs();
  }

  /**
   * Subscribe to centralized KPIs from portfolioKPIs
   * CRITICAL: This is called ONCE at init and displays KPIs whenever graph updates them
   */
  subscribeToKPIs() {
    if (this._kpiListener) portfolioKPIs.removeListener(this._kpiListener);
    this._kpiListener = (kpis) => {
      if (!kpis || kpis.source !== 'snapshot') {
        return;
      }

      console.log('[Investments] ✅ Displaying KPIs from graph:', kpis);

      // SINGLE SOURCE OF TRUTH pour le formatage : délègue à ui.updateTopKPIs
      // (au lieu d'une 2e copie de fmt/fmtPct/updateEl). kpis.totalValue inclut
      // déjà le cash (voir portfolioKPIs.js) → cashReserveTotal=0 ici pour ne
      // pas le compter deux fois.
      // Told explicitly (rather than inferred from whether the numbers happen
      // to add up — see ui.js's per-broker breakdown, dropped that approach:
      // kpis.totalValue comes from the graph's TWR engine while the per-broker
      // split is a plain calculateHoldings sum, two different methodologies
      // that were never going to reconcile to the cent even with NO filter
      // active, which hid the breakdown unconditionally).
      const hasActiveFilter = !!(
        this.currentAssetTypeFilter ||
        this.currentBrokerFilter ||
        this.currentSearchQuery ||
        this.filterManager?.getSelectedTickers().size
      );
      const adaptedSummary = {
        totalCurrentEUR: kpis.totalValue,
        totalInvestedEUR: kpis.invested,
        gainTotal: kpis.totalReturn,
        gainPct: kpis.totalReturnPct,
        totalDayChangeEUR: kpis.varToday,
        dayChangePct: kpis.varTodayPct,
        cash: kpis.cash,
        hasActiveFilter
      };
      // The global hour-based badge cannot certify a filtered asset's session
      // or quote freshness. The chart has the actual data freshness indicator.
      this.ui.updateTopKPIs(adaptedSummary, kpis.cash, null);

      console.log('[Investments] ✅ KPIs displayed successfully via IDs');
    };
    portfolioKPIs.addListener(this._kpiListener);
  }

  setupChartControls() {
    const toggleContainer = document.getElementById('view-toggle');
    if (toggleContainer) {
      toggleContainer.style.display = 'flex';
      // Same builder as historicalChart.js's _syncViewToggle(), which rebuilds
      // it for single-asset mode; the 'portfolio' mode tag it sets avoids a
      // needless rebuild on the very first render.
      mountViewToggle(toggleContainer, 'portfolio', () => this.historicalChart?.update(false, false));
    }
  }

  setHistoricalChart(chartInstance) {
    this.historicalChart = chartInstance;

    // Sync the clear-filter button color whenever the chart mode changes
    const origAsset = chartInstance.showAssetChart.bind(chartInstance);
    chartInstance.showAssetChart = async (ticker, summary) => {
      await origAsset(ticker, summary);
      this.updateClearButtonState();
    };

    const origPortfolio = chartInstance.showPortfolioChart.bind(chartInstance);
    chartInstance.showPortfolioChart = async (...args) => {
      await origPortfolio(...args);
      this.updateClearButtonState();
    };

    this.updateClearButtonState();
  }

  async render(searchQuery = '', fetchPrices = true) {
    this.currentSearchQuery = searchQuery;
    const tbody = document.querySelector('#investments-table tbody');
    if (!tbody) return;

    this.beginScopeRender();

    if (fetchPrices) {
      if (this.historicalChart) {
        await this.historicalChart.loadPageWithCacheFirst();
      }
    } else {
      // En mode non-bloquant, on affiche tout de suite avec les données en cache
      if (this.historicalChart) {
        // Afficher le graphique avec le cache (paramètres non-bloquants)
        await this.historicalChart.update(false, false);
      } else {
        const targetAllPurchases = this.getFilteredPurchasesFromPage(false);
        const result = await this.dataManager.getCanonicalMarketSnapshot(targetAllPurchases);
        const { holdings, summary, cashReserve } = result.snapshot._engine;
        this.renderData(holdings, summary, cashReserve);
      }
    }

    // A background "warm-up" call to calculateAllAssetsYesterdayClose(allPurchases)
    // used to run here once per page load, on the FULL unfiltered portfolio,
    // purely for its side effect of pre-populating the shared price cache — its
    // own result was discarded. That is a second, independent invocation of the
    // exact resolution logic the chart itself already runs (via
    // historicalChart.update() → _resolveTodayData()), and when it finished it
    // re-rendered the page a second time — a real risk of the text KPIs and the
    // chart curve momentarily reflecting two different render passes of the
    // same data, and the cause verified for one instance of "text says +161€ but
    // the curve sits below 0%". Removed: there is now exactly one render path
    // (via historicalChart.update()), so there is nothing left to warm up
    // separately or to race against.
  }

  getScopeKey() {
    return JSON.stringify({
      search: this.currentSearchQuery || '', type: this.currentAssetTypeFilter || '',
      broker: this.currentBrokerFilter || '',
      tickers: [...(this.filterManager?.getSelectedTickers() || [])].sort(),
      mode: this.historicalChart?.currentMode || 'portfolio',
      selectedAssets: this.historicalChart?.selectedAssets || []
    });
  }

  beginScopeRender() {
    const tbody = document.querySelector('#investments-table tbody');
    if (!tbody) return;
    if (this.lastRenderedScope !== this.getScopeKey()) {
      this.hasRenderedData = false;
      this.expandedTicker = null;
      for (const id of ['total-current', 'invested', 'total-gain-loss', 'total-gain-pct',
        'total-invested', 'avg-cost-per-share', 'best-day-asset', 'worst-day-asset',
        'best-asset', 'worst-asset', 'cash-reserve', 'cash-wallets']) {
        const element = document.getElementById(id);
        if (element) element.textContent = '—';
      }
      for (const id of ['best-day-context', 'worst-day-context']) {
        const element = document.getElementById(id);
        if (element) element.textContent = 'Variation du jour';
      }
      const context = document.getElementById('investment-filter-context');
      if (context) {
        context.hidden = false;
        context.textContent = `Chargement · ${this.getChartTitleConfig().label}`;
      }
    }
    if (!this.hasRenderedData) {
      tbody.innerHTML = '<tr><td colspan="11" class="investments-table-state">Chargement des positions…</td></tr>';
    }
  }

  showDataError() {
    if (this.hasRenderedData) {
      const context = document.getElementById('investment-filter-context');
      if (context) {
        context.hidden = false;
        context.textContent = `Dernières positions connues · ${this.getChartTitleConfig().label}`;
      }
      return;
    }
    const tbody = document.querySelector('#investments-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="11" class="investments-table-state">Positions indisponibles. <button type="button" class="investments-retry">Réessayer</button></td></tr>';
    const context = document.getElementById('investment-filter-context');
    if (context) {
      context.hidden = false;
      context.textContent = `Sélection indisponible · ${this.getChartTitleConfig().label}`;
    }
    const retry = tbody.querySelector('.investments-retry');
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      try {
        if (this.historicalChart) await this.historicalChart.update(true, true);
        else await this.render(this.currentSearchQuery, false);
      } finally {
        if (retry.isConnected) retry.disabled = false;
      }
    });
  }

  getFilteredPurchasesFromPage(ignoreTickerFilter = false) {
    const searchQuery = this.currentSearchQuery;
    let purchases = this.storage.getPurchases();

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      purchases = purchases.filter(p => p.ticker.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    }
    if (!ignoreTickerFilter) {
      const selectedTickers = this.filterManager.getSelectedTickers();
      if (selectedTickers.size > 0) {
        purchases = purchases.filter(p => selectedTickers.has(p.ticker.toUpperCase()));
      }
    }
    if (this.currentAssetTypeFilter) {
      purchases = purchases.filter(p => (p.assetType || 'Stock') === this.currentAssetTypeFilter);
    }
    if (this.currentBrokerFilter) {
      purchases = purchases.filter(p => (p.broker || 'RV-CT') === this.currentBrokerFilter);
    }
    return purchases;
  }


  // Seul filtre encore nécessaire ici : les "positions poussière" (quantité/valeur
  // quasi nulles), un concept propre aux holdings déjà agrégés, sans équivalent au
  // niveau des achats. Le filtrage ticker/type/courtier est déjà fait EN AMONT, sur
  // les achats, par getFilteredPurchasesFromPage (SINGLE SOURCE OF TRUTH partagée
  // avec historicalChart.js) — le re-vérifier ici sur les holdings déjà agrégés
  // était redondant et pouvait diverger de ce que le graphique affichait pour un
  // même filtre actif (ex: un ticker détenu chez 2 courtiers, filtré sur un seul).
  filterVisibleHoldings(holdings) {
    return holdings.filter(h => {
      if (h.quantity <= 0.0001) return false;
      if (h.currentValue !== null && Math.abs(h.currentValue) < 0.50 && Math.abs(h.quantity) < 0.01) return false;
      return true;
    });
  }

  resolveCashReserveDetails(cashReserve, { dividendsOnly = false } = {}) {
    const total = typeof cashReserve === 'number' ? cashReserve : cashReserve?.total;
    if (dividendsOnly || !Number.isFinite(total) || total === 0 ||
        Object.keys(cashReserve?.byBroker || {}).length ||
        !this.dataManager?.calculateCashReserve || !this.storage?.getPurchases) return cashReserve;

    // Compatibilité avec un ancien appelant qui transmet seulement le total.
    // Le détail n'est admis que s'il réconcilie exactement le montant affiché.
    const candidate = this.dataManager.calculateCashReserve(this.getFilteredPurchasesFromPage(false));
    if (!Number.isFinite(candidate?.total) || Math.abs(candidate.total - total) > 0.01 ||
        !Object.keys(candidate.byBroker || {}).length) return cashReserve;
    return { ...candidate, total };
  }

  // SSOT (audit architecture) : `holdings` DOIT être les positions canoniques
  // déjà résolues par le moteur (dataManager.buildTodaySnapshot/calculateHoldings,
  // via historicalChart.js::update()) — cette méthode ne lit/n'agrège plus
  // aucune donnée issue du graphique (voir suppression du paramètre chartStats
  // et de la logique d'écrasement qui l'utilisait, ci-dessous).
  renderData(holdings, summary, cashReserve, { dividendsOnly = false } = {}) {
    this.currentHoldings = holdings;
    const detailedCashReserve = this.resolveCashReserveDetails(cashReserve, { dividendsOnly });
    this.currentCashReserve = detailedCashReserve;
    const tbody = document.querySelector('#investments-table tbody');
    if (!tbody) return;
    this.hasRenderedData = true;
    this.lastRenderedScope = this.getScopeKey();

    const selectedTickers = this.filterManager.getSelectedTickers();
    let filteredHoldings = this.filterVisibleHoldings(this.currentHoldings);

    filteredHoldings.sort((a, b) => {
      const displayValue = (position) => {
        if (this.sortColumn === 'dayChange') return position.displayDayChange ?? position.displayDayPnl ?? position.dayChange;
        if (this.sortColumn === 'dayPct') return position.displayDayPct ?? position.displayDayPnlPct ?? position.dayPct;
        return position[this.sortColumn];
      };
      const valA = displayValue(a) ?? -Infinity;
      const valB = displayValue(b) ?? -Infinity;
      let order;
      if (typeof valA === 'string' && typeof valB === 'string') order = valA.localeCompare(valB);
      else order = valA < valB ? -1 : valA > valB ? 1 : 0;
      return order * (this.sortDirection === 'asc' ? 1 : -1);
    });

    const hasLastSessionValues = filteredHoldings.some(position => {
      const displayed = position.displayDayPct ?? position.displayDayPnlPct;
      return Number.isFinite(displayed) &&
        (!Number.isFinite(position.dayPct) || Math.abs(displayed - position.dayPct) > 0.000001);
    });
    const dayChangeLabel = document.getElementById('day-change-label');
    const dayPercentLabel = document.getElementById('day-percent-label');
    if (dayChangeLabel) dayChangeLabel.textContent = hasLastSessionValues ? 'VAR. AFFICHÉE' : 'VAR. JOUR';
    if (dayPercentLabel) {
      dayPercentLabel.textContent = hasLastSessionValues ? 'VAR. AFFICHÉE %' : 'VAR. JOUR %';
      dayPercentLabel.dataset.mobileLabel = hasLastSessionValues ? 'VAR. AFFICHÉE' : 'VAR. JOUR';
    }

    const totalPages = Math.max(1, Math.ceil(filteredHoldings.length / PAGE_SIZE));
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    const pageItems = filteredHoldings.slice((this.currentPage - 1) * PAGE_SIZE, this.currentPage * PAGE_SIZE);

    // Weight of each position among all positions (cash excluded), whatever the filter.
    const positionsValue = (this.currentHoldings || []).reduce((sum, position) =>
      sum + (Number.isFinite(position.currentValue) && position.currentValue > 0 ? position.currentValue : 0), 0);

    tbody.innerHTML = pageItems.map(p => {
      const isSelected = selectedTickers.has(p.ticker.toUpperCase());
      const selectedClass = isSelected ? 'selected' : '';
      const logoInfo = renderCompanyLogo(p.ticker, p.name);

      // Generate purchases sub-rows
      const sortedPurchases = [...p.purchases].sort((a, b) => new Date(a.date) - new Date(b.date));
      const purchaseRows = sortedPurchases.map(purchase => {
        const buyDate = purchase.date instanceof Date ? purchase.date : new Date(purchase.date);
        const dateStr = Number.isNaN(+buyDate) ? '—' : buyDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
        const buyCurrency = purchase.currency || 'EUR';
        const isSale = Number(purchase.quantity) < 0;
        const unitPrice = purchase.price == null ? '—' : new Intl.NumberFormat('fr-FR', {
          style: 'currency', currency: buyCurrency === 'USD' ? 'USD' : 'EUR'
        }).format(Number(purchase.price));
        const qty = purchase.quantity != null ? formatQuantity(Math.abs(Number(purchase.quantity))) : '—';

        return `
          <tr class="purchase-detail-row">
            <td>${isSale ? 'Vente' : 'Achat'} · ${escapeHtml(purchase.broker || 'Courtier inconnu')}</td>
            <td>${dateStr}</td>
            <td>${unitPrice}</td>
            <td>${qty}</td>
            <td>${formatMovementAmount(purchase.price, purchase.quantity, buyCurrency)}</td>
          </tr>
        `;
      }).join('');

      const isExpanded = this.expandedTicker === p.ticker;
      const rowExpandedClass = isExpanded ? 'expanded' : '';
      const purchasesOpenClass = isExpanded ? 'open' : '';
      const displayedDayChange = settleZero(p.displayDayChange ?? p.displayDayPnl ?? p.dayChange);
      const displayedDayPct = settleZero(p.displayDayPct ?? p.displayDayPnlPct ?? p.dayPct);
      const gainEUR = settleZero(p.gainEUR);
      const gainPct = settleZero(p.gainPct);
      const weight = positionsValue > 0 && Number.isFinite(p.currentValue) ? Math.max(0, p.currentValue / positionsValue * 100) : null;

      const purchasesTable = `
        <tr class="purchases-row ${purchasesOpenClass}" data-ticker="${escapeHtml(p.ticker)}">
          <td colspan="11" class="purchases-cell">
            <div class="purchases-expand">
              <p class="purchases-scroll-hint">Faites glisser pour voir tous les montants.</p>
              <table class="purchases-sub-table">
                <thead>
                  <tr>
                    <th>TYPE · COURTIER</th>
                    <th>DATE</th>
                    <th>PRIX UNITAIRE</th>
                    <th>QUANTITÉ</th>
                    <th>MONTANT BRUT</th>
                  </tr>
                </thead>
                <tbody>
                  ${purchaseRows}
                </tbody>
              </table>
              <div class="detail-action-buttons">
                <button class="detail-btn detail-btn-chart" data-ticker="${escapeHtml(p.ticker)}">
                  <i class="ph ph-chart-line"></i> Graphique
                </button>
                <button class="detail-btn detail-btn-screener" data-ticker="${escapeHtml(p.ticker)}">
                  <i class="ph ph-magnifying-glass"></i> Screener
                </button>
              </div>
            </div>
          </td>
        </tr>
      `;

      return `
            <tr class="asset-row ${selectedClass} ${rowExpandedClass}" data-ticker="${escapeHtml(p.ticker)}" data-avgprice="${escapeHtml(p.avgPrice)}">
                <td>
                    <div class="investment-asset-identity">
                        ${logoInfo.html}
                        <span class="investment-asset-text"><strong>${escapeHtml(p.name || p.ticker)}</strong><small class="asset-ticker">${escapeHtml(p.ticker)}</small><small>${escapeHtml(formatQuantity(p.quantity))} titres</small></span>
                    </div>
                </td>
                <td>${escapeHtml(p.ticker)}</td>
                <td class="num">${formatQuantity(p.quantity)}</td>
                <td class="num"><span class="badge badge-pru" title="Prix de revient unitaire (PRU)">${formatCurrency(p.avgPrice, 'EUR')}</span></td>
                <td class="num"><span class="badge badge-invested" title="Montant engagé dans la position (coût de revient)"><i class="ph ph-lock-simple" aria-hidden="true"></i>${formatCurrency(p.invested, 'EUR')}</span></td>
                <td class="num">${formatCurrency(p.currentPrice, 'EUR')}</td>
                <td class="num value-cell"><span class="value-amount">${formatCurrency(p.currentValue, 'EUR')}</span>${weight === null ? '' : `<span class="position-weight" title="Poids dans l'ensemble des positions"><span class="weight-track" aria-hidden="true"><span style="width:${Math.min(100, weight).toFixed(1)}%"></span></span><span class="weight-pct">${weightFormatter.format(weight)} %</span></span>`}</td>
                <td class="num ${toneClass(gainEUR, 'positive', 'negative', 'neutral-value')}">${formatCurrency(gainEUR, 'EUR')}</td>
                <td class="num"><span class="badge ${toneClass(gainPct, 'badge-positive', 'badge-negative', 'badge-neutral')}">${formatInvestmentPercent(gainPct)}</span></td>
                <td class="num ${toneClass(displayedDayChange, 'positive', 'negative', 'neutral-value')}">${formatCurrency(displayedDayChange, 'EUR')}</td>
                <td class="num"><span class="badge ${toneClass(displayedDayPct, 'badge-positive', 'badge-negative', 'badge-neutral')}">${formatInvestmentPercent(displayedDayPct)}</span></td>
            </tr>
            ${purchasesTable}
        `;
    }).join('') || '<tr><td colspan="11" class="investments-table-state">Aucune position pour cette sélection.</td></tr>';

    // Les classements lisent les mêmes positions et variations affichées que le
    // tableau. Les KPI principaux restent alimentés par le snapshot canonique.
    renderInvestmentInsights(filteredHoldings, detailedCashReserve, this.brokersList, { dividendsOnly });

    const filterContext = document.getElementById('investment-filter-context');
    if (filterContext) {
      const active = !!(this.currentSearchQuery || this.currentAssetTypeFilter || this.currentBrokerFilter || selectedTickers.size);
      filterContext.hidden = !active;
      if (active) filterContext.textContent = `${filteredHoldings.length} position${filteredHoldings.length > 1 ? 's' : ''} · ${this.getChartTitleConfig().label}`;
    }

    this.ui.renderPagination(this.currentPage, totalPages, (page) => {
      this.currentPage = page;
      this.renderData(this.currentHoldings, summary, this.currentCashReserve, { dividendsOnly });
    });

    this.ui.populateTickerSelect(this.storage.getPurchases());
    this.attachRowClickListeners();
  }

  getChartTitleConfig(tickerOverride = null) {
    const selectedTickers = this.filterManager.getSelectedTickers();
    const tickers = tickerOverride
      ? [String(tickerOverride).toUpperCase()]
      : Array.from(selectedTickers);
    const context = [];

    // Le bandeau du graphique doit décrire le sous-portefeuille réellement
    // affiché, pas uniquement le dernier filtre testé par une chaîne de if.
    if (this.currentBrokerFilter) {
      const brokerLabel = this.brokersList?.find(b => b.value === this.currentBrokerFilter)?.label || this.currentBrokerFilter;
      context.push(brokerLabel);
    }
    if (this.currentAssetTypeFilter) context.push(this.currentAssetTypeFilter);
    if (this.currentSearchQuery?.trim()) context.push(`Recherche : ${this.currentSearchQuery.trim()}`);

    if (tickers.length === 1) {
      const ticker = tickers[0];
      const name = this.storage.getPurchases().find(p => p.ticker.toUpperCase() === ticker.toUpperCase())?.name || ticker;
      const icon = this.dataManager.isCryptoTicker(ticker) ? 'currency-btc' : 'chart-bar';
      return { mode: 'asset', label: [...context, ticker, name].join(' • '), icon: icon };
    }
    if (tickers.length > 1) {
      const tickerLabel = tickers.length > 2 ? `${tickers.slice(0, 2).join(', ')}... (+${tickers.length - 2})` : tickers.join(', ');
      const assetTypes = tickers.map(t => this.dataManager.isCryptoTicker(t) ? 'Crypto' : 'Stock');
      const uniqueTypes = [...new Set(assetTypes)];
      let icon = uniqueTypes.length === 1 && uniqueTypes[0] === 'Crypto' ? 'currency-btc' : 'chart-line-up';
      return { mode: 'filter', label: [...context, tickerLabel].join(' • '), icon: icon };
    }
    if (context.length > 0) {
      const icon = this.currentAssetTypeFilter === 'Crypto' ? 'currency-btc' : (this.currentBrokerFilter ? 'bank' : 'chart-bar');
      return { mode: 'filter', label: context.join(' • '), icon };
    }
    return { mode: 'global', label: 'Portefeuille global', icon: 'chart-line-up' };
  }

  attachRowClickListeners() {
    document.querySelectorAll('.asset-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const ticker = row.dataset.ticker;
        if (!this.currentHoldings) return;
        const assetHolding = this.currentHoldings.find(h => h.ticker === ticker);
        if (!assetHolding) return;

        // --- Toggle purchases sub-row ---
        const purchasesRow = document.querySelector(`.purchases-row[data-ticker="${ticker}"]`);
        const isExpanded = row.classList.contains('expanded');

        // Close all open purchase rows
        document.querySelectorAll('.asset-row.expanded').forEach(r => r.classList.remove('expanded'));
        document.querySelectorAll('.purchases-row').forEach(r => r.classList.remove('open'));

        if (!isExpanded && purchasesRow) {
          row.classList.add('expanded');
          purchasesRow.classList.add('open');
          this.expandedTicker = ticker; // Save state across renders
        } else {
          this.expandedTicker = null;
        }
      });
    });

    document.querySelectorAll('.detail-btn-chart').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const ticker = btn.dataset.ticker;
        if (this.historicalChart) {
          this.historicalChart.showAssetChart(ticker);
          this.updateClearButtonState();
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });

    document.querySelectorAll('.detail-btn-screener').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const raw = btn.dataset.ticker.toUpperCase();
        const screenerTicker = SCREENER_TICKER_OVERRIDES[raw] || this.api.formatTicker(raw);
        window.location.href = `screener.html?ticker=${encodeURIComponent(screenerTicker)}`;
      });
    });
  }

  // Update clear button appearance based on selection state
  updateClearButtonState() {
    const btn = document.getElementById('clear-filters');
    if (!btn) return;
    const hasAssetSelected = this.historicalChart && this.historicalChart.currentMode === 'asset';
    btn.classList.toggle('clear-btn-active', hasAssetSelected);
  }

  setupFilters() { /* ... inchangé ... */
    const assetTypeFilter = document.getElementById('filter-asset-type');
    if (assetTypeFilter) assetTypeFilter.addEventListener('change', (e) => { this.currentAssetTypeFilter = e.target.value; this.currentPage = 1; this.render(this.currentSearchQuery); });

    const brokerFilter = document.getElementById('filter-broker');
    if (brokerFilter) brokerFilter.addEventListener('change', (e) => { this.currentBrokerFilter = e.target.value; this.currentPage = 1; this.render(this.currentSearchQuery); });

    const clearFiltersBtn = document.getElementById('clear-filters');
    if (clearFiltersBtn) {
      this.clearFiltersBtn = clearFiltersBtn; // Store reference for updates
      clearFiltersBtn.addEventListener('click', () => {
        this.currentAssetTypeFilter = ''; this.currentBrokerFilter = '';
        if (assetTypeFilter) assetTypeFilter.value = '';
        if (brokerFilter) brokerFilter.value = '';
        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.value = '';
        this.currentSearchQuery = '';
        const filterContext = document.getElementById('investment-filter-context');
        if (filterContext) filterContext.hidden = true;
        if (this.filterManager) {
          this.filterManager.clearAllFilters();
        }
        this.currentPage = 1;
        const benchmarkSelect = document.getElementById('benchmark-select');
        if (benchmarkSelect) benchmarkSelect.value = '';
        // FIX: Call showPortfolioChart() to properly reset in one click
        if (this.historicalChart) {
          this.historicalChart.currentBenchmark = null;
          this.historicalChart.currentPeriod = 1;
          this.historicalChart.showPortfolioChart(); // Proper reset method
        }
        this.render('');
        this.updateClearButtonState(); // Update button appearance
      });
    }
  }

  setupSorting() { /* ... inchangé ... */
    document.querySelectorAll('th[data-sort]').forEach(th => {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (window.innerWidth <= 768 && (col === 'dayPct' || col === 'gainPct')) {
          document.getElementById('investments-table').classList.toggle('show-total-gain');
          return;
        }
        if (this.sortColumn === col) this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        else { this.sortColumn = col; this.sortDirection = 'asc'; }
        document.querySelectorAll('th[data-sort]').forEach(header => header.classList.remove('sort-asc', 'sort-desc'));
        th.classList.add(`sort-${this.sortDirection}`);
        this.currentPage = 1;
        this.render(this.currentSearchQuery);
      });
    });
  }
}
