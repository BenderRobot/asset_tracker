// ========================================
// investmentsPage.js - Page Mes Investissements (Architecture "Zéro Incohérence")
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
    this.currentSearchQuery = ''; // Stocke la query pour le graphique
  }

  /**
   * ========================================================
   * === MODIFICATION "Cache-First" ===
   * 'render' appelle maintenant 'loadPageWithCacheFirst'
   * ========================================================
   */
  async render(searchQuery = '') {
    console.log('InvestmentsPage.render() appelé. Délégation au graphique...');
    this.currentSearchQuery = searchQuery;
    
    const tbody = document.querySelector('#investments-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:20px;">Chargement du cache...</td></tr>';
    
    // On appelle la nouvelle fonction de chargement "Cache-First"
    if (window.app && window.app.historicalChart) {
      // (Cette fonction gérera le rendu et le refresh API en arrière-plan)
      await window.app.historicalChart.loadPageWithCacheFirst(); 
    } else {
        console.error("Erreur: historicalChart n'est pas initialisé.");
    }
  }

  /**
   * ========================================================
   * === "ZÉRO INCOHÉRENCE" ===
   * Appelée par historicalChart.js lorsque les données
   * (holdings et summary) sont prêtes et unifiées.
   * ========================================================
   */
  renderData(holdings, summary) {
    console.log('InvestmentsPage.renderData() appelé par le graphique.');
    
    const tbody = document.querySelector('#investments-table tbody');
    if (!tbody) return;

    // 1. Appliquer les filtres de la page (non-graphique)
    let filteredHoldings = holdings.filter(h => {
      // Utilise les données du premier achat pour les filtres
      const assetType = h.purchases[0]?.assetType || 'Stock';
      const broker = h.purchases[0]?.broker || 'RV-CT';

      if (this.currentAssetTypeFilter) {
        if (assetType !== this.currentAssetTypeFilter) return false;
      }
      if (this.currentBrokerFilter) {
        if (broker !== this.currentBrokerFilter) return false;
      }
      return true;
    });

    // Mettre à jour la liste des holdings
    this.currentHoldings = filteredHoldings;

    // 2. Trier
    filteredHoldings.sort((a, b) => {
      const valA = a[this.sortColumn] ?? -Infinity;
      const valB = b[this.sortColumn] ?? -Infinity;
      const order = valA < valB ? -1 : valA > valB ? 1 : 0;
      return order * (this.sortDirection === 'asc' ? 1 : -1);
    });

    // 3. Pagination
    const totalPages = Math.max(1, Math.ceil(filteredHoldings.length / PAGE_SIZE));
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    const pageItems = filteredHoldings.slice((this.currentPage - 1) * PAGE_SIZE, this.currentPage * PAGE_SIZE);

    // 4. Affichage du tableau
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

    // 5. Mettre à jour l'UI avec le résumé (les cartes)
    // IMPORTANT: 'summary' vient directement du graphique
    this.ui.updatePortfolioSummary(summary, summary.movementsCount);

    // 6. Reste
    this.ui.renderPagination(this.currentPage, totalPages, (page) => {
      this.currentPage = page;
      this.renderData(holdings, summary); // Re-render SANS fetch
    });
    
    this.ui.populateTickerSelect(this.storage.getPurchases());
    this.attachRowClickListeners();
  }

  // (Cette fonction n'est plus utilisée, le graphique gère son propre update)
  // async updateChart(filtered, searchQuery, summary) { ... }

  attachRowClickListeners() {
    document.querySelectorAll('.asset-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const ticker = row.dataset.ticker;
        
        // Logique pour mettre à jour les cartes (inchangée)
        if (!this.currentHoldings) return;
        const assetHolding = this.currentHoldings.find(h => h.ticker === ticker);
        if (!assetHolding) return;
        const assetSummary = this.dataManager.calculateSummary([assetHolding]);
        this.ui.updatePortfolioSummary(assetSummary, 1);
        
        console.log(`📊 Clic sur ${ticker} - Affichage du graphique`);
        
        if (window.app && window.app.historicalChart) {
          window.app.historicalChart.showAssetChart(ticker, assetSummary);
          
          const summaryContainer = document.querySelector('.portfolio-summary-enhanced');
          if (summaryContainer) {
            summaryContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      });
      
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
        this.render(this.currentSearchQuery); // Relance le cycle de render
      });
    }
    
    const brokerFilter = document.getElementById('filter-broker');
    if (brokerFilter) {
      brokerFilter.addEventListener('change', (e) => {
        this.currentBrokerFilter = e.target.value;
        this.currentPage = 1;
        this.render(this.currentSearchQuery); // Relance le cycle de render
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
          this.currentSearchQuery = '';
        }
        
        if (this.filterManager) {
          this.filterManager.clearAllFilters();
        }
        
        this.currentPage = 1;
        this.render(''); // Relance le cycle de render
        
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
        this.render(this.currentSearchQuery); // Relance le cycle de render
      });
    });
  }
}