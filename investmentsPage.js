// benderrobot/asset_tracker/asset_tracker-d2b20147fdbaa70dfad9c7d62d05505272e63ca2/investmentsPage.js

// ========================================
// investmentsPage.js - (v10 - Fix Status Injection)
// ========================================

import { PAGE_SIZE } from './config.js';
import { formatCurrency, formatPercent, formatQuantity } from './utils.js';

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
    this.lastChartStats = null; // <-- NOUVEAU
  }

  setHistoricalChart(chartInstance) {
    this.historicalChart = chartInstance;
  }

  async render(searchQuery = '') {
    this.currentSearchQuery = searchQuery;
    const tbody = document.querySelector('#investments-table tbody');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:20px;">Chargement des données...</td></tr>';
    
    if (this.historicalChart) {
      await this.historicalChart.loadPageWithCacheFirst(); 
    } else {
        this.renderData([], { 
            totalInvestedEUR: 0, totalCurrentEUR: 0, totalDayChangeEUR: 0, 
            gainTotal: 0, gainPct: 0, dayChangePct: 0, 
            assetsCount: 0, movementsCount: 0 
        }, 0);
    }
  }

  renderData(holdings, summary, cashReserveTotal, chartStats = null) { // <-- MODIFIÉ
    this.currentHoldings = holdings;
    const tbody = document.querySelector('#investments-table tbody');
    if (!tbody) return;

    const selectedTickers = this.filterManager.getSelectedTickers();

    let filteredHoldings = this.currentHoldings.filter(h => {
      if (selectedTickers.size > 0) {
        if (!selectedTickers.has(h.ticker.toUpperCase())) return false;
      }
      const assetType = h.purchases[0]?.assetType || 'Stock';
      const brokers = [...new Set(h.purchases.map(p => p.broker || 'RV-CT'))];

      if (this.currentAssetTypeFilter && assetType !== this.currentAssetTypeFilter) return false;
      if (this.currentBrokerFilter && !brokers.includes(this.currentBrokerFilter)) return false;
      return true;
    });

    filteredHoldings.sort((a, b) => {
      const valA = a[this.sortColumn] ?? -Infinity;
      const valB = b[this.sortColumn] ?? -Infinity;
      let order;
      if (typeof valA === 'string' && typeof valB === 'string') order = valA.localeCompare(valB);
      else order = valA < valB ? -1 : valA > valB ? 1 : 0;
      return order * (this.sortDirection === 'asc' ? 1 : -1);
    });

    const totalPages = Math.max(1, Math.ceil(filteredHoldings.length / PAGE_SIZE));
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    const pageItems = filteredHoldings.slice((this.currentPage - 1) * PAGE_SIZE, this.currentPage * PAGE_SIZE);

    tbody.innerHTML = pageItems.map(p => `
      <tr class="asset-row" data-ticker="${p.ticker}" data-avgprice="${p.avgPrice}">
        <td><strong>${p.ticker}</strong></td>
        <td>${p.name}</td>
        <td>${formatQuantity(p.quantity)}</td>
        <td>${formatCurrency(p.avgPrice, 'EUR')}</td>
        <td>${formatCurrency(p.invested, 'EUR')}</td>
        <td>${formatCurrency(p.currentPrice, 'EUR')}</td>
        <td>${formatCurrency(p.currentValue, 'EUR')}</td>
        <td class="${p.gainEUR > 0 ? 'positive' : p.gainEUR < 0 ? 'negative' : ''}">${formatCurrency(p.gainEUR, 'EUR')}</td>
        <td class="${p.gainEUR > 0 ? 'positive' : p.gainEUR < 0 ? 'negative' : ''}">${formatPercent(p.gainPct)}</td>
        <td class="${p.dayChange > 0 ? 'positive' : p.dayChange < 0 ? 'negative' : ''}">${formatCurrency(p.dayChange, 'EUR')}</td>
        <td class="${p.dayChange > 0 ? 'positive' : p.dayChange < 0 ? 'negative' : ''}">${formatPercent(p.dayPct)}</td>
      </tr>
    `).join('') || '<tr><td colspan="11" style="text-align:center; padding:20px; color:var(--text-secondary);">Aucun investissement correspondant.</td></tr>';
    
    // --- LOGIQUE D'ÉCRASEMENT DES STATS PAR LE GRAPHIQUE ---
    // 1. Définir les stats du graphique (pour la persistance si pagination)
    if (chartStats) this.lastChartStats = chartStats;
    const effectiveChartStats = chartStats || this.lastChartStats;
    
    // 2. Créer un résumé final et appliquer l'écrasement
    let finalSummary = {...summary}; // Copier le résumé de base
    
    // ÉCRASEMENT : Si les stats du graphique existent et sont passées, elles sont la SEULE source de vérité pour la Var. Jour
    if (effectiveChartStats && effectiveChartStats.historicalDayChange !== null) {
        finalSummary.totalDayChangeEUR = effectiveChartStats.historicalDayChange;
        finalSummary.dayChangePct = effectiveChartStats.historicalDayChangePct;
    }
    // --- FIN LOGIQUE D'ÉCRASEMENT ---

    // === MODIF : Passage de marketStatus (utilise finalSummary) ===
    this.ui.updatePortfolioSummary(finalSummary, summary.movementsCount, cashReserveTotal, this.marketStatus); // <-- Utilise finalSummary

    this.ui.renderPagination(this.currentPage, totalPages, (page) => {
      this.currentPage = page;
      // L'appel récursif se fera avec this.lastChartStats qui sera récupéré au début de renderData
      this.renderData(this.currentHoldings, summary, cashReserveTotal); 
    });
    
    this.ui.populateTickerSelect(this.storage.getPurchases());
    this.attachRowClickListeners();
  }

  getChartTitleConfig() { /* ... inchangé ... */
    const selectedTickers = this.filterManager.getSelectedTickers();
    if (selectedTickers.size === 1) {
        const ticker = Array.from(selectedTickers)[0];
        const name = this.storage.getPurchases().find(p => p.ticker.toUpperCase() === ticker.toUpperCase())?.name || ticker;
        const icon = this.dataManager.isCryptoTicker(ticker) ? '₿' : '📊';
        return { mode: 'asset', label: `${ticker} • ${name}`, icon: icon };
    }
    if (selectedTickers.size > 1) {
      const tickers = Array.from(selectedTickers);
      let label = tickers.length > 2 ? `${tickers.slice(0, 2).join(', ')}... (+${tickers.length - 2})` : tickers.join(', ');
      const assetTypes = tickers.map(t => this.dataManager.isCryptoTicker(t) ? 'Crypto' : 'Stock');
      const uniqueTypes = [...new Set(assetTypes)];
      let icon = uniqueTypes.length === 1 && uniqueTypes[0] === 'Crypto' ? '₿' : '📈'; 
      return { mode: 'filter', label: label, icon: icon };
    }
    if (this.currentAssetTypeFilter) {
      let icon = this.currentAssetTypeFilter === 'Crypto' ? '₿' : (this.currentAssetTypeFilter === 'Stock' ? '📊' : '🌍');
      return { mode: 'filter', label: `${this.currentAssetTypeFilter}`, icon: icon };
    }
    if (this.currentBrokerFilter) {
      const brokerLabel = this.brokersList?.find(b => b.value === this.currentBrokerFilter)?.label || this.currentBrokerFilter;
      return { mode: 'filter', label: `${brokerLabel}`, icon: '🏦' };
    }
    return { mode: 'global', label: 'Portfolio Global', icon: '📈' };
  }

  attachRowClickListeners() {
    document.querySelectorAll('.asset-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const ticker = row.dataset.ticker;
        if (!this.currentHoldings) return;
        const assetHolding = this.currentHoldings.find(h => h.ticker === ticker);
        if (!assetHolding) return;
        const assetSummary = this.dataManager.calculateSummary([assetHolding]);
        this.ui.updatePortfolioSummary(assetSummary, assetHolding.purchases.length, 0, this.marketStatus);
        if (this.historicalChart) {
          this.historicalChart.showAssetChart(ticker, assetSummary);
          const summaryContainer = document.querySelector('.portfolio-summary-enhanced');
          if (summaryContainer) summaryContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  }

  setupFilters() { /* ... inchangé ... */
    const assetTypeFilter = document.getElementById('filter-asset-type');
    if (assetTypeFilter) assetTypeFilter.addEventListener('change', (e) => { this.currentAssetTypeFilter = e.target.value; this.currentPage = 1; this.render(this.currentSearchQuery); });
    
    const brokerFilter = document.getElementById('filter-broker');
    if (brokerFilter) brokerFilter.addEventListener('change', (e) => { this.currentBrokerFilter = e.target.value; this.currentPage = 1; this.render(this.currentSearchQuery); });
    
    const clearFiltersBtn = document.getElementById('clear-filters');
    if (clearFiltersBtn) clearFiltersBtn.addEventListener('click', () => {
        this.currentAssetTypeFilter = ''; this.currentBrokerFilter = '';
        if (assetTypeFilter) assetTypeFilter.value = '';
        if (brokerFilter) brokerFilter.value = '';
        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.value = '';
        this.currentSearchQuery = ''; 
        if (this.filterManager) this.filterManager.clearAllFilters(); 
        this.currentPage = 1;
        const benchmarkSelect = document.getElementById('benchmark-select');
        if (benchmarkSelect) benchmarkSelect.value = ''; 
        if (this.historicalChart) {
            this.historicalChart.currentMode = 'portfolio';
            this.historicalChart.selectedAssets = [];
            this.historicalChart.currentBenchmark = null; 
            this.historicalChart.update(true, false); 
        }
        this.render(''); 
      });
  }

  setupSorting() { /* ... inchangé ... */
    document.querySelectorAll('th[data-sort]').forEach(th => {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
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