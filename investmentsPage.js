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
   * === "Cache-First" ===
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
      // Un actif peut être sur plusieurs brokers, on vérifie si *l'un* d'eux correspond
      const brokers = [...new Set(h.purchases.map(p => p.broker || 'RV-CT'))];

      if (this.currentAssetTypeFilter) {
        if (assetType !== this.currentAssetTypeFilter) return false;
      }
      if (this.currentBrokerFilter) {
        if (!brokers.includes(this.currentBrokerFilter)) return false;
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

  /**
   * ========================================================
   * === FONCTION DE TITRE MISE À JOUR (v3) ===
   * Détermine le titre et l'icône du graphique en fonction
   * des filtres actifs sur la page.
   * ========================================================
   */
  getChartTitleConfig() {
    const selectedTickers = this.filterManager.getSelectedTickers();
    
    // Priorité 1 : Filtre sur UN SEUL ticker (exactement comme le clic)
    if (selectedTickers.size === 1) {
        const ticker = Array.from(selectedTickers)[0];
        // On va chercher le nom complet dans le storage
        const name = this.storage.getPurchases().find(p => p.ticker.toUpperCase() === ticker.toUpperCase())?.name || ticker;
        const icon = this.dataManager.isCryptoTicker(ticker) ? '₿' : '📊';
        
        return {
          mode: 'asset', // IMPORTANT: On dit au graphique que c'est un 'asset'
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

      // === NOUVELLE LOGIQUE D'ICÔNE "SMART" ===
      const assetTypes = tickers.map(t => this.dataManager.isCryptoTicker(t) ? 'Crypto' : 'Stock');
      const uniqueTypes = [...new Set(assetTypes)];
      
      let icon = '📈'; // '📈' (générique) est le fallback pour une sélection mixte
      if (uniqueTypes.length === 1) {
        // Tous les actifs sélectionnés sont du même type
        icon = (uniqueTypes[0] === 'Crypto') ? '₿' : '📊';
      }
      // === FIN NOUVELLE LOGIQUE ===

      return {
        mode: 'filter',
        label: label,
        icon: icon // Utilise le nouvel icône "smart"
      };
    }
    
    // Priorité 3 : Filtre par Type d'Actif
    if (this.currentAssetTypeFilter) {
      let icon = '📊'; // Défaut
      if (this.currentAssetTypeFilter === 'Crypto') icon = '₿';
      if (this.currentAssetTypeFilter === 'Stock') icon = '📊';
      if (this.currentAssetTypeFilter === 'ETF') icon = '🌍'; // Icône "monde" pour ETF
      
      return {
        mode: 'filter',
        label: `${this.currentAssetTypeFilter}`,
        icon: icon
      };
    }
    
    // Priorité 4 : Filtre par Broker
    if (this.currentBrokerFilter) {
      // Récupère le nom complet du broker (ex: "Boursobank PEA (BB-PEA)")
      const brokerLabel = window.app?.brokersList?.find(b => b.value === this.currentBrokerFilter)?.label || this.currentBrokerFilter;
      
      return {
        mode: 'filter',
        label: `${brokerLabel}`,
        icon: '🏦' // Icône "banque" pour broker
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
    document.querySelectorAll('.asset-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const ticker = row.dataset.ticker;
        
        // Logique pour mettre à jour les cartes (inchangée)
        if (!this.currentHoldings) return;
        const assetHolding = this.currentHoldings.find(h => h.ticker === ticker);
        if (!assetHolding) return;
        
        // Calcule un résumé *juste pour cet actif* pour les cartes
        const assetSummary = this.dataManager.calculateSummary([assetHolding]);
        this.ui.updatePortfolioSummary(assetSummary, assetHolding.purchases.length);
        
        console.log(`📊 Clic sur ${ticker} - Affichage du graphique`);
        
        if (window.app && window.app.historicalChart) {
          // CECI EST LA CLÉ :
          // showAssetChart change le mode du graphique en 'asset'
          // et force l'affichage de cet actif unique.
          window.app.historicalChart.showAssetChart(ticker, assetSummary);
          
          const summaryContainer = document.querySelector('.portfolio-summary-enhanced');
          if (summaryContainer) {
            summaryContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      });
      
      // L'effet de hover est géré par la classe .asset-row:hover dans style.css
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
          // Ceci va vider le set selectedTickers et mettre à jour le dropdown
          this.filterManager.clearAllFilters(); 
        }
        
        this.currentPage = 1;
        
        // ========================================================
        // === POINT CLÉ : Réinitialiser le mode du graphique ===
        // ========================================================
        if (window.app && window.app.historicalChart) {
            // Force le graphique à revenir en mode 'portfolio' (global)
            // au lieu de rester en mode 'asset' si un actif était cliqué
            window.app.historicalChart.currentMode = 'portfolio';
            window.app.historicalChart.selectedAssets = [];
        }
    
        // Relance le cycle de render.
        // `loadPageWithCacheFirst` sera appelé,
        // qui appellera `getChartTitleConfig`,
        // qui ne trouvera aucun filtre et retournera "Portfolio Global"
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
        
        // Mettre à jour les classes CSS pour les flèches
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