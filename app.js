// benderrobot/asset_tracker/asset_tracker-52109016fe138d6ac9b283096e2de3cfbb9437bb/app.js

// ========================================
// app.js - (v13 - FIX INDICES LOADING)
// ========================================
import { Storage } from './storage.js';
import { PriceAPI } from './api.js?v=4';
import { UIComponents } from './ui.js';
import { FilterManager } from './filters.js';
import { AchatsPage } from './achatsPage.js?v=7';
import { InvestmentsPage } from './investmentsPage.js?v=12';
import { HistoricalChart } from './historicalChart.js?v=9';
import { DataManager } from './dataManager.js?v=9';
import { initMarketStatus } from './marketStatus.js?v=3';
import { ASSET_TYPES, BROKERS, AUTO_REFRESH_INTERVAL, AUTO_REFRESH_ENABLED, DASHBOARD_INDICES } from './config.js';


class App {
  constructor() {
    this.storage = new Storage();
    this.api = new PriceAPI(this.storage);
    this.brokersList = BROKERS;
    this.dataManager = new DataManager(this.storage, this.api);
    this.ui = new UIComponents(this.storage);
    this.filterManager = new FilterManager(this.storage);

    this.marketStatus = initMarketStatus(this.storage);

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
        const type = document.getElementById('cash-type').value;
        const amount = parseFloat(document.getElementById('cash-amount').value);
        const finalAmount = (type === 'Retrait' ? -amount : amount);

        const cashMovement = {
          ticker: 'CASH',
          name: type,
          price: finalAmount,
          date: document.getElementById('date').value,
          quantity: 1,
          currency: 'EUR',
          assetType: 'Cash',
          broker: document.getElementById('cash-broker').value
        };

        if (!cashMovement.date || !cashMovement.broker || !cashMovement.price) {
          this.showNotification('Tous les champs sont requis pour le mouvement de cash.', 'warning');
          return;
        }

        this.storage.addPurchase(cashMovement);
        form.reset();

        await this.achatsPage.render(this.searchQuery);
        this.showNotification('Mouvement de cash ajouté', 'success');

      } catch (error) {
        console.error('Erreur ajout cash:', error);
        this.showNotification('Erreur: ' + error.message, 'error');
      }
    });
  }

  async init() {
    console.log('Initialisation de l\'application...');

    await this.initConversionRates();

    this.storage.cleanExpiredCache();
    this.filterManager.updateTickerFilter(() => this.renderCurrentPage());

    this.populateAssetTypeAndBrokerSelects();

    await this.renderCurrentPage(false);

    this.setupEventListeners();

    // Écouter les mises à jour Firestore
    window.addEventListener('purchases-updated', () => {
      console.log('⚡ UI Update triggered by Firestore');
      this.filterManager.updateTickerFilter(() => this.renderCurrentPage(false));
      this.renderCurrentPage(false);
    });

    this.addWeekendRefreshButton();

    if (this.historicalChart) {
      this.historicalChart.setupPeriodButtons();
      this.historicalChart.startAutoRefresh();
    }

    console.log('Lancement du rafraîchissement des prix en arrière-plan...');
    this.refreshPrices().then(() => {
      console.log('Mise à jour des prix terminée. Le tableau est mis à jour.');
      this.renderCurrentPage(false);
    }).catch(error => {
      console.error('Erreur lors du rafraîchissement initial non-bloquant:', error);
    });

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
      await this.achatsPage.render(this.searchQuery, fetchPrices);
    } else if (this.isInvestmentsPage()) {
      await this.investmentsPage.render(this.searchQuery, fetchPrices);
    }
  }

  setupEventListeners() {
    if (this.isAchatsPage()) {
      this.setupAchatsPageListeners();
      this.setupToggleListener();
    }
    if (this.isInvestmentsPage()) {
      this.setupInvestmentsPageListeners();
    }
  }

  setupToggleListener() {
    const toggleBtn = document.getElementById('toggle-add-btn');
    const wrapper = document.getElementById('add-transaction-wrapper');
    if (!toggleBtn || !wrapper) return;

    toggleBtn.innerHTML = '<i class="fas fa-plus"></i> Add';

    toggleBtn.addEventListener('click', () => {
      const isExpanded = wrapper.classList.toggle('expanded');

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

    // Wiring up new Dividend/Header listeners
    this.achatsPage.setupHeaderListeners();

    const refreshBtn = document.getElementById('refresh-prices');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        await this.refreshPrices(false, true);
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

    // --- NOUVEAU: Listener pour le type de transaction (Achat/Vente) ---
    const transactionTypeSelect = document.getElementById('transaction-type');
    const useCashCheckbox = document.getElementById('use-cash');
    const useCashLabel = document.getElementById('use-cash-label');
    const tickerInput = document.getElementById('ticker');
    const tickerSelect = document.getElementById('ticker-select'); // Nouveau select

    if (transactionTypeSelect && useCashCheckbox && tickerInput && tickerSelect) {

      const updateVisibility = () => {
        const isSell = transactionTypeSelect.value === 'sell';

        if (isSell) {
          // MODE VENTE
          useCashCheckbox.style.display = 'none';
          if (useCashLabel) useCashLabel.style.display = 'none';
          useCashCheckbox.checked = false;

          // Swap Input -> Select
          tickerInput.style.display = 'none';
          tickerInput.required = false;
          tickerSelect.style.display = 'block';
          tickerSelect.required = true;

          // Populate Dropdown with Owned Assets
          tickerSelect.innerHTML = '<option value="" disabled selected>Choisir un actif...</option>';

          // On recupère les holdings pour avoir les quantités nettes
          // Note: calculateHoldings est dans dataManager, on va utiliser une méthode simplifiée ou l'appeler via this.dataManager
          // Pour faire simple et robuste, on réutilise this.dataManager.calculateHoldings
          const allPurchases = this.storage.getPurchases();
          const assetPurchases = allPurchases.filter(p => p.assetType !== 'Cash');
          // On ignore le map yesterdayClose pour cette liste simple
          const holdings = this.dataManager.calculateHoldings(assetPurchases);

          holdings.forEach(h => {
            if (h.quantity > 0) {
              const option = document.createElement('option');
              option.value = h.ticker;
              option.textContent = `${h.ticker} - ${h.name} (${parseFloat(h.quantity.toFixed(4))})`;
              option.dataset.name = h.name; // Stocker le nom pour auto-fill
              tickerSelect.appendChild(option);
            }
          });

        } else {
          // MODE ACHAT (Défaut)
          useCashCheckbox.style.display = 'inline-block';
          if (useCashLabel) useCashLabel.style.display = 'inline';

          // Swap Select -> Input
          tickerSelect.style.display = 'none';
          tickerSelect.required = false;
          tickerInput.style.display = 'block';
          tickerInput.required = true;
          tickerInput.value = ''; // Clear input on switch back
        }
      };

      transactionTypeSelect.addEventListener('change', updateVisibility);

      // Listener pour auto-fill le Name quand on choisit dans la liste
      tickerSelect.addEventListener('change', (e) => {
        const selectedOption = tickerSelect.options[tickerSelect.selectedIndex];
        if (selectedOption && selectedOption.dataset.name) {
          const nameInput = document.getElementById('name');
          if (nameInput) nameInput.value = selectedOption.dataset.name;
        }
      });

      updateVisibility(); // Init
    }
    // -------------------------------------------------------------------

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
      const typeSelect = document.getElementById('transaction-type');
      const isSell = typeSelect && typeSelect.value === 'sell';
      const useCash = document.getElementById('use-cash')?.checked;

      // Récupération du Ticker selon le mode
      let tickerValue = '';
      if (isSell) {
        tickerValue = document.getElementById('ticker-select').value;
      } else {
        tickerValue = document.getElementById('ticker').value;
      }

      const purchase = {
        ticker: tickerValue ? tickerValue.toUpperCase().trim() : '',
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
        this.showNotification('Tous les champs sont requis', 'warning');
        return;
      }

      // 1. Gestion VENTE (Quantité négative)
      if (isSell) {
        purchase.quantity = -Math.abs(purchase.quantity);
      }

      // 2. Ajout de la transaction principale
      await this.storage.addPurchase(purchase);

      // 3. Gestion Automatique du Cash
      // Cas A: VENTE -> On crédite le cash du broker (Dépôt)
      // Cas B: ACHAT + "Déduire du Cash" -> On débite le cash du broker (Retrait)

      if (isSell || useCash) {
        const totalAmount = Math.abs(purchase.price * purchase.quantity);
        const cashTransaction = {
          ticker: purchase.currency, // 'EUR' ou 'USD'
          name: 'Cash',
          price: isSell ? totalAmount : -totalAmount, // + si Vente, - si Achat
          date: purchase.date,
          quantity: 1,
          currency: purchase.currency,
          assetType: 'Cash',
          broker: purchase.broker
        };

        await this.storage.addPurchase(cashTransaction);
        this.showNotification(isSell ? 'Vente enregistrée (+ Cash crédité)' : 'Achat enregistré (- Cash débité)', 'success');
      } else {
        this.showNotification('Transaction ajoutée', 'success');
      }

      document.getElementById('purchase-form').reset();
      // Reset manuel du select type car reset() ne le remet pas forcément à 'buy' si c'est la défaut
      if (typeSelect) {
        typeSelect.value = 'buy';
        const evt = new Event('change');
        typeSelect.dispatchEvent(evt);
      }
      this.filterManager.updateTickerFilter(() => this.renderCurrentPage());
      await this.achatsPage.render(this.searchQuery);

    } catch (error) {
      console.error('Erreur ajout:', error);
      this.showNotification('Erreur: ' + error.message, 'error');
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
        let tickers = [...new Set(purchases
          .filter(p => {
            const type = (p.assetType || 'Stock').toLowerCase();
            return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend';
          })
          .map(p => p.ticker.toUpperCase()))];

        // CORRECTION MAJEURE: Inclure tous les tickers d'indices au refresh
        tickers = [...new Set([...tickers, ...DASHBOARD_INDICES])];

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
    if (!file) return this.showNotification('Sélectionnez un fichier CSV', 'warning');

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
        let successCount = 0;
        let failCount = 0;

        for (const purchase of purchases) {
          try {
            await this.storage.addPurchase(purchase);
            successCount++;
          } catch (error) {
            console.error(`Failed to import ${purchase.ticker}:`, error);
            failCount++;
          }
        }

        if (failCount > 0) {
          this.showNotification(`${successCount} réussis, ${failCount} échecs. Vérifiez la console.`, 'warning');
          if (successCount === 0) {
            alert("Toutes les transactions ont échoué. Vérifiez que vous avez bien appliqué les règles de sécurité Firestore dans la console Firebase.");
          }
        } else {
          this.showNotification(`${successCount} transactions importées avec succès`, 'success');
        }
      }

      this.filterManager.updateTickerFilter(() => this.renderCurrentPage());
      await this.achatsPage.render(this.searchQuery);

      this.showNotification(`${count} transactions importées`, 'success');

      fileInput.value = '';
      if (fileNameSpan) fileNameSpan.textContent = 'No file chosen';

    } catch (error) {
      this.showNotification('Erreur import: ' + error.message, 'error');
      this.showNotification('Échec de l\'importation', 'error');
    } finally {
      if (importBtn) {
        importBtn.disabled = false;
        importBtn.innerHTML = originalBtnText;
      }
    }
  }

  exportCSV() {
    const purchases = this.storage.getPurchases();
    if (!purchases.length) return this.showNotification('Aucune transaction', 'warning');

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
        // CRITICAL FIX: Exclude DIVIDEND assets to avoid 400 errors
        let tickers = [...new Set(purchases
          .filter(p => {
            const type = (p.assetType || 'Stock').toLowerCase();
            return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend';
          })
          .map(p => p.ticker.toUpperCase()))];

        // CORRECTION: Inclure les tickers d'indices dans l'auto-refresh
        tickers = [...new Set([...tickers, ...DASHBOARD_INDICES])];

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
    // alert('Erreur au démarrage'); // Supprimé pour éviter de bloquer
  }
})();