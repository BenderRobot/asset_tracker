// ========================================
// app.js - Application principale (Câblage "Zéro Incohérence")
// ========================================
import { Storage } from './storage.js';
import { PriceAPI } from './api.js?v=4'; // v4 (inchangé)
import { UIComponents } from './ui.js';
import { FilterManager } from './filters.js';

// === CORRECTION : Mise à jour des versions ===
import { AchatsPage } from './achatsPage.js?v=6';
import { InvestmentsPage } from './investmentsPage.js?v=6';
import { HistoricalChart } from './historicalChart.js?v=6';
import { DataManager } from './dataManager.js?v=6';
// ===========================================

import { initMarketStatus } from './marketStatus.js';
import { ASSET_TYPES, BROKERS, AUTO_REFRESH_INTERVAL, AUTO_REFRESH_ENABLED } from './config.js';


class App {
  constructor() {
    this.storage = new Storage();
    this.api = new PriceAPI(this.storage); 

    // === LE BON CÂBLAGE ===
    this.dataManager = new DataManager(this.storage, this.api); 
    this.ui = new UIComponents(this.storage);
    this.filterManager = new FilterManager(this.storage);
    this.marketStatus = initMarketStatus(this.storage);

    // ==========================================================
    // === CORRECTION : dataManager est maintenant passé ===
    // ==========================================================
    this.achatsPage = new AchatsPage(this.storage, this.api, this.ui, this.filterManager, this.dataManager);
    // ==========================================================
    
    this.investmentsPage = new InvestmentsPage(this.storage, this.api, this.ui, this.filterManager, this.dataManager); 

    if (this.isInvestmentsPage()) { 
      // === MODIFICATION "ZÉRO INCOHÉRENCE" ===
      // Le graphique a besoin de 'ui' pour mettre à jour les cartes
      // et de 'investmentsPage' pour mettre à jour le tableau.
      this.historicalChart = new HistoricalChart(
          this.storage, 
          this.dataManager, 
          this.ui, 
          this.investmentsPage
      ); 
      // ==========================================
    }
    // === FIN CÂBLAGE ===

    this.searchQuery = '';
    this.isRefreshing = false;
    this.autoRefreshTimer = null;
  }

  async init() {
    console.log('Initialisation de l\'application...'); 

    // Afficher l'état du marché
    this.updateMarketStatus();

    this.storage.cleanExpiredCache();
    this.filterManager.updateTickerFilter(() => this.renderCurrentPage());

    // Peupler les selects d'asset type et broker
    this.populateAssetTypeAndBrokerSelects();

    // ==========================================================
    // === MODIFICATION : renderCurrentPage s'occupe de tout ===
    // ==========================================================
    // 'renderCurrentPage' va appeler 'investmentsPage.render',
    // qui va maintenant afficher le loader, puis charger le tableau,
    // puis charger le graphique (et cacher le loader).
    await this.renderCurrentPage(); 
    // ==========================================================

    this.setupEventListeners();

    // Ajouter le bouton spécial weekend si nécessaire
    this.addWeekendRefreshButton();

    // ==========================================================
    // === MODIFICATION : On déplace l'init du graphique ici ===
    // ==========================================================
    // On retire l'ancien appel 'historicalChart.init()' qui
    // rechargeait le graphique inutilement.
    if (this.historicalChart) { 
      // On attache juste les boutons de période (1D, 1W, etc.)
      this.historicalChart.setupPeriodButtons();
      // On démarre l'auto-refresh *du graphique*
      this.historicalChart.startAutoRefresh(); 
    }
    // ==========================================================

    // Démarrer le rafraîchissement automatique
    this.startAutoRefresh();
    console.log('Application prête');
  }

  updateMarketStatus() {
    if (this.marketStatus) {
      this.marketStatus.injectStatusBadge('market-status-container');
    }
  }

  populateAssetTypeAndBrokerSelects() {
    const assetTypeSelect = document.getElementById('asset-type-select');
    if (assetTypeSelect) {
      assetTypeSelect.innerHTML = '<option value="">Select Asset Type</option>' +
        ASSET_TYPES.map(type => `<option value="${type}">${type}</option>`).join('');
    }

    const editAssetTypeSelect = document.getElementById('edit-asset-type');
    if (editAssetTypeSelect) {
      editAssetTypeSelect.innerHTML = ASSET_TYPES.map(type =>
        `<option value="${type}">${type}</option>`
      ).join('');
    }

    const brokerSelect = document.getElementById('broker-select');
    if (brokerSelect) {
      brokerSelect.innerHTML = '<option value="">Select Broker</option>' +
        BROKERS.map(broker => `<option value="${broker.value}">${broker.label}</option>`).join('');
    }
  }

  isAchatsPage() {
    return window.location.pathname.endsWith('index.html') ||
           window.location.pathname === '/' ||
           window.location.pathname.endsWith('/');
  }

  isInvestmentsPage() {
    return window.location.pathname.includes('investments.html'); 
  }

  async renderCurrentPage() { 
    if (this.isAchatsPage()) {
      await this.achatsPage.render(this.searchQuery);
    } else if (this.isInvestmentsPage()) {
      // MODIFICATION : On passe la query au 'render' de investmentsPage
      // C'est lui qui la passera au graphique.
      await this.investmentsPage.render(this.searchQuery); 
    }
  }

  setupEventListeners() {
    if (this.isAchatsPage()) {
      this.setupAchatsPageListeners();
    }
    if (this.isInvestmentsPage()) {
      this.setupInvestmentsPageListeners();
    }
  }

  setupAchatsPageListeners() {
    const form = document.getElementById('purchase-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.addPurchase();
      });
    }

    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value;
        this.achatsPage.render(this.searchQuery);
      });
    }

    const refreshBtn = document.getElementById('refresh-prices');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        await this.refreshPrices();
      });
    }

    const clearFiltersBtn = document.getElementById('clear-filters');
    if (clearFiltersBtn) {
      clearFiltersBtn.addEventListener('click', () => {
        this.searchQuery = '';
        if (searchInput) searchInput.value = '';
        this.filterManager.clearAllFilters();
      });
    }

    const assetTypeFilter = document.getElementById('filter-asset-type');
    if (assetTypeFilter) {
      assetTypeFilter.addEventListener('change', (e) => {
        this.filterManager.setAssetTypeFilter(e.target.value);
      });
    }

    const brokerFilter = document.getElementById('filter-broker');
    if (brokerFilter) {
      brokerFilter.addEventListener('change', (e) => {
        this.filterManager.setBrokerFilter(e.target.value);
      });
    }

    this.achatsPage.setupSorting();
    this.setupCSVListeners();
  }

  setupInvestmentsPageListeners() {
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value;
        // MODIFICATION : On relance le render global
        this.investmentsPage.render(this.searchQuery);
      });
    }

    const refreshBtn = document.getElementById('refresh-prices');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        await this.refreshPrices();
      });
    }

    this.investmentsPage.setupSorting();
    this.investmentsPage.setupFilters();
  }

  async addPurchase() {
    try {
      const purchase = {
        ticker: document.getElementById('ticker').value.toUpperCase().trim(),
        name: document.getElementById('name').value.trim(),
        price: parseFloat(document.getElementById('price').value),
        date: document.getElementById('date').value,
        quantity: parseFloat(document.getElementById('quantity').value),
        currency: document.getElementById('currency-select').value,
        assetType: document.getElementById('asset-type-select').value,
        broker: document.getElementById('broker-select').value
      };

      if (!purchase.ticker || !purchase.name || !purchase.price ||
          !purchase.date || !purchase.quantity || !purchase.currency ||
          !purchase.assetType || !purchase.broker) {
        alert('Tous les champs sont requis');
        return;
      }

      this.storage.addPurchase(purchase);
      document.getElementById('purchase-form').reset();

      this.filterManager.updateTickerFilter(() => this.renderCurrentPage());
      await this.achatsPage.render(this.searchQuery);

      this.showNotification('Transaction ajoutée', 'success');
    } catch (error) {
      console.error('Erreur ajout:', error);
      alert('Erreur: ' + error.message);
    }
  }

  async refreshPrices(forceWeekend = false) {
    if (this.isRefreshing) return;

    this.isRefreshing = true;
    const btn = document.getElementById('refresh-prices');
    const originalText = btn?.textContent;

    const isWeekend = new Date().getDay() === 0 || new Date().getDay() === 6;

    if (btn) {
      btn.disabled = true;
      btn.textContent = forceWeekend ? 'Récupération douce...' : isWeekend ? 'Weekend Mode...' : 'Refreshing...';
    }

    try {
      // ==========================================================
      // === MODIFICATION "ZÉRO INCOHÉRENCE" ===
      // On ne rafraîchit PAS l'API ici. On se contente de
      // forcer le graphique à se mettre à jour.
      // Le graphique rafraîchira l'API ET le reste de la page.
      
      if (this.isInvestmentsPage() && this.historicalChart) {
          console.log('Rafraîchissement déclenché... Le graphique prend la main.');
          await this.historicalChart.update(true, true); // (showLoading = true, forceApi = true)
      } else {
          // Comportement normal pour les autres pages
          const purchases = this.storage.getPurchases();
          const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
          if (tickers.length > 0) {
             await this.api.fetchBatchPrices(tickers, forceWeekend); 
          }
          await this.renderCurrentPage();
      }
      // ==========================================================
      
      this.updateMarketStatus();

      this.showNotification(forceWeekend ? 'Prix de clôture récupérés !' : 'Prix mis à jour', 'success');
    } catch (error) {
      console.error('Erreur refresh:', error);
      this.showNotification('Erreur de mise à jour', 'error');
    } finally {
      this.isRefreshing = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  }

  hasEmptyCache() {
    const purchases = this.storage.getPurchases();
    const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
    let emptyCount = 0;
    tickers.forEach(ticker => {
      const cached = this.storage.getCurrentPrice(ticker);
      if (!cached || !cached.price) emptyCount++;
    });
    return emptyCount > tickers.length / 2;
  }

  addWeekendRefreshButton() {
    const isWeekend = new Date().getDay() === 0 || new Date().getDay() === 6;
    if (isWeekend && this.hasEmptyCache()) {
      const refreshBtn = document.getElementById('refresh-prices');
      if (refreshBtn && !document.getElementById('force-weekend-refresh')) {
        const forceBtn = document.createElement('button');
        forceBtn.id = 'force-weekend-refresh';
        forceBtn.className = 'btn-weekend';
        forceBtn.innerHTML = 'Récupérer les prix de clôture du vendredi';
        forceBtn.style.cssText = `
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white; padding: 12px 20px; border: none; border-radius: 8px;
          font-weight: 600; cursor: pointer; box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
          transition: all 0.3s; margin-left: 10px;
        `;

        forceBtn.addEventListener('mouseover', () => {
          forceBtn.style.transform = 'translateY(-2px)';
          forceBtn.style.boxShadow = '0 6px 16px rgba(102, 126, 234, 0.5)';
        });

        forceBtn.addEventListener('mouseout', () => {
          forceBtn.style.transform = 'translateY(0)';
          forceBtn.style.boxShadow = '0 4px 12px rgba(102, 126, 234, 0.4)';
        });

        forceBtn.addEventListener('click', async () => {
          const count = this.storage.getPurchases().filter((v, i, a) => a.findIndex(t => t.ticker === v.ticker) === i).length;
          const confirm = window.confirm(
            `Récupération des prix de clôture du vendredi\n\n` +
            `• Batches de 1 ticker\n` +
            `• Pause de 3s entre chaque\n` +
            `• Durée: ~${Math.ceil(count * 3)} secondes\n\n` +
            `Continuer ?`
          );
          if (confirm) {
            await this.refreshPrices(true);
            forceBtn.remove();
          }
        });

        refreshBtn.parentNode.insertBefore(forceBtn, refreshBtn.nextSibling);
      }
    }
  }

  setupCSVListeners() {
    const chooseFileBtn = document.getElementById('choose-file-btn');
    const fileInput = document.getElementById('csv-file');
    const fileNameSpan = document.getElementById('file-name');
    const importBtn = document.getElementById('import-csv');
    const exportBtn = document.getElementById('export-csv');

    if (chooseFileBtn && fileInput) {
      chooseFileBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file && fileNameSpan) fileNameSpan.textContent = file.name;
      });
    }

    if (importBtn) importBtn.addEventListener('click', () => this.importCSV());
    if (exportBtn) exportBtn.addEventListener('click', () => this.exportCSV());
  }

  async importCSV() {
    const fileInput = document.getElementById('csv-file');
    const file = fileInput?.files[0];
    if (!file) return alert('Sélectionnez un fichier CSV');

    try {
      const text = await file.text();
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length < 2) return alert('CSV vide ou invalide');

      const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
      let imported = 0;

      lines.slice(1).forEach(line => {
        const values = line.split(',').map(v => v.trim());
        const purchase = {};
        headers.forEach((h, i) => {
          if (h === 'ticker') purchase.ticker = values[i];
          else if (h === 'name') purchase.name = values[i];
          else if (h === 'price') purchase.price = parseFloat(values[i]);
          else if (h === 'date') purchase.date = values[i];
          else if (h === 'quantity') purchase.quantity = parseFloat(values[i]);
          else if (h === 'currency') purchase.currency = values[i];
          else if (h.includes('asset')) purchase.assetType = values[i];
          else if (h === 'broker') purchase.broker = values[i];
        });

        if (purchase.ticker && purchase.name && purchase.price && purchase.date && purchase.quantity) {
          purchase.currency = purchase.currency || 'EUR';
          purchase.assetType = purchase.assetType || 'Stock';
          purchase.broker = purchase.broker || 'RV-CT';
          this.storage.addPurchase(purchase);
          imported++;
        }
      });

      this.filterManager.updateTickerFilter(() => this.renderCurrentPage());
      await this.achatsPage.render(this.searchQuery);
      this.showNotification(`${imported} transactions importées`, 'success');

      fileInput.value = '';
      if (fileNameSpan) fileNameSpan.textContent = 'No file chosen';
    } catch (error) {
      alert('Erreur import: ' + error.message);
    }
  }

  exportCSV() {
    const purchases = this.storage.getPurchases();
    if (!purchases.length) return alert('Aucune transaction');

    const headers = ['ticker', 'name', 'price', 'date', 'quantity', 'currency', 'assetType', 'broker'];
    const csv = [
      headers.join(','),
      ...purchases.map(p => [
        p.ticker, p.name, p.price, p.date, p.quantity,
        p.currency || 'EUR', p.assetType || 'Stock', p.broker || 'RV-CT'
      ].join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `portfolio_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    this.showNotification('CSV exporté', 'success');
  }

  showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    notification.style.cssText = `
      position: fixed; top: 20px; right: 20px; padding: 15px 20px;
      background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : type === 'warning' ? '#fbbf24' : '#3b82f6'};
      color: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 10000; font-weight: 600;
    `;
    document.body.appendChild(notification);
    setTimeout(() => {
      notification.style.opacity = '0';
      notification.style.transition = 'opacity 0.3s';
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  startAutoRefresh() {
    if (!AUTO_REFRESH_ENABLED) return console.log('Rafraîchissement auto désactivé');

    const marketOpen = this.storage.isMarketOpen();
    if (marketOpen) {
      console.log(`Rafraîchissement auto toutes les ${AUTO_REFRESH_INTERVAL / 60000} min`);
      this.autoRefreshPrices(); // Lancement immédiat
      this.autoRefreshTimer = setInterval(() => this.autoRefreshPrices(), AUTO_REFRESH_INTERVAL);
    } else {
      console.log('Marché fermé - Rafraîchissement en pause');
      this.autoRefreshTimer = setInterval(() => {
        // Vérifie toutes les 30min si le marché a ouvert
        if (this.storage.isMarketOpen()) {
          this.stopAutoRefresh();
          this.startAutoRefresh();
        }
      }, 30 * 60 * 1000);
    }
  }

  stopAutoRefresh() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  async autoRefreshPrices() {
    if (this.isRefreshing) return;
    console.log('Rafraîchissement auto...');
    try {
      // ==========================================================
      // === MODIFICATION "ZÉRO INCOHÉRENCE" ===
      if (this.isInvestmentsPage() && this.historicalChart) {
          await this.historicalChart.silentUpdate(); // Le graphique gère tout
      } else {
          // Comportement normal pour les autres pages
          const tickers = [...new Set(this.storage.getPurchases().map(p => p.ticker.toUpperCase()))];
          await this.api.fetchBatchPrices(tickers);
          await this.renderCurrentPage();
      }
      // ==========================================================

    } catch (error) {
      console.error('Erreur auto-refresh:', error);
    }
  }
}

// === INITIALISATION ===
(async () => {
  const app = new App();
  window.app = app;
  try {
    await app.init();
  } catch (error) {
    console.error('Erreur fatale:', error); 
    alert('Erreur au démarrage');
  }
})();