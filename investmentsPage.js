// ========================================
// investmentsPage.js - (v11 - Tri Corrigé)
// ========================================

import { PAGE_SIZE } from './config.js';
import { formatCurrency, formatPercent, formatQuantity } from './utils.js';
// (Plus besoin de eventBus si on utilise l'injection de dépendance)

export class InvestmentsPage {
  constructor(storage, api, ui, filterManager, dataManager, brokersList) {
    this.storage = storage;
    this.api = api;
    this.ui = ui;
    this.filterManager = filterManager;
    this.dataManager = dataManager;
    this.brokersList = brokersList; // Propriété pour la liste des brokers
    this.historicalChart = null; // Propriété pour le graphique (sera injecté)
    this.currentPage = 1;
    this.sortColumn = 'dayPct';
    this.sortDirection = 'desc';
    this.currentAssetTypeFilter = '';
    this.currentBrokerFilter = '';
    
    this.currentHoldings = []; 
    this.currentSearchQuery = ''; 
  }

  // AJOUT : Méthode pour l'injection de dépendance
  setHistoricalChart(chartInstance) {
    this.historicalChart = chartInstance;
  }

  /**
   * ========================================================
   * === "Cache-First" ===
   * ========================================================
   */
  async render(searchQuery = '') {
    console.log('InvestmentsPage.render() appelé. Délégation au graphique...');
    this.currentSearchQuery = searchQuery; // Stocke la query pour que le graphique la lise
    
    const tbody = document.querySelector('#investments-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:20px;">Chargement du cache...</td></tr>';
    
    if (this.historicalChart) {
      await this.historicalChart.loadPageWithCacheFirst(); 
    } else {
        console.error("Erreur: historicalChart n'est pas initialisé.");
        // Fallback
        this.renderData([], { totalInvestedEUR: 0, totalCurrentEUR: 0, totalDayChangeEUR: 0, gainTotal: 0, gainPct: 0, dayChangePct: 0, assetsCount: 0, movementsCount: 0 }, 0);
    }
  }

  /**
   * ========================================================
   * === "ZÉRO INCOHÉRENCE" ===
   * MODIFIÉ : Accepte cashReserveTotal
   * ========================================================
   */
  renderData(holdings, summary, cashReserveTotal) {
    console.log('InvestmentsPage.renderData() appelé par le graphique.');
    
    const tbody = document.querySelector('#investments-table tbody');
    if (!tbody) return;

    // 1. Appliquer les filtres de la page (non-graphique)
    let filteredHoldings = holdings.filter(h => {
      const assetType = h.purchases[0]?.assetType || 'Stock';
      const brokers = [...new Set(h.purchases.map(p => p.broker || 'RV-CT'))];

      if (this.currentAssetTypeFilter) {
        if (assetType !== this.currentAssetTypeFilter) return false;
      }
      if (this.currentBrokerFilter) {
        if (!brokers.includes(this.currentBrokerFilter)) return false;
      }
      return true;
    });

    this.currentHoldings = filteredHoldings;

    // 2. Trier
    // MODIFICATION : Logique de tri améliorée
    filteredHoldings.sort((a, b) => {
      const valA = a[this.sortColumn] ?? -Infinity;
      const valB = b[this.sortColumn] ?? -Infinity;
      
      let order;
      if (typeof valA === 'string' && typeof valB === 'string') {
        order = valA.localeCompare(valB);
      } else {
        order = valA < valB ? -1 : valA > valB ? 1 : 0;
      }
      
      return order * (this.sortDirection === 'asc' ? 1 : -1);
    });
    // FIN MODIFICATION

    // 3. Pagination
    const totalPages = Math.max(1, Math.ceil(filteredHoldings.length / PAGE_SIZE));
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    const pageItems = filteredHoldings.slice((this.currentPage - 1) * PAGE_SIZE, this.currentPage * PAGE_SIZE);

    // 4. Affichage du tableau (inchangé)
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
    this.ui.updatePortfolioSummary(summary, summary.movementsCount, cashReserveTotal);

    // 6. Reste
    this.ui.renderPagination(this.currentPage, totalPages, (page) => {
      this.currentPage = page;
      this.renderData(holdings, summary, cashReserveTotal);
    });
    
    this.ui.populateTickerSelect(this.storage.getPurchases());
    this.attachRowClickListeners();
  }

  /**
   * ========================================================
   * === FONCTION DE TITRE MISE À JOUR (v3) ===
   * ========================================================
   */
  getChartTitleConfig() {
    // ... (cette fonction est inchangée) ...
    const selectedTickers = this.filterManager.getSelectedTickers();
    
    // Priorité 1 : Filtre sur UN SEUL ticker (exactement comme le clic)
    if (selectedTickers.size === 1) {
        const ticker = Array.from(selectedTickers)[0];
        const name = this.storage.getPurchases().find(p => p.ticker.toUpperCase() === ticker.toUpperCase())?.name || ticker;
        const icon = this.dataManager.isCryptoTicker(ticker) ? '₿' : '📊';
        
        return {
          mode: 'asset', 
          label: `${ticker} • ${name}`,
          icon: icon
        };
    }

    // Priorité 2 : Filtre sur PLUSIEURS tickers
    if (selectedTickers.size > 1) {
      const tickers = Array.from(selectedTickers);
      let label;
      if (tickers.length > 2) {
        label = `${tickers.slice(0, 2).join(', ')}... (+${tickers.length - 2})`;
      } else {
        label = tickers.join(', '); 
      }

      const assetTypes = tickers.map(t => this.dataManager.isCryptoTicker(t) ? 'Crypto' : 'Stock');
      const uniqueTypes = [...new Set(assetTypes)];
      
      let icon = '📈'; 
      if (uniqueTypes.length === 1) {
        icon = (uniqueTypes[0] === 'Crypto') ? '₿' : '📊';
      }

      return {
        mode: 'filter',
        label: label,
        icon: icon
      };
    }
    
    // Priorité 3 : Filtre par Type d'Actif
    if (this.currentAssetTypeFilter) {
      let icon = '📊'; // Défaut
      if (this.currentAssetTypeFilter === 'Crypto') icon = '₿';
      if (this.currentAssetTypeFilter === 'Stock') icon = '📊';
      if (this.currentAssetTypeFilter === 'ETF') icon = '🌍';
      
      return {
        mode: 'filter',
        label: `${this.currentAssetTypeFilter}`,
        icon: icon
      };
    }
    
    // Priorité 4 : Filtre par Broker
    if (this.currentBrokerFilter) {
      const brokerLabel = this.brokersList?.find(b => b.value === this.currentBrokerFilter)?.label || this.currentBrokerFilter;
      
      return {
        mode: 'filter',
        label: `${brokerLabel}`,
        icon: '🏦'
      };
    }
    
    // Priorité 5 : Vue Globale par défaut
    return {
      mode: 'global',
      label: 'Portfolio Global',
      icon: '📈'
    };
  }

  attachRowClickListeners() {
    // ... (cette fonction est inchangée) ...
    document.querySelectorAll('.asset-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const ticker = row.dataset.ticker;
        
        if (!this.currentHoldings) return;
        const assetHolding = this.currentHoldings.find(h => h.ticker === ticker);
        if (!assetHolding) return;
        
        const assetSummary = this.dataManager.calculateSummary([assetHolding]);
        
        // MODIFIÉ : Quand on clique sur un actif, la réserve de cash affichée est 0
        this.ui.updatePortfolioSummary(assetSummary, assetHolding.purchases.length, 0);
        
        console.log(`📊 Clic sur ${ticker} - Affichage du graphique`);
        
        if (this.historicalChart) {
          this.historicalChart.showAssetChart(ticker, assetSummary);
          
          const summaryContainer = document.querySelector('.portfolio-summary-enhanced');
          if (summaryContainer) {
            summaryContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      });
    });
  }

  setupFilters() {
    // ... (cette fonction est inchangée) ...
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
        
        this.currentSearchQuery = ''; 
        
        if (this.filterManager) {
          this.filterManager.clearAllFilters(); 
        }
        
        this.currentPage = 1;
        
        if (this.historicalChart) {
            this.historicalChart.currentMode = 'portfolio';
            this.historicalChart.selectedAssets = [];
        }
    
        this.render(''); 
        
        console.log('✅ Filtres réinitialisés');
      });
    }
  }

  setupSorting() {
    // ... (cette fonction est inchangée) ...
    document.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (this.sortColumn === col) {
          this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          this.sortColumn = col;
          this.sortDirection = 'asc';
        }
        
        document.querySelectorAll('th[data-sort]').forEach(header => {
          header.classList.remove('sort-asc', 'sort-desc');
        });
        th.classList.add(`sort-${this.sortDirection}`);
        
        this.currentPage = 1;
        this.render(this.currentSearchQuery); // Relance le cycle de render
      });
    });
  }
}