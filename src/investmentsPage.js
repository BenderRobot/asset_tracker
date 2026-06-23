// benderrobot/asset_tracker/asset_tracker-d2b20147fdbaa70dfad9c7d62d05505272e63ca2/investmentsPage.js

// ========================================
// investmentsPage.js - (v11 - Chargement Non-Bloquant)
// ========================================

import { PAGE_SIZE } from './config.js';
import { formatCurrency, formatPercent, formatQuantity } from './utils.js';
import { renderCompanyLogo } from './logoUtils.js';
import { portfolioKPIs } from './portfolioKPIs.js'; // NEW: Centralized KPI management

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
    this.lastChartStats = null; // <-- NOUVEAU

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
    portfolioKPIs.addListener((kpis) => {
      if (!kpis || kpis.source !== 'graph') {
        return;
      }

      console.log('[Investments] ✅ Displaying KPIs from graph:', kpis);

      // Helper function to format currency
      const fmt = (value) => {
        const formatted = Math.abs(value).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
        return value >= 0 ? `${formatted} €` : `-${formatted} €`;
      };

      const fmtPct = (value) => {
        return `${value >= 0 ? '+' : ''}${value.toFixed(2)} %`;
      };

      const updateEl = (id, text, colorClass = null) => {
        const el = document.getElementById(id);
        if (el) {
          el.innerHTML = text; // Use innerHTML to support spans if needed
        }
      };

      // 1. Total Value
      updateEl('total-current', kpis.totalValue.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €');

      const investedEl = document.getElementById('invested');
      if (investedEl) {
        investedEl.textContent = `Invested: ${kpis.invested.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
      }

      // 2. Total Return
      const gainColor = kpis.totalReturn >= 0 ? '#10b981' : '#ef4444';
      updateEl('total-gain-loss', `<span style="color: ${gainColor}">${kpis.totalReturn.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'}</span>`);
      updateEl('total-gain-pct', `<span style="color: ${gainColor}">${fmtPct(kpis.totalReturnPct)}</span>`);

      // 3. Var Today
      const dayColor = kpis.varToday >= 0 ? '#10b981' : '#ef4444';
      updateEl('total-invested', `<span style="color: ${dayColor}">${kpis.varToday.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'}</span>`);

      // Var Today Pct (ID is avg-cost-per-share... terrible naming but correct)
      updateEl('avg-cost-per-share', `<span style="color: ${dayColor}">${fmtPct(kpis.varTodayPct)}</span>`);

      console.log('[Investments] ✅ KPIs displayed successfully via IDs');
    });
  }

  setupChartControls() {
    const toggleContainer = document.getElementById('view-toggle');
    if (toggleContainer) {
      toggleContainer.style.display = 'flex';
      toggleContainer.innerHTML = `
              <div class="toggle-group">
                  <button class="toggle-btn" data-view="global">Valeur (€)</button>
                  <button class="toggle-btn active" data-view="performance">Performance (%)</button>
              </div>
          `;

      const updateToggle = (view) => {
        toggleContainer.querySelectorAll('.toggle-btn').forEach(btn => {
          if (btn.dataset.view === view) btn.classList.add('active');
          else btn.classList.remove('active');
        });

        if (this.historicalChart) {
          this.historicalChart.update(false, false);
        }
      };

      toggleContainer.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const view = e.target.dataset.view;
          updateToggle(view);
        });
      });
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

    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:20px;">Loading...</td></tr>';

    if (fetchPrices) {
      // En mode bloquant, nous devons récupérer les prix avant de charger le graphique
      const purchases = this.storage.getPurchases();
      const tickers = [...new Set(purchases
        .filter(p => {
          const type = (p.assetType || 'Stock').toLowerCase();
          return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend' && type !== 'real estate';
        })
        .map(p => p.ticker.toUpperCase()))];

      if (tickers.length > 0) {
        // === FIRESTORE SYNC LOGIC ===
        const shouldRefresh = await this.storage.marketDataSync.shouldRefreshPrices();

        if (!shouldRefresh) {
          // Follower mode: Load from Firestore
          console.log('[Investments] Loading prices from Firestore (follower mode)');
          const cachedPrices = await this.storage.loadCurrentPrices();
          if (cachedPrices && cachedPrices.size > 0) {
            this.storage.applyCachedPrices(cachedPrices);
          } else {
            console.warn('[Investments] No Firestore cache, falling back to API');
            await this.api.fetchBatchPrices(tickers);
          }
        } else {
          // Leader mode: Fetch from API and save to Firestore
          console.log('[Investments] Fetching from API (leader mode)');
          await this.api.fetchBatchPrices(tickers);
        }
      }

      if (this.historicalChart) {
        await this.historicalChart.loadPageWithCacheFirst();
      }
    } else {
      // En mode non-bloquant, on affiche tout de suite avec les données en cache
      if (this.historicalChart) {
        // Afficher le graphique avec le cache (paramètres non-bloquants)
        await this.historicalChart.update(false, false);
      } else {
        // Rendre les données du tableau immédiatement
        const targetAllPurchases = this.getFilteredPurchasesFromPage(false);
        const targetAssetPurchases = targetAllPurchases.filter(p => {
          const type = (p.assetType || 'Stock').toLowerCase();
          return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend' && type !== 'real estate';
        });
        const targetHoldings = this.dataManager.calculateHoldings(targetAssetPurchases);
        const targetCashPurchases = targetAllPurchases.filter(p => {
          const type = (p.assetType || 'Stock').toLowerCase();
          return type === 'cash' || type === 'dividend' || p.type === 'dividend';
        });

        // === LOAD OR CALCULATE SUMMARY ===
        const shouldRefresh = await this.storage.marketDataSync.shouldRefreshPrices();
        let currentSummary;

        if (!shouldRefresh) {
          // Follower mode: Try to load KPIs from Firestore
          const cachedSummary = await this.storage.marketDataSync.loadSummaryKPIs();
          if (cachedSummary && cachedSummary.timestamp) {
            console.log('[Investments] Using cached summary KPIs from Firestore');
            // Start with local calculations, then override main KPIs with cached values
            currentSummary = {
              ...this.dataManager.calculateSummary(targetHoldings),
              // Override with cached KPIs (these take priority)
              totalCurrentEUR: cachedSummary.totalValue,
              gainTotal: cachedSummary.totalReturn,
              gainPct: cachedSummary.totalReturnPct,
              totalDayChangeEUR: cachedSummary.varToday,
              dayChangePct: cachedSummary.varTodayPct,
              totalInvestedEUR: cachedSummary.invested
            };
          } else {
            // Fallback: calculate locally
            console.log('[Investments] No cached KPIs, calculating locally');
            currentSummary = this.dataManager.calculateSummary(targetHoldings);
          }
        } else {
          // Leader mode: Calculate fresh summary
          currentSummary = this.dataManager.calculateSummary(targetHoldings);
        }

        const targetCashReserve = this.dataManager.calculateCashReserve(targetCashPurchases);

        // === DEBUG: Log calculation details ===
        console.log('=== INVESTMENTS CALCULATION DEBUG ===');
        console.log('Total purchases:', targetAllPurchases.length);
        console.log('Asset purchases (filtered):', targetAssetPurchases.length);
        console.log('Cash purchases:', targetCashPurchases.length);
        console.log('Holdings calculated:', targetHoldings.length);
        console.log('Summary:', {
          totalValue: currentSummary.totalCurrentEUR,
          totalReturn: currentSummary.gainTotal,
          invested: currentSummary.totalInvestedEUR,
          varToday: currentSummary.totalDayChangeEUR
        });
        console.log('Cash reserve:', targetCashReserve.total);
        console.log('======================================');

        // === SAVE KPIs TO FIRESTORE (Leader Mode) ===
        if (shouldRefresh && tickers.length > 0) {
          const pricesMap = new Map();
          tickers.forEach(ticker => {
            const priceData = this.storage.getCurrentPrice(ticker);
            if (priceData) pricesMap.set(ticker, priceData);
          });
          if (pricesMap.size > 0) {
            // Save prices WITH summary KPIs
            await this.storage.marketDataSync.saveCurrentPrices(pricesMap, currentSummary);
          }
        }

        this.renderData(targetHoldings, currentSummary, targetCashReserve.total);
      }
    }

    // --- CORRECTION VAR DAY: Lancer le calcul précis en arrière-plan si pas encore fait ---
    if (!this.historyChecked) {
      this.historyChecked = true;
      console.log("DEBUG: All Asset Types present:", [...new Set(this.storage.getPurchases().map(p => p.assetType))]);
      const allPurchases = this.storage.getPurchases().filter(p => {
        const type = (p.assetType || 'Stock').toLowerCase();
        return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend';
      });
      console.log("Declenching background yesterdayClose calculation...");
      this.dataManager.calculateAllAssetsYesterdayClose(allPurchases).then(() => {
        console.log("Background yesterdayClose finished.");
        // Re-render only when market is closed (when open, app.js refreshPrices handles it)
        if (this.api.isMarketClosed()) {
          this.render(this.currentSearchQuery, false);
        }
      });
    }
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


  renderData(holdings, summary, cashReserveTotal, chartStats = null) { // <-- MODIFIÉ
    this.currentHoldings = holdings;
    const tbody = document.querySelector('#investments-table tbody');
    if (!tbody) return;

    const selectedTickers = this.filterManager.getSelectedTickers();

    let filteredHoldings = this.currentHoldings.filter(h => {
      // CRITICAL FIX: Hide assets with zero quantity, or "dust" positions (fully sold positions with fractional remainder)
      // We hide assets if their value is less than 0.50€ and quantity is tiny (< 0.01), to clean up the table
      if (h.quantity <= 0.000001) return false;
      if (h.currentValue !== null && Math.abs(h.currentValue) < 0.50 && Math.abs(h.quantity) < 0.01) return false;

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

    tbody.innerHTML = pageItems.map(p => {
      const isSelected = selectedTickers.has(p.ticker.toUpperCase());
      const selectedClass = isSelected ? 'selected' : '';
      const logoInfo = renderCompanyLogo(p.ticker, p.name);

      // Generate purchases sub-rows
      const sortedPurchases = [...p.purchases].sort((a, b) => a.date - b.date);
      const purchaseRows = sortedPurchases.map(purchase => {
        const buyDate = purchase.date instanceof Date ? purchase.date : new Date(purchase.date);
        const dateStr = buyDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
        const buyCurrency = purchase.currency || 'EUR';
        const buyPriceFormatted = purchase.price != null
          ? `${purchase.price.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${buyCurrency === 'USD' ? '$' : '€'}`
          : '-';
        const qty = purchase.quantity != null ? formatQuantity(purchase.quantity) : '-';

        // Gain total de cet achat
        const buyValue = (purchase.price || 0) * (purchase.quantity || 0);
        const currentPriceRaw = p.currentPrice || 0;
        // Convert currentPrice to purchase currency if needed
        const currentValueOfPurchase = currentPriceRaw * (purchase.quantity || 0);
        const purchaseGainEUR = p.currentPrice && purchase.price
          ? (p.currentPrice - purchase.price) * (purchase.quantity || 0)
          : null;
        const purchaseGainPct = purchase.price && purchaseGainEUR !== null
          ? ((p.currentPrice - purchase.price) / purchase.price) * 100
          : null;
        const purchaseCurrentValue = p.currentPrice
          ? p.currentPrice * (purchase.quantity || 0)
          : null;

        const gainClass = purchaseGainEUR > 0 ? 'positive' : purchaseGainEUR < 0 ? 'negative' : '';
        const gainArrow = purchaseGainEUR > 0 ? '↑' : purchaseGainEUR < 0 ? '↓' : '';
        const gainStr = purchaseGainEUR !== null
          ? `<span class="${gainClass}">${purchaseGainEUR >= 0 ? '+' : ''}${purchaseGainEUR.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>`
          : '-';
        const gainPctStr = purchaseGainPct !== null
          ? `<span class="badge ${purchaseGainPct > 0 ? 'badge-positive' : purchaseGainPct < 0 ? 'badge-negative' : 'badge-neutral'}">${gainArrow}${Math.abs(purchaseGainPct).toFixed(2)} %</span>`
          : '';
        const currentValStr = purchaseCurrentValue !== null
          ? purchaseCurrentValue.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
          : '-';

        return `
          <tr class="purchase-detail-row">
            <td>${dateStr}</td>
            <td>${buyPriceFormatted}</td>
            <td>${qty}</td>
            <td>${gainStr} ${gainPctStr}</td>
            <td>${currentValStr}</td>
          </tr>
        `;
      }).join('');

      const isExpanded = this.expandedTicker === p.ticker;
      const rowExpandedClass = isExpanded ? 'expanded' : '';
      const purchasesOpenClass = isExpanded ? 'open' : '';

      const purchasesTable = `
        <tr class="purchases-row ${purchasesOpenClass}" data-ticker="${p.ticker}">
          <td colspan="11" class="purchases-cell">
            <div class="purchases-expand">
              <table class="purchases-sub-table">
                <thead>
                  <tr>
                    <th>DATE D'ACHAT</th>
                    <th>PRIX D'ACHAT</th>
                    <th>QUANTITÉ</th>
                    <th>GAIN TOTAL</th>
                    <th>VALEUR</th>
                  </tr>
                </thead>
                <tbody>
                  ${purchaseRows}
                </tbody>
              </table>
              <div class="detail-action-buttons">
                <button class="detail-btn detail-btn-chart" data-ticker="${p.ticker}">
                  <i class="fas fa-chart-line"></i> Graphique
                </button>
                <button class="detail-btn detail-btn-screener" data-ticker="${p.ticker}">
                  <i class="fas fa-search"></i> Screener
                </button>
              </div>
            </div>
          </td>
        </tr>
      `;

      return `
            <tr class="asset-row ${selectedClass} ${rowExpandedClass}" data-ticker="${p.ticker}" data-avgprice="${p.avgPrice}">
                <td>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        ${logoInfo.html}
                        ${logoInfo.hasLogo ? '' : `<strong>${p.ticker}</strong>`}
                    </div>
                </td>
                <td>${p.name}</td>
                <td>${formatQuantity(p.quantity)}</td>
                <td>${formatCurrency(p.avgPrice, 'EUR')}</td>
                <td>${formatCurrency(p.invested, 'EUR')}</td>
                <td>${formatCurrency(p.currentPrice, 'EUR')}</td>
                <td>${formatCurrency(p.currentValue, 'EUR')}</td>
                <td class="${p.gainEUR > 0 ? 'positive' : p.gainEUR < 0 ? 'negative' : ''}">${formatCurrency(p.gainEUR, 'EUR')}</td>
                <td><span class="badge ${p.gainPct > 0 ? 'badge-positive' : p.gainPct < 0 ? 'badge-negative' : 'badge-neutral'}">${formatPercent(p.gainPct)}</span></td>
                <td class="${p.dayChange > 0 ? 'positive' : p.dayChange < 0 ? 'negative' : ''}">${formatCurrency(p.dayChange, 'EUR')}</td>
                <td><span class="badge ${p.dayPct > 0 ? 'badge-positive' : p.dayPct < 0 ? 'badge-negative' : 'badge-neutral'}">${formatPercent(p.dayPct)}</span></td>
            </tr>
            ${purchasesTable}
        `;
    }).join('') || '<tr><td colspan="11" style="text-align:center; padding:20px; color:var(--text-secondary);">Aucun investissement correspondant.</td></tr>';

    // --- CRITICAL FIX: Recalculate summary based on FILTERED holdings ---
    // Problem: VAR TODAY was calculated from ALL holdings, but table shows only filtered ones
    // Solution: Recalculate summary from filteredHoldings to match what's actually displayed
    const filteredSummary = this.dataManager.calculateSummary(filteredHoldings);

    // --- LOGIQUE D'ÉCRASEMENT DES STATS PAR LE GRAPHIQUE ---
    // 1. Définir les stats du graphique (pour la persistance si pagination)
    if (chartStats) this.lastChartStats = chartStats;
    const effectiveChartStats = chartStats || this.lastChartStats;

    // 2. Créer un résumé final BASÉ SUR LES DONNÉES FILTRÉES
    let finalSummary = { ...filteredSummary }; // Use filtered summary as base

    // CRITICAL FIX: GRAPH IS THE SINGLE SOURCE OF TRUTH FOR ALL KPIs
    // Override ALL summary values with chart values to ensure consistency with Dashboard
    // Dashboard's syncSummaryWithChartData does this, so we must do the same
    const isSingleAssetView = filteredHoldings.length === 1;

    if (!isSingleAssetView && effectiveChartStats) {
      // Full portfolio view: Use chart's values (SINGLE SOURCE OF TRUTH)

      // 1. Total Value: Use last value from graph (if available)
      if (effectiveChartStats.lastValue !== undefined && effectiveChartStats.lastValue !== null) {
        finalSummary.totalCurrentEUR = effectiveChartStats.lastValue;
        console.log(`[Investments] ✅ Total Value from graph: ${effectiveChartStats.lastValue.toFixed(2)}€`);
      }

      // 2. Total Return: Recalculate based on graph's Total Value
      if (finalSummary.totalInvestedEUR) {
        finalSummary.gainTotal = finalSummary.totalCurrentEUR - finalSummary.totalInvestedEUR;
        finalSummary.gainPct = finalSummary.totalInvestedEUR > 0
          ? (finalSummary.gainTotal / finalSummary.totalInvestedEUR) * 100
          : 0;
        console.log(`[Investments] ✅ Total Return from graph: ${finalSummary.gainTotal.toFixed(2)}€`);
      }

      // 3. Var Today: Use graph's historical day change
      if (effectiveChartStats.historicalDayChange !== null) {
        finalSummary.totalDayChangeEUR = effectiveChartStats.historicalDayChange;
        finalSummary.dayChangePct = effectiveChartStats.historicalDayChangePct;
        console.log(`[Investments] ✅ Var Today from graph: ${effectiveChartStats.historicalDayChange.toFixed(2)}€`);
      }
    } else {
      // Single asset or filtered view: Keep filteredSummary values
      console.log('[Investments] Using filteredSummary (single asset view)');
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
        // FIX: Call clearAllFilters twice to ensure single-click reset
        if (this.filterManager) {
          this.filterManager.clearAllFilters();
          this.filterManager.clearAllFilters(); // Force complete reset
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