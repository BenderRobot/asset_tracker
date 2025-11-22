// ========================================
// investmentsPage.js - (v12 - Fix Filtres & Tri)
// ========================================

import { PAGE_SIZE } from './config.js';
import { formatCurrency, formatPercent, formatQuantity } from './utils.js';

export class InvestmentsPage {
  constructor(storage, api, ui, filterManager, dataManager, brokersList) {
    this.storage = storage;
    this.api = api;
    this.ui = ui;
    this.filterManager = filterManager;
    this.dataManager = dataManager;
    this.brokersList = brokersList;
    this.historicalChart = null;
    this.currentPage = 1;
    this.sortColumn = 'dayPct';
    this.sortDirection = 'desc';
    this.currentAssetTypeFilter = '';
    this.currentBrokerFilter = '';
    
    this.currentHoldings = []; 
    this.currentSearchQuery = ''; 
  }

  // Injection de dépendance pour le graphique
  setHistoricalChart(chartInstance) {
    this.historicalChart = chartInstance;
  }

  /**
   * ========================================================
   * === Rendu Principal (Cache-First) ===
   * ========================================================
   */
  async render(searchQuery = '') {
    // Stocke la query pour usage ultérieur (tri, filtres, graph)
    this.currentSearchQuery = searchQuery;
    
    const tbody = document.querySelector('#investments-table tbody');
    if (!tbody) return;
    
    // Loader temporaire dans le tableau
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:20px;">Chargement des données...</td></tr>';
    
    if (this.historicalChart) {
      // Le graphique gère le chargement initial et appelle renderData une fois prêt
      await this.historicalChart.loadPageWithCacheFirst(); 
    } else {
        console.error("Erreur: historicalChart n'est pas initialisé.");
        this.renderData([], { 
            totalInvestedEUR: 0, totalCurrentEUR: 0, totalDayChangeEUR: 0, 
            gainTotal: 0, gainPct: 0, dayChangePct: 0, 
            assetsCount: 0, movementsCount: 0 
        }, 0);
    }
  }

  /**
   * ========================================================
   * === Rendu des Données (Tableau + Cartes) ===
   * ========================================================
   */
  renderData(holdings, summary, cashReserveTotal) {
    // Mise à jour de la référence locale des données
    this.currentHoldings = holdings;

    const tbody = document.querySelector('#investments-table tbody');
    if (!tbody) return;

    // === CORRECTION ICI : Récupération des tickers sélectionnés ===
    const selectedTickers = this.filterManager.getSelectedTickers();
    // ============================================================

    // 1. Appliquer les filtres (Type / Broker / Ticker / Recherche)
    let filteredHoldings = this.currentHoldings.filter(h => {
      
      // --- Filtre Prioritaire : Sélection Ticker via Menu Déroulant ---
      if (selectedTickers.size > 0) {
        if (!selectedTickers.has(h.ticker.toUpperCase())) {
            return false;
        }
      }
      // ---------------------------------------------------------------

      // Filtres contextuels (Type d'actif et Broker)
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

    // 2. Tri
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

    // 3. Pagination
    const totalPages = Math.max(1, Math.ceil(filteredHoldings.length / PAGE_SIZE));
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    const pageItems = filteredHoldings.slice((this.currentPage - 1) * PAGE_SIZE, this.currentPage * PAGE_SIZE);

    // 4. Génération HTML du tableau
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

    // 5. Mise à jour du résumé global (Cartes en haut de page)
    this.ui.updatePortfolioSummary(summary, summary.movementsCount, cashReserveTotal);

    // 6. Mise à jour de la pagination
    this.ui.renderPagination(this.currentPage, totalPages, (page) => {
      this.currentPage = page;
      // Rappel récursif avec les mêmes données pour changer de page
      this.renderData(this.currentHoldings, summary, cashReserveTotal);
    });
    
    // Mise à jour du sélecteur de ticker (si nécessaire pour l'UI) et attachement des événements
    this.ui.populateTickerSelect(this.storage.getPurchases());
    this.attachRowClickListeners();
  }

  /**
   * ========================================================
   * === Configuration du Titre du Graphique ===
   * ========================================================
   */
  getChartTitleConfig() {
    const selectedTickers = this.filterManager.getSelectedTickers();
    
    // Cas 1 : Un seul ticker sélectionné
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

    // Cas 2 : Plusieurs tickers sélectionnés
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
    
    // Cas 3 : Filtre par Type d'Actif
    if (this.currentAssetTypeFilter) {
      let icon = '📊';
      if (this.currentAssetTypeFilter === 'Crypto') icon = '₿';
      else if (this.currentAssetTypeFilter === 'Stock') icon = '📊';
      else if (this.currentAssetTypeFilter === 'ETF') icon = '🌍';
      
      return {
        mode: 'filter',
        label: `${this.currentAssetTypeFilter}`,
        icon: icon
      };
    }
    
    // Cas 4 : Filtre par Broker
    if (this.currentBrokerFilter) {
      const brokerLabel = this.brokersList?.find(b => b.value === this.currentBrokerFilter)?.label || this.currentBrokerFilter;
      return {
        mode: 'filter',
        label: `${brokerLabel}`,
        icon: '🏦'
      };
    }
    
    // Cas 5 : Vue Globale (Défaut)
    return {
      mode: 'global',
      label: 'Portfolio Global',
      icon: '📈'
    };
  }

  /**
   * ========================================================
   * === Gestionnaires d'événements ===
   * ========================================================
   */
  attachRowClickListeners() {
    document.querySelectorAll('.asset-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const ticker = row.dataset.ticker;
        
        if (!this.currentHoldings) return;
        const assetHolding = this.currentHoldings.find(h => h.ticker === ticker);
        if (!assetHolding) return;
        
        // Calculer un résumé rapide pour l'actif cliqué
        const assetSummary = this.dataManager.calculateSummary([assetHolding]);
        
        // Mise à jour des cartes du haut pour l'actif sélectionné (Cash = 0)
        this.ui.updatePortfolioSummary(assetSummary, assetHolding.purchases.length, 0);
        
        if (this.historicalChart) {
          this.historicalChart.showAssetChart(ticker, assetSummary);
          
          // Scroll fluide vers le graphique
          const summaryContainer = document.querySelector('.portfolio-summary-enhanced');
          if (summaryContainer) {
            summaryContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      });
    });
  }

  setupFilters() {
    // Filtre Type d'actif
    const assetTypeFilter = document.getElementById('filter-asset-type');
    if (assetTypeFilter) {
      assetTypeFilter.addEventListener('change', (e) => {
        this.currentAssetTypeFilter = e.target.value;
        this.currentPage = 1;
        this.render(this.currentSearchQuery); 
      });
    }
    
    // Filtre Broker
    const brokerFilter = document.getElementById('filter-broker');
    if (brokerFilter) {
      brokerFilter.addEventListener('change', (e) => {
        this.currentBrokerFilter = e.target.value;
        this.currentPage = 1;
        this.render(this.currentSearchQuery);
      });
    }
    
    // Bouton "Clear Filters"
    const clearFiltersBtn = document.getElementById('clear-filters');
    if (clearFiltersBtn) {
      clearFiltersBtn.addEventListener('click', () => {
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
        
        // Réinitialiser le graphique en mode portfolio
        if (this.historicalChart) {
            this.historicalChart.currentMode = 'portfolio';
            this.historicalChart.selectedAssets = [];
        }
    
        this.render(''); 
      });
    }
  }

  setupSorting() {
    document.querySelectorAll('th[data-sort]').forEach(th => {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        
        // Inversion de la direction ou changement de colonne
        if (this.sortColumn === col) {
          this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          this.sortColumn = col;
          this.sortDirection = 'asc';
        }
        
        // Mise à jour visuelle des en-têtes
        document.querySelectorAll('th[data-sort]').forEach(header => {
          header.classList.remove('sort-asc', 'sort-desc');
        });
        th.classList.add(`sort-${this.sortDirection}`);
        
        this.currentPage = 1;
        // Re-rendu avec les paramètres de tri
        this.render(this.currentSearchQuery);
      });
    });
  }
}