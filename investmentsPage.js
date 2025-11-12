// ========================================
// investmentsPage.js - Page Mes Investissements (Version Complète)
// ========================================

import { PAGE_SIZE, USD_TO_EUR_RATE } from './config.js';
import { formatCurrency, formatPercent, formatQuantity } from './utils.js';

export class InvestmentsPage {
  constructor(storage, api, ui, filterManager, dataManager) {
    this.storage = storage;
    this.api = api;
    this.ui = ui;
    this.filterManager = filterManager;
    this.dataManager = dataManager;
    this.currentPage = 1;
    this.sortColumn = 'dayPct';
    this.sortDirection = 'desc';
    this.currentAssetTypeFilter = '';
    this.currentBrokerFilter = '';
    
    // Stocke les holdings actuellement affichés pour le clic
    this.currentHoldings = []; 
  }

  async render(searchQuery = '') {
    const tbody = document.querySelector('#investments-table tbody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:20px;">Chargement...</td></tr>';

    // 1. Obtenir les achats filtrés
    let filteredPurchases = this.filterManager.filterPurchases(this.storage.getPurchases(), searchQuery);
    
    // Appliquer les filtres asset type et broker
    if (this.currentAssetTypeFilter) {
      filteredPurchases = filteredPurchases.filter(p => (p.assetType || 'Stock') === this.currentAssetTypeFilter);
    }
    if (this.currentBrokerFilter) {
      filteredPurchases = filteredPurchases.filter(p => (p.broker || 'RV-CT') === this.currentBrokerFilter);
    }

    // 2. Rafraîchir les prix
    const tickers = [...new Set(filteredPurchases.map(p => p.ticker.toUpperCase()))];
    await this.api.fetchBatchPrices(tickers);

    // 3. Calculer les holdings
    const holdings = this.dataManager.calculateHoldings(filteredPurchases);
    
    // Mettre à jour la liste des holdings
    this.currentHoldings = holdings;

    // 4. Calculer le résumé (pour les cartes)
    const summary = this.dataManager.calculateSummary(holdings);

    // 5. Trier
    holdings.sort((a, b) => {
      const valA = a[this.sortColumn] ?? -Infinity;
      const valB = b[this.sortColumn] ?? -Infinity;
      const order = valA < valB ? -1 : valA > valB ? 1 : 0;
      return order * (this.sortDirection === 'asc' ? 1 : -1);
    });

    // 6. Pagination
    const totalPages = Math.max(1, Math.ceil(holdings.length / PAGE_SIZE));
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    const pageItems = holdings.slice((this.currentPage - 1) * PAGE_SIZE, this.currentPage * PAGE_SIZE);

    // 7. Affichage du tableau
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
    `).join('') || '<tr><td colspan="11">Aucun investissement.</td></tr>';

    // 8. Mettre à jour l'UI avec le résumé
    this.ui.updatePortfolioSummary(summary, filteredPurchases.length);

    // 9. Reste
    this.ui.renderPagination(this.currentPage, totalPages, (page) => {
      this.currentPage = page;
      this.render(searchQuery);
    });
    this.ui.populateTickerSelect(this.storage.getPurchases());
    
    this.attachRowClickListeners();
    
    await this.updateChart(filteredPurchases, searchQuery, summary);
  }

  async updateChart(filtered, searchQuery, summary) {
    const selectedTickers = this.filterManager.getSelectedTickers();
    const selectedTickersArray = Array.from(selectedTickers);
    
    if (window.app && window.app.historicalChart) {
      if (selectedTickers.size > 0) {
        const tickerFilteredPurchases = filtered.filter(p => selectedTickers.has(p.ticker.toUpperCase()));
        window.app.historicalChart.showMultipleAssetsChart(tickerFilteredPurchases, selectedTickersArray, summary);
      } else {
        const hasOtherFilters = this.currentAssetTypeFilter || this.currentBrokerFilter || searchQuery;
        
        if (hasOtherFilters) {
          console.log('📈 Affichage du portfolio filtré');
          window.app.historicalChart.showFilteredPortfolioChart(filtered, summary);
        } else {
          console.log('📈 Affichage du portfolio global');
          window.app.historicalChart.showPortfolioChart(summary);
        }
      }
    }
  }

  attachRowClickListeners() {
    document.querySelectorAll('.asset-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const ticker = row.dataset.ticker;
        
        // Logique pour mettre à jour les cartes
        if (!this.currentHoldings) return;
        const assetHolding = this.currentHoldings.find(h => h.ticker === ticker);
        if (!assetHolding) return;
        const assetSummary = this.dataManager.calculateSummary([assetHolding]);
        this.ui.updatePortfolioSummary(assetSummary, 1);
        
        console.log(`📊 Clic sur ${ticker} - Affichage du graphique`);
        
        if (window.app && window.app.historicalChart) {
          
          // On passe le 'assetSummary' pour la synchro
          window.app.historicalChart.showAssetChart(ticker, assetSummary);
          
          // Scroll vers les cartes
          const summaryContainer = document.querySelector('.portfolio-summary-enhanced');
          if (summaryContainer) {
            summaryContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      });
      
      // Effet hover
      row.addEventListener('mouseenter', () => {
        row.style.backgroundColor = '#f8f9fa';
      });
      row.addEventListener('mouseleave', () => {
        row.style.backgroundColor = '';
      });
    });
  }

  setupFilters() {
    const assetTypeFilter = document.getElementById('filter-asset-type');
    if (assetTypeFilter) {
      assetTypeFilter.addEventListener('change', (e) => {
        this.currentAssetTypeFilter = e.target.value;
        this.currentPage = 1;
        this.render();
      });
    }
    
    const brokerFilter = document.getElementById('filter-broker');
    if (brokerFilter) {
      brokerFilter.addEventListener('change', (e) => {
        this.currentBrokerFilter = e.target.value;
        this.currentPage = 1;
        this.render();
      });
    }
    
    const clearFiltersBtn = document.getElementById('clear-filters');
    if (clearFiltersBtn) {
      clearFiltersBtn.addEventListener('click', () => {
        console.log('🧹 Clear Filters clicked');
        
        this.currentAssetTypeFilter = '';
        this.currentBrokerFilter = '';
        
        if (assetTypeFilter) assetTypeFilter.value = '';
        if (brokerFilter) brokerFilter.value = '';
        
        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.value = '';
        
        if (window.app) {
          window.app.searchQuery = '';
        }
        
        if (this.filterManager) {
          this.filterManager.clearAllFilters();
        }
        
        // L'appel prématuré au graphique a été supprimé (correct).
        
        this.currentPage = 1;
        this.render(''); 
        
        console.log('✅ Filtres réinitialisés');
      });
    }
  }

  setupSorting() {
    document.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (this.sortColumn === col) {
          this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          this.sortColumn = col;
          this.sortDirection = 'asc';
        }
        this.currentPage = 1;
        this.render();
      });
    });
  }
}