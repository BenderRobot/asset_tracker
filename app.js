// benderrobot/asset_tracker/asset_tracker-d2b20147fdbaa70dfad9c7d62d05505272e63ca2/app.js

// ========================================
// app.js - (v12 - Chargement Non-Bloquant)
// ========================================
import { Storage } from './storage.js';
import { PriceAPI } from './api.js?v=4';
import { UIComponents } from './ui.js';
import { FilterManager } from './filters.js';
import { AchatsPage } from './achatsPage.js?v=6';
import { InvestmentsPage } from './investmentsPage.js?v=9';
import { HistoricalChart } from './historicalChart.js?v=9';
import { DataManager } from './dataManager.js?v=7';
import { initMarketStatus } from './marketStatus.js?v=3'; // Import corrigé
import { ASSET_TYPES, BROKERS, AUTO_REFRESH_INTERVAL, AUTO_REFRESH_ENABLED } from './config.js';

class App {
  constructor() {
    this.storage = new Storage();
    this.api = new PriceAPI(this.storage); 
    this.brokersList = BROKERS;
    this.dataManager = new DataManager(this.storage, this.api); 
    this.ui = new UIComponents(this.storage);
    this.filterManager = new FilterManager(this.storage);
    
    // Initialisation du statut marché via la fonction helper
    this.marketStatus = initMarketStatus(this.storage);

    // On passe marketStatus aux pages
    this.achatsPage = new AchatsPage(this.storage, this.api, this.ui, this.filterManager, this.dataManager, this.marketStatus);
    this.investmentsPage = new InvestmentsPage(this.storage, this.api, this.ui, this.filterManager, this.dataManager, this.brokersList, this.marketStatus); 

    if (this.isInvestmentsPage()) { 
      this.historicalChart = new HistoricalChart(this.storage, this.dataManager, this.ui, this.investmentsPage); 
      this.investmentsPage.setHistoricalChart(this.historicalChart);
    }

    this.searchQuery = '';
    this.isRefreshing = false;
    this.autoRefreshTimer = null;
  }

  async setupCashFormListener() {
    const form = document.getElementById('cash-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        try {
            const type = document.getElementById('cash-type').value; // "Dépôt" ou "Retrait"
            const amount = parseFloat(document.getElementById('cash-amount').value);
            const finalAmount = (type === 'Retrait' ? -amount : amount);

            const cashMovement = {
                ticker: 'CASH',
                name: type, 
                price: finalAmount, 
                date: document.getElementById('date').value, // Utiliser la date du formulaire Actif
                quantity: 1, 
                currency: 'EUR',
                assetType: 'Cash',
                broker: document.getElementById('cash-broker').value
            };

            if (!cashMovement.date || !cashMovement.broker || !cashMovement.price) {
                alert('Tous les champs sont requis pour le mouvement de cash.');
                return;
            }

            this.storage.addPurchase(cashMovement);
            form.reset();

            await this.achatsPage.render(this.searchQuery);
            this.showNotification('Mouvement de cash ajouté', 'success');

        } catch (error) {
            console.error('Erreur ajout cash:', error);
            alert('Erreur: ' + error.message);
        }
    });
  }

  async init() {
    console.log('Initialisation de l\'application...'); 

    // 1. Initialiser le taux de conversion (rapide)
    await this.initConversionRates();

    this.storage.cleanExpiredCache();
    this.filterManager.updateTickerFilter(() => this.renderCurrentPage());

    this.populateAssetTypeAndBrokerSelects();

    // 2. RENDER INITIAL RAPIDE (AVEC DONNÉES EN CACHE OU VALEURS PAR DÉFAUT)
    await this.renderCurrentPage(false); // <-- NE PAS FORCER LE REFRESH

    this.setupEventListeners();

    this.addWeekendRefreshButton();

    if (this.historicalChart) { 
      this.historicalChart.setupPeriodButtons();
      this.historicalChart.startAutoRefresh(); 
    }
    
    // 3. LANCER LE REFRESH DES PRIX EN ARRIÈRE-PLAN (NON-BLOQUANT)
    console.log('Lancement du rafraîchissement des prix en arrière-plan...');
    this.refreshPrices().then(() => {
        console.log('Mise à jour des prix terminée. Le tableau est mis à jour.');
        // On relance le render pour afficher les prix à jour
        this.renderCurrentPage(false); 
    }).catch(error => {
        console.error('Erreur lors du rafraîchissement initial non-bloquant:', error);
    });
    
    // Démarrer l'auto-refresh du statut marché (badge header)
    this.marketStatus.startAutoRefresh('market-status-container', 'full');
    this.startAutoRefresh();

    console.log('Application prête (Chargement rapide du tableau effectué)');
  }

  async initConversionRates() {
    const pair = 'USD_TO_EUR';
    const cachedRate = this.storage.getConversionRate(pair);

    if (cachedRate) return; 

    try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=usd&vs_currencies=eur');
        if (!res.ok) throw new Error('Réponse API invalide');
        
        const data = await res.json();
        const rate = data?.usd?.eur;

        if (rate) {
            this.storage.setConversionRate(pair, rate);
        }
    } catch (error) {
        console.error('Échec taux de change:', error.message);
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

    const cashBrokerSelect = document.getElementById('cash-broker');
    if (cashBrokerSelect) {
      cashBrokerSelect.innerHTML = '<option value="">Select Broker</option>' +
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

  async renderCurrentPage(fetchPrices = true) { 
    if (this.isAchatsPage()) {
      await this.achatsPage.render(this.searchQuery, fetchPrices); // <-- PASSER LE FLAG
    } else if (this.isInvestmentsPage()) {
      await this.investmentsPage.render(this.searchQuery, fetchPrices); // <-- PASSER LE FLAG
    }
  }

  setupEventListeners() {
    if (this.isAchatsPage()) {
      this.setupAchatsPageListeners();
      this.setupToggleListener(); // Garde la fonction de bascule
    }
    if (this.isInvestmentsPage()) {
      this.setupInvestmentsPageListeners();
    }
  }

  // Fonction de bascule (non modifiée, elle est OK)
  setupToggleListener() {
    const toggleBtn = document.getElementById('toggle-add-btn');
    const wrapper = document.getElementById('add-transaction-wrapper');
    if (!toggleBtn || !wrapper) return;

    // Initialisation du texte du bouton (important car le bloc est masqué par défaut)
    toggleBtn.innerHTML = '<i class="fas fa-plus"></i> Add';

    toggleBtn.addEventListener('click', () => {
      const isExpanded = wrapper.classList.toggle('expanded');
      
      // Mise à jour du texte du bouton et de l'icône
      const icon = toggleBtn.querySelector('i');
      if (isExpanded) {
        window.scrollTo({ top: 0, behavior: 'smooth' }); 
        toggleBtn.textContent = ' Close';
        icon.className = 'fas fa-times';
        toggleBtn.prepend(icon);
      } else {
        toggleBtn.textContent = ' Add';
        icon.className = 'fas fa-plus';
        toggleBtn.prepend(icon);
      }
    });
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
        await this.refreshPrices(false, true); // Forcer le refresh API
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
    this.achatsPage.setupTabs();
    this.achatsPage.setupSorting();
    this.setupCSVListeners();
    this.setupCashFormListener();
  }

  setupInvestmentsPageListeners() {
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value;
        this.investmentsPage.render(this.searchQuery);
      });
    }

    const refreshBtn = document.getElementById('refresh-prices');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        await this.refreshPrices(false, true);
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

  async refreshPrices(forceWeekend = false, showLoading = true) {
    if (this.isRefreshing) return;

    this.isRefreshing = true;
    const btn = document.getElementById('refresh-prices');
    const originalText = btn?.textContent;

    if (showLoading && btn) {
      btn.disabled = true;
      btn.textContent = 'Refreshing...';
    }

    try {
      if (this.isInvestmentsPage() && this.historicalChart) {
          await this.historicalChart.update(showLoading, true);
      } else {
          const purchases = this.storage.getPurchases();
          const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
          if (tickers.length > 0) {
             await this.api.fetchBatchPrices(tickers, forceWeekend); 
          }
          await this.renderCurrentPage(false); // Rendre avec les nouveaux prix
      }
      
      this.showNotification(forceWeekend ? 'Prix de clôture récupérés !' : 'Prix mis à jour', 'success');
    } catch (error) {
      console.error('Erreur refresh:', error);
      this.showNotification('Erreur de mise à jour', 'error');
    } finally {
      this.isRefreshing = false;
      if (showLoading && btn) {
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
            await this.refreshPrices(true, true);
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

    const importBtn = document.getElementById('import-csv');
    const originalBtnText = importBtn ? importBtn.innerHTML : 'Import CSV';
    const fileNameSpan = document.getElementById('file-name');

    try {
      if (importBtn) {
        importBtn.disabled = true;
        importBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Import...';
      }

      const text = await file.text();
      const worker = new Worker('./csvWorker.js');
      worker.postMessage(text);

      const result = await new Promise((resolve, reject) => {
        worker.onmessage = (e) => {
          if (e.data.error) {
            reject(new Error(e.data.error));
          } else {
            resolve(e.data);
          }
        };
        worker.onerror = (e) => {
          reject(new Error('Erreur du Worker CSV: ' + e.message));
        };
      });
      
      worker.terminate(); 

      const { purchases, count } = result;

      if (count > 0) {
        purchases.forEach(purchase => {
          this.storage.addPurchase(purchase);
        });
      }

      this.filterManager.updateTickerFilter(() => this.renderCurrentPage());
      await this.achatsPage.render(this.searchQuery);

      this.showNotification(`${count} transactions importées`, 'success');

      fileInput.value = '';
      if (fileNameSpan) fileNameSpan.textContent = 'No file chosen';

    } catch (error) {
      alert('Erreur import: ' + error.message);
      this.showNotification('Échec de l\'importation', 'error');
    } finally {
      if (importBtn) {
        importBtn.disabled = false;
        btn.innerHTML = originalBtnText; // Utilisez la variable originale
      }
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
      this.autoRefreshPrices();
      this.autoRefreshTimer = setInterval(() => this.autoRefreshPrices(), AUTO_REFRESH_INTERVAL);
    } else {
      console.log('Marché fermé - Rafraîchissement en pause');
      this.autoRefreshTimer = setInterval(() => {
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
      if (this.isInvestmentsPage() && this.historicalChart) {
          await this.historicalChart.silentUpdate();
      } else {
          const purchases = this.storage.getPurchases();
          const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
          await this.api.fetchBatchPrices(tickers);
          await this.renderCurrentPage(false);
      }
    } catch (error) {
      console.error('Erreur auto-refresh:', error);
    }
  }
}

(async () => {
  const app = new App();
  try {
    await app.init();
  } catch (error) {
    console.error('Erreur fatale:', error); 
    alert('Erreur au démarrage');
  }
})();